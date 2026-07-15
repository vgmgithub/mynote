// Pure domain logic: config, formatting, date + financial calculations.
// No DOM, no storage, no side effects — safe to unit-test and reuse in any wrapper.

export const PORTFOLIOS = [
  { id: 'me-in', label: 'Me · India', cur: 'INR' },
  { id: 'wife-in', label: 'Wife · India', cur: 'INR' },
  { id: 'me-us', label: 'Me · US', cur: 'USD' },
];

export const CATEGORIES = [
  'Financial Services', 'Financial Services & Investment', 'Energy', 'Railways',
  'Defense', 'Automobile', 'Technology', 'Healthcare', 'Infrastructure',
  'Consumer Goods', 'Metals & Mining', 'ETFs & Commodities', 'Electronics',
  'Investment', 'Telecommunication', 'Index', 'Entertainment', 'BONDS',
  'E-Commerce', 'Quick Services', 'Agriculture', 'Tourism', 'Banking',
];

export const CONVICTIONS = [
  { v: '', label: '—', icon: '' },
  { v: 'up', label: 'Conviction 👍', icon: '👍' },
  { v: 'watch', label: 'Watch ✋', icon: '✋' },
  { v: 'down', label: 'Avoid 👎', icon: '👎' },
];
const CONV_ICON = CONVICTIONS.reduce((m, c) => { m[c.v] = c.icon; return m; }, {});
export const convIcon = (v) => CONV_ICON[v] || '';

const CUR_BY_PORTFOLIO = PORTFOLIOS.reduce((m, p) => { m[p.id] = p.cur; return m; }, {});
export const curOf = (pid) => CUR_BY_PORTFOLIO[pid] || 'INR';

// Intl.NumberFormat is expensive to construct, so build one formatter per currency once.
const _fmt = {};
export function fmtCur(n, cur) {
  const v = Number(n) || 0;
  let f = _fmt[cur];
  if (!f) {
    try {
      f = new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency', currency: cur, maximumFractionDigits: 0,
      });
    } catch (e) {
      f = { format: (x) => (cur === 'INR' ? '₹' : '$') + (Number(x) || 0).toFixed(0) };
    }
    _fmt[cur] = f;
  }
  return f.format(v);
}

export const fmtPct = (n) => {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
};

export const fmtIntRate = (n) => {
  const v = Number(n) || 0;
  return v.toFixed(2) + '%';
};
export const pctClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat');
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthToDate(label) {
  const m = label && label.match(/([A-Za-z]{3})[a-z.]*\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return m[2] + '-' + String(mo).padStart(2, '0') + '-01';
}
// 'YYYY-MM' <-> 'Mon YYYY' (the label format used in stock history and the sheet).
export function ymToLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return ym || '';
  return MONTH_ABBR[Number(m[2]) - 1] + ' ' + m[1];
}
export function labelToYm(label) {
  const d = monthToDate(label);
  return d ? d.slice(0, 7) : (/^\d{4}-\d{2}$/.test(label) ? label : null);
}
export const monthKey = (portfolio, ym) => portfolio + '|' + ym;
export const thisYm = () => new Date().toISOString().slice(0, 7);

// Parse messy sheet figures like "2,786.99", "+ 3340.61", "₹1,200", "29.39%".
export function cleanNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// Per-stock figures. For a sold stock, compares the latest price against the sold
// price to judge the exit; for a holding, computes price-based profit/loss.
export function calc(s) {
  const units = Number(s.units) || 0;
  const buy = Number(s.buyPrice) || 0;
  const cur = Number(s.currentPrice) || 0;
  if (s.status === 'sold') {
    const su = Number(s.soldUnits != null && s.soldUnits !== '' ? s.soldUnits : s.units) || 0;
    const sp = Number(s.soldPrice) || 0;
    const known = cur > 0 && sp > 0;
    const movedPct = sp ? ((cur - sp) / sp) * 100 : 0;
    return { sold: true, soldValue: su * sp, movedPct, known, goodSell: known ? cur < sp : null };
  }
  const invested = units * buy;
  const value = units * cur;
  const pl = value - invested;
  const plPct = invested ? (pl / invested) * 100 : 0;
  return { sold: false, invested, value, pl, plPct, priced: cur > 0 };
}

export function latestHist(s) {
  const h = s.history;
  if (h && h.length) {
    for (let i = h.length - 1; i >= 0; i--) {
      if (typeof h[i].pct === 'number') return h[i];
    }
  }
  return null;
}
export function latestHistPct(s) {
  const h = latestHist(s);
  return h ? h.pct : null;
}
// % to show for a holding: price-based when priced, else its latest tracked % from history.
export function displayPct(s, c) {
  if (c && c.priced) return c.plPct;
  return latestHistPct(s);
}

// Portfolio totals. Value/invested only count priced holdings; up/down counts use
// the displayed % (price-based or latest history) so imported stocks still register.
export function summarize(stocks) {
  let invested = 0, value = 0, up = 0, down = 0, holdings = 0, sold = 0, priced = 0;
  for (const s of stocks) {
    if (s.status === 'sold') { sold++; continue; }
    holdings++;
    const c = calc(s);
    let dpct;
    if (c.priced) { invested += c.invested; value += c.value; priced++; dpct = c.plPct; }
    else { dpct = latestHistPct(s); }
    if (dpct > 0) up++; else if (dpct < 0) down++;
  }
  const pl = value - invested;
  const plPct = invested ? (pl / invested) * 100 : 0;
  return { invested, value, pl, plPct, up, down, holdings, sold, priced, hasVal: priced > 0 };
}
