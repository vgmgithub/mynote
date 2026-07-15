// Dividend-tracker logic. Pure — no DOM, no storage, no side effects.
// Lazy-loaded from app.js (openDividend / renderDividend) so the rest of the
// app never pays for it until the user opens the Dividends surface.
//
// One record per tracked stock (store: 'dividends'):
//   { id, market:'in'|'us', name,
//     months:['Feb','May'],                       // historical payout months
//     years:[{ year:2026, units:25, perUnit:14.5 }, ...],   // per calendar year
//     createdAt, updatedAt }
// Per-year total = units * perUnit. Currency = INR when market==='in', else USD.
// India (₹) and US ($) are never summed together — analysis is always per-market.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _MON_IX = MONTHS.reduce((m, name, i) => { m[name.toLowerCase()] = i; return m; }, {});

export const curOfMarket = (market) => (market === 'us' ? 'USD' : 'INR');

// Currency with 2 decimals — dividends are small per-unit amounts (₹0.60, $0.01)
// and US totals can be fractional, so the app-wide whole-number fmtCur would
// wrongly show "$0". Matches the 2-decimal figures in the user's sheet.
const _dfmt = {};
export function fmtDiv(n, cur) {
  const v = Number(n) || 0;
  let f = _dfmt[cur];
  if (!f) {
    try {
      f = new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    } catch (e) {
      f = { format: (x) => (cur === 'INR' ? '₹' : '$') + (Number(x) || 0).toFixed(2) };
    }
    _dfmt[cur] = f;
  }
  return f.format(v);
}

// "Feb,May, jun" / "Feb May" / "2" → ['Feb','May','Jun']. Tolerant of separators,
// case, and full month names; dedupes and returns in calendar order.
export function parseMonths(input) {
  if (Array.isArray(input)) input = input.join(',');
  const seen = new Set();
  String(input || '')
    .split(/[,;/|]+|\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((tok) => {
      const key = tok.slice(0, 3).toLowerCase();
      if (_MON_IX[key] != null) seen.add(_MON_IX[key]);
    });
  return [...seen].sort((a, b) => a - b).map((i) => MONTHS[i]);
}

export const monthsToStr = (arr) => (arr || []).join(', ');

// Total dividend for one calendar year on a record: units * perUnit.
export function yearTotal(rec, year) {
  const y = (rec.years || []).find((r) => Number(r.year) === Number(year));
  if (!y) return 0;
  return (Number(y.units) || 0) * (Number(y.perUnit) || 0);
}

// Every calendar year that appears on a record, newest first.
export function yearsOf(rec) {
  return (rec.years || []).map((r) => Number(r.year)).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
}

// Most recent year with any dividend, and that year's total — used as the
// "expected ≈" hint on the calendar tab and the current-value on cards.
export function latestYearTotal(rec) {
  const ys = yearsOf(rec);
  for (const y of ys) { const t = yearTotal(rec, y); if (t) return { year: y, total: t }; }
  return ys.length ? { year: ys[0], total: 0 } : { year: null, total: 0 };
}

// Year-wise analysis for a set of records (all the SAME market/currency).
// Returns rows sorted NEWEST first:
//   { year, total, monthly, profit, incrementPct }
// profit  = total − previousYearTotal (immediately preceding year present in data)
// monthly = total / 12
// incrementPct = prevTotal>0 ? profit/prevTotal*100 : null (null = no base to compare)
export function annualAnalysis(records) {
  const years = new Set();
  records.forEach((rec) => yearsOf(rec).forEach((y) => years.add(y)));
  const asc = [...years].sort((a, b) => a - b);
  const totalFor = (year) => records.reduce((s, rec) => s + yearTotal(rec, year), 0);
  const rows = asc.map((year, i) => {
    const total = totalFor(year);
    const prev = i > 0 ? totalFor(asc[i - 1]) : null;
    const profit = prev == null ? null : total - prev;
    const incrementPct = prev != null && prev > 0 ? (profit / prev) * 100 : null;
    return { year, total, monthly: total / 12, profit, incrementPct };
  });
  return rows.reverse(); // newest first
}

// Group records by payout month for the calendar/prediction tab.
// Returns { Jan:[{ rec, expected }], ... } — expected = record's latest-year total.
// Each month's list is sorted by expected desc.
export function byMonth(records) {
  const out = {};
  MONTHS.forEach((m) => { out[m] = []; });
  records.forEach((rec) => {
    const exp = latestYearTotal(rec).total;
    parseMonths(rec.months).forEach((m) => { out[m].push({ rec, expected: exp }); });
  });
  MONTHS.forEach((m) => out[m].sort((a, b) => b.expected - a.expected));
  return out;
}

// Seed a dividend record from an existing stock holding: name + current-year
// units pre-filled, dividend-per-unit and payout months left for the user.
export function buildSeedRecord(stock, market, curYear, nowIso) {
  return {
    market,
    name: (stock.name || '').trim(),
    months: [],
    years: [{ year: curYear, units: Number(stock.units) || 0, perUnit: null }],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
