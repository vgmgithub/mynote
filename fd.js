// fd.js — Fixed Deposit ladder: pure calculations. No DOM, no IO.
// One record per FD; app.js owns the `fds` IndexedDB store CRUD. Lazy-loaded
// (import('./fd.js')) so the Stocks/MF surfaces never pay for it.
//
// FD record shape (fds store, IndexedDB v5):
//   { id, owner:'me', bank, principal, rate,           // rate = annual % p.a.
//     startDate:'YYYY-MM-DD', maturityDate:'YYYY-MM-DD',
//     compounding:'quarterly'|'monthly'|'half-yearly'|'yearly'|'simple',
//     payout:'cumulative'|'payout',                     // reinvest vs interest paid out
//     status:'active'|'broken',                          // 'matured' is derived from the date, never stored
//     brokenDate:'YYYY-MM-DD',                           // set only when status='broken' (early closure)
//     notes, createdAt, updatedAt }

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
export const FD_STATUS = ['active', 'matured', 'broken'];

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

export function computeFd(fd, nowMs) {
  const now = nowMs || Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const P = Number(fd.principal) || 0;
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
  // *contracted* tenure (start→maturity), never from elapsed days, so a single
  // FD can't switch convention partway through its life.
  const EIGHTEEN_MONTHS_DAYS = 548;
  const contractedDays = start && maturity ? (Date.parse(maturity) - Date.parse(start)) / DAY : 0;
  const inclusive365 = contractedDays > EIGHTEEN_MONTHS_DAYS;

  // A broken FD (closed early) ends on its broken date, not its maturity date -
  // interest accrues only up to then, at the same rate (no penalty modelled).
  const broken = (fd.status || 'active') === 'broken';
  const brokenDate = broken ? (fd.brokenDate || todayISO) : null;

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity, inclusive365)) : 0;
  const tenureMonths = tenureYears * 12;

  // Effective term end: the broken date for a broken FD, else the maturity date.
  // Everything financial is derived off this, so a normal FD is unchanged.
  const termEnd = broken ? brokenDate : maturity;
  const termYears = start && termEnd ? Math.max(0, yearsBetween(start, termEnd, inclusive365)) : 0;
  const termMonths = termYears * 12;

  // Maturity/exit value: a payout FD returns just the principal (interest was
  // paid out along the way); a cumulative FD reinvests, so it compounds. A broken
  // FD uses the shorter broken-date term.
  const maturityValue = payout ? P : valueAt(P, rate, termYears, comp);
  const totalInterest = payout ? (P * rate * termYears) / 100 : maturityValue - P;

  // Accrued value as of today (clamped to the effective term once ended).
  const elapsedRaw = start ? Math.max(0, yearsBetween(start, todayISO, inclusive365)) : 0;
  const elapsedYears = termYears > 0 ? Math.min(elapsedRaw, termYears) : elapsedRaw;
  const currentValue = payout ? P : valueAt(P, rate, elapsedYears, comp);
  const accruedInterest = payout ? (P * rate * elapsedYears) / 100 : currentValue - P;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  const pastMaturity = maturityT != null && now >= maturityT;

  // Broken wins; else an FD still marked active but past its date reads matured.
  const userStatus = fd.status || 'active';
  const effectiveStatus = broken
    ? 'broken'
    : userStatus === 'active' && pastMaturity ? 'matured' : userStatus;

  // Monthly interest income: payout FDs pay it out for real; for cumulative it's
  // the total interest averaged over the (effective) term - what it throws off/month.
  const monthlyIncome = payout
    ? (P * rate) / 1200
    : termMonths > 0 ? totalInterest / termMonths : 0;

  return {
    principal: P, rate, comp, payout, start, maturity,
    tenureYears, tenureMonths,
    broken, brokenDate, termYears,
    maturityValue, totalInterest,
    currentValue, accruedInterest,
    daysToMaturity, pastMaturity,
    userStatus, effectiveStatus,
    monthlyIncome,
  };
}

// Add `months` to a YYYY-MM-DD date → YYYY-MM-DD (UTC math, no tz drift). Used
// by the form's "tenure → maturity date" convenience.
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + Number(months || 0), +m[3]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
