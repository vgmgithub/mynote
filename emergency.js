// emergency.js — Emergency Fund: pure calculations. No DOM, no IO.
// Lazy-loaded (import('./emergency.js')) so every other surface stays free of it.
//
// The fund is a family lending pot with its own rulebook, not a passive savings
// pot. Three record kinds share one `emergency` store, discriminated by `kind`
// (indexed) so each logical table is one DB.byIndex call:
//
//   { id, kind:'contribution', date:'YYYY-MM-DD',
//     mine, spouse,                                    // ₹ each side paid that month — two equal contributors, stepped up over time as income rises
//     note, createdAt, updatedAt }
//
//   { id, kind:'target', name, amount,                 // ₹ this rung of the ladder
//     ladder:'add'|'absorb',                           // 'absorb' SUPERSEDES the rung above instead of stacking on it — e.g. a joint emergency target that IS 2× the single-person one below it, so adding them would double-count a goal that was only ever one goal. See ladderTargets()
//     order,                                            // rung position, low → high
//     expectedClosure, note, createdAt, updatedAt }
//
//   { id, kind:'loan', loanKind:'self'|'emergency'|'gift',
//     who, purpose, amount,
//     takenDate, expectedDate, closedDate,             // closedDate set = settled; else derived from repayments covering the amount
//     rate,                                             // % this loan was priced at - stamped from the fund's rate setting when it is saved, so changing that later never re-prices a loan already agreed
//     interestOverride,                                 // optional — replaces the computed figure outright when reality differed from the rule
//     interestPaid,                                     // ₹ interest actually collected
//     repayments:[{ date:'YYYY-MM-DD', amount }],       // instalment ledger — an emergency draw can be repaid across several months
//     note, createdAt, updatedAt }
//
// WHERE THE MONEY IS PARKED is deliberately NOT stored here. The fund's
// investments are ordinary `funds`/`bonds`/`fds` records carrying an
// `emergencyFund: true` flag, so they keep getting live NAV from the existing
// AMFI fetch with no duplicated code and no extra network calls. app.js reads
// them and passes the totals in. Those records are excluded from their own
// surface's totals and from Home's Total Invested — the same treatment SGBs
// already get in the stocks store.

// Loan kinds and their labels. The three differ ONLY in how long they stay
// interest-free (see EF_FREE_MONTHS) — everything else about them is identical,
// which is why an "emergency spend" isn't a separate concept from a loan.
export const EF_KINDS = [
  ['self', 'Self loan'],
  ['emergency', 'Emergency draw'],
  ['gift', 'Gift to family'],
];
// The fund's own lending rate. This is the BUILT-IN default: the live figure is
// a setting (meta/efLoanRate, editable on the Loans tab), which app.js reads and
// passes in as `defaultRate`. A loan carrying its own `rate` was priced at that
// figure and keeps it, whatever the setting says now.
export const EF_RATE = 2;         // %
export const EF_ROUND_TO = 100;   // interest rounds UP to the next ₹100 (the fund's convention)
// Rule 7: an emergency draw repaid inside 3 months costs nothing. Rule 9: a gift
// to family returned inside 5 months costs nothing. A self loan is priced from
// day one (rule 4).
export const EF_FREE_MONTHS = { emergency: 3, gift: 5, self: 0 };
// Rule 9: up to a quarter of the fund can be lent out interest-free, and rule
// 10 allows one such allocation per party at a time. Named rather than written
// as "25%" in three places, so the cap and the figures derived from it can
// never drift apart.
export const EF_HELP_SHARE = 25;  // % of the fund, per party
export const EF_LADDER = [
  ['add', 'Adds on top of the previous target'],
  ['absorb', 'Replaces the previous target'],
];

// Whole calendar months between two YYYY-MM-DD dates, day-of-month ignored. The
// fund's rules are all stated in months ("repay within 3 months") and the source
// records dates as Mon-YY, so counting days would invent precision that was
// never there — and would put a loan taken on the 28th into a different band
// from one taken on the 2nd of the same month.
export function monthsBetween(aISO, bISO) {
  const a = /^(\d{4})-(\d{2})/.exec(aISO || '');
  const b = /^(\d{4})-(\d{2})/.exec(bISO || '');
  if (!a || !b) return 0;
  return Math.max(0, (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]));
}

// Add `months` to a YYYY-MM-DD date → YYYY-MM-DD (UTC math, no tz drift).
// Duplicated from bonds.js/fd.js rather than imported — pure-logic modules in
// this app deliberately don't cross-import.
export function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + Number(months || 0), 1));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// The fund's duration multiplier: 1× up to 3 months, 2× for 4–6, 3× for 7–9,
// 4× for 10–12. That whole table is just "one step per quarter", so express it
// as arithmetic — it reproduces every stated band AND keeps working past 12
// months instead of falling off the end of a lookup table.
export function multiplierFor(months) {
  return Math.max(1, Math.ceil((Number(months) || 0) / 3));
}

