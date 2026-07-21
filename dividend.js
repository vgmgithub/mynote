// Dividend-tracker logic. Pure — no DOM, no storage, no side effects.
// Lazy-loaded from app.js (renderDividend) so the rest of the app never pays
// for it until the user opens the Dividends surface.
//
// A stock is tracked here only while its `stocks` record has divAvailable===true
// (toggled on the stock's edit form) — app.js keeps one 'dividends' record in
// sync per eligible stock, linked by `stockId`. Toggling it off just hides the
// stock from the surface; its history is kept in case it's turned back on.
//
// One record per tracked stock (store: 'dividends'):
//   { id, stockId, market:'in'|'us', name,
//     months:['Feb','May'],                       // historical payout months
//     years:[...],                                 // per calendar year, shape below
//     createdAt, updatedAt }
// India years: { year:2026, units:25, perUnit:14.5 } — total = units * perUnit
//   (units differ year to year, so both are tracked instead of one static count).
// US years:    { year:2026, amount:0.30 } — total = amount (entered directly; no
//   per-unit math, since the user just reads one dividend figure off their broker).
// Currency = INR when market==='in', else USD. India (₹) and US ($) are never
// summed together — analysis is always per-market.

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

// Total dividend for one calendar year on a record. US years store a direct
// amount (no units/per-unit math); India years store units * perUnit. A US
// year entered before the direct-amount change still has the old units/perUnit
// shape (no `amount` yet) — fall back to that math so old data isn't zeroed
// out; it self-heals to the `amount` shape the next time that year is saved.
export function yearTotal(rec, year) {
  const y = (rec.years || []).find((r) => Number(r.year) === Number(year));
  if (!y) return 0;
  if (rec.market === 'us') {
    if (y.amount != null) return Number(y.amount) || 0;
    return (Number(y.units) || 0) * (Number(y.perUnit) || 0);
  }
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

// What fraction of a record's payout months fall in Apr–Dec vs Jan–Mar — used
// to split a per-calendar-year total across the Apr–Mar financial-year boundary.
// A record with no payout months listed is treated as paying entirely in the
// Apr–Dec portion (so its whole calendar-year total lands in the FY starting
// that April) — there's no month info to place it more precisely.
function monthFractions(rec) {
  const ixs = parseMonths(rec.months).map((m) => _MON_IX[m.toLowerCase()]);
  if (!ixs.length) return { aprDec: 1, janMar: 0 };
  const janMar = ixs.filter((i) => i <= 2).length;   // Jan(0), Feb(1), Mar(2)
  return { aprDec: (ixs.length - janMar) / ixs.length, janMar: janMar / ixs.length };
}

// Total dividend for the financial year starting April `fyStartYear`
// (Apr fyStartYear – Mar fyStartYear+1). Data is stored per CALENDAR year with
// only a payout-months list (no per-month amounts), so each calendar year's
// total is split across the Apr boundary by its payout-month fractions
// (monthFractions): the Apr–Dec share of calendar year `fyStartYear` plus the
// Jan–Mar share of calendar year `fyStartYear+1`. Exact when a stock pays equal
// amounts in each payout month; approximate otherwise.
export function financialYearTotal(records, fyStartYear) {
  return records.reduce((s, rec) => {
    const f = monthFractions(rec);
    return s + yearTotal(rec, fyStartYear) * f.aprDec + yearTotal(rec, fyStartYear + 1) * f.janMar;
  }, 0);
}

// Two-digit financial-year label for the FY starting April `y`, e.g. 2025 → "25-26".
export const fyLabelOf = (y) => `${String(y).slice(-2)}-${String(y + 1).slice(-2)}`;

// Year-wise analysis for a set of records (all the SAME market/currency).
// Returns rows sorted NEWEST first:
//   { year, total, monthly, fyTotal, fyLabel, profit, incrementPct }
// profit  = total − previousYearTotal (immediately preceding year present in data)
// monthly = total / 12
// fyTotal = financial-year total for FY Apr(year)–Mar(year+1) (see financialYearTotal)
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
    return { year, total, monthly: total / 12, fyTotal: financialYearTotal(records, year), fyLabel: fyLabelOf(year), profit, incrementPct };
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

// Seed a dividend record from an existing stock holding, linked by stockId.
// India pre-fills the current year's units (dividend-per-unit left for the
// user); US has no units concept here, so the current year just starts blank
// for a direct dividend amount. Payout months are always left for the user.
export function buildSeedRecord(stock, market, curYear, nowIso) {
  const yearEntry = market === 'us'
    ? { year: curYear, amount: null }
    : { year: curYear, units: Number(stock.units) || 0, perUnit: null };
  return {
    stockId: stock.id,
    market,
    name: (stock.name || '').trim(),
    months: [],
    years: [yearEntry],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
