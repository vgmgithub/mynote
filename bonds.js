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
//     payout:'cumulative'|'payout',                       // reinvest (compounds annually, value grows in place) vs coupon paid out (deposit value stays flat at principal; the coupon is real cash tracked below) — no compounding-frequency picker like FD's: retail bonds don't offer quarterly/monthly compounding
//     maturityAmount,                                      // optional ₹ — the actual/promised amount you'll receive at maturity (from the bond's term sheet). Overrides the rate-based projection when set; leave blank to project from `rate` instead
//     payouts: [{ date:'YYYY-MM-DD', amount }],            // dated log of interest/coupon actually received — the real "interest earned" figure once any entry exists, overriding the projection
//     createdAt, updatedAt }
// Status is derived purely from the date: active before maturity, matured on/after
// it (same as fd.js — no separate "withdrawn" state; if a bond is exited early,
// just log its final payout(s) and stop adding more, or delete it).
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

// Simple annual interest — the norm for retail coupon bonds (each period's
// coupon is paid out, not compounded back in).
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
  const isCumulative = bond.payout === 'cumulative';
  const start = bond.startDate || null;
  const maturity = bond.maturityDate || null;

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity)) : 0;
  const tenureMonths = tenureYears * 12;

  // Projected maturity value: an entered maturityAmount (from the bond's own term
  // sheet) always wins over the formula — it's real data, the formula is a guess.
  // Absent that, project via the coupon rate: payout bonds use simple interest
  // (each coupon paid out, not reinvested); cumulative bonds compound annually.
  const maturityOverride = (bond.maturityAmount !== '' && bond.maturityAmount != null) ? Number(bond.maturityAmount) : null;
  const computedMaturityValue = isCumulative ? compoundValueAt(P, rate, tenureYears) : simpleValueAt(P, rate, tenureYears);
  const maturityValue = maturityOverride != null ? maturityOverride : computedMaturityValue;
  const totalInterest = maturityValue - P;   // projected total interest over the full tenure

  const elapsedRaw = start ? Math.max(0, yearsBetween(start, todayISO)) : 0;
  const elapsedYears = tenureYears > 0 ? Math.min(elapsedRaw, tenureYears) : elapsedRaw;
  // Projected interest accrued as of today — a straight-line pro-rata share of
  // totalInterest by elapsed/tenure. Works the same whether totalInterest came
  // from the coupon-rate formula or a directly-entered maturityAmount.
  const projectedAccrued = tenureYears > 0 ? totalInterest * (elapsedYears / tenureYears) : 0;

  // A payout bond's DEPOSIT value stays flat at principal — the coupon is paid
  // out as real cash (tracked in the payouts ledger below), not reinvested into
  // the bond itself. A cumulative bond's value grows in place instead.
  const currentValue = isCumulative ? P + projectedAccrued : P;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  const pastMaturity = maturityT != null && now >= maturityT;
  const effectiveStatus = pastMaturity ? 'matured' : 'active';

  // Real interest actually received, from the dated payout ledger (the bond
  // form's "Payouts" tab) — this is the authoritative figure once it has any
  // entries, since real money beats a formula.
  const payouts = Array.isArray(bond.payouts) ? bond.payouts : [];
  const payoutsTotal = payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const lastPayoutDate = payouts.reduce((max, p) => (p.date && p.date > (max || '')) ? p.date : max, null);
  const hasPayouts = payouts.length > 0;

  // Interest earned — the headline figure. Once ANY payout is logged, actuals
  // take over completely; otherwise fall back to the projection (the full
  // total once matured, the pro-rated accrual while still active) so a
  // freshly-added bond still shows a sensible number before any real data exists.
  const interestEarned = hasPayouts ? payoutsTotal : (effectiveStatus === 'matured' ? totalInterest : projectedAccrued);

  // Bank-equivalent comparison: what the same principal would have earned at
  // bankRate (simple interest) over the same elapsed period.
  const bankEquivalent = bankRate != null ? simpleValueAt(P, bankRate, elapsedYears) : null;
  const bankInterest = bankEquivalent != null ? bankEquivalent - P : null;
  const vsBank = bankInterest != null ? interestEarned - bankInterest : null;

  const monthlyIncome = tenureMonths > 0 ? totalInterest / tenureMonths : 0;

  // Human-readable explanation of what basis produced totalInterest/maturityValue
  // — surfaced directly in the UI so "how is this calculated" is never a mystery.
  const basis = maturityOverride != null
    ? `entered maturity amount (₹${Math.round(maturityOverride).toLocaleString('en-IN')})`
    : isCumulative
      ? `compounds annually at ${rate}%`
      : `simple interest at ${rate}% p.a.`;

  return {
    principal: P, rate, bankRate, payout: bond.payout, start, maturity,
    tenureYears, tenureMonths,
    maturityValue, totalInterest, maturityOverride, basis,
    currentValue, projectedAccrued,
    daysToMaturity, pastMaturity, effectiveStatus,
    payoutsTotal, hasPayouts, lastPayoutDate, interestEarned,
    bankEquivalent, bankInterest, vsBank,
    monthlyIncome,
  };
}

// Add `months` to a YYYY-MM-DD date → YYYY-MM-DD (UTC math, no tz drift). Used
// by the form's "tenure → maturity date" convenience, and to default a new
// payout row's date to one month after the last one logged (same helper as
// fd.js; duplicated here since pure logic modules don't cross-import in this app).
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + Number(months || 0), +m[3]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// One-time seed: the 3 real bonds from the user's X-MyNotes sheet (BOND tab).
// Start dates are approximate (sheet only gives month+year, e.g. "Aug 25") —
// defaulted to the 1st of the stated month; user can correct exact dates via
// Edit. No payouts are seeded — the sheet's own payout-schedule sub-table mixes
// "promised" and "actual" figures ambiguously, so real entries are left for the
// user to log via the Payouts tab.
export const SEED_BONDS = [
  {
    name: "U FRO-2 Aug'25", rating: 'A+', investAmount: 5961, rate: 11.50, bankRate: 5.80,
    startDate: '2025-08-01', maturityDate: '2026-03-01', payout: 'payout',
    maturityAmount: null, payouts: [],
  },
  {
    name: 'Wint Capital', rating: 'BBB-', investAmount: 10044.49, rate: 11.75, bankRate: 6.60,
    startDate: '2026-04-01', maturityDate: '2027-11-01', payout: 'payout',
    maturityAmount: null, payouts: [],
  },
  {
    name: 'Moothoot', rating: 'BBB', investAmount: 5978, rate: 10.50, bankRate: 6.00,
    startDate: '2026-05-01', maturityDate: '2027-02-01', payout: 'payout',
    maturityAmount: null, payouts: [],
  },
];
