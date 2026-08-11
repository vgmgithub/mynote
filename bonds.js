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
//     interestFreq,                                        // optional — when coupons arrive: 'monthly'|'quarterly'|'halfyearly'|'yearly'|'maturity'|'staggered'. Only meaningful for payout bonds; a cumulative bond IS "at maturity" by definition, so the form hides the picker. null/absent = unspecified (every pre-existing bond) → no schedule projected, totals behave exactly as before this field existed
//     principalFreq,                                       // optional — when principal comes back: same values. Absent/'maturity' = the classic single lump at maturity. Anything else means the bond AMORTIZES, which switches the interest projection onto the declining outstanding balance (see buildSchedule)
//     schedule: [{ date:'YYYY-MM-DD', principal, interest }], // only for 'staggered' — the term sheet's own uneven installments, typed in by the user. Principal rows drive amortization; interest rows are taken as-given (not recomputed) since a staggered coupon is whatever the issuer says it is
//     maturityAmount,                                      // optional ₹ — the actual/promised amount you'll receive at maturity (from the bond's term sheet). Overrides the rate-based projection when set; leave blank to project from `rate` instead
//     payouts: [{ date:'YYYY-MM-DD', amount }],            // dated log of interest/coupon actually received — the real "interest earned" figure once any entry exists, overriding the projection
//     soldDate:'YYYY-MM-DD',                               // set = exited early (or redeemed at/after maturity via this form instead of just letting it age out)
//     soldAmount,                                          // ₹ TOTAL credited on exit, including principal — never just the gain
//     createdAt, updatedAt }
// Status is derived: 'sold' when soldDate is set (wins over the maturity check —
// a bond redeemed after its maturity date still reads as sold, not matured),
// else 'matured' on/after maturity, else 'active' (same date-derived approach as
// fd.js). `pastMaturity` itself stays date-only and does NOT fold in soldDate —
// see computeBond for why that distinction matters.
// No reinvestment-chain concept here (unlike fd.js's parentFdIds) — bonds in this
// app don't ladder/merge the way the user's FDs do.

const DAY = 86400000;

