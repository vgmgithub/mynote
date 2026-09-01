// credit.js — Credit cards: pure calculations. No DOM, no IO.
// One record per CARD; app.js owns the `creditCards` IndexedDB store CRUD.
// Lazy-loaded (import('./credit.js')) so every other surface stays free of it.
//
// Card record shape (creditCards store, IndexedDB v13):
//   { id, name,                                  // 'Swiggy HDFC CC'
//     bank,                                      // 'HDFC' — the issuer, several cards can share one
//     creditLimit,                               // ₹ sanctioned limit (optional — blank means "not tracked")
//     cycleStartDay, cycleEndDay,                 // billing cycle, e.g. 5 -> 4 (day-of-month, 1-31)
//     months: [{ ym:'YYYY-MM', billed, status, paidOn }],  // one row per statement month
//     createdAt, updatedAt }
//
// `billed` is the statement total for that month. `status` is how that
// month's bill was settled: null/'' (not yet paid), 'ontime', or 'late' —
// set via a dropdown per row (app.js buildCcMonthEditor), not a text amount.
// `paidOn` is the ISO date `status` last changed away from unpaid, kept for
// display only ("paid on dd/mm").
//
// Reimbursement is NOT tracked per card any more (it was — see git history —
// but reimbursement represents home spending logged elsewhere, credited back
// as ONE combined figure, which was never really allocable to a specific
// card). It's now a single amount per MONTH, shared across every card billed
// that month, stored in the separate `ccReimbursements` store (db.js) and
// passed into computeCredit() as a plain {ym: amount} map — computeCard()
// below never sees it, since a single card can't sensibly claim a fraction
// of a combined monthly reimbursement on its own.
//
// The source sheet holds this as a wide grid: one ROW per card, one COLUMN per
// month (A:AB = the label column plus 27 months), with Total / Last Month
// Difference / to be PAID / AVERAGE as summary rows underneath. That shape is
// reproduced for DISPLAY in app.js, but stored per-card-with-months instead —
// a column-per-month store would need a schema change every new month.

const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM' → "Aug '26". Short form because the grid puts 27 of these side by
// side and the full month name would force a very wide column.
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym || '');
  if (!m) return ym || '';
  return `${MONS[+m[2] - 1]} '${m[1].slice(2)}`;
}