// Interest on one loan, priced through `throughISO`.
// Formula: CEILING(amount × rate% × multiplier, ₹100).
export function loanInterest(loan, throughISO, defaultRate) {
  // A typed figure wins outright: the rule is the default, not a straitjacket.
  if (loan.interestOverride != null && loan.interestOverride !== '') return Number(loan.interestOverride) || 0;
  const amt = Number(loan.amount) || 0;
  if (!(amt > 0) || !loan.takenDate || !throughISO) return 0;
  const months = monthsBetween(loan.takenDate, throughISO);
  const free = EF_FREE_MONTHS[loan.loanKind] || 0;
  // Only a kind that HAS a free window can be inside it. A self loan's window is
  // zero months, and `months` is also 0 in the month it was taken — so testing
  // `months <= free` alone made it free for its first month, which is the
  // opposite of rule 4 (a self loan is priced from day one).
  if (free > 0 && months <= free) return 0;
  const rate = Number(loan.rate != null && loan.rate !== ''
    ? loan.rate
    : (defaultRate != null && defaultRate !== '' ? defaultRate : EF_RATE)) || 0;
  const raw = amt * (rate / 100) * multiplierFor(months);
  return Math.ceil(raw / EF_ROUND_TO) * EF_ROUND_TO;
}

// Per-loan derived figures.
export function computeLoan(loan, nowMs, defaultRate) {
  const todayISO = new Date(nowMs || Date.now()).toISOString().slice(0, 10);
  const amt = Number(loan.amount) || 0;
  const reps = Array.isArray(loan.repayments) ? loan.repayments : [];
  const repaid = reps.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const outstanding = Math.max(0, amt - repaid);
  const lastRepay = reps.reduce((max, r) => (r.date && r.date > (max || '')) ? r.date : max, null);
  // Settled either explicitly, or because the instalments have covered it. The
  // 0.5 slack keeps a rounding remainder from leaving a loan permanently "open".
  const isClosed = !!loan.closedDate || (amt > 0 && repaid >= amt - 0.5);
  const closureDate = loan.closedDate || (isClosed ? (lastRepay || todayISO) : null);

  // The clock STOPS at closure — otherwise a settled loan would keep climbing
  // multiplier bands forever and its interest would drift after the fact.
  const throughNow = isClosed ? closureDate : todayISO;
  const monthsElapsed = monthsBetween(loan.takenDate, throughNow);
  const freeMonths = EF_FREE_MONTHS[loan.loanKind] || 0;

  // Two figures, because they answer different questions on an open loan:
  // accrued = what it has cost so far; projected = what it will cost if repaid
  // on the expected date. The sheet's own open-loan numbers are the projection.
  const interestAccrued = loanInterest(loan, throughNow, defaultRate);
  const projectThrough = (!isClosed && loan.expectedDate && loan.expectedDate > throughNow) ? loan.expectedDate : throughNow;
  const interestProjected = loanInterest(loan, projectThrough, defaultRate);
  // The figure to actually charge: settled loans are final, open ones are quoted
  // to their expected return date.
  const interest = isClosed ? interestAccrued : interestProjected;
  const interestPaid = Number(loan.interestPaid) || 0;

  return {
    amount: amt, repaid, outstanding, isClosed, closureDate, lastRepay,
    monthsElapsed, multiplier: multiplierFor(monthsElapsed),
    freeMonths,
    // The rate this loan is actually priced at, so callers can show the
    // arithmetic without repeating the fallback chain.
    rate: Number(loan.rate != null && loan.rate !== ''
      ? loan.rate
      : (defaultRate != null && defaultRate !== '' ? defaultRate : EF_RATE)) || 0,
    // Still inside its grace window — and, for an open loan, how long is left.
    // A kind with no free window (a self loan) is never "free": it has nothing
    // to be inside, which is why the zero case is excluded rather than left to
    // fall out of the comparison.
    isFree: freeMonths > 0 && monthsElapsed <= freeMonths,
    freeMonthsLeft: (isClosed || freeMonths <= 0) ? 0 : Math.max(0, freeMonths - monthsElapsed),
    interestAccrued, interestProjected, interest, interestPaid,
    interestDue: Math.max(0, interest - interestPaid),
    isOverridden: loan.interestOverride != null && loan.interestOverride !== '',
    // Past its promised return date and still owing.
    overdue: !isClosed && !!loan.expectedDate && todayISO > loan.expectedDate,
    instalments: reps.length,
  };
}

