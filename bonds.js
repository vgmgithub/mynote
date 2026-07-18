// bonds.js — Bonds ledger: pure calculations. No DOM, no IO.
// One record per bond; app.js owns the `bonds` IndexedDB store CRUD. Lazy-loaded
// (import('./bonds.js')) so the Stocks/MF/FD surfaces never pay for it.
//
// Bond record shape (bonds store, IndexedDB v8):
//   { id, owner:'me', name, rating,
//     investAmount,                                      // ₹ principal
//     rate,                                               // annual coupon %
//     bankRate,                                            // comparable bank/FD rate % (optional — blank skips the vs-Bank comparison)
//     startDate:'YYYY-MM-DD', maturityDate:'YYYY-MM-DD',
//     payout:'cumulative'|'payout',                       // reinvest (compounds annually) vs coupon paid out (simple interest) — no compounding-frequency picker like FD's: retail bonds don't offer quarterly/monthly compounding
//     withdrawAmount, withdrawDate,                        // set when redeemed (early exit or at maturity) — actual realized amount, overrides projected accrual
//     notes, createdAt, updatedAt }
// Status is derived: withdrawn (withdrawAmount set) > matured (past maturity) > active.
// No reinvestment-chain concept here (unlike fd.js's parentFdIds) — bonds in this
// app don't ladder/merge the way the user's FDs do.

const DAY = 86400000;

// Common credit-rating bands, free text + datalist convenience (mirrors FD_BANKS).
export const BOND_RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'Unrated'];
export const BOND_PAYOUT = ['cumulative', 'payout'];

// Whole-day-accurate year fraction between two YYYY-MM-DD dates (UTC midnight,
// no timezone drift). Single convention (exclusive day-count over 365.25) —
// unlike fd.js there's no real-bond data yet to tune a dual convention against.
function yearsBetween(aISO, bISO) {
  const a = Date.parse(aISO), b = Date.parse(bISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return (b - a) / (365.25 * DAY);
}

// Value of principal P after `years` at simple annual `rate`% (payout bonds pay
// the coupon out rather than compounding it back in).
function simpleValueAt(P, rate, years) {
  if (!(P > 0) || years <= 0) return P || 0;
  return P * (1 + (rate * years) / 100);
}
// Cumulative bonds compound annually (n=1) — bonds don't offer FD-style quarterly/
// monthly compounding, so there's no frequency picker.
function compoundValueAt(P, rate, years) {
  if (!(P > 0) || years <= 0) return P || 0;
  return P * Math.pow(1 + rate / 100, years);
}

export function computeBond(bond, nowMs) {
  const now = nowMs || Date.now();
  const todayISO = new Date(now).toISOString().slice(0, 10);
  const P = Number(bond.investAmount) || 0;
  const rate = Number(bond.rate) || 0;
  const bankRate = bond.bankRate !== '' && bond.bankRate != null ? Number(bond.bankRate) : null;
  const cumulative = bond.payout === 'cumulative';
  const start = bond.startDate || null;
  const maturity = bond.maturityDate || null;
  const valueAt = cumulative ? compoundValueAt : simpleValueAt;

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity)) : 0;
  const tenureMonths = tenureYears * 12;

  const maturityValue = valueAt(P, rate, tenureYears);
  const totalInterest = maturityValue - P;

  const elapsedRaw = start ? Math.max(0, yearsBetween(start, todayISO)) : 0;
  const elapsedYears = tenureYears > 0 ? Math.min(elapsedRaw, tenureYears) : elapsedRaw;
  const currentValue = valueAt(P, rate, elapsedYears);
  const accruedInterest = currentValue - P;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  const pastMaturity = maturityT != null && now >= maturityT;

  const withdrawAmount = bond.withdrawAmount !== '' && bond.withdrawAmount != null ? Number(bond.withdrawAmount) : null;
  const withdrawn = withdrawAmount != null;
  const effectiveStatus = withdrawn ? 'withdrawn' : (pastMaturity ? 'matured' : 'active');
  const realizedInterest = withdrawn ? withdrawAmount - P : null;

  // Bank-equivalent comparison: what the same principal would have earned at
  // bankRate (simple interest) over the same elapsed/held period.
  const bankEquivalent = bankRate != null ? simpleValueAt(P, bankRate, elapsedYears) : null;
  const bankInterest = bankEquivalent != null ? bankEquivalent - P : null;
  const effectiveInterest = withdrawn ? realizedInterest : accruedInterest;
  const vsBank = bankInterest != null ? effectiveInterest - bankInterest : null;

  const monthlyIncome = tenureMonths > 0 ? totalInterest / tenureMonths : 0;

  return {
    principal: P, rate, bankRate, payout: bond.payout, start, maturity,
    tenureYears, tenureMonths,
    maturityValue, totalInterest,
    currentValue, accruedInterest,
    daysToMaturity, pastMaturity,
    effectiveStatus, withdrawAmount, realizedInterest,
    bankEquivalent, bankInterest, vsBank,
    monthlyIncome,
  };
}

// Add `months` to a YYYY-MM-DD date → YYYY-MM-DD (UTC math, no tz drift). Used
// by the form's "tenure → maturity date" convenience (same helper as fd.js;
// duplicated here since pure logic modules don't cross-import in this app).
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + Number(months || 0), +m[3]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// One-time seed: the 3 real bonds from the user's X-MyNotes sheet (BOND tab).
// Start dates are approximate (sheet only gives month+year, e.g. "Aug 25") —
// defaulted to the 1st of the stated month; user can correct exact dates via
// Edit. U FRO-2 Aug'25 is seeded WITHOUT a withdrawAmount even though the sheet
// shows a "Withdraw: 6000" figure — it doesn't reconcile cleanly against the
// sheet's own "Int Amount: 6321.3" and the exact exit date isn't recorded, so
// guessing would risk wrong data; it seeds as matured (interest still computing)
// and the user can fill in the real exit figures.
export const SEED_BONDS = [
  {
    name: "U FRO-2 Aug'25", rating: 'A+', investAmount: 5961, rate: 11.50, bankRate: 5.80,
    startDate: '2025-08-01', maturityDate: '2026-03-01', payout: 'payout',
    withdrawAmount: null, withdrawDate: null, notes: 'Seeded from X-MyNotes BOND sheet.',
  },
  {
    name: 'Wint Capital', rating: 'BBB-', investAmount: 10044.49, rate: 11.75, bankRate: 6.60,
    startDate: '2026-04-01', maturityDate: '2027-11-01', payout: 'payout',
    withdrawAmount: null, withdrawDate: null, notes: 'Seeded from X-MyNotes BOND sheet.',
  },
  {
    name: 'Moothoot', rating: 'BBB', investAmount: 5978, rate: 10.50, bankRate: 6.00,
    startDate: '2026-05-01', maturityDate: '2027-02-01', payout: 'payout',
    withdrawAmount: null, withdrawDate: null, notes: 'Seeded from X-MyNotes BOND sheet.',
  },
];