// Common credit-rating bands, free text + datalist convenience (mirrors FD_BANKS).
export const BOND_RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'Unrated'];
export const BOND_PAYOUT = ['cumulative', 'payout'];
// Shared by both the interest and principal frequency pickers — [value, label].
export const BOND_FREQ = [
  ['maturity', 'At maturity'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['halfyearly', 'Half-yearly'],
  ['yearly', 'Yearly'],
  ['staggered', 'Staggered (custom)'],
];
const FREQ_MONTHS = { monthly: 1, quarterly: 3, halfyearly: 6, yearly: 12 };
// null for 'maturity'/'staggered'/unspecified — neither has a fixed period.
function freqMonths(f) { return FREQ_MONTHS[f] || null; }

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

// Installment dates for a periodic frequency: every `pm` months from the start
// date, stopping BEFORE maturity, then maturity itself as the final one.
// Maturity is always included because principal must be fully returned by then —
// a tenure that isn't a whole number of periods (e.g. 10 months quarterly) would
// otherwise leave a stub of principal unaccounted for.
function periodDates(start, maturity, pm) {
  if (!start || !maturity || !(pm > 0) || maturity <= start) return [];
  const out = [];
  // Hard bound: monthly over a 50-year bond is 600 rows; anything past that is a
  // data-entry error, not a real bond, and must not spin.
  for (let k = 1; k <= 600; k++) {
    const d = addMonths(start, k * pm);
    if (!d || d >= maturity) break;
    out.push(d);
  }
  out.push(maturity);
  return out;
}

// Projected cash-flow schedule: one row per date where principal and/or interest
// changes hands, plus the balance left after it.
//
// Interest always accrues on whatever principal was actually OUTSTANDING over the
// days held, then pays out on interest dates. That single rule covers every
// combination correctly: a non-amortizing bond's coupons stay level (balance never
// moves), an amortizing bond's coupons shrink as capital comes back, and a
// cumulative bond banks the same declining accrual until maturity instead of
// paying it. The bank comparison rides the same balance so it stays
// apples-to-apples rather than crediting the bank a full-principal return on money
// the bond already handed back.
function buildSchedule(P, rate, bankRate, start, maturity, iFreq, pFreq, custom) {
  const events = new Map();
  const bump = (date, key, amt) => {
    if (!date || !(amt > 0)) return;
    const x = events.get(date) || { principal: 0, interest: 0 };
    x[key] += amt;
    events.set(date, x);
  };

  // ---- Principal side ----
  let perInstallment = null, installments = 0;
  if (pFreq === 'staggered') {
    const rows = custom.filter((r) => r.date && r.principal > 0);
    rows.forEach((r) => bump(r.date, 'principal', r.principal));
    installments = rows.length;
  } else if (freqMonths(pFreq)) {
    const ds = periodDates(start, maturity, freqMonths(pFreq));
    if (ds.length) {
      perInstallment = P / ds.length;
      installments = ds.length;
      ds.forEach((d) => bump(d, 'principal', perInstallment));
    }
  } else if (maturity) {
    bump(maturity, 'principal', P);
    installments = 1;
  }

  // ---- Interest side ----
  // Staggered amounts are user-given and taken as-is. For every other frequency
  // we only mark WHICH dates pay; the amount comes from the balance walk below.
  const payDates = new Set();
  const staggeredInterest = iFreq === 'staggered';
  if (staggeredInterest) {
    custom.forEach((r) => { if (r.date && r.interest > 0) bump(r.date, 'interest', r.interest); });
  } else {
    const ds = freqMonths(iFreq) ? periodDates(start, maturity, freqMonths(iFreq)) : (maturity ? [maturity] : []);
    ds.forEach((d) => {
      payDates.add(d);
      if (!events.has(d)) events.set(d, { principal: 0, interest: 0 });
    });
  }

  const dates = Array.from(events.keys()).sort();
  const rows = [];
  let outstanding = P, accrued = 0, prev = start;
  for (const d of dates) {
    const dt = yearsBetween(prev, d);
    accrued += outstanding * (rate / 100) * dt;
    prev = d;
    const ev = events.get(d);
    let interest = 0;
    if (staggeredInterest) {
      interest = ev.interest;
      accrued -= interest;   // keep the bucket honest so a later computed date isn't double-paid
    } else if (payDates.has(d)) {
      interest = accrued;
      accrued = 0;
    }
    const openingBalance = outstanding;
    outstanding = Math.max(0, outstanding - ev.principal);
    rows.push({ date: d, principal: ev.principal, interest, openingBalance, outstanding });
  }
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  // How much principal the schedule actually accounts for. For a staggered plan
  // this can silently fall short of (or overshoot) the invested amount, which
  // skews every downstream figure — callers compare it against P and warn.
  const principalScheduled = rows.reduce((s, r) => s + r.principal, 0);
  return { rows, perInstallment, installments, totalInterest, principalScheduled };
}

// Replay a schedule up to `asOf`: what's still outstanding, what has already been
// paid, and the part-period interest accrued since the last event but not yet due.
// Separate from buildSchedule because the schedule itself is fixed at issue while
// these move every day.
function scheduleAsOf(sched, P, rate, bankRate, start, asOf) {
  let outstanding = P, interestPaid = 0, principalBack = 0, bankInterest = 0, prev = start;
  for (const r of sched.rows) {
    if (r.date > asOf) break;
    const dt = yearsBetween(prev, r.date);
    if (bankRate != null) bankInterest += outstanding * (bankRate / 100) * dt;
    prev = r.date;
    interestPaid += r.interest;
    principalBack += r.principal;
    outstanding = Math.max(0, outstanding - r.principal);
  }
  // Stub period: last event → asOf, on the balance still held across it.
  const stubDt = yearsBetween(prev, asOf);
  const stubAccrual = outstanding * (rate / 100) * stubDt;
  if (bankRate != null) bankInterest += outstanding * (bankRate / 100) * stubDt;
  return {
    outstanding, principalBack,
    // "Earned so far" = coupons already due + interest accrued since the last one.
    accrued: interestPaid + stubAccrual,
    interestPaid,
    bankInterest: bankRate != null ? bankInterest : null,
    nextDue: sched.rows.find((r) => r.date > asOf) || null,
  };
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

  const isSold = !!bond.soldDate;
  const soldDate = isSold ? bond.soldDate : null;
  const soldAmount = isSold && bond.soldAmount != null ? Number(bond.soldAmount) : null;
  const soldGain = isSold && soldAmount != null ? soldAmount - P : 0;

  const tenureYears = start && maturity ? Math.max(0, yearsBetween(start, maturity)) : 0;
  const tenureMonths = tenureYears * 12;

  // Cash-flow schedule. `principalFreq` absent or 'maturity' is the classic single
  // lump — every bond that existed before this feature — and that path is left
  // completely alone below so no stored bond's numbers shift. Anything else means
  // the bond amortizes, which is what moves the interest projection onto the
  // declining balance.
  const interestFreq = bond.interestFreq || null;
  const principalFreq = bond.principalFreq || 'maturity';
  const amortizes = principalFreq !== 'maturity';
  const customSchedule = (Array.isArray(bond.schedule) ? bond.schedule : [])
    .map((r) => ({ date: r.date || '', principal: Number(r.principal) || 0, interest: Number(r.interest) || 0 }))
    .filter((r) => r.date);
  // Only build one when there's actually a schedule to show: an amortizing bond
  // always has one, a level bond only if its coupons are periodic.
  const wantsSchedule = !!(start && maturity && P > 0 && (amortizes || (interestFreq && interestFreq !== 'maturity')));
  const sched = wantsSchedule
    ? buildSchedule(P, rate, bankRate, start, maturity, interestFreq || 'maturity', principalFreq, customSchedule)
    : null;

  // Projected maturity value: an entered maturityAmount (from the bond's own term
  // sheet) always wins over the formula — it's real data, the formula is a guess.
  // Absent that: an amortizing bond takes the schedule's own total (interest on the
  // shrinking balance, which no closed-form rate formula captures); otherwise the
  // classic projection — payout bonds use simple interest (each coupon paid out,
  // not reinvested); cumulative bonds compound annually.
  const maturityOverride = (bond.maturityAmount !== '' && bond.maturityAmount != null) ? Number(bond.maturityAmount) : null;
  const computedMaturityValue = (amortizes && sched)
    ? P + sched.totalInterest
    : (isCumulative ? compoundValueAt(P, rate, tenureYears) : simpleValueAt(P, rate, tenureYears));
  const maturityValue = maturityOverride != null ? maturityOverride : computedMaturityValue;
  const totalInterest = maturityValue - P;   // projected total interest over the full tenure

  // "Elapsed" freezes at the exit date once sold — a bond sold years before its
  // maturity date shouldn't keep accruing projected interest it never received.
  // Guarded with `soldDate < todayISO` (not <=) because todayISO is UTC-derived:
  // between 00:00–05:30 IST a genuinely-today sale has soldDate > todayISO, and
  // this must CLAMP to today rather than reject a legitimate same-day entry.
  const asOf = (isSold && soldDate && soldDate < todayISO) ? soldDate : todayISO;
  const elapsedRaw = start ? Math.max(0, yearsBetween(start, asOf)) : 0;
  const elapsedYears = tenureYears > 0 ? Math.min(elapsedRaw, tenureYears) : elapsedRaw;
  // Replay the schedule to `asOf` for the live figures (what's still outstanding,
  // what's already been paid). Only meaningful once a schedule exists.
  const asOfSched = sched ? scheduleAsOf(sched, P, rate, bankRate, start, asOf) : null;

  // Projected interest accrued as of today (or the exit date). An amortizing bond
  // takes it from the schedule replay — coupons already due plus the part-period
  // since the last one — because a straight-line share of the total would
  // under-credit the early periods, when the balance (and so each coupon) was
  // largest.
  // Everything else keeps the straight-line pro-rata, which works the same whether
  // totalInterest came from the coupon-rate formula or a directly-entered
  // maturityAmount.
  const projectedAccrued = (amortizes && asOfSched)
    ? asOfSched.accrued
    : (tenureYears > 0 ? totalInterest * (elapsedYears / tenureYears) : 0);

  // Principal still working. For an amortizing bond this genuinely shrinks over
  // the tenure; for every other bond it's the whole principal until the bond
  // closes, then nothing — the capital is back in your pocket either way.
  const rawOutstanding = (amortizes && asOfSched) ? asOfSched.outstanding : P;
  const principalReturned = Math.max(0, P - rawOutstanding);
  const nextDue = asOfSched ? asOfSched.nextDue : null;

  // A payout bond's DEPOSIT value stays flat at principal — the coupon is paid
  // out as real cash (tracked in the payouts ledger below), not reinvested into
  // the bond itself. A cumulative bond's value grows in place instead. Once
  // sold this freezes too, since elapsedYears no longer advances past asOf.
  // An amortizing bond's base is what's left outstanding, not the original.
  const valueBase = amortizes ? rawOutstanding : P;
  const currentValue = isCumulative ? valueBase + projectedAccrued : valueBase;

  const maturityT = maturity ? Date.parse(maturity) : null;
  const daysToMaturity = maturityT != null ? Math.ceil((maturityT - now) / DAY) : null;
  // Deliberately date-only — does NOT fold in `isSold`. A bond sold after its own
  // maturity date must still read pastMaturity===true (it really is past maturity)
  // while effectiveStatus below reports 'sold', not 'matured'. Any filter written
  // against pastMaturity instead of effectiveStatus would put that bond in BOTH
  // the matured and sold buckets and double-count it — always filter on
  // effectiveStatus.
  const pastMaturity = maturityT != null && now >= maturityT;
  const effectiveStatus = isSold ? 'sold' : (pastMaturity ? 'matured' : 'active');

  // Real interest actually received, from the dated payout ledger (the bond
  // form's "Payouts" tab) — this is the authoritative figure once it has any
  // entries, since real money beats a formula.
  const payouts = Array.isArray(bond.payouts) ? bond.payouts : [];
  const payoutsTotal = payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const lastPayoutDate = payouts.reduce((max, p) => (p.date && p.date > (max || '')) ? p.date : max, null);
  const hasPayouts = payouts.length > 0;

  // A payout row dated on/after the sale is, by definition, part of the exit —
  // NOT extra interest on top of it. Excluding it here is what stops
  // `payoutsTotal + soldGain` from double-counting the principal when a payout
  // row already recorded the proceeds (the doc'd workaround before this feature
  // existed). `<` not `<=`: a coupon credited exactly on the sale date is part
  // of the proceeds. payoutsAfterExit is surfaced in the form as a cleanup nudge.
  const payoutsBeforeExit = (isSold && soldDate)
    ? payouts.reduce((s, p) => s + (p.date && p.date < soldDate ? (Number(p.amount) || 0) : 0), 0)
    : payoutsTotal;
  const payoutsAfterExit = payoutsTotal - payoutsBeforeExit;

  // Interest earned — the headline figure.
  //  - Sold: realised = (all cash in) − (capital out) = payoutsBeforeExit + soldGain.
  //    Basis-independent: a payout bond sold near par has soldGain≈0 and its
  //    coupons carry the return; a cumulative bond (no payouts) has its accrued
  //    interest entirely inside soldGain; a mixed case (cumulative that paid one
  //    partial coupon) still adds up correctly.
  //  - Not sold: once ANY payout is logged, actuals take over completely;
  //    otherwise fall back to the projection (full total once matured, the
  //    pro-rated accrual while active) so a freshly-added bond still shows a
  //    sensible number before any real data exists.
  const interestEarned = isSold
    ? payoutsBeforeExit + soldGain
    : (hasPayouts ? payoutsTotal : (effectiveStatus === 'matured' ? totalInterest : projectedAccrued));

  // Bank-equivalent comparison: what the same principal would have earned at
  // bankRate (simple interest) over the same elapsed period (frozen at the exit
  // date when sold, via elapsedYears above — so this stays an apples-to-apples
  // comparison over the period actually held, not stretched out to today).
  // An amortizing bond takes the figure from the schedule replay, which walks the
  // SAME declining balance the bond's own interest walked. Leaving it on the full
  // principal would credit the bank a return on money the bond had already handed
  // back, making every amortizing bond look worse than it is.
  const bankInterest = bankRate == null
    ? null
    : (amortizes && asOfSched ? asOfSched.bankInterest : simpleValueAt(P, bankRate, elapsedYears) - P);
  const bankEquivalent = bankInterest != null ? P + bankInterest : null;
  const vsBank = bankInterest != null ? interestEarned - bankInterest : null;

  const monthlyIncome = tenureMonths > 0 ? totalInterest / tenureMonths : 0;

  // Human-readable explanation of what basis produced totalInterest/maturityValue
  // — surfaced directly in the UI so "how is this calculated" is never a mystery.
  // Sold bonds get their own prefix since the headline no longer comes from the
  // rate formula at all once soldAmount is set.
  const freqLabel = (f) => (BOND_FREQ.find(([v]) => v === f) || [null, f])[1];
  const rateBasis = maturityOverride != null
    ? `entered maturity amount (₹${Math.round(maturityOverride).toLocaleString('en-IN')})`
    : (amortizes && sched)
      // Say WHICH balance, because the number is materially lower than a naive
      // rate x principal x tenure and that difference needs explaining on sight.
      ? `${rate}% on the reducing balance · principal back ${freqLabel(principalFreq).toLowerCase()}` +
        (sched.installments ? ` in ${sched.installments} installment${sched.installments === 1 ? '' : 's'}` : '')
      : isCumulative
        ? `compounds annually at ${rate}%`
        : `simple interest at ${rate}% p.a.`;
  const basis = isSold
    ? (soldAmount != null
        ? `sold ${soldDate} for ₹${Math.round(soldAmount).toLocaleString('en-IN')} (realised) — projection was ${rateBasis}`
        : `sold ${soldDate} — amount received not entered yet`)
    : rateBasis;

  return {
    principal: P, rate, bankRate, payout: bond.payout, start, maturity,
    tenureYears, tenureMonths,
    maturityValue, totalInterest, maturityOverride, basis,
    currentValue, projectedAccrued,
    daysToMaturity, pastMaturity, effectiveStatus,
    payoutsTotal, hasPayouts, lastPayoutDate, interestEarned,
    isSold, soldDate, soldAmount, soldGain, payoutsBeforeExit, payoutsAfterExit,
    bankEquivalent, bankInterest, vsBank,
    monthlyIncome,
    // Schedule / amortization. `outstandingPrincipal` is the live capital figure the
    // Bonds and Home totals count — it drops to 0 once the bond closes, since the
    // money is back either way, and shrinks across the tenure when it amortizes.
    interestFreq, principalFreq, amortizes,
    scheduleRows: sched ? sched.rows : [],
    perInstallmentPrincipal: sched ? sched.perInstallment : null,
    installments: sched ? sched.installments : 0,
    principalScheduled: sched ? sched.principalScheduled : 0,
    outstandingPrincipal: effectiveStatus === 'active' ? rawOutstanding : 0,
    principalReturned, nextDue,
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