// Walk the target ladder, resolving 'absorb' rungs. `absorb` means this rung
// replaces the running total rather than adding to it: a joint target that is
// already 2× the single-person rung below it should sit at its own amount, not
// at the sum of the two.
export function ladderTargets(targets, corpus) {
  const rows = (targets || []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  let cum = 0;
  return rows.map((t) => {
    const amount = Number(t.amount) || 0;
    cum = t.ladder === 'absorb' ? amount : cum + amount;
    const funded = Math.min(Math.max(0, corpus), cum);
    return Object.assign({}, t, {
      amount,
      cumulative: cum,
      funded,
      // Clamped: an exceeded target shows 0 left, never a negative "remaining".
      remaining: Math.max(0, cum - corpus),
      surplus: Math.max(0, corpus - cum),
      pct: cum > 0 ? Math.min(100, (corpus / cum) * 100) : 0,
      isMet: cum > 0 && corpus >= cum,
    });
  });
}

// Projects the fund's contributed total forward, assuming the last logged
// monthly contribution keeps repeating unchanged. Only WHOLE months between
// the last contribution and the target count — matching how contributions are
// actually logged, one row per month — so a target date in the same month as
// the last contribution adds nothing yet.
export function projectContributions(contributedTotal, lastContributionISO, monthlyAmount, throughISO) {
  const amt = Number(monthlyAmount) || 0;
  if (!lastContributionISO || !throughISO) return contributedTotal;
  const months = Math.max(0, monthsBetween(lastContributionISO, throughISO));
  return contributedTotal + months * amt;
}

// Whole-fund figures. `parkedInvested`/`parkedValue` are passed IN by app.js
// from the linked funds/bonds/fds records (see the header note) — this module
// never reads a store.
export function computeEmergencyFund(data, nowMs) {
  const now = nowMs || Date.now();
  const contributions = (data && data.contributions) || [];
  const rawLoans = (data && data.loans) || [];
  const targets = (data && data.targets) || [];
  const parkedInvested = Number(data && data.parkedInvested) || 0;
  const parkedValue = Number(data && data.parkedValue) || 0;
  const parkedCount = Number(data && data.parkedCount) || 0;
  // Gains from parked investments that have already CLOSED (a matured bond, a
  // redeemed fund). Their principal has left `parkedInvested`, so the derived
  // cash below rises by it automatically; this adds the gain on top, which is
  // real money the fund received and would otherwise vanish from the corpus.
  const parkedRealised = Number(data && data.parkedRealised) || 0;
  // The fund's current lending rate, passed in from the stored setting. Only
  // used for loans that carry no rate of their own.
  const rate = Number(data && data.rate) > 0 ? Number(data.rate) : EF_RATE;

  let contributedTotal = 0, mineTotal = 0, spouseTotal = 0, lastContribution = null;
  for (const c of contributions) {
    const mine = Number(c.mine) || 0, spouse = Number(c.spouse) || 0;
    mineTotal += mine; spouseTotal += spouse; contributedTotal += mine + spouse;
    if (c.date && c.date > (lastContribution || '')) lastContribution = c.date;
  }

  const loans = rawLoans.map((l) => Object.assign({ rec: l }, computeLoan(l, now, rate)));
  let lentOut = 0, loanInterestRealised = 0, loanInterestPending = 0;
  let openCount = 0, overdueCount = 0, freeExpiringCount = 0;
  for (const l of loans) {
    if (l.isClosed) {
      // Realised = what a settled loan actually cost the borrower, i.e. income
      // the fund has already banked.
      loanInterestRealised += l.interest;
    } else {
      openCount++;
      lentOut += l.outstanding;
      loanInterestPending += l.interest;
      if (l.overdue) overdueCount++;
      // Inside its grace window but with one month or less of it left — worth a
      // nudge BEFORE interest starts, not after.
      if (l.isFree && l.freeMonthsLeft <= 1) freeExpiringCount++;
    }
  }

  // Everything the fund has ever taken in: contributions plus both kinds of
  // interest it has actually realised (parkedRealised stays 0 until a parked
  // investment closes).
  const corpusIn = contributedTotal + loanInterestRealised + parkedRealised;
  // Unrealised gain/loss on the parked investments, live from their own records.
  const marketInterest = parkedValue - parkedInvested;
  // What's left uncommitted. Derived, so it can't drift out of step with the
  // parts — but it CAN go negative if more has been parked and lent than was
  // ever collected, which means a contribution is missing from the log.
  const cashInHand = corpusIn - parkedInvested - lentOut;
  const fundValue = parkedValue + cashInHand + lentOut;

  const ladder = ladderTargets(targets, corpusIn);
  const nextTarget = ladder.find((t) => !t.isMet) || null;

  return {
    contributedTotal, mineTotal, spouseTotal,
    contributionCount: contributions.length, lastContribution,
    // Passed straight back so the Log tab can list them without a second read.
    contributionRows: contributions,
    loans, loanCount: loans.length, openCount, overdueCount, freeExpiringCount,
    // Handed back so the surface can show and edit it without a second read.
    rate,
    lentOut, loanInterestRealised, loanInterestPending,
    parkedInvested, parkedValue, parkedCount, marketInterest, parkedRealised,
    corpusIn, cashInHand, fundValue,
    // Both interest streams are tracked separately (lending vs market) and
    // summed here. Realised gains from closed investments count once — they're
    // already inside corpusIn as cash.
    totalInterest: loanInterestRealised + marketInterest + parkedRealised,
    targets: ladder, nextTarget,
    // Surfaced rather than silently rendered as a negative number in a column
    // headed "available".
    shortfall: cashInHand < 0 ? -cashInHand : 0,
    reconciles: cashInHand >= 0,
  };
}
