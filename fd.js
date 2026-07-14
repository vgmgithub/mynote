// fd.js — Fixed Deposit ladder: pure calculations. No DOM, no IO.
// One record per FD; app.js owns the `fds` IndexedDB store CRUD. Lazy-loaded
// (import('./fd.js')) so the Stocks/MF surfaces never pay for it.
//
// FD record shape (fds store, IndexedDB v5):
//   { id, owner:'me', bank,
//     principal,                                         // FRESH money added to THIS FD only (top-up). Effective deposit = principal + sum of mapped parents' maturity values (see resolveChain).
//     rate,                                              // annual % p.a.
//     startDate:'YYYY-MM-DD', maturityDate:'YYYY-MM-DD',
//     compounding:'quarterly'|'monthly'|'half-yearly'|'yearly'|'simple',
//     payout:'cumulative'|'payout',                     // reinvest vs interest paid out
//     parentFdIds:[id, ...],                              // ids of the matured FD(s) reinvested into this one (chain link; supports merging 2+ matured FDs into one). Empty/absent = fresh-only. Each parent's maturity value seeds this FD's effective deposit. (Legacy singular `parentFdId` from an older version is still read as a 1-element list.)
//     notes, createdAt, updatedAt }
// Status is derived purely from the date: active before maturity, matured on/after
// it. There is no stored status and no "broken" - to drop an FD, delete it.

const DAY = 86400000;

// The three small finance banks the user actually uses (higher FD rates,
// still DICGC-insured). Free-text, so any bank can be typed — these just
// pre-fill the datalist.
export const FD_BANKS = [
  'North East Small Finance Bank (via Airtel Finance)',
  'Slice Small Finance Bank',
  'Utkarsh Small Finance Bank',
];
export const FD_COMPOUNDING = ['quarterly', 'monthly', 'half-yearly', 'yearly', 'simple'];

const PERIODS = { yearly: 1, 'half-yearly': 2, quarterly: 4, monthly: 12 };

// Whole-day-accurate year fraction between two YYYY-MM-DD dates (both parsed as
// UTC midnight, so no timezone drift). `inclusive365` switches to inclusive
// day-count (deposit date counts as day 1) over a flat 365-day year - see the
// convention note in computeFd for why/when.
function yearsBetween(aISO, bISO, inclusive365) {
  const a = Date.parse(aISO), b = Date.parse(bISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return inclusive365 ? ((b - a) / DAY + 1) / 365 : (b - a) / (365.25 * DAY);
}

// Value of principal P after `years`, given annual rate% and compounding.
function valueAt(P, rate, years, comp) {
  if (!(P > 0) || years <= 0) return P || 0;
  if (comp === 'simple') return P * (1 + (rate * years) / 100);
  const n = PERIODS[comp] || 4;
  return P * Math.pow(1 + rate / (100 * n), n * years);
}

// `seed` = the rolled-in base from a mapped matured parent (its maturity value).
// Effective deposit P = fresh principal (fd.principal) + seed. Interest, maturity,
// and current value all compute on P. `seed` defaults to 0 (a fresh-only FD).
export function computeFd(fd, nowMs, seed) {
  const now = nowMs || Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const freshPrincipal = Number(fd.principal) || 0;
  const rolledIn = Number(seed) || 0;
  const P = freshPrincipal + rolledIn;         // effective deposit (bank pays interest on this)
  const rate = Number(fd.rate) || 0;
  const comp = fd.compounding || 'quarterly';
  const payout = fd.payout === 'payout';
  const start = fd.startDate || null;
  const maturity = fd.maturityDate || null;

  // Day-count convention: FDs contracted for more than ~18 months match an
  // inclusive-day/flat-365 convention better (verified against a real FD: ₹9,500
  // @ 7.75% quarterly, 18mo1day → ₹10,664.88 vs bank's ₹10,665, 12 paise off).
  // FDs of 18 months or under matched the original exclusive-day/365.25
  // convention better (₹2,000 @ 8.75%, 13mo). Decided once from the FD's
  // *contracted* tenure (start→maturity).
  const contractedDays = start && maturity ? (Date.parse(maturity) - Date.parse(start)) / DAY : 0;
  const inclusive365 = contractedDays > 548;

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity, inclusive365)) : 0;
  const tenureMonths = tenureYears * 12;

  // Maturity value: a payout FD returns just the principal (interest paid out
  // along the way); a cumulative FD reinvests, so it compounds.
  const maturityValue = payout ? P : valueAt(P, rate, tenureYears, comp);
  const totalInterest = payout ? (P * rate * tenureYears) / 100 : maturityValue - P;

  // Accrued value as of today (clamped to the tenure once matured).
  const elapsedRaw = start ? Math.max(0, yearsBetween(start, todayISO, inclusive365)) : 0;
  const elapsedYears = tenureYears > 0 ? Math.min(elapsedRaw, tenureYears) : elapsedRaw;
  const currentValue = payout ? P : valueAt(P, rate, elapsedYears, comp);
  const accruedInterest = payout ? (P * rate * elapsedYears) / 100 : currentValue - P;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  const pastMaturity = maturityT != null && now >= maturityT;

  // Status is purely date-derived now (no stored status, no broken).
  const effectiveStatus = pastMaturity ? 'matured' : 'active';

  // Monthly interest income: payout FDs pay it out for real; for cumulative it's
  // the total interest averaged over the tenure - what it throws off/month.
  const monthlyIncome = payout
    ? (P * rate) / 1200
    : tenureMonths > 0 ? totalInterest / tenureMonths : 0;

  return {
    principal: P, freshPrincipal, rolledIn,
    rate, comp, payout, start, maturity,
    tenureYears, tenureMonths,
    maturityValue, totalInterest,
    currentValue, accruedInterest,
    daysToMaturity, pastMaturity,
    effectiveStatus,
    monthlyIncome,
  };
}

// Normalizes an FD's parent links to an array, whatever shape is stored: the
// current `parentFdIds` array, or a legacy singular `parentFdId` from an older
// version of this app.
export function parentIdsOf(fd) {
  if (Array.isArray(fd.parentFdIds)) return fd.parentFdIds.filter((x) => x != null);
  if (fd.parentFdId != null) return [fd.parentFdId];
  return [];
}

// Resolve an FD's computeFd result folding in its mapped parent(s)' maturity
// value(s) as the seed (summed - this is how two matured FDs merge into one),
// recursively up the chain. `byId` = Map(id → fd record); `cache` = Map(id →
// result) memo (also a cycle guard). Use this instead of computeFd anywhere a
// chain (parentFdIds) may be present.
export function resolveChain(fd, byId, nowMs, cache) {
  cache = cache || new Map();
  if (cache.has(fd.id)) return cache.get(fd.id) || computeFd(fd, nowMs, 0);
  cache.set(fd.id, null);                       // cycle guard: null while resolving
  let seed = 0;
  for (const pid of parentIdsOf(fd)) {
    if (!byId.has(pid)) continue;
    const pc = resolveChain(byId.get(pid), byId, nowMs, cache);
    if (pc) seed += pc.maturityValue;
  }
  const c = computeFd(fd, nowMs, seed);
  cache.set(fd.id, c);
  return c;
}

// Add `months` to a YYYY-MM-DD date → YYYY-MM-DD (UTC math, no tz drift). Used
// by the form's "tenure → maturity date" convenience.
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + Number(months || 0), +m[3]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