// Every 'YYYY-MM' from `fromYm` through `toYm` inclusive, ascending. Used for
// the month-timeline strip, which spans a fixed range regardless of which
// months actually have data logged.
export function monthRangeYm(fromYm, toYm) {
  const out = [];
  const fm = /^(\d{4})-(\d{2})/.exec(fromYm || '');
  const tm = /^(\d{4})-(\d{2})/.exec(toYm || '');
  if (!fm || !tm) return out;
  let y = +fm[1], m = +fm[2];
  const endY = +tm[1], endM = +tm[2];
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Normalise whatever the form produced into sorted, deduped month rows. Last
// row wins on a duplicate month, so re-entering a month corrects it instead of
// silently double-counting it in every total. A row's `status` is one of
// null, 'ontime', 'late' — anything else collapses to null (unpaid).
export function normaliseMonths(months) {
  const byYm = new Map();
  (months || []).forEach((r) => {
    const ym = /^(\d{4})-(\d{2})/.test(r.ym || '') ? String(r.ym).slice(0, 7) : null;
    if (!ym) return;
    const status = r.status === 'ontime' || r.status === 'late' ? r.status : null;
    byYm.set(ym, { ym, billed: Number(r.billed) || 0, status, paidOn: status ? (r.paidOn || null) : null });
  });
  return [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

// Per-card derived figures. No reimbursement/outstanding here any more — see
// the file header; that's now a monthly, cross-card figure computed only in
// computeCredit().
export function computeCard(card) {
  const months = normaliseMonths(card && card.months);
  const limit = Number(card && card.creditLimit) || 0;
  let billedTotal = 0, billedMonths = 0;
  months.forEach((r) => {
    billedTotal += r.billed;
    // Average use is over months that actually have a bill.
    if (r.billed > 0) billedMonths++;
  });
  const latest = months.length ? months[months.length - 1] : null;
  const averageUse = billedMonths > 0 ? billedTotal / billedMonths : 0;
  return {
    months,
    monthCount: months.length,
    billedTotal,
    averageUse,
    latestYm: latest ? latest.ym : null,
    latestBilled: latest ? latest.billed : 0,
    latestStatus: latest ? latest.status : null,
    latestPaidOn: latest ? latest.paidOn : null,
    limit,
    // Utilisation is measured on the LATEST statement against the limit — the
    // question it answers is "how close am I to the ceiling right now", so a
    // lifetime total would be meaningless here. Null when no limit is on record
    // rather than 0, so "not tracked" can't be mistaken for "0% used".
    utilisationPct: limit > 0 && latest ? (latest.billed / limit) * 100 : null,
  };
}

// The wide grid, built once for every card at once. `reimbursements` is a
// plain {ym: amount} map (from the ccReimbursements store) — one combined
// figure per month, not per card.
//
// Returns `yms` (every month any card OR reimbursement has data for,
// ascending) plus one row per card and the summary rows the sheet carries
// underneath its grid.
export function computeCredit(cards, reimbursements) {
  const reimb = reimbursements || {};
  const list = (cards || []).map((c) => ({ card: c, c: computeCard(c) }));

  const ymSet = new Set();
  list.forEach(({ c }) => c.months.forEach((r) => ymSet.add(r.ym)));
  Object.keys(reimb).forEach((ym) => ymSet.add(ym));
  const yms = [...ymSet].sort();

  // Per-card lookup so the grid/timeline can ask for an exact cell without
  // re-scanning.
  const rows = list.map(({ card, c }) => {
    const byYm = new Map(c.months.map((r) => [r.ym, r]));
    return { card, c, cell: (ym) => byYm.get(ym) || null };
  });

  const monthly = yms.map((ym) => {
    let billed = 0, cardsWithBill = 0, cardsPaid = 0;
    rows.forEach((r) => {
      const cell = r.cell(ym);
      if (!cell) return;
      billed += cell.billed;
      if (cell.billed > 0) {
        cardsWithBill++;
        if (cell.status) cardsPaid++;
      }
    });
    const reimbursed = Number(reimb[ym]) || 0;
    return {
      ym, billed, reimbursed,
      toBePaid: Math.max(0, billed - reimbursed),
      // Fully settled only when EVERY card billed that month has a status
      // set (ontime or late) — drives the green-bold "To be paid" cell.
      fullyPaid: cardsWithBill > 0 && cardsPaid === cardsWithBill,
    };
  });

  // "vs last month" compares TO BE PAID against the PREVIOUS ENTRY in the
  // series (not the previous calendar month, and not raw billed — a
  // reimbursement changes what's actually still owed, so that's the figure
  // that should move). Computed in ASCENDING order here regardless of how
  // app.js chooses to display the columns (newest-first) — reversing for
  // display must not touch this math, or every diff would compare against
  // the wrong neighbour.
  monthly.forEach((m, i) => { m.diff = i === 0 ? null : m.toBePaid - monthly[i - 1].toBePaid; });

  const grandBilled = monthly.reduce((s, m) => s + m.billed, 0);
  const grandReimbursed = monthly.reduce((s, m) => s + m.reimbursed, 0);
  const billedMonths = monthly.filter((m) => m.billed > 0).length;
  const grandToBePaid = Math.max(0, grandBilled - grandReimbursed);

  return {
    yms,
    rows,
    monthly,
    cardCount: rows.length,
    grandBilled,
    grandReimbursed,
    grandToBePaid,
    // Average across MONTHS (not cards) — "what does this whole wallet
    // actually cost in a typical month" (To Be Paid, not raw Billed).
    averagePerMonth: monthly.length > 0 ? monthly.reduce((s, m) => s + m.toBePaid, 0) / monthly.length : 0,
    latestYm: yms.length ? yms[yms.length - 1] : null,
    latestBilled: monthly.length ? monthly[monthly.length - 1].billed : 0,
    totalLimit: rows.reduce((s, r) => s + r.c.limit, 0),
  };
}
