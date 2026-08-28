// credit.js — Credit cards: pure calculations. No DOM, no IO.
// One record per CARD; app.js owns the `creditCards` IndexedDB store CRUD.
// Lazy-loaded (import('./credit.js')) so every other surface stays free of it.
//
// Card record shape (creditCards store, IndexedDB v11):
//   { id, name,                                  // 'Swiggy HDFC CC'
//     bank,                                      // 'HDFC' — the issuer, several cards can share one
//     creditLimit,                               // ₹ sanctioned limit (optional — blank means "not tracked")
//     cycleStartDay, cycleEndDay,                 // billing cycle, e.g. 5 -> 4 (day-of-month, 1-31)
//     months: [{ ym:'YYYY-MM', billed, reimbursed, paidOn }],  // one row per statement month
//     createdAt, updatedAt }
//
// The source sheet holds this as a wide grid: one ROW per card, one COLUMN per
// month (A:AB = the label column plus 27 months), with Total / Last Month
// Difference / to be PAID / AVERAGE as summary rows underneath. That shape is
// reproduced for DISPLAY in app.js, but stored per-card-with-months instead —
// a column-per-month store would need a schema change every new month.
//
// `billed` vs `reimbursed` are tracked separately on purpose, and neither is
// "money paid to the bank":
//   billed      — the statement total for that month.
//   reimbursed  — money credited back for that month's spend (originally home
//                 spending logged elsewhere, folded in here as a running total
//                 until the Expense tab tracks it directly). Reduces what's
//                 actually owed out of pocket.
//   toBePaid    — billed - reimbursed. What's still due after reimbursement.
//   paidOn      — set when the user marks that month's due amount as actually
//                 paid to the card issuer (the "To Pay" button on the card
//                 list) — a separate action from logging reimbursed, and not
//                 a rupee amount at all, just a settled/unsettled flag+date.
//
// This field was named `paid` before reimbursed/paidOn existed and held what
// left the bank account; normaliseMonths reads it as a one-time fallback into
// `reimbursed` so no existing data is lost, but nothing is written back to it.

const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM' → "Aug '26". Short form because the grid puts 27 of these side by
// side and the full month name would force a very wide column.
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym || '');
  if (!m) return ym || '';
  return `${MONS[+m[2] - 1]} '${m[1].slice(2)}`;
}

