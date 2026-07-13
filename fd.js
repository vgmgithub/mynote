// fd.js — Fixed Deposit ladder: pure calculations. No DOM, no IO.
// One record per FD; app.js owns the `fds` IndexedDB store CRUD. Lazy-loaded
// (import('./fd.js')) so the Stocks/MF surfaces never pay for it.
//
// FD record shape (fds store, IndexedDB v5):
//   { id, owner:'me', bank, principal, rate,           // rate = annual % p.a.
//     startDate:'YYYY-MM-DD', maturityDate:'YYYY-MM-DD',
//     compounding:'quarterly'|'monthly'|'half-yearly'|'yearly'|'simple',
//     payout:'cumulative'|'payout',                     // reinvest vs interest paid out
//     status:'active'|'matured'|'broken', notes, createdAt, updatedAt }

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
// UTC midnight, so no timezone drift).
function yearsBetween(aISO, bISO) {
  const a = Date.parse(aISO), b = Date.parse(bISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return (b - a) / (365.25 * DAY);
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

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity)) : 0;
  const tenureMonths = tenureYears * 12;

  // Maturity value: a payout FD returns just the principal (interest was paid
  // out along the way); a cumulative FD reinvests, so it compounds.
  const maturityValue = payout ? P : valueAt(P, rate, tenureYears, comp);
  const totalInterest = payout ? (P * rate * tenureYears) / 100 : maturityValue - P;

  // Accrued value as of today (clamped to the tenure once matured).
  const elapsedRaw = start ? Math.max(0, yearsBetween(start, todayISO)) : 0;
  const elapsedYears = tenureYears > 0 ? Math.min(elapsedRaw, tenureYears) : elapsedRaw;
  const currentValue = payout ? P : valueAt(P, rate, elapsedYears, comp);
  const accruedInterest = payout ? (P * rate * elapsedYears) / 100 : currentValue - P;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  const pastMaturity = maturityT != null && now >= maturityT;

  // User's status wins; an FD still marked active but past its date reads matured.
  const userStatus = fd.status || 'active';
  const effectiveStatus = userStatus === 'active' && pastMaturity ? 'matured' : userStatus;

  // Monthly interest income: payout FDs pay it out for real; for cumulative it's
  // the total interest averaged over the tenure (what the FD "throws off"/month).
  const monthlyIncome = payout
    ? (P * rate) / 1200
    : tenureMonths > 0 ? totalInterest / tenureMonths : 0;

  return {
    principal: P, rate, comp, payout, start, maturity,
    tenureYears, tenureMonths,
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
