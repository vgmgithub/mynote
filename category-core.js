// Category Spend, the arithmetic: month -> category totals, and one month read against the ones before it. Pure (no
// DOM, no storage), so the numbers are tested on their own.
// Ported from the sibling mynote-app repo (category-core.js).

const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// rows    spend records ({ category, amount, ... })
// monthOf (row) -> 'YYYY-MM' the row counts in, or '' to leave it out
// refundCat the category that marks money coming back (a negative amount): kept apart as "back", never a category
// Returns Map<ym, { spent, back, byCat: Map<name, amount> }>. Spent is gross money out; a refund in any other
// category (a negative amount there) nets off that category, the way every other tab counts it.
export function categoryMonths(rows, monthOf, refundCat = 'Refund') {
  const out = new Map();
  for (const r of rows || []) {
    const ym = monthOf(r);
    if (!/^\d{4}-\d{2}$/.test(ym || '')) continue;
    const amt = Number(r && r.amount) || 0;
    if (!amt) continue;
    let m = out.get(ym);
    if (!m) { m = { spent: 0, back: 0, byCat: new Map() }; out.set(ym, m); }
    const name = (r.category || 'Misc');
    if (name === refundCat) { m.back = r2(m.back + Math.abs(amt)); continue; }
    m.byCat.set(name, r2((m.byCat.get(name) || 0) + amt));
  }
  out.forEach((m) => { m.spent = r2([...m.byCat.values()].reduce((a, v) => a + Math.max(0, v), 0)); });
  return out;
}

// One month, read against the months before it.
//   months  the map from categoryMonths
//   ym      the month on screen
//   groupOf (name) -> group label, optional (the category list's own groups: Fixed, Food, ...)
//   lookback how many earlier months (that hold spending) make "usual" - a median, so one heavy month cannot
//            become what a category usually costs (the rule Review uses)
// Categories spent in the lookback but not this month are listed at 0, so a habit that stopped is visible.
export function categoryView(months, ym, { groupOf = null, lookback = 6 } = {}) {
  const cur = months.get(ym) || { spent: 0, back: 0, byCat: new Map() };
  const earlier = [...months.keys()].filter((k) => k < ym && months.get(k).spent > 0).sort().slice(-lookback);
  const prevYm = earlier.length ? earlier[earlier.length - 1] : null;
  const names = new Set([...cur.byCat.keys()]);
  earlier.forEach((k) => months.get(k).byCat.forEach((v, n) => { if (v > 0) names.add(n); }));
  const amountIn = (k, n) => (k && months.get(k) ? months.get(k).byCat.get(n) || 0 : 0);
  const history = (n) => [...earlier, ym].map((k) => ({ ym: k, amount: Math.max(0, amountIn(k, n)), current: k === ym }));
  const spent = cur.spent;
  const cats = [...names].map((name) => {
    const amount = r2(cur.byCat.get(name) || 0);
    const usual = earlier.length ? r2(median(earlier.map((k) => amountIn(k, name)))) : null;
    const prev = prevYm ? r2(amountIn(prevYm, name)) : null;
    return {
      name, group: groupOf ? groupOf(name) || '' : '',
      amount, share: spent > 0 ? Math.max(0, amount) / spent * 100 : 0,
      prev, usual, vsUsual: usual == null ? null : r2(amount - usual),
      history: history(name),
    };
  }).sort((a, b) => b.amount - a.amount || (b.usual || 0) - (a.usual || 0) || a.name.localeCompare(b.name));
  const groups = new Map();
  if (groupOf) cats.forEach((c) => { if (c.amount > 0) groups.set(c.group || 'Other', r2((groups.get(c.group || 'Other') || 0) + c.amount)); });
  // What moved most against usual, both ways - only once there is a usual to move against.
  const moved = cats.filter((c) => c.vsUsual != null && Math.abs(c.vsUsual) >= 1);
  const up = moved.filter((c) => c.vsUsual > 0).sort((a, b) => b.vsUsual - a.vsUsual).slice(0, 3);
  const down = moved.filter((c) => c.vsUsual < 0).sort((a, b) => a.vsUsual - b.vsUsual).slice(0, 3);
  const usualTotal = earlier.length ? r2(median(earlier.map((k) => months.get(k).spent))) : null;
  return {
    ym, spent, back: cur.back, prevYm, prevSpent: prevYm ? months.get(prevYm).spent : null,
    usualTotal, historyMonths: earlier.length,
    cats, groups: [...groups].map(([group, amount]) => ({ group, amount, share: spent > 0 ? amount / spent * 100 : 0 })).sort((a, b) => b.amount - a.amount),
    up, down,
  };
}