// Normalise whatever the form produced into sorted, deduped month rows. Last
// row wins on a duplicate month, so re-entering a month corrects it instead of
// silently double-counting it in every total. `paidOn` passes through as-is
// (the month editor UI doesn't expose it — see buildCcMonthEditor in app.js)
// so re-saving a card's Details never clobbers an already-marked-paid month.
export function normaliseMonths(months) {
  const byYm = new Map();
  (months || []).forEach((r) => {
    const ym = /^(\d{4})-(\d{2})/.test(r.ym || '') ? String(r.ym).slice(0, 7) : null;
    if (!ym) return;
    const reimbursed = r.reimbursed != null ? Number(r.reimbursed) || 0 : Number(r.paid) || 0;
    byYm.set(ym, { ym, billed: Number(r.billed) || 0, reimbursed, paidOn: r.paidOn || null });
  });
  return [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

// Per-card derived figures.
export function computeCard(card) {
  const months = normaliseMonths(card && card.months);
  const limit = Number(card && card.creditLimit) || 0;
  let billedTotal = 0, reimbursedTotal = 0, billedMonths = 0;
  months.forEach((r) => {
    billedTotal += r.billed;
    reimbursedTotal += r.reimbursed;
    // Average use is over months that actually have a bill — a month logged
    // only to record a reimbursement shouldn't drag the average toward zero.
    if (r.billed > 0) billedMonths++;
  });
  const latest = months.length ? months[months.length - 1] : null;
  // Average use = the sheet's own per-card "average use" column.
  const averageUse = billedMonths > 0 ? billedTotal / billedMonths : 0;
  return {
    months,
    monthCount: months.length,
    billedTotal,
    reimbursedTotal,
    outstanding: Math.max(0, billedTotal - reimbursedTotal),
    averageUse,
    latestYm: latest ? latest.ym : null,
    latestBilled: latest ? latest.billed : 0,
    // What THIS card's latest logged month still owes, and whether that
    // month has already been marked paid — drives the "To Pay" button on
    // the card list (app.js). A new month row starts with paidOn unset, so
    // logging next month's statement is what brings the button back.
    latestToBePaid: latest ? Math.max(0, latest.billed - latest.reimbursed) : 0,
    latestPaidOn: latest ? (latest.paidOn || null) : null,
    limit,
    // Utilisation is measured on the LATEST statement against the limit — the
    // question it answers is "how close am I to the ceiling right now", so a
    // lifetime total would be meaningless here. Null when no limit is on record
    // rather than 0, so "not tracked" can't be mistaken for "0% used".
    utilisationPct: limit > 0 && latest ? (latest.billed / limit) * 100 : null,
  };
}

// The wide grid, built once for every card at once.
//
// Returns `yms` (every month any card has data for, ascending) plus one row per
// card and the summary rows the sheet carries underneath its grid.
export function computeCredit(cards) {
  const list = (cards || []).map((c) => ({ card: c, c: computeCard(c) }));

  const ymSet = new Set();
  list.forEach(({ c }) => c.months.forEach((r) => ymSet.add(r.ym)));
  const yms = [...ymSet].sort();

  // Per-card lookup so the grid can ask for an exact cell without re-scanning.
  const rows = list.map(({ card, c }) => {
    const byYm = new Map(c.months.map((r) => [r.ym, r]));
    return { card, c, cell: (ym) => byYm.get(ym) || null };
  });

  const monthly = yms.map((ym) => {
    let billed = 0, reimbursed = 0, cardsWithBill = 0, cardsPaid = 0;
    rows.forEach((r) => {
      const cell = r.cell(ym);
      if (!cell) return;
      billed += cell.billed;
      reimbursed += cell.reimbursed;
      if (cell.billed > 0) {
        cardsWithBill++;
        if (cell.paidOn) cardsPaid++;
      }
    });
    return {
      ym, billed, reimbursed,
      toBePaid: Math.max(0, billed - reimbursed),
      // Fully settled only when EVERY card billed that month has been marked
      // paid — drives the green-bold "To be paid" cell in the wide grid.
      fullyPaid: cardsWithBill > 0 && cardsPaid === cardsWithBill,
    };
  });

  // "vs last month" compares TO BE PAID against the PREVIOUS ENTRY in the
  // series (not the previous calendar month, and not raw billed — reimbursed
  // amounts change what's actually still owed, so that's the figure that
  // should move). A gap month with no data logged anywhere would otherwise
  // show the full total as a jump, which reads as a spending spike that
  // never happened.
  monthly.forEach((m, i) => { m.diff = i === 0 ? null : m.toBePaid - monthly[i - 1].toBePaid; });

  const grandBilled = monthly.reduce((s, m) => s + m.billed, 0);
  const grandReimbursed = monthly.reduce((s, m) => s + m.reimbursed, 0);
  const billedMonths = monthly.filter((m) => m.billed > 0).length;

  return {
    yms,
    rows,
    monthly,
    cardCount: rows.length,
    grandBilled,
    grandReimbursed,
    grandToBePaid: Math.max(0, grandBilled - grandReimbursed),
    // Average across MONTHS (not cards) — "what does this whole wallet cost in
    // a typical month".
    averagePerMonth: billedMonths > 0 ? grandBilled / billedMonths : 0,
    latestYm: yms.length ? yms[yms.length - 1] : null,
    latestBilled: monthly.length ? monthly[monthly.length - 1].billed : 0,
    totalLimit: rows.reduce((s, r) => s + r.c.limit, 0),
  };
}
