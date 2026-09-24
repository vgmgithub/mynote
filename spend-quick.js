// Pure helpers for the two quick spend forms, household (Kitty) and Personal: what to offer first, worked out from
// what has already been logged. No DOM, no storage, so it can be unit tested. The pieces on screen are in
// spend-kit.js. Nothing here writes anything: the rows are read as they are and every record keeps its shape.
// Ported from the sibling mynote-app repo (spend-quick.js, commit 585782c).

const DAY = 864e5;
const dayNum = (iso) => {
  const t = Date.parse(String(iso || '').slice(0, 10) + 'T00:00:00Z');
  return isNaN(t) ? NaN : Math.round(t / DAY);
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The date n days from iso (YYYY-MM-DD), for the Yesterday chip. Counted on the calendar, so it never drifts an
// hour across a daylight-saving change.
export function dayShift(iso, n) {
  const d = dayNum(iso);
  if (isNaN(d)) return iso;
  return new Date((d + n) * DAY).toISOString().slice(0, 10);
}

// Spends (not refunds) dated in the `days` days up to and including today.
function recentSpends(rows, today, days) {
  const t = dayNum(today);
  return (rows || []).filter((r) => {
    if (!r || !(Number(r.amount) > 0)) return false;
    const d = dayNum(r.date);
    return !isNaN(d) && d <= t && t - d < days;
  });
}
// Most used first; a tie goes to the one used last.
const byUse = (a, b) => b[1].n - a[1].n || (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : 0);
const tally = (map, key, r) => {
  const s = map.get(key) || { n: 0, last: '' };
  s.n += 1;
  const at = String(r.date || '') + '|' + String(r.createdAt || '');
  if (at > s.last) s.last = at;
  map.set(key, s);
};

// The categories used most in recent spends, for the "Recent" row. Only ones still in the list (`valid`), never
// the ones in `exclude` (Refund), at most `limit`.
export function recentCategories(rows, { valid = null, exclude = [], today, days = 90, limit = 6 } = {}) {
  const ok = valid ? new Set(valid) : null;
  const no = new Set(exclude);
  const stat = new Map();
  recentSpends(rows, today, days).forEach((r) => {
    const c = r.category;
    if (!c || no.has(c) || (ok && !ok.has(c))) return;
    tally(stat, c, r);
  });
  return [...stat.entries()].sort(byUse).slice(0, limit).map(([c]) => c);
}

// The amounts most often paid for this category lately, smallest first, for one-tap chips under the amount.
export function usualAmounts(rows, category, { today, days = 90, limit = 3 } = {}) {
  if (!category) return [];
  const stat = new Map();
  recentSpends(rows, today, days).forEach((r) => {
    if (r.category !== category) return;
    tally(stat, round2(r.amount), r);
  });
  return [...stat.entries()].sort(byUse).slice(0, limit).map(([a]) => a).sort((a, b) => a - b);
}

// How the last spend was paid, to start the next one the same way. The method is dropped if the form no longer
// offers it, and the card if it has since been deleted. null when there is nothing to go on.
export function lastChoice(rows, { methods = null, cardIds = null } = {}) {
  let best = null;
  (rows || []).forEach((r) => {
    if (!r || !r.method || !(Number(r.amount) > 0)) return;
    const at = String(r.createdAt || r.updatedAt || r.date || '');
    if (!best || at > best.at) best = { at, r };
  });
  if (!best) return null;
  const method = best.r.method;
  if (methods && methods.indexOf(method) < 0) return null;
  const cards = cardIds ? new Set(cardIds) : null;
  const cardId = method === 'Card' && best.r.cardId != null && (!cards || cards.has(best.r.cardId)) ? best.r.cardId : null;
  return { method, cardId };
}

// What is left of an allowance once this entry is in: a spend takes from it, a refund gives back.
export function leftAfter(left, typed, refund = false) {
  const a = Math.abs(Number(typed) || 0);
  return round2((Number(left) || 0) + (refund ? a : -a));
}
