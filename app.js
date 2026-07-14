// UI, state and wiring. Pure calculations live in core.js; storage in db.js;
// CSV parsing is lazy-loaded from csv.js only when the user imports.
import { DB } from './db.js';
import {
  PORTFOLIOS, CATEGORIES, CONVICTIONS, convIcon, curOf,
  fmtCur, fmtPct, pctClass, todayISO, num,
  calc, latestHist, displayPct, summarize,
  ymToLabel, labelToYm, monthKey, thisYm,
} from './core.js';
import {
  PIN_LENGTH, getLockConfig, setPin, verifyPin, disableLock,
  biometricSupported, biometricAvailable, registerBiometric, verifyBiometric,
  disableBiometric, wipeAllData,
} from './lock.js';
import {
  BACKUPS_KEEP, fileSystemAccessSupported, getSavedFolder, ensureFolderPermission,
  pickFolder, listBackups, readBackupByName, writeBackup, rotateBackups,
  writePreRestoreSnapshot, readBackupViaFilePicker,
} from './backup.js';

const state = {
  appMode: 'home',   // 'home' | 'stocks' | 'mf' - top-level surface (Stocks app is untouched)
  portfolio: 'me-in',
  view: 'holdings', // 'holdings' | 'monthly' | 'heatmap' | 'trends' | 'feed'
  filter: 'holding', // 'all' | 'holding' | 'sold' - default to active holdings
  sortField: 'name', // 'name' | 'pct' | 'value'
  sortStage: 0,      // 0 = default (name A-Z), 1 = primary, 2 = secondary
  search: '',
  stocks: [],
  snapshots: [],
  months: [],
};

// Mutual-fund view state (only used inside the MF surface).
let _mfSort = 'ret';        // 'ret' | 'xirr' | 'inv' | 'name' (default: Return %)
let _mfFilter = 'investing'; // 'investing' | 'sold' (holding vs redeemed - not SIP status)
let _mfTab = 'holdings';     // 'holdings' | 'overview' | 'benchmark' | 'stats' (bottom nav)
let _mfBenchTab = 'returns';  // 'returns' | 'xirr' (sub-tabs within benchmark)
let _mfStatsTab = 'day';      // 'day' | 'month' | 'year' (sub-tabs within stats)

// Fixed-deposit view state (only used inside the FD surface).
let _fdSort = 'maturity';    // 'maturity' | 'principal' | 'rate' | 'bank'
let _fdFilter = 'active';    // 'active' | 'matured' | 'all'
let _fdTab = 'holdings';     // 'holdings' | 'overview' | 'ladder' (bottom nav)
const MF_TYPES = ['Multi Cap', 'Flexi Cap', 'Large Cap', 'Mid Cap', 'Small Cap', 'Tax Saver', 'Technology', 'Pharma', 'Energy', 'International', 'Index', 'Debt', 'Hybrid'];
const MF_STATUS = ['Investing', 'Investing On/Off', 'Investing Variable', 'Stopped', 'Sold'];

let deferredInstall = null;

// ---------- tiny DOM helpers (no innerHTML: dynamic strings are always text nodes) ----------
const $ = (sel, root) => (root || document).querySelector(sel);
// Returns a size-class suffix for .stat-v based on text length, so a long
// formatted currency string (e.g. "+₹1,91,997.42" = 13 chars, or "+₹10,00,000.00"
// = 14 chars) shrinks instead of wrapping mid-value. Combined with
// `white-space: nowrap` on .stat-v in CSS so nothing ever breaks across lines.
function _statSizeClass(value) {
  const len = String(value).length;
  if (len >= 16) return 'stat-v-xs';
  if (len >= 13) return 'stat-v-sm';
  return '';
}

function el(tag, props, children) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const val = props[k];
      if (k === 'class') n.className = val;
      else if (k === 'text') n.textContent = val;
      else if (k.startsWith('on') && typeof val === 'function') n.addEventListener(k.slice(2), val);
      else n.setAttribute(k, val);
    }
  }
  if (children) for (const c of children) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const b = (s) => el('b', { text: s });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const benchmarkName = (p) => (p === 'me-us' ? 'Nasdaq' : 'Nifty 50');
// All months from start..end inclusive as 'YYYY-MM' (used to insert gaps in charts).
function monthRange(startYm, endYm) {
  const out = [];
  let [y, m] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const STALE_PRICE_DAYS = 30;

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function priceAgeDays(s) {
  if (!s || s.status === 'sold' || !(Number(s.currentPrice) > 0)) return null;
  return daysSince(s.updatedAt || s.createdAt);
}

function isPriceStale(s) {
  const d = priceAgeDays(s);
  return d != null && d >= STALE_PRICE_DAYS;
}

function formatTimeDuration(days) {
  if (days == null) return null;
  if (days < 30) return Math.round(days) + 'd';
  const months = Math.round(days / 30.44);
  if (months < 12) return months + 'm';
  const years = Math.round(days / 365.25);
  return years + 'y';
}

function isMonthEndReminderWindow(now) {
  const d = now || new Date();
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() >= lastDay - 6;
}

function missingCurrentMonthCapture(months) {
  const ym = thisYm();
  return !(months || []).some((m) => m.ym === ym);
}

let toastTimer = null;
function toast(msg) {
  const existing = $('.toast');
  if (existing) existing.remove();
  const t = el('div', { class: 'toast', text: msg });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

// ---------- data ----------
async function load() {
  const [stocks, snapshots, months] = await Promise.all([
    DB.byPortfolio('stocks', state.portfolio),
    DB.byPortfolio('snapshots', state.portfolio),
    DB.byPortfolio('monthly', state.portfolio),
  ]);
  state.stocks = stocks.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  state.snapshots = snapshots.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  state.months = months.sort((a, b) => (a.ym || '').localeCompare(b.ym || ''));
}
async function refresh() { await load(); render(); }

// ---------- chrome (built once, only active state toggles afterward) ----------
function buildChrome() {
  const tabs = $('#portfolioTabs');
  tabs.innerHTML = '';
  PORTFOLIOS.forEach((p) => tabs.appendChild(el('button', {
    class: 'ptab', 'data-id': p.id, text: p.label,
    onclick: () => { if (state.portfolio === p.id) return; state.portfolio = p.id; state.search = ''; refresh(); },
  })));

  const nav = $('#bottomNav');
  nav.innerHTML = '';
  [['holdings', '📈', 'Holdings'], ['heatmap', '🗺️', 'Heatmap'], ['monthly', '🗓️', 'Trend'], ['trends', '📊', 'Overview'], ['feed', '📰', 'Feed']].forEach(([v, ico, label]) => {
    nav.appendChild(el('button', { 'data-view': v, onclick: () => { if (state.view === v) return; state.view = v; render(); } },
      [el('span', { class: 'bn-ico', text: ico }), label]));
  });

  const sortBar = $('#sortBar');
  sortBar.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-field');
      if (state.sortField === f) state.sortStage = (state.sortStage + 1) % 3;
      else { state.sortField = f; state.sortStage = 0; }
      updateSortButtons();
      renderList();
    });
  });
  updateSortButtons();

  const seg = $('#filterSeg');
  seg.innerHTML = '';
  [['holding', 'Holding'], ['sold', 'Sold']].forEach(([v, label]) => {
    seg.appendChild(el('button', {
      'data-filter': v, text: label,
      onclick: () => { if (state.filter === v) return; state.filter = v; updateFiltersActive(); renderList(); },
    }));
  });
}
function updateFiltersActive() {
  $('#filterSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.getAttribute('data-filter') === state.filter));
}
function updateChromeActive() {
  $('#portfolioTabs').querySelectorAll('.ptab').forEach((x) => x.classList.toggle('active', x.getAttribute('data-id') === state.portfolio));
  $('#bottomNav').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.getAttribute('data-view') === state.view));
  updateFiltersActive();
}

// ---------- render ----------
function renderSummary() {
  const host = $('#summary');
  const cur = curOf(state.portfolio);
  const s = summarize(state.stocks);
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'row-between' }, [
    el('span', { class: 'label', text: 'Current value' }),
    s.hasVal
      ? el('span', { class: 'badge ' + (s.pl >= 0 ? 'good' : 'bad'), text: fmtPct(s.plPct) })
      : el('span', { class: 'badge muted', text: 'no prices yet' }),
  ]));
  host.appendChild(el('div', { class: 'big', text: s.hasVal ? fmtCur(s.value, cur) : '-' }));
  const grid = el('div', { class: 'grid' });
  const cells = [
    ['Invested', s.hasVal ? fmtCur(s.invested, cur) : '-', ''],
    ['Profit / Loss', s.hasVal ? (s.pl >= 0 ? '+' : '') + fmtCur(s.pl, cur) : '-', s.hasVal ? pctClass(s.pl) : ''],
    ['Holdings', String(s.holdings) + (s.sold ? '  ·  ' + s.sold + ' sold' : ''), ''],
    ['Up / Down', s.up + ' ▲  /  ' + s.down + ' ▼', ''],
  ];
  cells.forEach(([k, v, cls]) => grid.appendChild(el('div', { class: 'cell' }, [
    el('div', { class: 'k', text: k }), el('div', { class: 'v ' + (cls || ''), text: v }),
  ])));
  host.appendChild(grid);
}

// Portfolio Risk Analysis - fully offline. Reads current-portfolio holdings +
// (optionally) cached feed sentiment. Long-term, structural view only: weights,
// diversification, sector exposure, news mood. No timing/intraday signals.
async function renderPortfolioAnalyzer(host, portfolio) {
  const holdings = state.stocks.filter((s) => s.status !== 'sold');
  if (!holdings.length) return;

  // Cached feed sentiment is optional - analyzer still works without it.
  let feedCache = new Map();
  try {
    const mod = await import('./feed.js');
    feedCache = await mod.getCachedFeed(portfolio);
  } catch (_) { /* feed never used yet - show structural metrics only */ }

  // Allocation by value. Stocks without a price contribute 0 (and are noted).
  const valued = holdings.map((s) => ({ stock: s, value: calc(s).value || 0, entry: feedCache.get(s.id) }));
  const total = valued.reduce((sum, v) => sum + v.value, 0);
  valued.forEach((v) => { v.alloc = total > 0 ? (v.value / total) * 100 : 0; });
  valued.sort((a, b) => b.alloc - a.alloc);

  const bySector = {};
  valued.forEach((v) => {
    const k = v.stock.category || 'Uncategorized';
    if (!bySector[k]) bySector[k] = { value: 0, count: 0 };
    bySector[k].value += v.value;
    bySector[k].count += 1;
  });
  const sectors = Object.entries(bySector).sort((a, b) => b[1].value - a[1].value || b[1].count - a[1].count);
  const health = computePortfolioHealth(holdings, valued, sectors, total);

  const analyzer = el('div', { class: 'chart-card pa-card' }, [el('h3', { text: 'Portfolio Risk Analysis' })]);
  analyzer.appendChild(el('div', { class: 'health-score ' + health.tone }, [
    el('div', { class: 'health-ring' }, [
      el('div', { class: 'health-num', text: String(health.score) }),
      el('div', { class: 'health-den', text: '/100' }),
    ]),
    el('div', { class: 'health-copy' }, [
      el('div', { class: 'health-title', text: health.label }),
      el('div', { class: 'health-detail', text: health.reasons.join(' - ') }),
    ]),
  ]));
  analyzer.appendChild(el('div', { class: 'pa-sub', text: portfolioLabel(portfolio) + ' · ' + holdings.length + ' holdings · long-term view' }));

  // ---- 1. Concentration ----
  const concentrated = valued.filter((v) => v.alloc > 15);
  if (total <= 0) {
    analyzer.appendChild(_paFlag('neutral', 'Allocation unavailable', 'Add current prices to your holdings to see weight-based risk.'));
  } else if (concentrated.length) {
    analyzer.appendChild(_paFlag('bad', '⚠️ Concentration risk',
      concentrated.map((v) => v.stock.name + ' · ' + v.alloc.toFixed(1) + '%').join('   ')));
  } else {
    analyzer.appendChild(_paFlag('good', '✓ Well diversified', 'No single holding exceeds 15% of value.'));
  }

  // ---- 2. Weight distribution (top holdings as bars) ----
  if (total > 0) {
    const top = valued.slice(0, 6);
    const maxAlloc = top[0] ? top[0].alloc : 1;
    const wrap = el('div', { class: 'pa-section' }, [el('div', { class: 'pa-h', text: 'Weight by holding' })]);
    top.forEach((v) => {
      const sent7d = v.entry ? (v.entry.sentiment7d || 0) : null;
      const dot = sent7d == null ? '' : (sent7d > 0.15 ? ' 📈' : sent7d < -0.15 ? ' 📉' : '');
      wrap.appendChild(el('div', { class: 'bar-row' }, [
        el('span', { class: 'bl', text: v.stock.name + dot }),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' + (v.alloc > 15 ? ' over' : ''), style: 'width:' + (v.alloc / maxAlloc * 100).toFixed(1) + '%' })]),
        el('span', { class: 'bn', text: v.alloc.toFixed(1) + '%' }),
      ]));
    });
    analyzer.appendChild(wrap);
  }

  // ---- 3. Sector exposure ----
  if (sectors.length) {
    const useValue = total > 0;
    const maxSec = sectors[0][1][useValue ? 'value' : 'count'] || 1;
    const wrap = el('div', { class: 'pa-section' }, [el('div', { class: 'pa-h', text: 'Sector exposure' })]);
    sectors.forEach(([name, d]) => {
      const pct = useValue ? (d.value / total * 100) : (d.count / holdings.length * 100);
      const metric = useValue ? d.value / maxSec : d.count / maxSec;
      const over = useValue && pct > 40; // single-sector concentration
      wrap.appendChild(el('div', { class: 'bar-row' }, [
        el('span', { class: 'bl', text: name + ' (' + d.count + ')' }),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill' + (over ? ' over' : ''), style: 'width:' + (metric * 100).toFixed(1) + '%' })]),
        el('span', { class: 'bn', text: pct.toFixed(0) + '%' }),
      ]));
    });
    if (sectors[0] && total > 0 && (sectors[0][1].value / total * 100) > 40) {
      wrap.appendChild(el('div', { class: 'pa-note bad', text: '⚠️ ' + sectors[0][0] + ' is over 40% of value - sector-concentrated.' }));
    }
    analyzer.appendChild(wrap);
  }

  // ---- 4. News sentiment summary (only if feed has data) ----
  const withNews = valued.filter((v) => v.entry && v.entry.items && v.entry.items.length);
  if (withNews.length) {
    let bull = 0, bear = 0, neutral = 0;
    const watch = [];
    withNews.forEach((v) => {
      // Use the same count-based majority vote as the Feed cards so the two
      // views always agree - raw average scores are too low-magnitude to cross
      // the ±0.15 threshold reliably, making everything show as neutral.
      const items = v.entry.items || [];
      let pos = 0, neg = 0;
      for (const it of items) {
        const k = _sentimentFlag(Number(it.sentiment) || 0).key;
        if (k === 'pos') pos++;
        else if (k === 'neg') neg++;
      }
      if (pos > neg) bull++;
      else if (neg > pos) { bear++; watch.push(v); }
      else neutral++;
    });
    const wrap = el('div', { class: 'pa-section' }, [el('div', { class: 'pa-h', text: 'News mood · 7-day (' + withNews.length + ' covered)' })]);
    wrap.appendChild(el('div', { class: 'pa-mood' }, [
      el('div', { class: 'pa-mood-cell good' }, [el('div', { class: 'pa-mood-n', text: String(bull) }), el('div', { class: 'pa-mood-k', text: '📈 Bullish' })]),
      el('div', { class: 'pa-mood-cell' }, [el('div', { class: 'pa-mood-n', text: String(neutral) }), el('div', { class: 'pa-mood-k', text: '→ Neutral' })]),
      el('div', { class: 'pa-mood-cell bad' }, [el('div', { class: 'pa-mood-n', text: String(bear) }), el('div', { class: 'pa-mood-k', text: '📉 Bearish' })]),
    ]));
    // Attention list - bearish-sentiment holdings worth a thesis review.
    if (watch.length) {
      wrap.appendChild(el('div', { class: 'pa-note', text: 'Worth reviewing: ' + watch.map((v) => v.stock.name).join(', ') + '. Open Feed for the news behind this.' }));
    }
    analyzer.appendChild(wrap);
  } else {
    analyzer.appendChild(el('div', { class: 'pa-note', text: 'No news synced yet - open the Feed tab and tap Refresh to add sentiment to this analysis.' }));
  }

  host.appendChild(analyzer);
}

// Small coloured flag row used by the analyzer. tone: 'good' | 'bad' | 'neutral'.
function _paFlag(tone, title, detail) {
  return el('div', { class: 'pa-flag ' + tone }, [
    el('div', { class: 'pa-flag-t', text: title }),
    el('div', { class: 'pa-flag-d', text: detail }),
  ]);
}

function computePortfolioHealth(holdings, valued, sectors, total) {
  const count = holdings.length || 1;
  const unpriced = holdings.filter((s) => !(Number(s.currentPrice) > 0)).length;
  const stale = holdings.filter(isPriceStale).length;
  const maxAlloc = total > 0 && valued[0] ? valued[0].alloc : 0;
  const maxSectorPct = total > 0 && sectors[0] ? (sectors[0][1].value / total) * 100 : 0;
  const avoid = holdings.filter((s) => s.conviction === 'down').length;

  let score = 100;
  if (total <= 0) score -= 30;
  score -= Math.round((unpriced / count) * 20);
  score -= Math.round((stale / count) * 20);
  if (maxAlloc > 30) score -= 22;
  else if (maxAlloc > 20) score -= 14;
  else if (maxAlloc > 15) score -= 8;
  if (maxSectorPct > 55) score -= 16;
  else if (maxSectorPct > 40) score -= 10;
  score -= Math.min(10, avoid * 3);
  score = Math.max(0, Math.min(100, score));

  const reasons = [];
  reasons.push(unpriced ? unpriced + ' without price' : 'prices covered');
  reasons.push(stale ? stale + ' stale price' + (stale > 1 ? 's' : '') : 'prices fresh');
  if (maxAlloc > 15) reasons.push('top holding ' + maxAlloc.toFixed(0) + '%');
  else reasons.push('weight balanced');
  if (maxSectorPct > 40) reasons.push('sector ' + maxSectorPct.toFixed(0) + '%');
  else reasons.push('sector spread ok');

  const tone = score >= 80 ? 'good' : score >= 60 ? 'neutral' : 'bad';
  const label = score >= 80 ? 'Strong portfolio health'
    : score >= 60 ? 'Balanced, watch a few items'
      : 'Needs review';
  return { score, tone, label, reasons };
}

function portfolioLabel(id) {
  const p = PORTFOLIOS.find((x) => x.id === id);
  return p ? p.label : id;
}

// Sortable return figures for a stock. Holdings use price-based P/L (or latest
// tracked %); sold stocks use current-vs-sold move. Missing values sort last.
function metricOf(s) {
  const c = calc(s);
  if (s.status === 'sold') return { pct: c.known ? c.movedPct : null, money: null };
  return { pct: displayPct(s, c), money: c.priced ? c.pl : null };
}
// Tri-state sort: stage 0 = default name A-Z; for the active field, stage 1 and 2
// are its two directions (name A-Z/Z-A; return & value high-first/low-first).
function sortStocks(list) {
  const f = state.sortField, st = state.sortStage;
  const soldRank = (s) => (s.status === 'sold' ? 1 : 0); // holdings (0) before sold (1)
  return list.sort((a, b) => {
    const r0 = soldRank(a) - soldRank(b);
    if (r0 !== 0) return r0;
    if (st === 0) return (a.name || '').localeCompare(b.name || '');
    if (f === 'name') { const r = (a.name || '').localeCompare(b.name || ''); return st === 1 ? r : -r; }
    const key = f === 'value' ? 'money' : 'pct';
    const av = metricOf(a)[key], bv = metricOf(b)[key];
    if (av == null && bv == null) return (a.name || '').localeCompare(b.name || '');
    if (av == null) return 1;
    if (bv == null) return -1;
    return st === 1 ? (bv - av) : (av - bv);
  });
}

const SORT_LABELS = { name: 'Name', pct: 'Return %', value: 'Value' };
function updateSortButtons() {
  $('#sortBar').querySelectorAll('.sort-btn').forEach((btn) => {
    const f = btn.getAttribute('data-field');
    const active = f === state.sortField && state.sortStage > 0;
    btn.classList.toggle('active', active);
    let arrow = '';
    if (active) {
      const asc = f === 'name' ? state.sortStage === 1 : state.sortStage === 2;
      arrow = asc ? ' ↑' : ' ↓';
    }
    btn.textContent = SORT_LABELS[f] + arrow;
  });
}

function visibleStocks() {
  const q = state.search.trim().toLowerCase();
  const filtered = state.stocks.filter((s) => {
    if (state.filter === 'holding' && s.status === 'sold') return false;
    if (state.filter === 'sold' && s.status !== 'sold') return false;
    if (q && !((s.name || '') + ' ' + (s.category || '')).toLowerCase().includes(q)) return false;
    return true;
  });
  return sortStocks(filtered);
}

function stockCard(s) {
  const cur = curOf(state.portfolio);
  const c = calc(s);

  const nameEl = el('div', { class: 'name' }, [s.name || '(unnamed)']);
  if (s.conviction) nameEl.appendChild(el('span', { class: 'conv', text: '  ' + convIcon(s.conviction) }));
  if (s.category) nameEl.appendChild(el('span', { class: 'cat-badge', text: s.category }));

  const left = el('div', { class: 'card-left' }, [nameEl]);
  const right = el('div', { class: 'card-right' });

  if (s.status === 'sold') {
    const cls = c.goodSell == null ? 'muted' : c.goodSell ? 'good' : 'bad';
    const text = c.goodSell == null ? 'Sold' : c.goodSell ? 'Good exit' : 'Sold early';
    right.appendChild(el('span', { class: 'badge ' + cls, text }));
    const su = Number(s.soldUnits != null && s.soldUnits !== '' ? s.soldUnits : s.units) || 0;
    left.appendChild(el('div', { class: 'meta-line' }, ['Sold ', b(String(su)), ' @ ', b(fmtCur(s.soldPrice, cur))]));
    if (c.known) left.appendChild(el('div', { class: 'meta-line ' + (c.goodSell ? 'pos' : 'neg') }, ['Now ', b(fmtCur(s.currentPrice, cur)), ' (' + fmtPct(c.movedPct) + ')']));
    else left.appendChild(el('div', { class: 'meta-line flat', text: 'Set current price to judge' }));
  } else {
    const dpct = displayPct(s, c);
    right.appendChild(el('div', { class: 'pct ' + (dpct != null ? pctClass(dpct) : 'flat'), text: dpct != null ? fmtPct(dpct) : '-' }));
    if (c.priced) {
      left.appendChild(el('div', { class: 'meta-line' }, [b(String(Number(s.units) || 0)), ' @ ' + fmtCur(s.buyPrice, cur)]));
      // "Price updated" now rides inline on the right of the current-price line in
      // a very tiny font (was its own line below).
      const priceLine = el('div', { class: 'meta-line price-line' }, ['Current price ', b(fmtCur(s.currentPrice, cur))]);
      const age = priceAgeDays(s);
      if (age != null) {
        priceLine.appendChild(el('span', {
          class: 'price-age' + (age >= STALE_PRICE_DAYS ? ' warn' : ''),
          text: age === 0 ? 'updated today' : 'updated ' + age + 'd ago',
        }));
      }
      left.appendChild(priceLine);
      const kv = (label, valNode) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label', text: label }), valNode]);
      right.appendChild(kv('Overall return', el('span', { class: 'kv-val ' + (c.pl >= 0 ? 'pos' : 'neg'), text: (c.pl >= 0 ? '+' : '') + fmtCur(c.pl, cur) })));
      right.appendChild(kv('Current value', el('span', { class: 'kv-val', text: fmtCur(c.value, cur) })));
    } else {
      const lh = latestHist(s);
      if (lh) left.appendChild(el('div', { class: 'meta-line' }, [b(String(s.history.length)), ' months · latest ', b(lh.month)]));
      else if (Number(s.units)) left.appendChild(el('div', { class: 'meta-line' }, [b(String(Number(s.units))), ' @ ' + fmtCur(s.buyPrice, cur), ' · set price']));
      else left.appendChild(el('div', { class: 'meta-line flat', text: 'Tap to add prices' }));
    }
  }

  return el('div', { class: 'card', onclick: () => openStockForm(s) }, [el('div', { class: 'top' }, [left, right])]);
}

function renderList() {
  const host = $('#stockList');
  const frag = document.createDocumentFragment();
  if (!state.stocks.length) {
    frag.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: '📝' }),
      el('p', { text: 'No stocks yet in this portfolio.' }),
      el('p', { class: 'hint', text: 'Tap + to add your first one.' }),
    ]));
  } else {
    const list = visibleStocks();
    if (!list.length) frag.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'Nothing matches this filter.' })]));
    else list.forEach((s) => frag.appendChild(stockCard(s)));
  }
  host.innerHTML = '';
  host.appendChild(frag);
}

function sparkline(values, w, h, emptyMsg) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', h);
  if (values.length < 2) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', w / 2); t.setAttribute('y', h / 2);
    t.setAttribute('fill', '#9fb0d4'); t.setAttribute('font-size', '12'); t.setAttribute('text-anchor', 'middle');
    t.textContent = emptyMsg || 'Not enough data to chart';
    svg.appendChild(t);
    return svg;
  }
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const pad = 8;
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => (pad + i * stepX).toFixed(1) + ',' + (h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1));
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', pts.join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#38bdf8');
  poly.setAttribute('stroke-width', '2.5');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);
  return svg;
}

// Multiple lines sharing one scale (used to overlay Nifty on a stock). Each series
// is { values: (number|null)[], color, dash? }; nulls break the line into segments.
function multiSparkline(series, w, h, emptyMsg) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', h);
  const all = [];
  let maxLen = 0;
  series.forEach((s) => { maxLen = Math.max(maxLen, s.values.length); s.values.forEach((v) => { if (v != null && !isNaN(v)) all.push(v); }); });
  if (all.length < 2) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', w / 2); t.setAttribute('y', h / 2);
    t.setAttribute('fill', '#9fb0d4'); t.setAttribute('font-size', '12'); t.setAttribute('text-anchor', 'middle');
    t.textContent = emptyMsg || 'Not enough data to chart';
    svg.appendChild(t);
    return svg;
  }
  const min = Math.min.apply(null, all), max = Math.max.apply(null, all);
  const pad = 8, span = (max - min) || 1;
  const xAt = (i) => pad + (maxLen > 1 ? (i * (w - 2 * pad)) / (maxLen - 1) : (w - 2 * pad) / 2);
  const yAt = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  series.forEach((s) => {
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        const poly = document.createElementNS(ns, 'polyline');
        poly.setAttribute('points', seg.join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', s.color);
        poly.setAttribute('stroke-width', '2.5');
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        if (s.dash) poly.setAttribute('stroke-dasharray', s.dash);
        svg.appendChild(poly);
      }
      seg = [];
    };
    s.values.forEach((v, i) => { if (v == null || isNaN(v)) flush(); else seg.push(xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)); });
    flush();
  });
  return svg;
}

// Value-by-month line with a dot per month; each dot has a native tooltip
// (hover on desktop / tap on mobile) showing that month's value and return.
function monthlyValueChart(months, cur, bname) {
  const ns = 'http://www.w3.org/2000/svg';
  const w = 320, h = 150, pad = 12;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', '100%'); svg.setAttribute('height', h);
  const info = el('div', { class: 'chart-info', text: months.length < 2 ? '' : 'Tap a dot for that month\'s details' });
  const setInfo = (text, color) => { info.textContent = text; info.style.color = color || ''; };
  if (months.length < 2) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', w / 2); t.setAttribute('y', h / 2); t.setAttribute('fill', '#9fb0d4');
    t.setAttribute('font-size', '12'); t.setAttribute('text-anchor', 'middle');
    t.textContent = 'Add at least 2 months to see a trend';
    svg.appendChild(t);
    return el('div', {}, [svg, info]);
  }
  const xAt = (i) => pad + (i * (w - pad * 2)) / (months.length - 1);
  // Each series is normalised to its own min/max (different units), so shapes are
  // comparable; the real numbers live in each dot's hover/tap tooltip.
  const drawSeries = (series, lineColor, dash, dotColor, tip) => {
    const nums = series.filter((v) => v != null && !isNaN(v));
    if (!nums.length) return;
    const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums), span = (max - min) || 1;
    const yAt = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        const poly = document.createElementNS(ns, 'polyline');
        poly.setAttribute('points', seg.join(' '));
        poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', lineColor); poly.setAttribute('stroke-width', '2');
        poly.setAttribute('stroke-linejoin', 'round'); poly.setAttribute('stroke-linecap', 'round');
        if (dash) poly.setAttribute('stroke-dasharray', dash);
        svg.appendChild(poly);
      }
      seg = [];
    };
    series.forEach((v, i) => { if (v == null || isNaN(v)) flush(); else seg.push(xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)); });
    flush();
    series.forEach((v, i) => {
      if (v == null || isNaN(v)) return;
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', xAt(i).toFixed(1)); dot.setAttribute('cy', yAt(v).toFixed(1)); dot.setAttribute('r', '4.5');
      dot.setAttribute('fill', dotColor(i));
      dot.style.cursor = 'pointer';
      const tipText = tip(i), tipColor = dotColor(i);
      const title = document.createElementNS(ns, 'title'); title.textContent = tipText; dot.appendChild(title); // desktop hover
      dot.addEventListener('click', () => setInfo(tipText, tipColor)); // works on mobile tap too
      svg.appendChild(dot);
    });
  };
  // benchmark first (behind), portfolio value on top
  const bvals = months.map((m) => (m.nifty != null ? Number(m.nifty) : null));
  if (bvals.some((v) => v != null)) {
    drawSeries(bvals, '#fbbf24', '4 3', () => '#fbbf24', (i) => ymToLabel(months[i].ym) + ': ' + bname + ' ' + months[i].nifty);
  }
  const vals = months.map((m) => (m.value != null ? Number(m.value) : null));
  drawSeries(vals, '#38bdf8', null,
    (i) => (months[i].returnPct != null && months[i].returnPct < 0 ? '#f87171' : '#34d399'),
    (i) => ymToLabel(months[i].ym) + ': ' + fmtCur(months[i].value, cur) + (months[i].returnPct != null ? '  (' + fmtPct(months[i].returnPct) + ')' : ''));
  return el('div', {}, [svg, info]);
}

// Overview tab: all-portfolios summary + allocation by category (cross-portfolio).
async function renderTrends() {
  const host = $('#trendView');
  host.innerHTML = '';
  let allStocks = [], allMonthly = [];
  try { [allStocks, allMonthly] = await Promise.all([DB.all('stocks'), DB.all('monthly')]); } catch (e) { return; }

  // latest monthly record per portfolio = its real ₹/$ totals
  const latest = {};
  allMonthly.forEach((m) => { if (!latest[m.portfolio] || (m.ym || '') > (latest[m.portfolio].ym || '')) latest[m.portfolio] = m; });

  const pcard = el('div', { class: 'chart-card' }, [el('h3', { text: 'Portfolios' })]);
  const grid = el('div', { class: 'stats' });
  PORTFOLIOS.forEach((p) => {
    const lm = latest[p.id];
    const valTxt = lm && lm.value != null ? fmtCur(lm.value, p.cur) : '-';
    grid.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: ('stat-v ' + _statSizeClass(valTxt)).trim(), text: valTxt }),
      el('div', { class: 'stat-k', text: p.label }),
      el('div', { class: 'stat-k ' + (lm && lm.returnPct != null ? pctClass(lm.returnPct) : ''), text: lm ? (lm.returnPct != null ? fmtPct(lm.returnPct) : ' ') : 'No data' }),
    ]));
  });
  pcard.appendChild(grid);
  const inInv = ['me-in', 'wife-in'].reduce((s, id) => s + ((latest[id] && latest[id].invested) || 0), 0);
  const inVal = ['me-in', 'wife-in'].reduce((s, id) => s + ((latest[id] && latest[id].value) || 0), 0);
  if (inInv || inVal) {
    const pl = inVal - inInv;
    pcard.appendChild(el('div', { class: 'insight-card', style: 'margin-top:10px' }, [
      el('div', { class: 'ic-k', text: 'India combined (you + wife)' }),
      el('div', { class: 'ic-v' }, ['Invested ', b(fmtCur(inInv, 'INR')), '  ·  Value ', b(fmtCur(inVal, 'INR')), '  ·  ', el('span', { class: pctClass(pl) }, [b((pl >= 0 ? '+' : '') + fmtCur(pl, 'INR'))])]),
    ]));
  }
  host.appendChild(pcard);

  const holdings = allStocks.filter((s) => s.status !== 'sold');
  if (!holdings.length) {
    host.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'Add holdings to see allocation.' })]));
    return;
  }
  const byCat = {};
  holdings.forEach((s) => { const k = s.category || 'Uncategorized'; byCat[k] = (byCat[k] || 0) + 1; });
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const maxC = byCat[cats[0]] || 1;
  const acard = el('div', { class: 'chart-card' }, [el('h3', { text: 'Allocation by category · ' + holdings.length + ' holdings' })]);
  cats.forEach((cat) => {
    const cnt = byCat[cat];
    acard.appendChild(el('div', { class: 'bar-row' }, [
      el('span', { class: 'bl', text: cat }),
      el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: 'width:' + (cnt / maxC * 100).toFixed(1) + '%' })]),
      el('span', { class: 'bn', text: String(cnt) }),
    ]));
  });
  host.appendChild(acard);

  const conv = { up: 0, watch: 0, down: 0 };
  holdings.forEach((s) => { if (conv[s.conviction] != null) conv[s.conviction]++; });
  host.appendChild(el('div', { class: 'chart-card' }, [
    el('h3', { text: 'Conviction' }),
    el('div', { class: 'insight-cards' }, [
      el('div', { class: 'insight-card' }, [el('div', { class: 'ic-k', text: 'Conviction 👍' }), el('div', { class: 'ic-v', text: String(conv.up) })]),
      el('div', { class: 'insight-card' }, [el('div', { class: 'ic-k', text: 'Watch ✋' }), el('div', { class: 'ic-v', text: String(conv.watch) })]),
      el('div', { class: 'insight-card' }, [el('div', { class: 'ic-k', text: 'Avoid 👎' }), el('div', { class: 'ic-v', text: String(conv.down) })]),
    ]),
  ]));

  // Portfolio Analyzer - only show for current portfolio
  await renderPortfolioAnalyzer(host, state.portfolio);
}

// ---------- Feed & Recommendations tab ----------
// Lazy-loaded module: nothing in feed.js is touched (and no network requests
// fire) until the user visits the Feed tab or opens its settings.

let _feedFetchInFlight = false; // simple lock against double-tap on Refresh

function _relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  return days + 'd ago';
}

async function renderFeed() {
  const host = $('#feedView');
  host.innerHTML = '';
  const mod = await import('./feed.js');
  const apiKey = await mod.getApiKey();

  // First-time onboarding: no key yet → show the sign-up explainer.
  if (!apiKey) {
    host.appendChild(_buildFeedHeader(mod, null, 'nokey', portfolio));
    host.appendChild(el('div', { class: 'chart-card' }, [
      el('h3', { text: 'Set up news feed' }),
      el('p', { class: 'hint', text:
        'To pull last-24h news, MyNote uses Marketaux - free, 100 requests per day. Sign up at marketaux.com, get your free API key, and paste it in Feed settings. Your key stays on this device only. Only stock names are sent in requests - no prices, no balances.' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn primary', text: 'Open Feed settings', onclick: () => openFeedSettings() }),
      ]),
    ]));
    return;
  }

  const portfolio = state.portfolio;
  const cached = await mod.getCachedFeed(portfolio);
  const lastFetched = await mod.getLastFetch(portfolio);
  const holdings = state.stocks.filter((s) => s.status !== 'sold');

  host.appendChild(_buildFeedHeader(mod, lastFetched, navigator.onLine ? 'online' : 'offline', portfolio));

  if (!holdings.length) {
    host.appendChild(el('div', { class: 'feed-empty', text: 'No active holdings - Feed is empty.' }));
    return;
  }

  host.appendChild(el('div', { class: 'feed-section-head' }, [
    el('h3', { class: 'feed-section-title', text: 'Holdings · News & Recommendations' }),
    el('span', { class: 'feed-section-sub', text: 'Tap a card for the news behind each call' }),
  ]));

  const list = el('div', { class: 'feed-list' });
  let todayNewsCount = 0;
  for (const stock of holdings) {
    const entry = cached.get(stock.id);
    const hasToday = !!(entry && entry.todayCount > 0);
    const has7d = !!(entry && entry.days && entry.days.length > 0);
    if (hasToday) todayNewsCount++;

    // --- Today's Stocks card ---
    // Built with today's articles only. Stocks with no today news get
    // data-no-today so applyFilter keeps them hidden regardless of tab switch.
    const todayWrapper = el('div', { class: 'feed-item feed-item-today' });
    if (!hasToday) todayWrapper.setAttribute('data-no-today', 'true');
    const todayEntry = entry ? Object.assign({}, entry, { items: entry.todayItems || [] }) : null;
    todayWrapper.appendChild(_buildFeedCard(stock, todayEntry, mod));
    list.appendChild(todayWrapper);

    // --- All tab card ---
    // Full 7-day articles + dot timeline for any stock with news in the window.
    const allWrapper = el('div', { class: 'feed-item feed-item-all' });
    allWrapper.appendChild(_buildFeedCard(stock, entry, mod));
    if (has7d) {
      const tl = _buildFeedTimeline(entry);
      if (tl) allWrapper.appendChild(tl);
    }
    list.appendChild(allWrapper);
  }

  // Switch between Today's Stocks and All. Each stock has two DOM elements -
  // one per context. data-no-today marks stocks that had nothing today so they
  // stay hidden when Today's Stocks is active.
  const applyFilter = (mode) => {
    list.querySelectorAll('.feed-item-today').forEach((w) => {
      w.style.display = (mode === 'today' && !w.getAttribute('data-no-today')) ? '' : 'none';
    });
    list.querySelectorAll('.feed-item-all').forEach((w) => {
      w.style.display = (mode === 'all') ? '' : 'none';
    });
  };
  const btnToday = el('button', { class: 'feed-filter-btn', text: "Today's Stocks (" + todayNewsCount + ')' });
  const btnAll = el('button', { class: 'feed-filter-btn', text: 'All (' + holdings.length + ')' });
  btnToday.onclick = () => { btnToday.classList.add('active'); btnAll.classList.remove('active'); applyFilter('today'); };
  btnAll.onclick = () => { btnAll.classList.add('active'); btnToday.classList.remove('active'); applyFilter('all'); };
  const defaultToday = todayNewsCount > 0;
  (defaultToday ? btnToday : btnAll).classList.add('active');
  host.appendChild(el('div', { class: 'feed-filter' }, [btnToday, btnAll]));
  host.appendChild(list);
  applyFilter(defaultToday ? 'today' : 'all');

  // Auto-fetch if stale. Background; UI shows cached results meanwhile.
  if (navigator.onLine && mod.shouldAutoRefresh(lastFetched, portfolio, Date.now()) && !_feedFetchInFlight) {
    refreshFeedNow(/*silent*/ true);
  }
}

function _buildFeedHeader(mod, lastFetched, status, portfolio) {
  const isUS = portfolio === 'me-us';
  const anchorLabel = isUS ? '6:30 PM IST' : '8:30 AM IST';
  const syncLink = el('span', { class: 'feed-sync-link', text: 'Sync now' });
  syncLink.addEventListener('click', () => refreshFeedNow(false));
  const lastTxt = lastFetched
    ? 'Synced ' + _relTime(new Date(lastFetched).toISOString())
    : 'Not yet synced today';
  const statusDot = status === 'online' ? '●' : status === 'offline' ? '●' : '●';
  return el('div', {}, [
    el('div', { class: 'feed-disclaimer', text:
      'Recommendations use local price history + cached news. Not financial advice. Only stock names leave this device.' }),
    el('div', { class: 'feed-actions' }, [
      el('div', { class: 'feed-schedule' }, [
        el('span', { class: 'feed-anchor', text: 'Auto-syncs daily at ' + anchorLabel }),
        el('span', { class: 'feed-sep', text: '·' }),
        el('span', { class: 'feed-last', text: lastTxt }),
        el('span', { class: 'feed-sep', text: '·' }),
        syncLink,
      ]),
      el('div', { class: 'feed-status ' + status, text: statusDot + ' ' + (status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'No API key') }),
    ]),
  ]);
}

// Classify a single sentiment score. Returns { key, label, icon }.
function _sentimentFlag(score) {
  if (score > 0.15) return { key: 'pos', label: 'Positive', icon: '📈' };
  if (score < -0.15) return { key: 'neg', label: 'Negative', icon: '📉' };
  return { key: 'neu', label: 'Neutral', icon: '→' };
}

// Count-based verdict over a set of articles. This is what the card face shows,
// so it always agrees with the per-article pills inside: we count how many
// articles are positive / negative / neutral and let the MAJORITY win. A tie
// with content = "Mixed"; nothing notable = "Neutral". Magnitude (the average
// score) is reported separately inside as intensity, not the headline call.
function _sentimentVerdict(items) {
  let pos = 0, neg = 0, neu = 0;
  for (const it of items) {
    const k = _sentimentFlag(Number(it.sentiment) || 0).key;
    if (k === 'pos') pos++; else if (k === 'neg') neg++; else neu++;
  }
  let flag;
  if (pos > neg) flag = { key: 'pos', label: 'Positive', icon: '📈' };
  else if (neg > pos) flag = { key: 'neg', label: 'Negative', icon: '📉' };
  else if (pos > 0) flag = { key: 'mix', label: 'Mixed', icon: '⚖️' };
  else flag = { key: 'neu', label: 'Neutral', icon: '→' };
  return { flag, pos, neg, neu };
}

// Renders the 7-day dot timeline below a feed card.
// Each dot = one day's majority-vote sentiment: pos (green) / neg (red) / neu (gray).
// Returns null if there are no daily buckets yet (nothing to show).
function _buildFeedTimeline(entry) {
  const days = (entry && entry.days) || [];
  if (!days.length) return null;
  const todayCount = (entry && entry.todayCount) || 0;
  const todayTxt = todayCount > 0
    ? todayCount + (todayCount === 1 ? ' article today' : ' articles today')
    : 'No news today';
  return el('div', { class: 'feed-timeline' }, [
    el('div', { class: 'ft-dots' },
      days.map((d) => el('span', { class: 'ft-dot ' + d.sentiment,
        title: d.dateStr + ' · ' + d.count + (d.count === 1 ? ' article' : ' articles') }))
    ),
    el('span', { class: 'ft-today', text: todayTxt }),
  ]);
}

function _buildFeedCard(stock, entry, mod) {
  const items = entry ? (entry.items || []) : [];
  const sentiment24h = entry ? (entry.sentiment24h || 0) : 0;
  const sentiment7d = entry ? (entry.sentiment7d || 0) : 0;
  // Recompute every render - cheap and ensures price-history updates take effect.
  const rec = mod.computeRecommendation(stock, items, stock.history || [], sentiment24h, sentiment7d, entry ? (entry.days || []) : []);
  const articleCount = items.length;
  const verdict = _sentimentVerdict(items);
  const flag = verdict.flag;

  const card = el('div', { class: 'feed-card' });

  // Row 1 - stock name + recommendation badge (the "action" call).
  card.appendChild(el('div', { class: 'feed-card-head' }, [
    el('div', { class: 'feed-stock', text: stock.name }),
    el('div', { class: 'feed-badge ' + (rec.color || 'grey'), text: rec.label }),
  ]));

  // Row 2 - sentiment verdict pill + transparent count breakdown.
  // The breakdown explains the verdict so it never contradicts the articles.
  const flagRow = el('div', { class: 'feed-flag-row' });
  if (articleCount) {
    flagRow.appendChild(el('span', { class: 'feed-flag ' + flag.key, text: flag.icon + ' ' + flag.label }));
    const breakdown = el('span', { class: 'feed-breakdown' });
    if (verdict.pos) breakdown.appendChild(el('span', { class: 'fb pos', text: verdict.pos + '▲' }));
    if (verdict.neg) breakdown.appendChild(el('span', { class: 'fb neg', text: verdict.neg + '▼' }));
    if (verdict.neu) breakdown.appendChild(el('span', { class: 'fb neu', text: verdict.neu + '·' }));
    flagRow.appendChild(breakdown);
  } else {
    flagRow.appendChild(el('span', { class: 'feed-flag neu muted', text: '· No news' }));
  }
  card.appendChild(flagRow);

  // Row 3 - recommendation reason.
  card.appendChild(el('div', { class: 'feed-reason', text: rec.reason }));

  if (articleCount) {
    const expandHint = el('div', { class: 'feed-expand-hint', text: 'Tap for news & sentiment ▾' });
    card.appendChild(expandHint);

    // Expanded panel - hidden until tap. Holds the detailed numbers + articles.
    const panel = el('div', { class: 'feed-articles hidden' });

    // Verdict recap + average-score intensity (clearly labelled so the average
    // is never mistaken for the headline call).
    const s24 = (sentiment24h >= 0 ? '+' : '') + sentiment24h.toFixed(2);
    const s7 = (sentiment7d >= 0 ? '+' : '') + sentiment7d.toFixed(2);
    panel.appendChild(el('div', { class: 'feed-sent-detail' }, [
      el('div', { class: 'feed-sent-item' }, [
        el('span', { class: 'feed-sent-k', text: 'Verdict' }),
        el('span', { class: 'feed-sent-v ' + flag.key, text: flag.label }),
        el('span', { class: 'feed-sent-x', text: verdict.pos + ' pos · ' + verdict.neg + ' neg · ' + verdict.neu + ' neutral' }),
      ]),
      el('div', { class: 'feed-sent-item' }, [
        el('span', { class: 'feed-sent-k', text: 'Avg score · 24h / 7d' }),
        el('span', { class: 'feed-sent-v ' + _sentimentFlag(sentiment7d).key, text: s24 + ' / ' + s7 }),
        el('span', { class: 'feed-sent-x', text: 'intensity, −1 to +1' }),
      ]),
    ]));

    for (const it of items) {
      const link = el('a', { href: it.url || '#', target: '_blank', rel: 'noopener', text: it.title || '(no title)' });
      const af = _sentimentFlag(Number(it.sentiment) || 0);
      panel.appendChild(el('div', { class: 'feed-article' }, [
        el('div', { class: 'feed-article-title' }, [link]),
        it.summary ? el('div', { class: 'feed-article-summary', text: it.summary }) : null,
        el('div', { class: 'feed-article-meta' }, [
          el('span', { class: 'feed-article-source', text: it.source || 'Source' }),
          el('span', { text: _relTime(it.publishedAt) }),
          el('span', { class: 'feed-article-sentiment ' + af.key, text: af.label }),
        ]),
      ].filter(Boolean)));
    }
    card.appendChild(panel);

    // Toggle on card tap (but not on link tap - links handle their own clicks).
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      panel.classList.toggle('hidden');
      expandHint.textContent = panel.classList.contains('hidden') ? 'Tap for news & sentiment ▾' : 'Tap to hide ▴';
    });
  }
  return card;
}

async function refreshFeedNow(silent) {
  if (_feedFetchInFlight) return;
  _feedFetchInFlight = true;
  try {
    const mod = await import('./feed.js');
    const apiKey = await mod.getApiKey();
    if (!apiKey) {
      if (!silent) toast('No API key - set one in Feed settings');
      return;
    }
    if (!navigator.onLine) {
      if (!silent) toast('You\'re offline - showing cached news');
      return;
    }
    // India portfolios (me-in, wife-in) are synced together so a stock that
    // appears in both only gets one API request - the news is saved to both.
    // US is single-portfolio only (different market, no overlap expected).
    const isIndia = state.portfolio !== 'me-us';
    const portfolios = isIndia ? ['me-in', 'wife-in'] : [state.portfolio];

    // Load active holdings for each portfolio in scope.
    const portfolioStocks = new Map();
    for (const p of portfolios) {
      const all = p === state.portfolio
        ? state.stocks
        : await DB.byPortfolio('stocks', p).catch(() => []);
      portfolioStocks.set(p, (all || []).filter((s) => s.status !== 'sold'));
    }

    // Deduplicate by normalised name across portfolios. Key = lowercase name.
    // Each unique name fetched once; result shared to all matching stocks.
    const byName = new Map(); // normName → { fetchName, targets[] }
    for (const [p, stocks] of portfolioStocks) {
      for (const s of stocks) {
        const norm = s.name.trim().toLowerCase();
        if (!byName.has(norm)) byName.set(norm, { fetchName: s.name, targets: [] });
        byName.get(norm).targets.push({ stockId: s.id, portfolio: p, stockName: s.name });
      }
    }

    const totalUnique = byName.size;
    if (!totalUnique) {
      if (!silent) toast('No holdings to fetch');
      return;
    }
    if (!silent) showLoader('Fetching news… 0/' + totalUnique);

    // Privacy: only stock NAME leaves the device (one request per unique name).
    const toFetch = [...byName.entries()].map(([norm, d]) => ({ id: norm, name: d.fetchName }));
    const result = await mod.fetchNewsForStocks(toFetch, apiKey, (p) => {
      if (!silent) setLoader('Fetching news… ' + p.done + '/' + p.total + (p.current ? ' · ' + p.current : ''));
    });

    const now = Date.now();
    const todayIST = new Date(now + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
    let stocksWithNews = 0, errors = 0;

    for (const [norm, d] of byName) {
      const r = result.get(norm) || { items: [], error: null };
      if (r.error) { errors++; continue; } // preserve existing cache on error
      if (r.items && r.items.length) stocksWithNews++;
      // Save to every portfolio that holds this stock (may be more than one).
      for (const target of d.targets) {
        await mod.saveFeedEntry({
          portfolio: target.portfolio,
          stockId: target.stockId,
          stockName: target.stockName,
          items: r.items || [],
          lastError: null,
        }, todayIST);
      }
    }

    // Stamp lastFetch for every portfolio synced - so switching to wife-in
    // doesn't trigger a duplicate sync if me-in already ran this morning.
    const totalFailure = errors === byName.size;
    if (!totalFailure) {
      for (const p of portfolios) await mod.setLastFetch(p, now);
    }
    if (!silent) hideLoader();
    if (!silent) {
      if (totalFailure) {
        toast('News service unavailable (rate limit or network). Showing cached.');
      } else {
        const saved = byName.size - errors;
        const summary = 'Feed updated · ' + stocksWithNews + ' with news, ' + (saved - stocksWithNews) + ' quiet' + (errors ? ' · ' + errors + ' skipped' : '');
        toast(summary);
      }
    }
    // Re-render only if still on Feed tab.
    if (state.view === 'feed') renderFeed();
  } catch (e) {
    if (!silent) { hideLoader(); toast('Refresh failed: ' + (e.message || e)); }
    else console.warn('feed auto-refresh failed', e);
  } finally {
    _feedFetchInFlight = false;
  }
}

// Called once on app open. Silently refreshes the feed for the current
// portfolio if data is stale - so the user gets fresh news just by opening
// the app, without needing to visit the Feed tab first.
async function _autoRefreshFeedOnInit() {
  if (!navigator.onLine) return;
  try {
    const mod = await import('./feed.js');
    const apiKey = await mod.getApiKey();
    if (!apiKey) return; // no key configured - nothing to do
    const lastFetch = await mod.getLastFetch(state.portfolio);
    if (mod.shouldAutoRefresh(lastFetch, state.portfolio, Date.now())) {
      refreshFeedNow(/*silent*/ true);
    }
  } catch (_) { /* feed.js not available or DB error - silently skip */ }
}

async function openFeedSettings() {
  const mod = await import('./feed.js');
  const key = await mod.getApiKey();
  const input = el('input', { type: 'text', value: key, placeholder: 'Marketaux API key', style: 'width:100%;padding:8px;font-size:0.86rem;' });
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Feed settings' }),
    el('p', { class: 'hint', text:
      'Get a free Marketaux API key at marketaux.com (100 requests/day). Stored only on this device. Only stock names are sent in requests - no prices, no portfolio data.' }),
    el('label', { style: 'display:block;font-size:0.8rem;margin:8px 0 4px;color:var(--muted);', text: 'API key' }),
    input,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', text: 'Save', onclick: async () => {
        await mod.saveApiKey(input.value.trim());
        closeModal();
        toast(input.value.trim() ? 'API key saved' : 'API key cleared');
        if (state.view === 'feed') renderFeed();
      }}),
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
    ]),
  ]));
}

// ---------- monthly tab ----------
const mCell = (k, v) => el('div', { class: 'cell' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })]);

function renderMonthly() {
  const host = $('#monthlyView');
  const cur = curOf(state.portfolio);
  const bname = benchmarkName(state.portfolio);
  const months = state.months; // ascending by ym
  host.innerHTML = '';

  const head = el('div', { class: 'chart-card' }, [
    el('div', { class: 'row-between' }, [
      el('h3', { text: 'Monthly tracking' }),
      el('button', { class: 'btn primary small', text: 'Capture this month', onclick: captureMonth }),
    ]),
    el('p', { class: 'note', text: 'Note: Capture stores this month\'s totals from your current holdings. Re-saving the same month overwrites it (no duplicate history).' }),
  ]);
  if (isMonthEndReminderWindow() && missingCurrentMonthCapture(months)) {
    head.appendChild(el('div', { class: 'snapshot-reminder' }, [
      el('div', {}, [
        el('div', { class: 'snapshot-reminder-t', text: ymToLabel(thisYm()) + ' snapshot is not captured yet' }),
        el('div', { class: 'snapshot-reminder-d', text: 'Month end is near. Capture after your prices are updated.' }),
      ]),
      el('button', { class: 'btn primary small', text: 'Capture now', onclick: captureMonth }),
    ]));
  }
  if (!months.length) {
    host.appendChild(head);
  } else {
    let adds = 0, n = 0;
    const moms = []; // month-over-month change in cumulative gain (or value)
    for (let i = 1; i < months.length; i++) {
      const a = num(months[i].invested), p = num(months[i - 1].invested);
      if (a != null && p != null) { adds += a - p; n++; }
      // Simple definition: MoM = this month's value minus last month's value.
      const cv = months[i].value, pv = months[i - 1].value;
      const mom = (cv != null && pv != null) ? cv - pv : null;
      if (mom != null) moms.push({ ym: months[i].ym, mom });
    }
    const last = months[months.length - 1];
    let best = null, worst = null, wins = 0;
    moms.forEach((x) => { if (!best || x.mom > best.mom) best = x; if (!worst || x.mom < worst.mom) worst = x; if (x.mom > 0) wins++; });
    const winRate = moms.length ? Math.round((wins / moms.length) * 100) : null;

    const stat = (label, value, cls) => {
      const sizeCls = _statSizeClass(value);
      return el('div', { class: 'stat' }, [
        el('div', { class: ('stat-v ' + sizeCls + ' ' + (cls || '')).trim().replace(/\s+/g, ' '), text: value }),
        el('div', { class: 'stat-k', text: label }),
      ]);
    };
    head.appendChild(el('div', { class: 'stats' }, [
      stat('Months', String(months.length)),
      stat('Avg invested / mo', n ? fmtCur(adds / n, cur) : '-'),
      stat('Invested', last.invested != null ? fmtCur(last.invested, cur) : '-'),
      stat('Value', last.value != null ? fmtCur(last.value, cur) : '-'),
      stat('Total return', last.profitLoss != null ? (last.profitLoss >= 0 ? '+' : '') + fmtCur(last.profitLoss, cur) : '-', last.profitLoss != null ? pctClass(last.profitLoss) : ''),
      stat('Overall %', last.returnPct != null ? fmtPct(last.returnPct) : '-', last.returnPct != null ? pctClass(last.returnPct) : ''),
    ]));
    host.appendChild(head);

    host.appendChild(el('div', { class: 'chart-card' }, [
      el('h3', { text: 'Value by month' }),
      monthlyValueChart(months, cur, bname),
      el('div', { class: 'hint' }, [
        el('span', { style: 'color:#38bdf8', text: '- Value' }),
        months.some((m) => m.nifty != null) ? el('span', { style: 'color:#fbbf24', text: '   - ' + bname }) : document.createTextNode(''),
      ]),
      el('p', { class: 'note', text: 'Hover or tap a dot to see that month\'s value and return.' }),
    ]));

    // ---- insights ----
    const insights = [];
    if (best) insights.push(['Best month', ymToLabel(best.ym) + '  ' + (best.mom >= 0 ? '+' : '') + fmtCur(best.mom, cur)]);
    if (worst) insights.push(['Toughest month', ymToLabel(worst.ym) + '  ' + (worst.mom >= 0 ? '+' : '') + fmtCur(worst.mom, cur)]);
    if (winRate != null) insights.push(['Win rate', winRate + '% of months gained (' + wins + ' of ' + moms.length + ')']);
    if (moms.length) {
      const lm = moms[moms.length - 1];
      insights.push(['Latest month', ymToLabel(lm.ym) + '  ' + (lm.mom >= 0 ? '+' : '') + fmtCur(lm.mom, cur) + ' vs prior']);
    }
    const peak = Math.max.apply(null, months.map((m) => Number(m.value) || 0));
    if (peak > 0 && last.value != null) {
      const dd = ((last.value - peak) / peak) * 100;
      insights.push(['Drawdown', dd >= -0.05 ? 'At / near peak value' : Math.abs(dd).toFixed(1) + '% below peak (' + fmtCur(peak, cur) + ')']);
    }
    if (last.invested && last.value != null) {
      insights.push(['Money multiple', (last.value / last.invested).toFixed(2) + 'x of invested']);
    }
    const nm = months.filter((m) => m.nifty != null);
    if (nm.length >= 2 && last.returnPct != null) {
      const bpct = (nm[nm.length - 1].nifty / nm[0].nifty - 1) * 100;
      insights.push(['Vs ' + bname, 'You ' + fmtPct(last.returnPct) + ' vs ' + bname + ' ' + fmtPct(bpct) + ' over this span']);
    }
    if (insights.length) {
      const ins = el('div', { class: 'insight-cards' });
      insights.forEach(([k, v]) => ins.appendChild(el('div', { class: 'insight-card' }, [el('div', { class: 'ic-k', text: k }), el('div', { class: 'ic-v', text: v })])));
      host.appendChild(el('div', { class: 'chart-card' }, [el('h3', { text: 'Insights' }), ins]));
    }
  }

  const list = el('div', { class: 'snap-list' }, [
    el('div', { class: 'row-between' }, [
      el('h3', { text: 'Months' }),
      el('button', { class: 'btn ghost small', text: '+ Add month', onclick: () => openMonthForm(null) }),
    ]),
  ]);
  if (!months.length) {
    list.appendChild(el('p', { class: 'hint', text: 'No monthly data yet. Tap "Capture this month", add one manually, or import your sheet (menu) to back-fill history.' }));
  } else {
    months.map((m, i) => ({ m, prev: i > 0 ? months[i - 1] : null })).reverse().forEach(({ m, prev }) => {
      const mom = (m.value != null && prev && prev.value != null) ? m.value - prev.value : null;
      const top = el('div', { class: 'top' }, [
        el('div', { class: 'name', text: ymToLabel(m.ym) }),
        el('div', { class: 'pct ' + (m.returnPct != null ? pctClass(m.returnPct) : 'flat'), text: m.returnPct != null ? fmtPct(m.returnPct) : '-' }),
      ]);
      const momTip = 'MoM = this month\'s value minus last month\'s value.';
      const sub = el('div', { class: 'sub' }, [
        el('span', {}, ['Value ', b(m.value != null ? fmtCur(m.value, cur) : '-')]),
        mom != null
          ? el('span', { class: pctClass(mom), title: momTip }, ['MoM ', b((mom >= 0 ? '+' : '') + fmtCur(mom, cur))])
          : el('span', { class: 'flat', title: momTip, text: 'MoM -' }),
      ]);
      const line3 = el('div', { class: 'meta-line' }, [
        'Invested ' + (m.invested != null ? fmtCur(m.invested, cur) : '-')
        + '  ·  ▲' + (m.countProfit != null ? m.countProfit : '-') + ' ▼' + (m.countLoss != null ? m.countLoss : '-')
        + (m.nifty != null ? '  ·  ' + bname + ' ' + m.nifty : ''),
      ]);
      list.appendChild(el('div', { class: 'card', onclick: () => openMonthForm(m) }, [top, sub, line3]));
    });
  }
  host.appendChild(list);
}

async function captureMonth() {
  const s = summarize(state.stocks);
  const ym = thisYm();
  const existing = state.months.find((x) => x.ym === ym);
  const rec = {
    key: monthKey(state.portfolio, ym),
    portfolio: state.portfolio,
    ym,
    invested: s.hasVal ? s.invested : null,
    value: s.hasVal ? s.value : null,
    profitLoss: s.hasVal ? s.pl : null,
    returnPct: s.hasVal ? Math.round(s.plPct * 100) / 100 : null,
    countProfit: s.up,
    countLoss: s.down,
    nifty: existing ? existing.nifty : null,
    source: 'capture',
    updatedAt: new Date().toISOString(),
  };
  await syncNifty(rec);
  await DB.put('monthly', rec);
  toast('Saved ' + ymToLabel(ym));
  refresh();
}

// Nifty 50 is one market value - propagate it across the portfolios that share
// that benchmark. me-in <-> wife-in share Nifty; me-us (Nasdaq) is alone.
async function syncNifty(rec) {
  if (rec.portfolio !== 'me-in' && rec.portfolio !== 'wife-in') return;
  const peer = rec.portfolio === 'me-in' ? 'wife-in' : 'me-in';
  const peerRec = await DB.get('monthly', monthKey(peer, rec.ym));
  if (rec.nifty == null && peerRec && peerRec.nifty != null) {
    rec.nifty = peerRec.nifty; // fill missing from peer
  } else if (rec.nifty != null && peerRec && peerRec.nifty !== rec.nifty) {
    peerRec.nifty = rec.nifty; // push to existing peer (no new empty months created)
    peerRec.updatedAt = new Date().toISOString();
    await DB.put('monthly', peerRec);
  }
}

async function syncNiftyAll() {
  const [me, wife] = await Promise.all([DB.byPortfolio('monthly', 'me-in'), DB.byPortfolio('monthly', 'wife-in')]);
  const meBy = {}, wifeBy = {};
  me.forEach((m) => { meBy[m.ym] = m; });
  wife.forEach((m) => { wifeBy[m.ym] = m; });
  const writes = [];
  me.forEach((m) => { if (m.nifty == null && wifeBy[m.ym] && wifeBy[m.ym].nifty != null) { m.nifty = wifeBy[m.ym].nifty; writes.push(DB.put('monthly', m)); } });
  wife.forEach((m) => { if (m.nifty == null && meBy[m.ym] && meBy[m.ym].nifty != null) { m.nifty = meBy[m.ym].nifty; writes.push(DB.put('monthly', m)); } });
  await Promise.all(writes);
}

function openMonthForm(existing) {
  const isEdit = !!existing;
  const m = existing || {};
  const monthInput = el('input', { type: 'month', value: m.ym || thisYm() });
  const invested = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.invested != null ? m.invested : '', placeholder: '0' });
  const value = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.value != null ? m.value : '', placeholder: '0' });
  const nifty = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.nifty != null ? m.nifty : '', placeholder: benchmarkName(state.portfolio) + ' level' });
  const cp = el('input', { type: 'number', inputmode: 'numeric', step: '1', value: m.countProfit != null ? m.countProfit : '', placeholder: '0' });
  const cl = el('input', { type: 'number', inputmode: 'numeric', step: '1', value: m.countLoss != null ? m.countLoss : '', placeholder: '0' });

  const save = async () => {
    const ym = monthInput.value;
    if (!ym) { toast('Pick a month'); return; }
    const inv = num(invested.value), val = num(value.value);
    const rec = {
      key: monthKey(state.portfolio, ym),
      portfolio: state.portfolio,
      ym,
      invested: inv,
      value: val,
      profitLoss: (inv != null && val != null) ? val - inv : null,
      returnPct: (inv && val != null) ? Math.round(((val - inv) / inv) * 10000) / 100 : null,
      countProfit: num(cp.value),
      countLoss: num(cl.value),
      nifty: num(nifty.value),
      source: m.source || 'manual',
      updatedAt: new Date().toISOString(),
    };
    if (isEdit && existing.ym !== ym) await DB.del('monthly', existing.key); // month changed -> drop old key
    await syncNifty(rec);
    await DB.put('monthly', rec);
    closeModal();
    toast('Saved ' + ymToLabel(ym));
    refresh();
  };
  const del = async () => {
    if (!confirm('Delete ' + ymToLabel(existing.ym) + '?')) return;
    await DB.del('monthly', existing.key);
    closeModal();
    toast('Deleted');
    refresh();
  };

  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: isEdit ? 'Edit month' : 'Add month' }),
    field('Month', monthInput),
    el('div', { class: 'field-row' }, [field('Invested', invested), field('Current value', value)]),
    field(benchmarkName(state.portfolio), nifty),
    el('div', { class: 'field-row' }, [field('# in profit', cp), field('# in loss', cl)]),
    el('p', { class: 'hint', text: 'Profit/Loss and return % are derived from Invested and Current value.' }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn primary', text: 'Save', onclick: save }),
    ]),
    isEdit ? el('div', { class: 'btn-row' }, [el('button', { class: 'btn danger', text: 'Delete this month', onclick: del })]) : document.createTextNode(''),
  ]));
}

async function render() {
  // Stocks app only. Home/MF surfaces are drawn by setAppMode/renderMF, and this
  // function is only ever reached via the stock nav/portfolio tabs anyway - the
  // guard keeps a stray call from un-hiding stock sections over the home screen.
  if (state.appMode !== 'stocks') return;
  updateChromeActive();
  const v = state.view;
  const holdings = v === 'holdings';
  $('#summary').classList.toggle('hidden', !holdings);
  $('#toolbar').classList.toggle('hidden', !holdings);
  $('#stockList').classList.toggle('hidden', !holdings);
  $('#monthlyView').classList.toggle('hidden', v !== 'monthly');
  $('#heatmapView').classList.toggle('hidden', v !== 'heatmap');
  $('#trendView').classList.toggle('hidden', v !== 'trends');
  $('#feedView').classList.toggle('hidden', v !== 'feed');
  $('#addBtn').classList.toggle('hidden', !holdings);
  // Camera FAB: Holdings tab only, and only on portfolios with an OCR parser.
  // wife-in is included (Groww, price-only) - see openOcrReview's priceOnly branch.
  $('#ocrBtn').classList.toggle('hidden', !holdings || !(state.portfolio === 'me-in' || state.portfolio === 'me-us' || state.portfolio === 'wife-in'));
  if (v === 'monthly') { renderMonthly(); return; }
  if (v === 'heatmap') { renderHeatmap(); return; }
  if (v === 'trends') { await renderTrends(); return; }
  if (v === 'feed') { await renderFeed(); return; }
  renderSummary();
  renderList();
  $('#search').value = state.search;
}

// ---------- top-level surface switch (Home launcher / Stocks / Mutual Funds) ----------
// Sits ABOVE the stock view system. The Stocks app renders exactly as before;
// this just decides which of the three surfaces is on screen and keeps the
// header (with the shared 3-dots menu) consistent.
const STOCK_SURFACE = ['#summary', '#toolbar', '#stockList', '#monthlyView', '#heatmapView', '#trendView', '#feedView', '#addBtn', '#ocrBtn'];
function setAppMode(mode) {
  state.appMode = mode;
  const isHome = mode === 'home', isStocks = mode === 'stocks', isMF = mode === 'mf', isFD = mode === 'fd';
  $('#homeView').classList.toggle('hidden', !isHome);
  $('#mfView').classList.toggle('hidden', !isMF);
  $('#fdView').classList.toggle('hidden', !isFD);
  $('#portfolioTabs').classList.toggle('hidden', !isStocks);
  $('#bottomNav').classList.toggle('hidden', !isStocks);
  $('#mfBottomNav').classList.toggle('hidden', !isMF);
  $('#fdBottomNav').classList.toggle('hidden', !isFD);
  $('#mfAddBtn').classList.toggle('hidden', !isMF);
  $('#mfFetchBtn').classList.toggle('hidden', !isMF);
  $('#fdAddBtn').classList.toggle('hidden', !isFD);
  $('#backBtn').classList.toggle('hidden', isHome);
  $('#appTitle').innerHTML = isHome ? '' : (isMF ? 'Mutual&nbsp;Funds' : isFD ? 'Fixed&nbsp;Deposits' : 'MyNote&nbsp;Stocks');
  if (isStocks) {
    render();
  } else {
    // Nothing from the stock surface should show on Home/MF/FD.
    STOCK_SURFACE.forEach((sel) => $(sel).classList.add('hidden'));
    if (isHome) renderHome();
    if (isMF) { buildMfBottomNav(); renderMF(); }
    if (isFD) { buildFdBottomNav(); renderFD(); }
  }
}

// Bottom nav for the MF surface (Holdings | Overview) - built once, mirrors
// the Stocks app's #bottomNav look (fixed, icon + label, active in accent).
function buildMfBottomNav() {
  const nav = $('#mfBottomNav');
  if (nav.childElementCount) { updateMfNavActive(); return; }
  nav.innerHTML = '';
  [['holdings', '📈', 'Holdings'], ['overview', '📊', 'Overview'], ['benchmark', '🎯', 'Benchmark'], ['stats', '⚖️', 'Stats']].forEach(([v, ico, label]) => {
    nav.appendChild(el('button', { 'data-view': v, onclick: () => { if (_mfTab === v) return; _mfTab = v; renderMF(); } },
      [el('span', { class: 'bn-ico', text: ico }), label]));
  });
  updateMfNavActive();
}
function updateMfNavActive() {
  $('#mfBottomNav').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.getAttribute('data-view') === _mfTab));
}

// ---------- Fixed Deposits surface (FDs | Overview | Ladder) ----------
// Mirrors the MF surface: a second fixed bottom nav (built once), lazy-loaded
// pure logic in fd.js, app.js does the `fds`-store CRUD + rendering.
function buildFdBottomNav() {
  const nav = $('#fdBottomNav');
  if (nav.childElementCount) { updateFdNavActive(); return; }
  nav.innerHTML = '';
  [['holdings', '🏦', 'FDs'], ['overview', '📊', 'Overview'], ['ladder', '🪜', 'Ladder']].forEach(([v, ico, label]) => {
    nav.appendChild(el('button', { 'data-view': v, onclick: () => { if (_fdTab === v) return; _fdTab = v; renderFD(); } },
      [el('span', { class: 'bn-ico', text: ico }), label]));
  });
  updateFdNavActive();
}
function updateFdNavActive() {
  $('#fdBottomNav').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.getAttribute('data-view') === _fdTab));
}

const _FD_MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _fdMonthLabel = (iso) => { const m = /^\d{4}-(\d{2})/.exec(iso || ''); return m ? _FD_MONS[+m[1] - 1] : ''; };

// Whole-rupee currency formatting (no paise) - used for FD interest figures
// (paisa precision doesn't matter, and it makes bank-statement comparisons
// easier to eyeball) and for the Home screen's summary/card figures. Everywhere
// else keeps the normal fmtCur (2 decimals).
const _intCurFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtIntCur = (n) => _intCurFmt.format(Math.round(Number(n) || 0));

async function renderFD() {
  const host = $('#fdView');
  host.innerHTML = '';
  const mod = await import('./fd.js');
  const fds = (await DB.byIndex('fds', 'owner', 'me')) || [];
  const now = Date.now();
  // resolveChain folds each FD's mapped parent maturity value into its effective
  // deposit (principal = fresh only). One shared cache memoizes the whole tree.
  const fdByIdR = new Map(fds.map((x) => [x.id, x]));
  const rCache = new Map();
  const rows = fds.map((f) => ({ f, c: mod.resolveChain(f, fdByIdR, now, rCache) }));
  updateFdNavActive();

  // No FDs → simple empty state (tabs would be pointless).
  if (!fds.length) {
    host.appendChild(el('section', { class: 'summary' }, [
      el('div', { class: 'label', text: 'Fixed Deposits' }),
      el('div', { class: 'big', text: fmtCur(0, 'INR') }),
    ]));
    host.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: '🏦' }),
      el('p', { text: 'No fixed deposits yet.' }),
      el('p', { class: 'hint', text: 'Tap + to add your first FD — bank, amount, rate, start & maturity dates.' }),
    ]));
    return;
  }

  // Reinvestment-chain lookups (parentFdIds links) - for card badges + supersede.
  // A new FD can merge several matured FDs, so each parent id maps to the one FD
  // that consumed it.
  const fdByIdAll = new Map(rows.map(({ f }) => [f.id, f]));
  const childByParent = new Map();
  rows.forEach(({ f }) => { mod.parentIdsOf(f).forEach((pid) => childByParent.set(pid, f)); });
  const chainOf = (f) => ({
    parents: mod.parentIdsOf(f).map((pid) => fdByIdAll.get(pid)).filter(Boolean),
    child: childByParent.get(f.id) || null,
  });

  // A matured FD is "superseded" once the FD reinvested from it (its child) has
  // ALSO matured - the newer matured FD then telescopes its principal+interest.
  // Superseded matured FDs are hidden from the holdings list (kept in the data +
  // visible in the Chain tab), so the matured list shows only the latest matured
  // link per chain and can't grow unbounded as the ladder loops. Active FDs are
  // never superseded.
  const supersededIds = new Set();
  rows.forEach(({ f, c }) => { if (c.effectiveStatus === 'matured') mod.parentIdsOf(f).forEach((pid) => supersededIds.add(pid)); });
  const activeRows = rows.filter(({ c }) => c.effectiveStatus === 'active');
  const maturedVisible = rows.filter(({ f, c }) => c.effectiveStatus === 'matured' && !supersededIds.has(f.id));
  const visibleRows = rows.filter(({ f, c }) => c.effectiveStatus === 'active' || !supersededIds.has(f.id));
  let list = _fdFilter === 'active' ? activeRows.slice() : _fdFilter === 'matured' ? maturedVisible.slice() : visibleRows.slice();

  // Totals over active FDs (the live ladder). With principal = fresh money only,
  // each active FD splits into fresh (out-of-pocket) + rolledIn (recycled from a
  // matured parent); effective principal = fresh + rolledIn.
  let totEff = 0, totFresh = 0, totRolled = 0, totCurVal = 0, totInterest = 0, monthlyIncome = 0;
  activeRows.forEach(({ c }) => {
    totEff += c.principal; totFresh += c.freshPrincipal; totRolled += c.rolledIn;
    totCurVal += c.currentValue; totInterest += c.totalInterest; monthlyIncome += c.monthlyIncome;
  });
  const totInv = totEff;   // used by the Overview allocation-by-bank below
  // Simple total return: Interest to earn ÷ effective invested. NOT annualized - a
  // ladder with longer-tenure FDs reads higher here even at the same bank rate,
  // since it's total interest over each FD's own remaining life, not per year.
  const returnPct = totEff > 0 ? (totInterest / totEff) * 100 : 0;
  // Realized interest from matured FDs (non-superseded only - the latest matured
  // link per chain, so recycled money isn't counted twice as the ladder loops).
  let interestMatured = 0;
  maturedVisible.forEach(({ c }) => { interestMatured += c.totalInterest; });

  const holdContent = el('div', { class: 'tab-content' + (_fdTab === 'holdings' ? '' : ' hidden') });
  const ovrvContent = el('div', { class: 'tab-content' + (_fdTab === 'overview' ? '' : ' hidden') });
  const ladderContent = el('div', { class: 'tab-content' + (_fdTab === 'ladder' ? '' : ' hidden') });

  // Summary card (shared by Holdings + Overview; hidden on Ladder).
  const summarySec = el('section', { class: 'summary' + (_fdTab === 'ladder' ? ' hidden' : '') }, [
    el('div', { class: 'row-between summary-top' }, [
      el('div', {}, [
        el('div', { class: 'label', text: 'Total invested value' }),
        el('div', { class: 'big', text: fmtCur(totEff, 'INR') }),
        el('div', { class: 'fd-subline', text: 'Fresh invested ' + fmtCur(totFresh, 'INR') }),
      ]),
      el('div', { class: 'summary-earned' }, [
        el('div', { class: 'label', text: 'Interest to earn' }),
        el('div', { class: 'v pos', text: fmtIntCur(totInterest) }),
      ]),
    ]),
    el('div', { class: 'grid' }, [
      _mfCell('Reinvested', fmtCur(totRolled, 'INR')),
      _mfCell('Interest matured', fmtIntCur(interestMatured), 'pos'),
      _mfCell('Return %', returnPct ? returnPct.toFixed(2) + '%' : '—'),
      _mfCell('Active FDs', String(activeRows.length)),
    ]),
  ]);

  // ---- Holdings tab: filter + sort + card list ----
  const filterSeg = el('div', { class: 'seg' }, [['active', `Active (${activeRows.length})`], ['matured', `Matured (${maturedVisible.length})`], ['all', `All (${visibleRows.length})`]].map(([v, l]) =>
    el('button', { class: (_fdFilter === v ? 'active' : ''), type: 'button', text: l, onclick: () => { _fdFilter = v; renderFD(); } })));
  const sortbar = el('div', { class: 'sortbar mf-sortbar' }, [['maturity', 'Maturity'], ['principal', 'Amount'], ['rate', 'Rate']].map(([v, l]) =>
    el('button', { class: 'sort-btn' + (_fdSort === v ? ' active' : ''), type: 'button', text: l, onclick: () => { _fdSort = v; renderFD(); } })));
  holdContent.appendChild(el('div', { class: 'toolbar mf-toolbar-top' }, [filterSeg, sortbar]));

  if (!list.length) {
    holdContent.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'e-icon', text: '🏦' }), el('p', { text: 'Nothing here.' })]));
  } else {
    list.sort((a, b2) => {
      if (_fdSort === 'principal') return b2.c.principal - a.c.principal;
      if (_fdSort === 'rate') return b2.c.rate - a.c.rate;
      if (_fdSort === 'bank') return (a.f.bank || '').localeCompare(b2.f.bank || '');
      const am = a.c.maturity ? Date.parse(a.c.maturity) : Infinity;   // maturity: soonest first
      const bm = b2.c.maturity ? Date.parse(b2.c.maturity) : Infinity;
      return am - bm;
    });
    const wrap = el('section', { class: 'stock-list' });
    list.forEach(({ f, c }) => wrap.appendChild(_fdCard(f, c, chainOf(f))));
    holdContent.appendChild(wrap);
  }
  holdContent.appendChild(el('p', { class: 'hint mf-foot', text: 'Cumulative FDs compound (quarterly by default); payout FDs return principal at maturity with interest paid out along the way. Matured FDs reinvested into a newer FD that has since also matured are hidden here (still in the chain). Not financial advice.' }));

  // ---- Overview tab: allocation by bank + income potential + next maturity ----
  const byBank = {};
  activeRows.forEach(({ f, c }) => { const k = f.bank || 'Other'; byBank[k] = (byBank[k] || 0) + c.principal; });
  const banks = Object.keys(byBank).sort((a, b2) => byBank[b2] - byBank[a]);
  if (banks.length && totInv > 0) {
    const alloc = el('div', { class: 'chart-card' }, [el('h3', { text: 'Invested by bank' })]);
    banks.forEach((bk) => {
      const pct = (byBank[bk] / totInv) * 100;
      alloc.appendChild(el('div', { class: 'bar-row' }, [
        el('span', { class: 'bl', text: bk }),
        el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, pct).toFixed(1)}%` })]),
        el('span', { class: 'bn', text: pct.toFixed(0) + '%' }),
      ]));
    });
    ovrvContent.appendChild(alloc);
  }
  ovrvContent.appendChild(el('div', { class: 'chart-card' }, [
    el('h3', { text: 'Interest income potential' }),
    el('div', { class: 'mf-goal-meta', text: `≈ ${fmtIntCur(monthlyIncome)} / month · ${fmtIntCur(monthlyIncome * 12)} / year` }),
    el('p', { class: 'hint', text: 'Average interest thrown off by your active FDs over their tenure (payout FDs use their actual periodic interest).' }),
  ]));
  const upcoming = activeRows.filter(({ c }) => c.daysToMaturity != null).sort((a, b2) => a.c.daysToMaturity - b2.c.daysToMaturity)[0];
  if (upcoming) {
    ovrvContent.appendChild(el('div', { class: 'chart-card' }, [
      el('h3', { text: 'Next maturity' }),
      el('div', { class: 'mf-goal-meta', text: `${upcoming.f.bank || 'FD'} — ${fmtCur(upcoming.c.maturityValue, 'INR')} on ${upcoming.c.maturity} (${upcoming.c.daysToMaturity} days)` }),
    ]));
  }

  // ---- Ladder tab: ACTIVE FDs only, in upcoming-maturity order ----
  // Matured FDs have already paid out and are done, so they'd just be clutter on
  // a forward-looking "what's coming due" view - the Holdings/Matured filter and
  // Chain tab are where matured history lives.
  const ladderRows = rows.filter(({ c }) => c.maturity && c.effectiveStatus === 'active').sort((a, b2) => Date.parse(a.c.maturity) - Date.parse(b2.c.maturity));
  if (!ladderRows.length) {
    ladderContent.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'e-icon', text: '🪜' }), el('p', { text: 'No upcoming maturities. Add an active FD with a maturity date to see your ladder.' })]));
  } else {
    ladderContent.appendChild(el('p', { class: 'hint', text: 'Your upcoming maturities, in order — the rungs of the ladder. A gap month means no FD matures then (no interest landing that month), so you can plug it. Tap a rung to edit.' }));
    const wrap = el('div', { class: 'fd-ladder' });
    const mkey = (iso) => (iso || '').slice(0, 7);   // YYYY-MM
    const byMonth = {};
    ladderRows.forEach((r) => { const k = mkey(r.c.maturity); (byMonth[k] = byMonth[k] || []).push(r); });
    const rung = ({ f, c }) => {
      const sub = `${fmtCur(c.principal, 'INR')} @ ${c.rate}%` + (c.daysToMaturity >= 0 ? ` · ${c.daysToMaturity}d left` : ' · due');
      return el('div', { class: 'card fd-ladder-row', onclick: () => openFdForm(f) }, [
        el('div', { class: 'fd-ladder-date' }, [
          el('div', { class: 'fd-ladder-mon', text: _fdMonthLabel(c.maturity) }),
          el('div', { class: 'fd-ladder-yr', text: (c.maturity || '').slice(0, 4) }),
        ]),
        el('div', { class: 'fd-ladder-body' }, [
          el('div', { class: 'name', text: f.bank || 'FD' }),
          el('div', { class: 'cat', text: sub }),
        ]),
        // Green badge shows the INTEREST landing at this maturity (the point of the
        // ladder) - the principal is already on the sub-line above.
        el('div', { class: 'fd-ladder-val' }, [el('span', { class: 'mf-value-card positive', text: '+' + fmtIntCur(c.totalInterest) })]),
      ]);
    };
    const gapRung = (k) => el('div', { class: 'card fd-ladder-row fd-ladder-gap' }, [
      el('div', { class: 'fd-ladder-date' }, [
        el('div', { class: 'fd-ladder-mon', text: _FD_MONS[+k.slice(5, 7) - 1] }),
        el('div', { class: 'fd-ladder-yr', text: k.slice(0, 4) }),
      ]),
      el('div', { class: 'fd-ladder-body' }, [
        el('div', { class: 'name', text: 'No maturity' }),
        el('div', { class: 'cat', text: 'No FD maturing this month' }),
      ]),
    ]);
    // Walk every month from the first rung to the last; a month with no maturing
    // FD gets a gap card so the missing interest-landing is visible (the whole
    // point of a ladder is every month having something mature). Guard caps the
    // walk at 600 months so a bad date can't spin forever.
    let [y, m] = mkey(ladderRows[0].c.maturity).split('-').map(Number);
    const [ey, em] = mkey(ladderRows[ladderRows.length - 1].c.maturity).split('-').map(Number);
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      if (byMonth[k]) byMonth[k].forEach((r) => wrap.appendChild(rung(r)));
      else wrap.appendChild(gapRung(k));
      m++; if (m > 12) { m = 1; y++; }
    }
    ladderContent.appendChild(wrap);
  }

  host.appendChild(summarySec);
  host.appendChild(holdContent);
  host.appendChild(ovrvContent);
  host.appendChild(ladderContent);
}

function _fdCard(f, c, chain) {
  const statusBadge = c.effectiveStatus === 'active'
    ? el('span', { class: 'badge good mf-beat', text: 'active' })
    : el('span', { class: 'badge muted mf-beat', text: 'matured' });
  const catLine = el('div', { class: 'cat mf-catline' }, [`${c.rate}% · ${c.comp}` + (c.payout ? ' · payout' : '')]);
  catLine.appendChild(statusBadge);
  // A compact blue "reinvested" badge flags an FD funded by rolling in matured
  // FD(s) - replaces the old "↻ from {bank}" text (which wrapped to another line)
  // and the fresh+rolled sub-line. Full breakdown lives in the Chain tab.
  const parents = (chain && chain.parents) || [];
  if (parents.length) catLine.appendChild(el('span', { class: 'badge mf-beat fd-reinvested', text: 'reinvested' }));
  if (chain && chain.child) catLine.appendChild(el('span', { class: 'badge muted mf-beat', text: 'rolled over' }));
  const matTxt = c.maturity
    ? (c.effectiveStatus === 'active'
        ? (c.daysToMaturity >= 0 ? `Matures ${c.maturity} · ${c.daysToMaturity}d` : `Due ${c.maturity}`)
        : `Matured ${c.maturity}`)
    : 'No maturity date';
  return el('div', { class: 'card', onclick: () => openFdForm(f) }, [
    el('div', { class: 'top' }, [
      el('div', { class: 'card-left' }, [
        el('div', { class: 'name', text: f.bank || 'Fixed Deposit' }),
        catLine,
      ]),
      el('div', { class: 'card-right' }, [
        el('div', { class: 'pct pos', text: '+' + fmtIntCur(c.totalInterest) }),
        el('div', { class: 'meta-line', text: 'interest' }),
      ]),
    ]),
    el('div', { class: 'sub mf-sub2' }, [
      el('span', {}, [
        el('div', {}, ['Invested ', b(fmtIntCur(c.principal))]),
        el('div', { class: 'mf-meta-mini', text: matTxt }),
      ]),
      el('span', { class: 'value-emphasis' }, ['Maturity ', _mfValueCard(c.maturityValue, c.principal, false, fmtIntCur)]),
    ]),
  ]);
}

async function openFdForm(existing) {
  const isEdit = !!(existing && existing.id != null);
  const mod = await import('./fd.js');
  const f = Object.assign({ owner: 'me', status: 'active', compounding: 'quarterly', payout: 'cumulative' }, existing || {});

  // Load every FD for the "Funded by" picker + the Chain tab (reinvestment links).
  const allFds = (await DB.byIndex('fds', 'owner', 'me')) || [];
  const nowFd = Date.now();
  const fdById = new Map(allFds.map((x) => [x.id, x]));
  const rCache = new Map();
  const compById = new Map(allFds.map((x) => [x.id, mod.resolveChain(x, fdById, nowFd, rCache)]));
  const childByParent = new Map();   // matured parent id → the FD that merged it in
  allFds.forEach((x) => { mod.parentIdsOf(x).forEach((pid) => childByParent.set(pid, x)); });

  const bankList = el('datalist', { id: 'fdbanklist' }, mod.FD_BANKS.map((x) => el('option', { value: x })));
  const bank = el('input', { type: 'text', value: f.bank || '', list: 'fdbanklist', placeholder: 'Bank / platform' });
  const numInput = (v, ph) => el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: v != null && v !== '' ? v : '', placeholder: ph });
  const principal = numInput(f.principal, 'Fresh ₹ (top-up only)');
  const rate = numInput(f.rate, 'Rate % p.a.');
  const startDate = el('input', { type: 'date', value: f.startDate || todayISO() });
  const maturityDate = el('input', { type: 'date', value: f.maturityDate || '' });
  const tenure = numInput('', 'Months');
  const compounding = el('select', {}, mod.FD_COMPOUNDING.map((x) => { const o = el('option', { value: x, text: x }); if (x === f.compounding) o.selected = true; return o; }));
  const payout = el('select', {}, [['cumulative', 'Cumulative (reinvest)'], ['payout', 'Payout (interest out)']].map(([v, l]) => { const o = el('option', { value: v, text: l }); if (v === f.payout) o.selected = true; return o; }));
  const notes = el('textarea', { placeholder: 'Your notes' });
  notes.value = f.notes || '';

  // "Funded by" — tick the matured FD(s) whose proceeds seed this one. Multiple
  // can be ticked to MERGE several matured FDs into this single new FD. Only
  // matured FDs not already consumed by another FD are offered (plus any this FD
  // already links). Sorted by maturity date (oldest first). Each parent's payout
  // adds to this FD's effective deposit; the links drive the no-double-count totals.
  const currentParentIds = new Set(mod.parentIdsOf(f));
  const eligibleParents = allFds
    .filter((x) => {
      if (x.id === f.id) return false;                              // never self
      if (compById.get(x.id).effectiveStatus !== 'matured') return false; // only matured can be a source
      const takenBy = childByParent.get(x.id);
      return !(takenBy && takenBy.id !== f.id);                     // not already consumed elsewhere
    })
    .sort((a, b2) => (Date.parse(a.maturityDate || 0) || 0) - (Date.parse(b2.maturityDate || 0) || 0));
  const parentBoxes = [];   // { id, cb }
  const parentListEl = el('div', { class: 'fd-parent-list' });
  if (!eligibleParents.length) {
    parentListEl.appendChild(el('p', { class: 'hint', text: 'No matured FDs available to merge in — this FD is funded by fresh money only.' }));
  } else {
    eligibleParents.forEach((x) => {
      const cb = el('input', { type: 'checkbox' });
      if (currentParentIds.has(x.id)) cb.checked = true;
      parentBoxes.push({ id: x.id, cb });
      const cx = compById.get(x.id);
      parentListEl.appendChild(el('label', { class: 'fd-parent-row' }, [
        cb, el('span', { text: `${x.bank || 'FD'} · ${fmtIntCur(cx.maturityValue)} · matured ${x.maturityDate || ''}` }),
      ]));
    });
  }
  const checkedParentIds = () => parentBoxes.filter((p) => p.cb.checked).map((p) => p.id);

  const buildRec = () => ({
    owner: 'me',
    bank: bank.value.trim(),
    principal: num(principal.value) || 0,   // fresh money only
    rate: num(rate.value) || 0,
    startDate: startDate.value || null,
    maturityDate: maturityDate.value || null,
    compounding: compounding.value,
    payout: payout.value,
    parentFdIds: checkedParentIds(),
    notes: notes.value.trim(),
    createdAt: f.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Seed = sum of every ticked matured parent's maturity value (its payout). The
  // new FD's deposit = that + the fresh amount typed here.
  const seedFromParent = () => checkedParentIds().reduce((s, pid) => {
    const pc = compById.get(pid);
    return s + (pc ? pc.maturityValue : 0);
  }, 0);

  const readout = el('div', { class: 'mf-bench-readout' });
  const refresh = () => {
    readout.innerHTML = '';
    const seed = seedFromParent();
    const c = mod.computeFd(buildRec(), Date.now(), seed);
    const rows = [
      el('span', {}, ['Tenure ', b(c.tenureYears ? c.tenureYears.toFixed(2) + ' yr' : '—')]),
      el('span', {}, ['Maturity ', b(c.maturity ? fmtCur(c.maturityValue, 'INR') : '—')]),
      el('span', {}, ['Interest ', b(c.maturity ? fmtIntCur(c.totalInterest) : '—')]),
    ];
    // When money is rolled in from a parent, show the effective deposit breakdown.
    if (seed > 0) rows.unshift(el('span', {}, ['Deposit ', b(fmtCur(c.principal, 'INR')), ` (${fmtCur(c.freshPrincipal, 'INR')} fresh + ${fmtCur(c.rolledIn, 'INR')} rolled)`]));
    readout.appendChild(el('div', { class: 'mf-bench-now' }, rows));
  };
  // Typing a tenure fills the maturity date from the start date; then recompute.
  tenure.addEventListener('input', () => {
    const m = num(tenure.value);
    if (m != null && startDate.value) maturityDate.value = mod.addMonths(startDate.value, m);
    refresh();
  });
  [principal, rate, compounding, payout, startDate, maturityDate].forEach((inp) => inp.addEventListener('input', refresh));
  parentBoxes.forEach((p) => p.cb.addEventListener('change', refresh));
  refresh();

  const del = async () => {
    if (!window.confirm('Delete this FD? This cannot be undone.')) return;
    await DB.del('fds', f.id); closeModal(); toast('FD deleted'); renderFD();
  };
  const save = async () => {
    if (!bank.value.trim()) { toast('Enter the bank / platform'); return; }
    if (!(num(principal.value) > 0)) { toast('Enter the principal amount'); return; }
    const rec = buildRec();
    if (isEdit) rec.id = f.id;
    await DB.put('fds', rec); closeModal(); toast(isEdit ? 'FD updated' : 'FD added'); renderFD();
  };

  // ---- Details tab (the form) ----
  const detailsContent = el('div', {}, [
    field('Bank / platform', bank),
    el('div', { class: 'field-row' }, [field('Fresh principal (top-up only)', principal), field('Rate % p.a.', rate)]),
    el('div', { class: 'field-row' }, [field('Start date', startDate), field('Maturity date', maturityDate)]),
    field('Tenure (months) → fills maturity date', tenure),
    el('div', { class: 'field-row' }, [field('Compounding', compounding), field('Type', payout)]),
    field('Funded by — tick matured FD(s) to merge in (adds their payout to your deposit)', parentListEl),
    field('Notes', notes),
    readout,
  ]);

  // ---- Chain tab: the linked FDs (this FD itself is NOT listed). Walks up via
  // parentFdIds (matured FDs merged in, transitively) and down via childByParent
  // (where this rolled into), deduped, sorted by maturity date. Reflects the LIVE
  // checkbox selection, not just what's saved.
  const chainList = el('div', { class: 'fd-chain' });
  const buildChain = () => {
    const seen = new Set([f.id]);
    const out = [];
    const upStack = checkedParentIds().slice();   // live selection
    let guard = 0;
    while (upStack.length && guard++ < 400) {
      const pid = upStack.shift();
      if (seen.has(pid)) continue;
      const p = fdById.get(pid); if (!p) continue;
      seen.add(pid); out.push(p);
      mod.parentIdsOf(p).forEach((gp) => upStack.push(gp));
    }
    let cur = f; guard = 0;
    while (cur && childByParent.get(cur.id) && guard++ < 400) {
      const ch = childByParent.get(cur.id);
      if (seen.has(ch.id)) break;
      seen.add(ch.id); out.push(ch); cur = ch;
    }
    return out.sort((a, b2) => (Date.parse(a.maturityDate || 0) || 0) - (Date.parse(b2.maturityDate || 0) || 0));
  };
  const renderChain = () => {
    chainList.innerHTML = '';
    const chain = buildChain();
    if (!chain.length) {
      chainList.appendChild(el('p', { class: 'hint', text: 'No linked FDs. Tick a matured FD under “Funded by” on the Details tab to merge it into this one — the linked FDs then show here.' }));
      return;
    }
    chain.forEach((x) => {
      const cx = compById.get(x.id);
      chainList.appendChild(el('div', { class: 'card fd-chain-row', onclick: () => openFdForm(x) }, [
        el('div', { class: 'fd-chain-body' }, [
          el('div', { class: 'name', text: x.bank || 'FD' }),
          el('div', { class: 'cat', text: `${fmtCur(cx.principal, 'INR')} @ ${cx.rate}% · ${cx.effectiveStatus}` + (x.maturityDate ? ` · mat ${x.maturityDate}` : '') }),
        ]),
        el('div', { class: 'fd-chain-int pos', text: '+' + fmtIntCur(cx.totalInterest) }),
      ]));
    });
  };
  const chainContent = el('div', { class: 'hidden' }, [
    el('p', { class: 'hint', text: 'Linked FDs — the matured FD(s) merged into this one (and where it rolls into, if any). Tap a link to open it.' }),
    chainList,
  ]);

  // ---- Tabs (Chain only when editing an existing FD) ----
  const detailsTabBtn = el('button', { class: 'active', type: 'button', text: 'Details' });
  const chainTabBtn = el('button', { type: 'button', text: 'Chain' });
  const tabs = [{ btn: detailsTabBtn, content: detailsContent }];
  if (isEdit) tabs.push({ btn: chainTabBtn, content: chainContent });
  const showTab = (which) => {
    tabs.forEach((t) => { const on = t === which; t.btn.classList.toggle('active', on); t.content.classList.toggle('hidden', !on); });
    if (which.btn === chainTabBtn) renderChain();
  };
  detailsTabBtn.addEventListener('click', () => showTab(tabs[0]));
  if (isEdit) chainTabBtn.addEventListener('click', () => showTab(tabs[1]));

  const scrollChildren = [
    el('h2', { text: isEdit ? (f.bank || 'Edit FD') : 'Add fixed deposit' }),
    el('div', { class: 'seg' }, isEdit ? [detailsTabBtn, chainTabBtn] : [detailsTabBtn]),
    bankList,
    detailsContent,
    ...(isEdit ? [chainContent] : []),
  ];
  const btns = [el('button', { class: 'btn primary', text: 'Save', onclick: save })];
  if (isEdit) btns.push(el('button', { class: 'btn danger', text: 'Delete', onclick: del }));
  btns.push(el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }));
  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, scrollChildren),
    el('div', { class: 'sheet-footer' }, [el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, btns)]),
  ]));
}

async function renderHome() {
  const host = $('#homeView');
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'home-hero' }, [
    el('h2', { class: 'home-title', text: 'MyNotes' }),
    el('p', { class: 'home-tag', text: 'Private tracker - everything stays on this device.' }),
  ]));

  // Calculate total invested and earned across both Stocks and Mutual Funds
  let totalInvested = 0, totalValue = 0;
  try {
    // Stocks — Me-India only (holdings, not sold). SGB gold bonds excluded here -
    // they'll be tracked under a future Metal Investment surface, not Stocks.
    const meInStocks = (await DB.byPortfolio('stocks', 'me-in')) || [];
    for (const s of meInStocks) {
      if (s.status === 'holding' && !/sgb/i.test(s.name || '')) {
        totalInvested += Number(s.units || 0) * Number(s.buyPrice || 0);
        totalValue += Number(s.units || 0) * Number(s.currentPrice || 0);
      }
    }
    // Mutual Funds — Investing only (exclude Sold, matches the MF card subtext below)
    const funds = await DB.byIndex('funds', 'owner', 'me') || [];
    for (const f of funds) {
      if (f.status === 'Sold' || f.soldDate) continue;
      const c = await import('./mf.js').then(mod => mod.computeFund(f, Date.now())).catch(() => null);
      if (c) {
        totalInvested += c.invested || 0;
        totalValue += c.value || 0;
      }
    }
    // Fixed Deposits — MATURED, but NOT superseded by a matured child. In a
    // reinvestment ladder each new FD's principal already telescopes the previous
    // matured FD's principal + interest, so counting every matured FD would count
    // the same rupees each cycle. A matured FD is "superseded" if the FD it was
    // reinvested into (its child, via parentFdIds) has ALSO matured - then that
    // newer matured FD already contains its money, so we skip the older one and
    // count only the latest matured link in each chain. Active FDs stay excluded
    // (still-locked capital, tracked in the FD surface's own totals); a matured
    // FD whose child is still active IS counted (its principal = all recycled
    // principal+interest to date, its interest = the freshly realized gain).
    const fds = (await DB.byIndex('fds', 'owner', 'me')) || [];
    if (fds.length) {
      const fdMod = await import('./fd.js');
      const nowT = Date.now();
      const fdByIdH = new Map(fds.map((x) => [x.id, x]));
      const fdCacheH = new Map();
      const fdComp = new Map(fds.map((x) => [x.id, fdMod.resolveChain(x, fdByIdH, nowT, fdCacheH)]));
      const supersededIds = new Set();
      fds.forEach((x) => {
        if (fdComp.get(x.id).effectiveStatus === 'matured') fdMod.parentIdsOf(x).forEach((pid) => supersededIds.add(pid));
      });
      for (const fdRec of fds) {
        const c = fdComp.get(fdRec.id);
        if (c.effectiveStatus !== 'matured') continue;   // active/broken excluded
        if (supersededIds.has(fdRec.id)) continue;        // older link in a chain - already telescoped into a newer matured FD
        totalInvested += c.principal;
        totalValue += c.maturityValue;
      }
    }
  } catch (_) {}

  // Earned is derived from the exact same (filtered) invested/value totals above -
  // same stocks + funds included, nothing computed on a separate dataset.
  const totalEarned = totalValue - totalInvested;
  const totalEarnedPct = totalInvested > 0 ? (totalEarned / totalInvested) * 100 : 0;
  const summaryCard = el('div', { class: 'home-summary' }, [
    el('div', { class: 'summary-stat' }, [
      el('div', { class: 'stat-label', text: 'Total Invested' }),
      el('div', { class: 'stat-value', text: fmtIntCur(totalInvested) }),
    ]),
    el('div', { class: 'summary-stat' }, [
      el('div', { class: 'stat-label', text: 'Total Earned' }),
      el('div', { class: 'stat-value' }, [fmtIntCur(totalEarned) + ' ', el('span', { class: 'summary-badge ' + pctClass(totalEarnedPct), text: fmtPct(totalEarnedPct) })]),
    ]),
  ]);
  host.appendChild(summaryCard);

  const stockCard = _homeCard('📈', 'Stocks', 'Holdings · trends · news', () => setAppMode('stocks'));
  const mfCard = _homeCard('📊', 'Mutual Funds', 'SIPs · XIRR · 2030 goal', () => openMF());
  const fdCard = _homeCard('🏦', 'Fixed Deposits', 'FD ladder · maturity · interest', () => setAppMode('fd'));
  host.appendChild(el('div', { class: 'home-cards' }, [stockCard, mfCard, fdCard]));
  host.appendChild(el('p', { class: 'hint home-foot', text: 'Backup covers everything - open the ⋮ menu → Backup & Restore.' }));

  // Live stats for Stock and MF cards
  try {
    // Stocks — Holdings only (exclude Sold + SGB gold bonds, matches totals above)
    const meInStocks = (await DB.byPortfolio('stocks', 'me-in')) || [];
    const holdings = meInStocks.filter(s => s.status === 'holding' && !/sgb/i.test(s.name || ''));
    const stockSub = stockCard.querySelector('.home-card-sub');
    if (holdings.length && stockSub) {
      const invested = holdings.reduce((s, stock) => s + (Number(stock.units || 0) * Number(stock.buyPrice || 0)), 0);
      stockSub.textContent = `${holdings.length} stocks · ${fmtIntCur(invested)} invested`;
    }
    // Mutual Funds — Investing only (exclude Sold; same "sold" definition mf.js
    // uses elsewhere - status='Sold' OR a soldDate is set). Invested uses mf.js's
    // investedOf() (average-cost-basis rollup) - not a raw sum of contribution
    // amounts, which would wrongly add a partial-sell row's proceeds as if it
    // were money invested.
    const funds = (await DB.byIndex('funds', 'owner', 'me')) || [];
    const investing = funds.filter(f => f.status !== 'Sold' && !f.soldDate);
    const sub = mfCard.querySelector('.home-card-sub');
    if (investing.length && sub) {
      const mfMod = await import('./mf.js');
      const invested = investing.reduce((s, f) => s + (mfMod.investedOf(f) || 0), 0);
      sub.textContent = `${investing.length} funds · ${fmtIntCur(invested)} invested`;
    }
    // Fixed Deposits — subtext shows the active count + Total invested value,
    // matching the FD Overview's headline (= active-FD principal only).
    const fdList = (await DB.byIndex('fds', 'owner', 'me')) || [];
    if (fdList.length) {
      const fdMod = await import('./fd.js');
      const nowT = Date.now();
      const fdByIdC = new Map(fdList.map((x) => [x.id, x]));
      const fdCacheC = new Map();
      const activeFds = fdList.map((x) => fdMod.resolveChain(x, fdByIdC, nowT, fdCacheC)).filter((c) => c.effectiveStatus === 'active');
      const activeCount = activeFds.length;
      const invested = activeFds.reduce((s, c) => s + (Number(c.principal) || 0), 0);
      const fdSub = fdCard.querySelector('.home-card-sub');
      if (fdSub) fdSub.textContent = `${activeCount} active · ${fmtIntCur(invested)} invested`;
    }
  } catch (_) {}
}
function _homeCard(icon, title, sub, onclick) {
  return el('button', { class: 'home-card', type: 'button', onclick }, [
    el('span', { class: 'home-card-ico', text: icon }),
    el('span', { class: 'home-card-body' }, [
      el('span', { class: 'home-card-title', text: title }),
      el('span', { class: 'home-card-sub', text: sub }),
    ]),
    el('span', { class: 'home-card-arrow', text: '›' }),
  ]);
}

// ---------- Mutual Funds surface ----------
// Lazy-loaded: mf.js (logic + seed data) only loads when the user opens MF.
async function openMF() {
  try {
    const existing = await DB.byIndex('funds', 'owner', 'me');
    if (!existing || !existing.length) {
      // Seed the 11 funds from the sheet once. The flag stops them reappearing
      // if the user later deletes everything.
      const seeded = await DB.get('meta', 'mfSeeded').catch(() => null);
      if (!seeded || !seeded.value) {
        const mod = await import('./mf.js');
        const now = Date.now();
        for (const s of mod.SEED_FUNDS) await DB.put('funds', mod.buildSeedFund(s, now));
        await DB.put('meta', { key: 'mfSeeded', value: true });
      }
    }
    // One-time: add Quant Mid Cap as a Sold entry so it shows on the Sold tab.
    // Seeded as a stub (no fabricated figures) - the user fills invested + sold
    // value/date from Paytm Money. Guarded so it's added only once.
    const midDone = await DB.get('meta', 'mfMidCapAdded').catch(() => null);
    if (!midDone || !midDone.value) {
      const all = (await DB.byIndex('funds', 'owner', 'me')) || [];
      if (!all.some((x) => /quant\s*mid\s*cap/i.test(x.name || ''))) {
        const iso = new Date().toISOString();
        await DB.put('funds', {
          owner: 'me', name: 'Quant Mid Cap Fund Direct - Growth', type: 'Mid Cap',
          category: 'Equity', benchmark: '', status: 'Sold', sip: 0, targetYear: 2030,
          benchXirr: null, goodReturn: '', judgeAfter: '',
          remarks: 'Sold - tap to add your invested amounts and the sold value/date.',
          contributions: [], valueHistory: [], valueAsOf: null,
          soldValue: null, soldDate: null, seedXirrRef: null,
          xirrLow: null, xirrHigh: null, returnLow: null, returnHigh: null,
          seeded: false, createdAt: iso, updatedAt: iso,
        });
      }
      await DB.put('meta', { key: 'mfMidCapAdded', value: true });
    }
  } catch (e) { console.error('MF seed failed', e); }
  setAppMode('mf');
}

const _mfCell = (k, v, cls) => el('div', { class: 'cell' }, [
  el('div', { class: 'k', text: k }),
  el('div', { class: 'v ' + (cls || ''), text: v }),
]);

async function renderMF() {
  const host = $('#mfView');
  host.innerHTML = '';
  const mod = await import('./mf.js');
  const funds = (await DB.byIndex('funds', 'owner', 'me')) || [];
  const now = Date.now();
  const rows = funds.map((f) => ({ f, c: mod.computeFund(f, now) }));

  // No funds at all → simple empty state (tabs would be pointless).
  if (!funds.length) {
    updateMfNavActive();
    host.appendChild(el('section', { class: 'summary' }, [
      el('div', { class: 'label', text: 'Current value' }),
      el('div', { class: 'big', text: fmtCur(0, 'INR') }),
    ]));
    host.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: '📊' }),
      el('p', { text: 'No funds yet.' }),
      el('p', { class: 'hint', text: 'Tap + to add your first mutual fund.' }),
    ]));
    return;
  }

  // Holding vs sold split (SIP state is irrelevant - a paused SIP is still held).
  const soldRows = rows.filter(({ c }) => c.sold);
  const heldRows = rows.filter(({ c }) => !c.sold);
  const viewSold = _mfFilter === 'sold';
  const list = (viewSold ? soldRows : heldRows).slice();

  // Totals over the funds currently shown.
  let totInv = 0, totVal = 0, aboveBench = 0, benchCount = 0, wSum = 0, wW = 0;
  list.forEach(({ c }) => {
    totInv += c.invested; totVal += c.value;
    if (c.benchStatus) { benchCount++; if (c.benchStatus === 'above') aboveBench++; }
    if (c.xirr != null && c.value > 0) { wSum += c.xirr * c.value; wW += c.value; }
  });
  const gainPct = totInv > 0 ? ((totVal - totInv) / totInv) * 100 : 0;
  const wXirr = wW > 0 ? (wSum / wW) * 100 : null;

  // Tab: Holdings (fund list) | Overview (summary + allocation) | Benchmark - the fixed
  // #mfBottomNav (built by setAppMode) drives the tab, this just syncs its active state.
  updateMfNavActive();

  // Show FABs only on Holdings tab (+ ☁️ NAV fetch also on Stats, since Stats
  // data is populated by that same fetch).
  $('#mfAddBtn').classList.toggle('hidden', _mfTab !== 'holdings');
  $('#mfFetchBtn').classList.toggle('hidden', _mfTab !== 'holdings' && _mfTab !== 'stats');
  // ☁️ is normally docked left of the + FAB (fab-secondary's fixed offset assumes
  // + is there). On Stats, + is hidden, so ☁️ would float with an empty gap where
  // + used to be - .solo docks it to the corner + would have occupied instead.
  $('#mfFetchBtn').classList.toggle('solo', _mfTab === 'stats');

  // Holdings tab content: fund list with filter/sort
  const holdContent = el('div', { class: 'tab-content' + (_mfTab === 'holdings' ? '' : ' hidden') });
  const ovrvContent = el('div', { class: 'tab-content' + (_mfTab === 'overview' ? '' : ' hidden') });
  const benchContent = el('div', { class: 'tab-content' + (_mfTab === 'benchmark' ? '' : ' hidden') });
  const statsContent = el('div', { class: 'tab-content' + (_mfTab === 'stats' ? '' : ' hidden') });

  // Summary (shown in Overview tab only)
  const cells = [
    _mfCell('Invested', fmtCur(totInv, 'INR')),
    _mfCell('Returns Earned', fmtCur(totVal - totInv, 'INR'), pctClass(gainPct)),
    _mfCell(viewSold ? 'Realized XIRR' : 'Portfolio XIRR', wXirr != null ? fmtPct(wXirr) : '-', wXirr != null ? pctClass(wXirr) : ''),
    _mfCell('Above benchmark', benchCount ? `${aboveBench} of ${benchCount}` : '-'),
  ];

  // Summary is common to Holdings/Overview tabs only (hidden for Benchmark/Stats tabs).
  // Current value + Current Return share the top row (value on the left,
  // gain % on the right).
  const summarySec = el('section', { class: 'summary' + (_mfTab === 'benchmark' || _mfTab === 'stats' ? ' hidden' : '') }, [
    el('div', { class: 'row-between summary-top' }, [
      el('div', {}, [
        el('div', { class: 'label', text: viewSold ? 'Realized value' : 'Current value' }),
        el('div', { class: 'big', text: fmtCur(totVal, 'INR') }),
      ]),
      el('div', { class: 'summary-earned' }, [
        el('div', { class: 'label', text: viewSold ? 'Realized gain' : 'Current Return' }),
        el('div', { class: 'v ' + pctClass(gainPct), text: fmtPct(gainPct) }),
      ]),
    ]),
    el('div', { class: 'grid' }, cells),
  ]);

  // Filter + Sort + Update button (top of holdings tab)
  const filterSeg = el('div', { class: 'seg' }, [['investing', `Investing (${heldRows.length})`], ['sold', `Sold (${soldRows.length})`]].map(([v, l]) =>
    el('button', { class: (_mfFilter === v ? 'active' : ''), 'data-filter': v, type: 'button', text: l, onclick: () => { _mfFilter = v; renderMF(); } })));
  const sortbar = el('div', { class: 'sortbar mf-sortbar' }, [['xirr', 'XIRR'], ['ret', 'Return'], ['inv', 'Invested'], ['name', 'Name']].map(([v, l]) =>
    el('button', { class: 'sort-btn' + (_mfSort === v ? ' active' : ''), type: 'button', text: l, onclick: () => { _mfSort = v; renderMF(); } })));
  const toolbarTop = el('div', { class: 'toolbar mf-toolbar-top' }, [filterSeg, sortbar]);

  holdContent.appendChild(toolbarTop);

  if (!list.length) {
    holdContent.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: viewSold ? '🧾' : '📈' }),
      el('p', { text: viewSold ? 'No sold funds.' : 'No funds you are holding.' }),
    ]));
  } else {
    list.sort((a, b) => {
      if (_mfSort === 'name') return (a.f.name || '').localeCompare(b.f.name || '');
      if (_mfSort === 'inv') return b.c.invested - a.c.invested;
      if (_mfSort === 'ret') return b.c.absReturnPct - a.c.absReturnPct;
      const av = a.c.xirr == null ? -Infinity : a.c.xirr, bv = b.c.xirr == null ? -Infinity : b.c.xirr;
      return bv - av;
    });

    const listWrap = el('section', { class: 'stock-list' });
    list.forEach(({ f, c }) => listWrap.appendChild(_mfCard(f, c)));
    holdContent.appendChild(listWrap);
  }

  holdContent.appendChild(el('p', { class: 'hint mf-foot', text: viewSold
    ? 'Sold funds show your realized XIRR - from your dated investments to the sold value. Not investment advice.'
    : 'XIRR is computed from your dated investments. Funds marked "(sheet)" still use your sheet\'s figure - add a real investment to switch to app-computed XIRR. Not investment advice.' }));

  // Overview tab content: allocation (summary is common, rendered above both tabs).
  const byType = {};
  list.forEach(({ f, c }) => { const k = f.type || 'Other'; byType[k] = (byType[k] || 0) + c.invested; });
  const types = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
  if (types.length && totInv > 0) {
    const alloc = el('div', { class: 'chart-card' }, [el('h3', { text: 'Allocation by type' })]);
    types.forEach((t) => {
      const pct = (byType[t] / totInv) * 100;
      alloc.appendChild(el('div', { class: 'bar-row' }, [
        el('span', { class: 'bl', text: t }),
        el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, pct).toFixed(1)}%` })]),
        el('span', { class: 'bn', text: pct.toFixed(0) + '%' }),
      ]));
    });
    ovrvContent.appendChild(alloc);
  }

  // Top/Bottom performers by return
  if (list.length > 0) {
    const sorted = [...list].sort((a, b) => b.c.absReturnPct - a.c.absReturnPct);
    const topBottom = el('div', { class: 'chart-card' }, [el('h3', { text: 'Top & bottom performers' })]);
    const top3 = sorted.slice(0, 3);
    const bottom3 = sorted.slice(-3).reverse();
    [['Top', top3, 'mf-perf-top'], ['Bottom', bottom3, 'mf-perf-bottom']].forEach(([label, funds, cls]) => {
      topBottom.appendChild(el('div', { class: 'mf-perf-section' }, [
        el('div', { class: 'mf-perf-label', text: label }),
        el('div', { class: cls }, funds.map(({ f, c }) =>
          el('div', { class: 'mf-perf-item' }, [
            el('span', { class: 'mf-perf-name', text: f.name.length > 25 ? f.name.substring(0, 22) + '…' : f.name }),
            el('span', { class: 'mf-perf-ret ' + pctClass(c.absReturnPct), text: fmtPct(c.absReturnPct) }),
          ]))),
      ]));
    });
    ovrvContent.appendChild(topBottom);
  }

  // Performance attribution: top gains in INR
  if (list.length > 0) {
    const byGain = [...list].map(({ f, c }) => ({ f, c, gain: c.value - c.invested })).sort((a, b) => b.gain - a.gain);
    const topGain = byGain.slice(0, 5);
    const attr = el('div', { class: 'chart-card' }, [el('h3', { text: 'Top contributors (absolute gain)' })]);
    topGain.forEach(({ f, c, gain }) => {
      attr.appendChild(el('div', { class: 'bar-row' }, [
        el('span', { class: 'bl', text: f.name.length > 20 ? f.name.substring(0, 17) + '…' : f.name }),
        el('span', { class: 'bar-track' }, [el('span', { class: 'bar-fill', style: `width:${Math.max(2, (gain / (byGain[0].gain || 1)) * 100).toFixed(1)}%` })]),
        el('span', { class: 'bn', text: fmtCur(gain, 'INR') }),
      ]));
    });
    ovrvContent.appendChild(attr);
  }

  // Goal progress: toward 2030 target
  if (!viewSold && totVal > 0) {
    let target2030 = 0;
    heldRows.forEach(({ c }) => {
      if (c.targetYear === 2030 && c.projCorpusStay != null) target2030 += c.projCorpusStay;
    });
    if (target2030 > 0) {
      const progress = Math.min(100, (totVal / target2030) * 100);
      const goalCard = el('div', { class: 'chart-card' }, [
        el('h3', { text: '2030 Goal progress' }),
        el('div', { class: 'mf-goal-row' }, [
          el('span', { class: 'mf-goal-current', text: fmtCur(totVal, 'INR') }),
          el('span', { class: 'mf-goal-track' }, [el('div', { class: 'mf-goal-fill', style: `width:${progress}%` })]),
          el('span', { class: 'mf-goal-target', text: fmtCur(target2030, 'INR') }),
        ]),
        el('div', { class: 'mf-goal-meta', text: progress.toFixed(0) + '% toward target' }),
      ]);
      ovrvContent.appendChild(goalCard);
    }
  }

  // Benchmark tab content: sub-tabs for Returns and XIRR with different color schemes
  const benchRetContent = el('div', { class: 'tab-content' + (_mfBenchTab === 'returns' ? '' : ' hidden') });
  const benchXirrContent = el('div', { class: 'tab-content' + (_mfBenchTab === 'xirr' ? '' : ' hidden') });

  // Interpolate the current-value badge colour along the same gradient the bar uses,
  // so a value near the low end reads light (light-green for Returns / yellow for XIRR)
  // and near the high end reads dark (dark-green / orange). Endpoints are read from the
  // --bench-*-light/dark CSS vars so both themes stay correct; text flips to dark on
  // light backgrounds for contrast.
  const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hexToRgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((ch) => ch + ch).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
  const badgeStyle = (scheme, t) => {
    const lo = hexToRgb(readVar('--bench-' + scheme + '-light') || '#86efac');
    const hi = hexToRgb(readVar('--bench-' + scheme + '-dark') || '#16a34a');
    const mix = lo.map((v, i) => Math.round(v + (hi[i] - v) * t));
    const lum = 0.299 * mix[0] + 0.587 * mix[1] + 0.114 * mix[2];
    return `background:rgb(${mix[0]},${mix[1]},${mix[2]});color:${lum > 150 ? '#0b1220' : '#fff'}`;
  };

  // Helper to create benchmark visualization with custom gradient.
  // `metricPct` must already be a percent NUMBER (e.g. 79.27 for 79.27%) — same unit
  // fmtPct expects. f.benchReturnLow/High and f.benchXirrLow/High are stored as
  // DECIMALS (e.g. 0.1 for 10%), so those need *100 to reach percent-number form;
  // metricPct (c.absReturnPct / c.xirrPct from mf.js) is percent-number already and
  // must NOT be multiplied or divided again — that double-conversion was the bug
  // behind "79.27% shows as 0.79%".
  // Low/high bound: the user's manual target wins when set (same priority as
  // mf.js's benchStatus); otherwise falls back to the fund's own auto-tracked
  // historical range. That range comes from `c.liveReturnLow/High` /
  // `c.liveXirrLow/High` (mf.js), NOT the raw stored f.returnLow/High - the
  // stored fields only move on the next save, so reading them straight would
  // show a stale high the moment current beats it, even though the status
  // badge already says "above" (the exact bug reported: current 20.25% vs a
  // stored high still showing 20.11%). The live fields fold today's reading
  // into the bound immediately, before any save persists it.
  const createBenchViz = (funds, metricPct, metricKey, colorScheme) => {
    const container = el('div', { class: 'mf-bench-list' });
    funds.forEach(({ f, c }) => {
      const manualLowKey = metricKey === 'return' ? 'benchReturnLow' : 'benchXirrLow';
      const manualHighKey = metricKey === 'return' ? 'benchReturnHigh' : 'benchXirrHigh';
      const manualLow = f[manualLowKey] != null ? f[manualLowKey] * 100 : null;
      const manualHigh = f[manualHighKey] != null ? f[manualHighKey] * 100 : null;
      const obsLow = metricKey === 'return' ? c.liveReturnLow : c.liveXirrLow;
      const obsHigh = metricKey === 'return' ? c.liveReturnHigh : c.liveXirrHigh;
      const current = metricPct || 0;
      let low = manualLow != null ? manualLow : (obsLow != null ? obsLow : 0);
      let high = manualHigh != null ? manualHigh : (obsHigh != null ? obsHigh : (metricKey === 'return' ? 30 : 15));
      // The drawn bar must always contain `current`. A MANUAL high/low is a fixed
      // target ("never changed automatically"), so when current shoots past it the
      // bound can't grow on its own — the marker would pin at the edge with its
      // badge dangling past the labelled bound (the reported bug: high shows 20.11
      // but current is 23.71). Expand the DISPLAYED range to swallow current so it
      // renders as the new peak/low instead. Stored manual target is untouched.
      if (current > high) high = current;
      if (current < low) low = current;
      // At the high threshold = all-time high (🏆, green). At the low threshold =
      // all-time low (🔻, red). Peak wins if somehow both (degenerate zero range).
      const isAtPeak = Math.abs(current - high) < 0.01;
      const isAtLow = !isAtPeak && Math.abs(current - low) < 0.01;
      const range = high - low;
      const position = range !== 0 ? ((current - low) / range) * 100 : 100;
      const clampedPct = Math.max(0, Math.min(100, position));
      const lowLabel = isAtLow
        ? el('span', { class: 'mf-bench-bottom', text: fmtPct(current) + ' 🔻', title: 'All-time low!' })
        : el('span', { class: 'mf-bench-low', text: fmtPct(low) });
      const highLabel = isAtPeak
        ? el('span', { class: 'mf-bench-peak', text: fmtPct(current) + ' 🏆', title: 'All-time high!' })
        : el('span', { class: 'mf-bench-high', text: fmtPct(high) });
      const trackChildren = [
        el('div', { class: 'mf-bench-fill', style: `width:${clampedPct}%` }),
        el('span', { class: 'mf-bench-marker', style: `left:${clampedPct}%`, title: 'Current: ' + fmtPct(current) }),
      ];
      // Current-value badge sits below the marker dot, colour-graded by position.
      // Skipped for peak/low rows since the value already shows in the 🏆/🔻 label.
      if (!isAtPeak && !isAtLow) {
        trackChildren.push(el('span', { class: 'mf-bench-value-badge', style: `left:${clampedPct}%;${badgeStyle(colorScheme, clampedPct / 100)}`, text: fmtPct(current) }));
      }
      const barElements = [
        lowLabel,
        el('div', { class: 'mf-bench-track ' + colorScheme }, trackChildren),
        highLabel,
      ];
      const rowChildren = [
        el('div', { class: 'mf-bench-name' }, f.name),
        el('div', { class: 'mf-bench-bar' }, barElements),
      ];
      const rowCls = 'mf-bench-row' + (isAtPeak ? ' mf-bench-peak-row' : isAtLow ? ' mf-bench-bottom-row' : ' mf-bench-row--badge');
      container.appendChild(el('div', { class: rowCls }, rowChildren));
    });
    return container;
  };

  // Returns tab (Red-Green gradient)
  if (heldRows.length > 0) {
    const retList = el('div');
    heldRows.forEach(({ f, c }) => {
      const vizNode = createBenchViz([{ f, c }], c.absReturnPct || 0, 'return', 'ret');
      retList.appendChild(vizNode.firstChild);
    });
    benchRetContent.appendChild(retList);
  }

  // XIRR tab (Orange-Yellow gradient)
  if (heldRows.length > 0) {
    const xirrList = el('div');
    heldRows.forEach(({ f, c }) => {
      const vizNode = createBenchViz([{ f, c }], c.xirrPct || 0, 'xirr', 'xirr');
      xirrList.appendChild(vizNode.firstChild);
    });
    benchXirrContent.appendChild(xirrList);
  }

  // Add sub-tabs to Benchmark tab
  const benchRetBtn = el('button', { class: 'sort-btn' + (_mfBenchTab === 'returns' ? ' active' : ''), type: 'button', text: 'Returns', onclick: () => { _mfBenchTab = 'returns'; renderMF(); } });
  const benchXirrBtn = el('button', { class: 'sort-btn' + (_mfBenchTab === 'xirr' ? ' active' : ''), type: 'button', text: 'XIRR', onclick: () => { _mfBenchTab = 'xirr'; renderMF(); } });
  benchContent.appendChild(el('div', { class: 'mf-bench-tabs' }, [benchRetBtn, benchXirrBtn]));
  benchContent.appendChild(benchRetContent);
  benchContent.appendChild(benchXirrContent);

  // Stats tab: Day / Month / Year NAV change per fund vs Nifty 50 (index-fund
  // proxy — mfapi.in has no direct Nifty index endpoint). Populated by the ☁️
  // NAV fetch (fetchMfNavs), which stores only the computed deltas per fund
  // (f.stats = {d1,m1,y1,asOf}) and one Nifty reading in meta.mfNiftyStats —
  // not raw daily history, so the on-device footprint stays negligible.
  const STATS_PERIODS = { day: 'd1', month: 'm1', year: 'y1' };
  const statsKey = STATS_PERIODS[_mfStatsTab];
  const niftyStatsMeta = await DB.get('meta', 'mfNiftyStats').catch(() => null);
  const niftyStats = niftyStatsMeta && niftyStatsMeta.value;
  const anyFundStats = heldRows.some(({ f }) => f.stats && f.stats[statsKey] != null);
  const badgeClassFor = (cls) => (cls === 'pos' ? 'good' : cls === 'neg' ? 'bad' : 'muted');

  const statsSubTabs = el('div', { class: 'mf-bench-tabs' }, [['day', 'Day'], ['month', 'Month'], ['year', 'Year']].map(([v, l]) =>
    el('button', { class: 'sort-btn' + (_mfStatsTab === v ? ' active' : ''), type: 'button', text: l, onclick: () => { _mfStatsTab = v; renderMF(); } })));
  statsContent.appendChild(statsSubTabs);

  if (!heldRows.length) {
    statsContent.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: '⚖️' }),
      el('p', { text: 'No funds you are holding.' }),
    ]));
  } else if (!anyFundStats) {
    statsContent.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'e-icon', text: '⚖️' }),
      el('p', { text: 'No stats yet.' }),
      el('p', { class: 'hint', text: 'Tap ☁️ to fetch NAV history and compare against Nifty 50 (needs internet).' }),
    ]));
  } else {
    const niftyPct = niftyStats ? niftyStats[statsKey] : null;
    statsContent.appendChild(el('div', { class: 'mf-stats-nifty' }, [
      el('span', { text: 'Nifty 50 (index fund proxy)' }),
      el('span', { class: 'mf-stats-pct ' + (niftyPct != null ? pctClass(niftyPct) : 'flat'), text: niftyPct != null ? fmtPct(niftyPct) : '-' }),
    ]));

    const sortedFunds = heldRows.slice().sort((a, b2) => {
      const av = a.f.stats && a.f.stats[statsKey] != null ? a.f.stats[statsKey] : -Infinity;
      const bv = b2.f.stats && b2.f.stats[statsKey] != null ? b2.f.stats[statsKey] : -Infinity;
      return bv - av;
    });
    const statsList = el('section', { class: 'stock-list' });
    sortedFunds.forEach(({ f }) => {
      const pct = f.stats && f.stats[statsKey] != null ? f.stats[statsKey] : null;
      const delta = pct != null && niftyPct != null ? pct - niftyPct : null;
      const rowChildren = [
        el('span', { class: 'mf-stats-pct ' + (pct != null ? pctClass(pct) : 'flat'), text: pct != null ? fmtPct(pct) : '—' }),
      ];
      if (delta != null) {
        const dCls = pctClass(delta);
        rowChildren.push(el('span', { class: 'badge ' + badgeClassFor(dCls), text: (delta >= 0 ? '+' : '') + delta.toFixed(2) + '% vs Nifty' }));
      }
      statsList.appendChild(el('div', { class: 'card mf-stats-row', onclick: () => openFundForm(f) }, [
        el('div', { class: 'mf-stats-name', text: f.name }),
        el('div', { class: 'mf-stats-vals' }, rowChildren),
      ]));
    });
    statsContent.appendChild(statsList);

    const asOfFundRow = heldRows.find(({ f }) => f.stats && f.stats.asOf);
    const asOfTxt = (niftyStats && niftyStats.asOf) || (asOfFundRow && asOfFundRow.f.stats.asOf);
    statsContent.appendChild(el('p', { class: 'hint mf-foot', text: (asOfTxt ? 'As of ' + asOfTxt + '. ' : '') +
      'Nifty 50 is approximated via a Nifty 50 index fund\'s NAV — mfapi.in has no direct index endpoint reachable from the browser. Not investment advice.' }));
  }

  // Assemble the view — summary common (both tabs), then the active tab's content.
  host.appendChild(summarySec);
  host.appendChild(holdContent);
  host.appendChild(ovrvContent);
  host.appendChild(benchContent);
  host.appendChild(statsContent);
}

function _mfValueCard(value, invested, sold, fmtFn) {
  const gain = value - invested;
  const isPositive = gain >= 0;
  const cardClass = 'mf-value-card ' + (isPositive ? 'positive' : 'negative');
  return el('span', { class: cardClass }, (fmtFn || ((v) => fmtCur(v, 'INR')))(value));
}

function _mfCard(f, c) {
  const xirrTxt = c.xirrPct != null ? fmtPct(c.xirrPct) : '-';
  // Benchmark status badge (user-defined thresholds → Below / Within / Above).
  const benchBadge = c.benchStatus === 'above' ? el('span', { class: 'badge good mf-beat', text: 'above bench' })
    : c.benchStatus === 'below' ? el('span', { class: 'badge bad mf-beat', text: 'below bench' })
    : c.benchStatus === 'within' ? el('span', { class: 'badge muted mf-beat', text: 'within bench' }) : null;
  const statusTxt = c.sold ? ('Sold' + (c.soldDate ? ' · ' + c.soldDate : '')) : (f.status || '');
  const catLine = el('div', { class: 'cat mf-catline' }, [(f.type || '') + (statusTxt ? ' · ' + statusTxt : '')]);
  if (c.sold) catLine.appendChild(el('span', { class: 'badge muted mf-beat', text: 'sold' }));
  if (benchBadge) catLine.appendChild(benchBadge);
  const xirrLabel = c.xirrSource === 'sheet' ? 'XIRR (sheet)' : c.xirrSource === 'realized' ? 'Realized XIRR' : 'XIRR';

  // Calculate fund start date and last invested date
  const contribDates = (f.contributions || []).filter(c => c.date).map(c => c.date).sort();
  const fundStartDays = contribDates.length ? daysSince(contribDates[0]) : null;
  const lastInvestDays = contribDates.length ? daysSince(contribDates[contribDates.length - 1]) : null;
  const fundStartTxt = fundStartDays != null ? formatTimeDuration(fundStartDays) : '-';
  const lastInvestTxt = lastInvestDays != null ? formatTimeDuration(lastInvestDays) : '-';

  // Balanced card: name + status badge, Return headline (the intuitive number),
  // then Value/XIRR + Invested. Everything else (units, avg/latest NAV, observed
  // range, remarks) lives in the fund form which opens on tap.
  const card = el('div', { class: 'card', onclick: () => openFundForm(f) }, [
    el('div', { class: 'top' }, [
      el('div', { class: 'card-left' }, [
        el('div', { class: 'name', text: f.name }),
        catLine,
      ]),
      el('div', { class: 'card-right' }, [
        el('div', { class: 'pct ' + pctClass(c.absReturnPct), text: fmtPct(c.absReturnPct) }),
        el('div', { class: 'meta-line' }, [xirrLabel + ' ', el('b', { class: pctClass(c.xirrPct || 0) }, [xirrTxt])]),
      ]),
    ]),
    el('div', { class: 'sub mf-sub2' }, [
      el('span', {}, [el('div', {}, ['Invested ', b(fmtCur(c.invested, 'INR'))]), el('div', { class: 'mf-meta-mini' }, ['Started ', b(fundStartTxt), ' | Last Invested ', b(lastInvestTxt)])]),
      el('span', { class: 'value-emphasis' }, [(c.sold ? 'Sold for ' : 'Value '), _mfValueCard(c.value, c.invested, c.sold)]),
    ]),
  ]);
  return card;
}

// Dated-investment editor: rows of { date, amount, units, nav, type }, type is
// 'buy' (default) or 'sell'. Units + amount drive total-units and invested (a
// sell reduces both, via average-cost-basis in mf.js); NAV is per-unit
// (auto-derived from amount/units when left blank). Powers XIRR and the
// units × latest-NAV value. Buy and Sell are separate sub-tabs (Buy default) -
// one shared `refs` array backs both so collect() sees a single combined log.
function buildContribEditor(contributions, getSip, onChange) {
  const buyRowsWrap = el('div', { class: 'hist-rows mf-txn-rows' });
  const sellRowsWrap = el('div', { class: 'hist-rows mf-txn-rows' });
  const buySummary = el('div', { class: 'mf-txn-summary' });
  const sellSummary = el('div', { class: 'mf-txn-summary' });
  const buyEmpty = el('div', { class: 'mf-txn-empty', text: 'No investments logged yet.' });
  const sellEmpty = el('div', { class: 'mf-txn-empty', text: 'No sales logged yet.' });
  const refs = [];

  // Row count + running ₹ total above each list, and a dashed empty-state
  // placeholder instead of a blank box when a fund has no buys/sells yet.
  const refreshSummary = (type) => {
    const rows = refs.filter((r) => !r.removed && r.type === type);
    const wrap = type === 'sell' ? sellRowsWrap : buyRowsWrap;
    const summaryEl = type === 'sell' ? sellSummary : buySummary;
    const emptyEl = type === 'sell' ? sellEmpty : buyEmpty;
    const has = rows.length > 0;
    wrap.classList.toggle('hidden', !has);
    summaryEl.classList.toggle('hidden', !has);
    emptyEl.classList.toggle('hidden', has);
    if (has) {
      const total = rows.reduce((s, r) => s + (num(r.amt.value) || 0), 0);
      const noun = type === 'sell' ? (rows.length === 1 ? 'sale' : 'sales') : (rows.length === 1 ? 'investment' : 'investments');
      summaryEl.innerHTML = '';
      summaryEl.appendChild(el('span', { text: rows.length + ' ' + noun }));
      summaryEl.appendChild(el('span', { text: (type === 'sell' ? 'Proceeds ' : 'Invested ') + fmtCur(total, 'INR') }));
    }
    // Deferred: refreshSummary also fires while buildContribEditor is still
    // constructing (seeding existing rows, before it's even been assigned to
    // its `const` in the caller) - onChange (the caller's live-recompute)
    // typically closes over that binding, so calling it synchronously here
    // would hit a TDZ error. A macrotask tick guarantees the caller's own
    // synchronous setup has finished first.
    if (typeof onChange === 'function') setTimeout(onChange, 0);
  };

  const addRow = (date, amount, units, nav, type) => {
    const isSell = type === 'sell';
    const d = el('input', { class: 'txn-date', type: 'date', value: date || todayISO() });
    const amt = el('input', { class: 'txn-amt', type: 'number', inputmode: 'decimal', step: 'any', value: amount != null ? amount : '', placeholder: isSell ? 'Proceeds received ₹' : 'Amount invested ₹' });
    const u = el('input', { class: 'txn-units', type: 'number', inputmode: 'decimal', step: 'any', value: units != null ? units : '', placeholder: isSell ? 'Units sold' : 'Units purchased' });
    const nv = el('input', { class: 'txn-nav', type: 'number', inputmode: 'decimal', step: 'any', value: nav != null ? nav : '', placeholder: 'NAV' });
    const del = el('button', { class: 'icon-btn', type: 'button', text: '×' });
    const ref = { d, amt, u, nv, type: isSell ? 'sell' : 'buy', removed: false };
    // Convenience: derive whichever of amount/units/NAV is left blank from the
    // other two, so the user only ever has to type two of the three numbers.
    amt.addEventListener('blur', () => { autofill(); refreshSummary(ref.type); });
    u.addEventListener('blur', () => { autofill(); refreshSummary(ref.type); });
    nv.addEventListener('blur', () => { autofill(); refreshSummary(ref.type); });
    function autofill() {
      const a = num(amt.value), uu = num(u.value), vv = num(nv.value);
      if (a != null && uu != null && uu > 0 && vv == null) nv.value = Math.round((a / uu) * 10000) / 10000;
      else if (a != null && vv != null && vv > 0 && uu == null) u.value = Math.round((a / vv) * 10000) / 10000;
      else if (uu != null && vv != null && a == null) amt.value = Math.round(uu * vv * 100) / 100;
    }
    // Two tidy lines: (date · amount) then (units · NAV); delete sits on line 1.
    const row = el('div', { class: 'mf-txn-row' + (isSell ? ' mf-txn-row--sell' : '') }, [
      el('div', { class: 'txn-line' }, [d, amt, del]),
      el('div', { class: 'txn-line' }, [u, nv]),
    ]);
    del.addEventListener('click', () => { row.remove(); ref.removed = true; refreshSummary(ref.type); });
    refs.push(ref);
    (isSell ? sellRowsWrap : buyRowsWrap).appendChild(row);
    refreshSummary(ref.type);
  };
  (contributions || []).slice().sort((a, b2) => (b2.date || '').localeCompare(a.date || '')).forEach((c) => addRow(c.date, c.amount, c.units, c.nav, c.type));
  refreshSummary('buy'); refreshSummary('sell'); // covers the empty-fund case (no addRow calls above)

  const lastDateOf = (type) => refs.reduce((max, r) => (!r.removed && r.type === type && r.d.value && r.d.value > (max || '')) ? r.d.value : max, null);

  const addBuyBtn = el('button', {
    class: 'icon-btn', type: 'button', text: '+', title: 'Add investment',
    onclick: () => {
      // Default the new row's date to the latest transaction already logged
      // (not today) - most adds are "the next SIP month", so this saves a tap.
      addRow(lastDateOf('buy'), null, null, null, 'buy');
    },
  });
  const addSellBtn = el('button', {
    class: 'icon-btn', type: 'button', text: '×', title: 'Add sale',
    onclick: () => addRow(lastDateOf('sell'), null, null, null, 'sell'),
  });

  const buyTabBtn = el('button', { type: 'button', text: 'Buy', class: 'active' });
  const sellTabBtn = el('button', { type: 'button', text: 'Sell' });
  const buyPane = el('div', { class: 'mf-txn-pane' }, [buySummary, buyEmpty, buyRowsWrap, el('div', { class: 'mf-txn-btn-row' }, [addBuyBtn])]);
  const sellPane = el('div', { class: 'mf-txn-pane hidden' }, [sellSummary, sellEmpty, sellRowsWrap, el('div', { class: 'mf-txn-btn-row' }, [addSellBtn])]);
  buyTabBtn.addEventListener('click', () => {
    buyTabBtn.classList.add('active'); sellTabBtn.classList.remove('active');
    buyPane.classList.remove('hidden'); sellPane.classList.add('hidden');
  });
  sellTabBtn.addEventListener('click', () => {
    sellTabBtn.classList.add('active'); buyTabBtn.classList.remove('active');
    sellPane.classList.remove('hidden'); buyPane.classList.add('hidden');
  });

  const node = el('div', {}, [el('div', { class: 'seg' }, [buyTabBtn, sellTabBtn]), buyPane, sellPane]);
  const collect = () => {
    const out = [];
    for (const r of refs) {
      if (r.removed) continue;
      const dv = r.d.value;
      let av = num(r.amt.value), uu = num(r.u.value), vv = num(r.nv.value);
      if (r.type === 'sell') {
        if (!dv || uu == null) continue; // units sold is the one required field for a sale
        if (vv == null && av != null && uu > 0) vv = Math.round((av / uu) * 10000) / 10000;
        if (av == null && vv != null) av = Math.round(uu * vv * 100) / 100;
        if (av == null) continue; // no proceeds figure derivable yet - skip incomplete row
        out.push({ date: dv, amount: Math.round(av * 100) / 100, units: uu, nav: vv, type: 'sell' });
      } else {
        if (!dv || av == null) continue;
        if (uu == null && vv != null && vv > 0) uu = Math.round((av / vv) * 10000) / 10000;
        if (vv == null && uu != null && uu > 0) vv = Math.round((av / uu) * 10000) / 10000;
        out.push({ date: dv, amount: Math.round(av * 100) / 100, units: uu != null ? uu : null, nav: vv != null ? vv : null, type: 'buy' });
      }
    }
    out.sort((a, b2) => (b2.date || '').localeCompare(a.date || ''));
    return out;
  };
  return { node, collect };
}

// Widen the user's benchmark bands outward when a freshly computed value crosses
// them, so a new all-time high/low that lands on a NAV update becomes the band
// permanently (the user's request: "set the higher/lower band if current touches
// it, on NAV update"). Expand-ONLY — a reading that stays inside the band leaves
// it untouched, and a blank band (null = ignore) is never created here. Units:
// benchReturn* are decimals vs c.absReturnPct is a percent number (÷100 to match);
// benchXirr* are decimals vs c.xirr is already a decimal rate.
function widenBenchBands(rec, c) {
  const retDec = c.absReturnPct != null ? c.absReturnPct / 100 : null;
  if (retDec != null) {
    if (rec.benchReturnHigh != null && rec.benchReturnHigh !== '' && retDec > Number(rec.benchReturnHigh)) rec.benchReturnHigh = retDec;
    if (rec.benchReturnLow != null && rec.benchReturnLow !== '' && retDec < Number(rec.benchReturnLow)) rec.benchReturnLow = retDec;
  }
  const xr = c.xirr;
  if (xr != null) {
    if (rec.benchXirrHigh != null && rec.benchXirrHigh !== '' && xr > Number(rec.benchXirrHigh)) rec.benchXirrHigh = xr;
    if (rec.benchXirrLow != null && rec.benchXirrLow !== '' && xr < Number(rec.benchXirrLow)) rec.benchXirrLow = xr;
  }
}

async function openFundForm(existing) {
  const isEdit = !!(existing && existing.id != null);
  const f = Object.assign({ owner: 'me', status: 'Investing', targetYear: 2030, sip: 0 }, existing || {});
  const mod = await import('./mf.js');

  const name = el('input', { type: 'text', value: f.name || '', placeholder: 'e.g. Quant Small Cap Fund' });
  const typeList = el('datalist', { id: 'mftypelist' }, MF_TYPES.map((t) => el('option', { value: t })));
  const type = el('input', { type: 'text', value: f.type || '', list: 'mftypelist', placeholder: 'Multi Cap, Small Cap…' });
  const category = el('input', { type: 'text', value: f.category || 'Equity', placeholder: 'Equity / Debt / Hybrid' });
  const status = el('select', {}, MF_STATUS.map((s) => { const o = el('option', { value: s, text: s }); if (s === f.status) o.selected = true; return o; }));
  const numInput = (v, ph) => el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: v != null && v !== '' ? v : '', placeholder: ph });
  const pctInput = (dec, ph) => numInput(dec != null && dec !== '' ? Math.round(Number(dec) * 10000) / 100 : '', ph);
  const sip = numInput(f.sip, 'Monthly SIP ₹ (0 if lumpsum)');
  const targetYear = numInput(f.targetYear || 2030, '2030');
  const goodReturn = el('input', { type: 'text', value: f.goodReturn || '', placeholder: 'e.g. 15%+ XIRR' });
  const remarks = el('textarea', { placeholder: 'Your notes' });
  remarks.value = f.remarks || '';

  // Latest NAV drives current value (units × NAV). Replaces the old manual value.
  const latestNav = numInput(f.latestNav, 'Latest NAV ₹');
  const navAsOf = el('input', { type: 'date', value: f.navAsOf || f.valueAsOf || todayISO() });

  // Benchmark thresholds (user-defined %, stored as decimals; never auto-modified).
  const benchRetLo = pctInput(f.benchReturnLow, 'Low return %');
  const benchRetHi = pctInput(f.benchReturnHigh, 'High return %');
  const benchXirrLo = pctInput(f.benchXirrLow != null ? f.benchXirrLow : f.benchXirr, 'Low XIRR %');
  const benchXirrHi = pctInput(f.benchXirrHigh, 'High XIRR %');

  // Sold funds (Option 2): a single sold value + sold date drives the realized XIRR.
  const soldValue = numInput(f.soldValue, 'Sold value ₹');
  const soldDate = el('input', { type: 'date', value: f.soldDate || '' });
  const soldRow = el('div', { class: 'field-row' + (f.status === 'Sold' ? '' : ' hidden') }, [field('Sold value', soldValue), field('Sold on', soldDate)]);
  status.addEventListener('change', () => { soldRow.classList.toggle('hidden', status.value !== 'Sold'); });

  // Live units-held / avg-NAV readout, shown above the Buy/Sell sub-tabs on the
  // Fund Holdings tab - recomputed from the log itself (not the full computeFund
  // record) so it stays in sync as buys/sells are added, edited or removed.
  const unitsInfo = el('div', { class: 'mf-units-info' });
  const contribEditor = buildContribEditor(f.contributions, () => num(sip.value) || 0, () => refreshUnitsInfo());
  const refreshUnitsInfo = () => {
    const tmp = { contributions: contribEditor.collect() };
    const units = mod.totalUnitsOf(tmp);
    const avgNav = mod.avgNavOf(tmp);
    unitsInfo.innerHTML = '';
    if (units > 0) {
      unitsInfo.appendChild(el('span', {}, ['Units held ', b(units.toFixed(3))]));
      unitsInfo.appendChild(el('span', {}, ['Avg NAV ', b(avgNav != null ? fmtCur(avgNav, 'INR') : '—')]));
    } else {
      unitsInfo.appendChild(el('span', { class: 'hint', text: 'No units held yet — log a buy below.' }));
    }
  };
  refreshUnitsInfo();

  // Build a fund record from the current form inputs (used for save + live preview).
  const buildRec = () => {
    const contributions = contribEditor.collect();
    const isSold = status.value === 'Sold';
    const sv = num(soldValue.value);
    const ln = num(latestNav.value);
    const asOf = navAsOf.value || todayISO();
    const toDec = (inp) => { const v = num(inp.value); return v != null ? v / 100 : null; };
    return {
      owner: 'me',
      name: name.value.trim(),
      type: type.value.trim(),
      category: category.value.trim() || 'Equity',
      benchmark: f.benchmark || '',       // field removed from form; stored value preserved
      status: status.value,
      sip: num(sip.value) || 0,
      targetYear: num(targetYear.value) || 2030,
      latestNav: ln != null ? ln : null,
      navAsOf: ln != null ? asOf : (f.navAsOf || null),
      benchReturnLow: toDec(benchRetLo), benchReturnHigh: toDec(benchRetHi),
      benchXirrLow: toDec(benchXirrLo), benchXirrHigh: toDec(benchXirrHi),
      goodReturn: goodReturn.value.trim(),
      judgeAfter: f.judgeAfter || '',     // field removed from form; stored value preserved
      remarks: remarks.value.trim(),
      contributions,
      valueHistory: (f.valueHistory || []).slice(),   // preserved as the fallback value
      valueAsOf: f.valueAsOf || asOf,
      soldValue: isSold ? (sv != null ? sv : null) : null,
      soldDate: isSold ? (soldDate.value || null) : null,
      seedXirrRef: f.seedXirrRef != null ? f.seedXirrRef : null,
      seeded: false,
      createdAt: f.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  };

  const del = async () => {
    if (!window.confirm('Delete this fund? This cannot be undone.')) return;
    await DB.del('funds', f.id);
    closeModal();
    toast('Fund deleted');
    renderMF();
  };
  const save = async () => {
    if (!name.value.trim()) { toast('Enter a fund name'); return; }
    const rec = buildRec();
    const c2 = mod.computeFund(rec, Date.now());
    // Auto-track observed low/high (distinct from the user's benchmark thresholds).
    const lo = (prev, v) => v == null ? (prev != null ? prev : null) : (prev == null ? v : Math.min(prev, v));
    const hi = (prev, v) => v == null ? (prev != null ? prev : null) : (prev == null ? v : Math.max(prev, v));
    rec.xirrLow = lo(f.xirrLow, c2.xirrPct); rec.xirrHigh = hi(f.xirrHigh, c2.xirrPct);
    rec.returnLow = lo(f.returnLow, c2.absReturnPct); rec.returnHigh = hi(f.returnHigh, c2.absReturnPct);
    widenBenchBands(rec, c2);
    if (isEdit) rec.id = f.id;
    await DB.put('funds', rec);
    closeModal();
    toast(isEdit ? 'Fund updated' : 'Fund added');
    renderMF();
  };

  // ---------- three tabs: Edit fund | Fund Holdings | Benchmark ----------
  const editTabBtn = el('button', { class: 'active', type: 'button', text: 'Edit fund' });
  const holdTabBtn = el('button', { type: 'button', text: 'Fund Holdings' });
  const benchTabBtn = el('button', { type: 'button', text: 'Benchmark' });

  const editTabContent = el('div', { class: 'tab-content' }, [
    typeList,
    field('Fund name', name),
    el('div', { class: 'field-row' }, [field('Type', type), field('Category', category)]),
    el('div', { class: 'field-row' }, [field('Status', status), field('Monthly SIP', sip)]),
    el('div', { class: 'field-row' }, [field('Latest NAV', latestNav), field('NAV as of', navAsOf)]),
    soldRow,
    el('div', { class: 'field-row' }, [field('Good return', goodReturn), field('Target year', targetYear)]),
    field('Remarks', remarks),
  ]);
  editTabContent.appendChild(el('p', { class: 'hint', text: 'Current value = total units × latest NAV. Log each buy (with units) on the Fund Holdings tab, then just refresh the latest NAV here to update value, return, XIRR and benchmark status.' }));

  const holdTabContent = el('div', { class: 'tab-content hidden' }, [
    unitsInfo,
    contribEditor.node,
  ]);

  // Benchmark tab: 4 optional thresholds + a live status readout.
  const benchReadout = el('div', { class: 'mf-bench-readout' });
  const refreshBenchReadout = () => {
    benchReadout.innerHTML = '';
    const c = mod.computeFund(buildRec(), Date.now());
    const retTxt = c.invested > 0 ? fmtPct(c.absReturnPct) : '—';
    const xirrTxt = c.xirrPct != null ? fmtPct(c.xirrPct) : '—';
    const st = c.benchStatus;
    const badge = st ? el('span', { class: 'badge mf-bench-badge ' + (st === 'above' ? 'good' : st === 'below' ? 'bad' : 'muted'), text: st === 'above' ? 'Above benchmark' : st === 'below' ? 'Below benchmark' : 'Within benchmark' }) : el('span', { class: 'hint', text: 'Set at least one threshold to get a status.' });
    benchReadout.appendChild(el('div', { class: 'mf-bench-now' }, [
      el('span', {}, ['Current return ', b(retTxt)]),
      el('span', {}, ['Current XIRR ', b(xirrTxt)]),
    ]));
    benchReadout.appendChild(el('div', { class: 'mf-bench-status' }, [badge]));
  };
  [benchRetLo, benchRetHi, benchXirrLo, benchXirrHi, latestNav].forEach((inp) => inp.addEventListener('input', refreshBenchReadout));

  const benchTabContent = el('div', { class: 'tab-content hidden' }, [
    el('p', { class: 'hint', text: 'Your own targets. They only ever widen: when a NAV update pushes the current return/XIRR past a band, that band expands to the new value (a set band is never narrowed on its own). Status is Below if current return is under its low bound, Above if over its high bound, else Within. Leave any blank to ignore it.' }),
    el('div', { class: 'field-row' }, [field('Low return %', benchRetLo), field('High return %', benchRetHi)]),
    el('div', { class: 'field-row' }, [field('Low XIRR %', benchXirrLo), field('High XIRR %', benchXirrHi)]),
    benchReadout,
  ]);

  const tabs = [
    { btn: editTabBtn, content: editTabContent },
    { btn: holdTabBtn, content: holdTabContent },
    { btn: benchTabBtn, content: benchTabContent },
  ];
  // Delete is only meaningful while looking at the fund's identity/status, so it
  // only shows on the Edit fund tab - Fund Holdings/Benchmark just show Save/Cancel.
  const deleteBtn = isEdit ? el('button', { class: 'btn danger', text: 'Delete', onclick: del }) : null;
  const showTab = (which) => {
    tabs.forEach((t) => {
      const on = t === which;
      t.btn.classList.toggle('active', on);
      t.content.classList.toggle('hidden', !on);
    });
    if (which.btn === benchTabBtn) refreshBenchReadout();
    if (deleteBtn) deleteBtn.classList.toggle('hidden', which.btn !== editTabBtn);
  };
  editTabBtn.addEventListener('click', () => showTab(tabs[0]));
  holdTabBtn.addEventListener('click', () => showTab(tabs[1]));
  benchTabBtn.addEventListener('click', () => showTab(tabs[2]));

  const scrollChildren = [
    el('h2', { text: isEdit ? (f.name || 'Edit fund') : 'Add fund' }),
    el('div', { class: 'seg' }, [editTabBtn, holdTabBtn, benchTabBtn]),
    editTabContent,
    holdTabContent,
    benchTabContent,
  ];

  const btns = [el('button', { class: 'btn primary', text: 'Save', onclick: save })];
  if (deleteBtn) btns.push(deleteBtn);
  btns.push(el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }));
  const footer = el('div', { class: 'sheet-footer' }, [el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, btns)]);

  // Save/Cancel stay fixed at the bottom (long investment logs shouldn't bury them);
  // everything above scrolls in its own region instead of the whole sheet.
  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, scrollChildren),
    footer,
  ]));
}

function _findFundMatch(parsedName, funds) {
  const t = _normName(parsedName);
  if (!t) return null;
  let best = null;
  for (const f of funds) {
    const nn = _normName(f.name);
    if (!nn) continue;
    if (nn === t) return f;
    if (nn.includes(t) || t.includes(nn)) {
      const s = Math.min(nn.length, t.length) / Math.max(nn.length, t.length);
      if (!best || s > best.s) best = { f, s };
      continue;
    }
    let k = 0; const lim = Math.min(nn.length, t.length);
    while (k < lim && nn.charCodeAt(k) === t.charCodeAt(k)) k++;
    if (k >= 4) { const s = k / Math.max(nn.length, t.length); if (!best || s > best.s) best = { f, s }; }
  }
  return best && best.s >= 0.35 ? best.f : null;
}

// Periodic update: bulk "update latest NAV" sheet. Lists every held fund with its
// latest-NAV input; value/return/XIRR/benchmark-status all recompute from it. A
// holdings screenshot can pre-fill by dividing each parsed current value by the
// fund's known total units (NAV = value ÷ units). Saving stores latestNav + navAsOf
// and refreshes the auto-tracked low/high.
async function openMfValueSheet() {
  const mod = await import('./mf.js');
  const funds = ((await DB.byIndex('funds', 'owner', 'me')) || []).filter((f) => !(f.status === 'Sold' || f.soldDate));
  if (!funds.length) { toast('No holding funds to update'); return; }
  const asOf = el('input', { type: 'date', value: todayISO() });
  const refs = funds.map((f) => ({
    f,
    units: mod.totalUnitsOf(f),
    inp: el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: f.latestNav != null && f.latestNav !== '' ? f.latestNav : '', placeholder: 'Latest NAV ₹' }),
  }));
  const rowsWrap = el('div', { class: 'mf-value-list' }, refs.map(({ f, inp, units }) => {
    const cap = el('div', { class: 'mf-value-cap' });
    const refreshCap = () => {
      const nv = num(inp.value);
      cap.textContent = units > 0
        ? (nv != null ? `${units.toFixed(3)} units → ${fmtCur(units * nv, 'INR')}` : `${units.toFixed(3)} units held`)
        : 'no units logged — add units on the fund to derive value';
    };
    inp.addEventListener('input', refreshCap);
    refreshCap();
    return el('div', { class: 'mf-value-row' }, [
      el('div', { class: 'mf-value-name' }, [el('div', { text: f.name }), cap]),
      inp,
    ]);
  }));
  const scan = () => {
    const input = el('input', { type: 'file', accept: 'image/*', multiple: '' });
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      showLoader('Loading OCR engine…');
      try {
        const ocr = await import('./ocr.js');
        const texts = await ocr.ocrImages(files, (m) => {
          if (!m || !m.status) return;
          const pct = (m.progress != null && !isNaN(m.progress)) ? Math.round(m.progress * 100) : null;
          setLoader(m.status.charAt(0).toUpperCase() + m.status.slice(1) + (pct != null ? ' · ' + pct + '%' : ''));
        });
        const holdings = [];
        for (const t of texts) holdings.push(...mod.parsePaytmHoldings(t));
        hideLoader();
        let filled = 0;
        for (const h of holdings) {
          const match = _findFundMatch(h.name, funds);
          if (!match) continue;
          const ref = refs.find((r) => r.f.id === match.id);
          // The holdings screen shows current value; convert to NAV via known units.
          if (ref && ref.units > 0 && h.value > 0) {
            ref.inp.value = Math.round((h.value / ref.units) * 10000) / 10000;
            ref.inp.dispatchEvent(new Event('input'));
            filled++;
          }
        }
        if (!filled) console.warn('MF holdings OCR - raw text:\n', texts.join('\n----- next -----\n'));
        toast(filled ? `${filled} NAV${filled > 1 ? 's' : ''} pre-filled - review & Save` : 'No funds matched (need units logged) - enter NAV manually');
      } catch (e) { hideLoader(); alert('OCR failed: ' + e.message); }
    });
    input.click();
  };
  const save = async () => {
    const asOfV = asOf.value || todayISO();
    let n = 0;
    for (const { f, inp } of refs) {
      const nv = num(inp.value);
      if (nv == null) continue;
      const rec = Object.assign({}, f, { latestNav: nv, navAsOf: asOfV, seeded: false, updatedAt: new Date().toISOString() });
      const c = mod.computeFund(rec, Date.now());
      const lo = (p, x) => x == null ? (p != null ? p : null) : (p == null ? x : Math.min(p, x));
      const hi = (p, x) => x == null ? (p != null ? p : null) : (p == null ? x : Math.max(p, x));
      rec.xirrLow = lo(f.xirrLow, c.xirrPct); rec.xirrHigh = hi(f.xirrHigh, c.xirrPct);
      rec.returnLow = lo(f.returnLow, c.absReturnPct); rec.returnHigh = hi(f.returnHigh, c.absReturnPct);
      widenBenchBands(rec, c);
      await DB.put('funds', rec);
      n++;
    }
    closeModal();
    toast(n ? `Updated ${n} fund${n > 1 ? 's' : ''}` : 'Nothing to update');
    renderMF();
  };
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Update latest NAV' }),
    el('p', { class: 'hint', text: 'Enter each fund\'s latest NAV from Paytm Money. Current value (units × NAV), return, XIRR and benchmark status recompute automatically. A holdings screenshot pre-fills NAV for funds that have units logged.' }),
    el('div', { class: 'field' }, [el('label', { text: 'NAV as of' }), asOf]),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn ghost', type: 'button', text: '📷 Scan holdings screenshot', onclick: scan })]),
    rowsWrap,
    el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
      el('button', { class: 'btn primary', text: 'Save all', onclick: save }),
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
    ]),
  ]));
}

// ---------- online NAV fetch (AMFI via mfapi.in — free, no key, no rate limit) ----------
// Marketaux can't do Indian MF NAV; AMFI (official) publishes daily and mfapi.in
// wraps it as CORS-friendly JSON. We resolve each held fund's AMFI scheme code from
// its name once (preferring Direct + Growth, rejecting IDCW/Regular), cache it on
// the fund, then pull the latest NAV. One network run per calendar day.
const MFAPI = 'https://api.mfapi.in';

// dd-mm-yyyy (AMFI) → yyyy-mm-dd.
function _ddmmyyyyToIso(s) {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Score an mfapi search hit against a fund name. Reject IDCW/dividend plans; prefer
// Direct + Growth; add core-name token overlap. Higher = better.
function _scoreScheme(fundName, schemeName) {
  const s = (schemeName || '').toLowerCase();
  if (/idcw|dividend|payout|reinvest/.test(s)) return -Infinity;
  let score = 0;
  score += /\bdirect\b/.test(s) ? 3 : -3;
  score += /\bgrowth\b/.test(s) ? 2 : -1;
  if (/\bregular\b/.test(s)) score -= 3;
  const strip = (x) => (x || '').toLowerCase().replace(/direct|regular|growth|idcw|dividend|plan|option|fund|the/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const a = new Set(strip(fundName));
  for (const t of strip(schemeName)) if (a.has(t)) score += 1;
  return score;
}

async function _resolveSchemeCode(fund) {
  const q = (fund.name || '').replace(/direct|regular|growth|plan|option|[-–—]/gi, ' ').replace(/\s+/g, ' ').trim();
  const r = await fetch(`${MFAPI}/mf/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) return null;
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return null;
  let best = null, bestScore = -Infinity;
  for (const it of list) {
    const sc = _scoreScheme(fund.name, it.schemeName || '');
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  return best && bestScore > 0 ? { code: best.schemeCode, name: best.schemeName } : null;
}

// ---------- Stats tab: Day/Month/Year NAV change vs Nifty 50 ----------
// mfapi.in only wraps AMFI mutual-fund NAVs - there is no Nifty 50 INDEX endpoint
// reachable from the browser (NSE's own API needs session cookies + blocks CORS;
// Yahoo's ^NSEI is CORS-blocked too). A Nifty 50 INDEX FUND's NAV tracks the index
// within a small tracking error and lives on this same mfapi.in endpoint, so it's
// used as the benchmark proxy. UTI Nifty 50 Index Fund - Direct Growth.
const NIFTY50_PROXY = '120716';

// mfapi's /mf/{code} full-history payload → [{t: <ms>, nav: <number>}], newest-first.
function _parseNavHistory(json) {
  const data = json && Array.isArray(json.data) ? json.data : [];
  const out = [];
  for (const d of data) {
    const t = Date.parse(_ddmmyyyyToIso(d.date) || '');
    const nav = parseFloat(d.nav);
    if (!isNaN(t) && nav > 0) out.push({ t, nav });
  }
  return out; // already newest-first, matching mfapi's own ordering
}

// % change between the newest NAV and the nearest reading at-or-before `daysBack`
// days earlier. Returns null when history doesn't reach back far enough.
function navChangePct(hist, daysBack) {
  if (!hist || hist.length < 2) return null;
  const latest = hist[0];
  const targetT = latest.t - daysBack * 86400000;
  let past = null;
  for (const h of hist) { if (h.t <= targetT) { past = h; break; } }
  if (!past && daysBack === 1) past = hist[1]; // day change: just the previous entry
  if (!past || !(past.nav > 0)) return null;
  return ((latest.nav - past.nav) / past.nav) * 100;
}

async function fetchMfNavs() {
  const today = todayISO();
  const funds = ((await DB.byIndex('funds', 'owner', 'me')) || []).filter((f) => !(f.status === 'Sold' || f.soldDate));
  if (!funds.length) { toast('No holding funds to update'); return; }
  showLoader('Fetching latest NAV…');
  const mod = await import('./mf.js');
  let updated = 0; const unmatched = [];
  try {
    for (let i = 0; i < funds.length; i++) {
      const f = funds[i];
      setLoader(`Fetching NAV… ${i + 1}/${funds.length}`);
      let code = f.schemeCode, schemeName = f.schemeName;
      if (!code) {
        const m = await _resolveSchemeCode(f).catch(() => null);
        if (!m) { unmatched.push(f.name); continue; }
        code = m.code; schemeName = m.name;
      }
      // Full history (not just /latest) - one call now feeds both the current
      // NAV and the Stats tab's day/month/year deltas; only the deltas are
      // persisted (rec.stats), not the history itself.
      let hist = [];
      try {
        const r = await fetch(`${MFAPI}/mf/${code}`);
        if (r.ok) hist = _parseNavHistory(await r.json());
      } catch (_) {}
      const navVal = hist.length ? hist[0].nav : null;
      const navDate = hist.length ? new Date(hist[0].t).toISOString().slice(0, 10) : null;
      if (navVal == null || !(navVal > 0)) { unmatched.push(f.name); continue; }
      const rec = Object.assign({}, f, {
        schemeCode: code, schemeName: schemeName || f.schemeName || '',
        latestNav: navVal, navAsOf: navDate || today, seeded: false,
        stats: { d1: navChangePct(hist, 1), m1: navChangePct(hist, 30), y1: navChangePct(hist, 365), asOf: navDate || today },
        updatedAt: new Date().toISOString(),
      });
      const c = mod.computeFund(rec, Date.now());
      const lo = (p, x) => x == null ? (p != null ? p : null) : (p == null ? x : Math.min(p, x));
      const hi = (p, x) => x == null ? (p != null ? p : null) : (p == null ? x : Math.max(p, x));
      rec.xirrLow = lo(f.xirrLow, c.xirrPct); rec.xirrHigh = hi(f.xirrHigh, c.xirrPct);
      rec.returnLow = lo(f.returnLow, c.absReturnPct); rec.returnHigh = hi(f.returnHigh, c.absReturnPct);
      widenBenchBands(rec, c);
      await DB.put('funds', rec);
      updated++;
    }
    // Nifty 50 proxy (index fund NAV) - one extra call, cached in meta so the
    // Stats tab has a benchmark reading without re-fetching per fund.
    try {
      const r = await fetch(`${MFAPI}/mf/${NIFTY50_PROXY}`);
      if (r.ok) {
        const hist = _parseNavHistory(await r.json());
        if (hist.length) {
          const asOf = new Date(hist[0].t).toISOString().slice(0, 10);
          await DB.put('meta', { key: 'mfNiftyStats', value: { d1: navChangePct(hist, 1), m1: navChangePct(hist, 30), y1: navChangePct(hist, 365), asOf } });
        }
      }
    } catch (_) {}
  } catch (e) {
    hideLoader();
    alert('NAV fetch failed: ' + e.message + '\n\nAre you online? NAV comes from AMFI via mfapi.in.');
    return;
  }
  hideLoader();
  if (unmatched.length) console.warn('MF NAV fetch — unmatched funds (set NAV manually):', unmatched);
  if (!updated) { toast('Could not fetch any NAV — check connection or set manually'); return; }
  toast(`${updated} NAV${updated === 1 ? '' : 's'} updated${unmatched.length ? ` · ${unmatched.length} unmatched` : ''}`);
  renderMF();
}

// ---------- heatmap (sheet-style grid) ----------
// Color buckets matching the spreadsheet: reds (negative), greens (0-100%), blues (>100%).
function heatColor(p) {
  if (p == null || isNaN(p)) return null;
  if (p <= -50) return ['#7f0000', '#fff'];
  if (p <= -30) return ['#c62828', '#fff'];
  if (p <= -10) return ['#ef5350', '#fff'];
  if (p < 0)    return ['#ff8a80', '#3b0000'];
  if (p < 10)   return ['#dcedc8', '#1b3a0e'];
  if (p < 30)   return ['#aed581', '#1b3a0e'];
  if (p < 50)   return ['#81c784', '#0c2a12'];
  if (p < 80)   return ['#4caf50', '#fff'];
  if (p < 100)  return ['#2e7d32', '#fff'];
  if (p < 110)  return ['#bbdefb', '#0a2a4a'];
  if (p < 130)  return ['#90caf9', '#0a2a4a'];
  if (p < 150)  return ['#64b5f6', '#06243a'];
  if (p < 180)  return ['#42a5f5', '#fff'];
  if (p < 200)  return ['#1e88e5', '#fff'];
  return ['#0d47a1', '#fff'];
}
const HEAT_LEGEND = [
  ['> -50%', '#7f0000', '#fff'], ['-30 to -50%', '#c62828', '#fff'], ['-10 to -30%', '#ef5350', '#fff'], ['-1 to -10%', '#ff8a80', '#3b0000'],
  ['0-10%', '#dcedc8', '#1b3a0e'], ['10-30%', '#aed581', '#1b3a0e'], ['30-50%', '#81c784', '#0c2a12'], ['50-80%', '#4caf50', '#fff'], ['80-100%', '#2e7d32', '#fff'],
  ['101-110%', '#bbdefb', '#0a2a4a'], ['110-130%', '#90caf9', '#0a2a4a'], ['130-150%', '#64b5f6', '#06243a'], ['150-180%', '#42a5f5', '#fff'], ['180-200%', '#1e88e5', '#fff'], ['200%+', '#0d47a1', '#fff'],
];
function shortMonth(label) {
  const p = (label || '').split(' ');
  return p.length === 2 ? p[0].slice(0, 3) + " '" + p[1].slice(2) : label;
}
function renderHeatmap() {
  const host = $('#heatmapView');
  host.innerHTML = '';
  const stocks = state.stocks.filter((s) => s.status !== 'sold').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const monthMap = new Map();
  stocks.forEach((s) => (s.history || []).forEach((h) => { const ym = labelToYm(h.month); if (ym) monthMap.set(ym, h.month); }));
  const months = [...monthMap.keys()].sort().map((ym) => ({ ym, label: monthMap.get(ym) }));

  if (!stocks.length || !months.length) {
    host.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'No monthly returns yet to map. Add month-end % to your stocks, or import your sheet.' })]));
    return;
  }

  const table = el('table', { class: 'heatmap' });
  const htr = el('tr', {}, [el('th', { class: 'corner', text: 'Stock' })]);
  months.forEach((m) => htr.appendChild(el('th', { text: shortMonth(m.label) })));
  table.appendChild(el('thead', {}, [htr]));

  const tbody = el('tbody');
  stocks.forEach((s) => {
    const byYm = {};
    (s.history || []).forEach((h) => { const ym = labelToYm(h.month); if (ym) byYm[ym] = h.pct; });
    // Best (👍) and worst (👎) month for this stock.
    let maxYm = null, minYm = null, maxV = -Infinity, minV = Infinity;
    Object.keys(byYm).forEach((ym) => { const v = byYm[ym]; if (typeof v === 'number') { if (v > maxV) { maxV = v; maxYm = ym; } if (v < minV) { minV = v; minYm = ym; } } });
    const tr = el('tr', {}, [el('th', { class: 'rowhead' }, [
      el('div', { class: 'hm-name', text: s.name || '(unnamed)' }),
      s.category ? el('div', { class: 'hm-cat', text: s.category }) : document.createTextNode(''),
    ])]);
    months.forEach((m) => {
      const p = byYm[m.ym];
      const td = el('td');
      const c = heatColor(p);
      if (c) {
        td.style.background = c[0]; td.style.color = c[1];
        td.appendChild(document.createTextNode(p.toFixed(2) + '%'));
        if (m.ym === maxYm) td.appendChild(el('span', { class: 'hm-sticker', text: '👍' }));
        else if (m.ym === minYm) td.appendChild(el('span', { class: 'hm-sticker', text: '👎' }));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(el('div', { class: 'heatmap-scroll' }, [table]));

  const legend = el('div', { class: 'heat-legend' });
  HEAT_LEGEND.forEach(([t, bg, fg]) => { const c = el('span', { class: 'hl', text: t }); c.style.background = bg; c.style.color = fg; legend.appendChild(c); });
  host.appendChild(el('div', { class: 'legend-wrap' }, [el('h3', { text: 'Scale' }), legend]));
}

// ---------- theme (auto by time of day) ----------
function applyTheme() {
  const h = new Date().getHours();
  const light = h >= 7 && h < 19; // daytime = light
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', light ? '#eef2f9' : '#0e1726');
}

// ---------- modals ----------
let escHandler = null;
function openModal(node) {
  const host = $('#modalHost');
  host.innerHTML = '';
  host.appendChild(node);
  host.classList.remove('hidden');
  host.setAttribute('aria-hidden', 'false');
  host.onclick = (e) => { if (e.target === host) closeModal(); };
  escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', escHandler);
}
function closeModal() {
  const host = $('#modalHost');
  host.classList.add('hidden');
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = '';
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
}
const field = (labelText, inputNode) => el('div', { class: 'field' }, [el('label', { text: labelText }), inputNode]);

// Editable list of month-end returns. Dedupes by month (last wins) so re-entering
// a month never creates duplicate history.
function buildHistoryEditor(history) {
  const rowsWrap = el('div', { class: 'hist-rows' });
  const refs = [];
  const addRow = (month, pct) => {
    const ymVal = month ? (labelToYm(month) || '') : thisYm();
    const ym = el('input', { type: 'month', value: ymVal });
    const pc = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: pct != null ? pct : '', placeholder: '% return' });
    const ref = { ym, pc, removed: false };
    // Only the current month is deletable, so past months can't be removed by mistake.
    const isCurrent = ymVal === thisYm();
    const tail = isCurrent ? el('button', { class: 'icon-btn', type: 'button', text: '×' }) : el('span', { class: 'hist-lock' });
    const row = el('div', { class: 'hist-row' }, [ym, pc, tail]);
    if (isCurrent) tail.addEventListener('click', () => { row.remove(); ref.removed = true; });
    refs.push(ref);
    rowsWrap.appendChild(row);
  };
  (history || []).slice()
    .sort((a, b) => (labelToYm(b.month) || '').localeCompare(labelToYm(a.month) || '')) // newest first
    .forEach((h) => addRow(h.month, h.pct));
  const node = el('div', {}, [rowsWrap, el('button', { class: 'btn ghost small', type: 'button', text: '+ Add month', onclick: () => addRow(null, null) })]);
  const collect = () => {
    const map = new Map();
    for (const r of refs) {
      if (r.removed) continue;
      const ymv = r.ym.value, pv = num(r.pc.value);
      if (!ymv || pv == null) continue;
      map.set(ymv, { month: ymToLabel(ymv), pct: Math.round(pv * 100) / 100 });
    }
    return Array.from(map.keys()).sort().map((k) => map.get(k));
  };
  return { node, collect };
}

function openStockForm(existing) {
  const isEdit = !!(existing && existing.id != null);
  const s = Object.assign({ status: 'holding', conviction: '' }, existing || {});

  const name = el('input', { type: 'text', value: s.name || '', placeholder: 'e.g. Tata Power' });
  const catList = el('datalist', { id: 'catlist' }, CATEGORIES.map((c) => el('option', { value: c })));
  const category = el('input', { type: 'text', value: s.category || '', list: 'catlist', placeholder: 'Category' });
  const conviction = el('select', {}, CONVICTIONS.map((c) => {
    const o = el('option', { value: c.v, text: c.label });
    if (c.v === (s.conviction || '')) o.selected = true;
    return o;
  }));
  const status = el('select', {}, [['holding', 'Holding'], ['sold', 'Sold']].map(([v, t]) => {
    const o = el('option', { value: v, text: t });
    if (v === s.status) o.selected = true;
    return o;
  }));
  const numInput = (val, ph) => el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: val != null ? val : '', placeholder: ph });
  const units = numInput(s.units, '0');
  const buyPrice = numInput(s.buyPrice, '0');
  const currentPrice = numInput(s.currentPrice, '0');
  const soldPrice = numInput(s.soldPrice, '0');
  const soldUnits = numInput(s.soldUnits, 'units sold');
  const soldDate = el('input', { type: 'date', value: s.soldDate || todayISO() });
  const notes = el('textarea', { placeholder: 'Notes (optional)' });
  notes.value = s.notes || '';

  const soldBlock = el('div', { class: 'sold-only' + (s.status === 'sold' ? '' : ' hidden') }, [
    el('div', { class: 'field-row' }, [field('Sold price', soldPrice), field('Units sold', soldUnits)]),
    field('Sold date', soldDate),
    el('p', { class: 'hint', text: 'After selling, keep updating "Current price". If it falls below your sold price it was a good exit; if it rises above, you sold early.' }),
  ]);
  status.addEventListener('change', () => soldBlock.classList.toggle('hidden', status.value !== 'sold'));

  const lh = latestHist(s);
  const bname = benchmarkName(state.portfolio);
  const histEditor = buildHistoryEditor(s.history);
  const histCount = (s.history && s.history.length) || 0;
  // With a chart present, the list hides until the chart is tapped; with no
  // history yet there's no chart, so show the editor straight away.
  const editorWrap = el('div', { class: histCount ? 'hidden' : '' }, [histEditor.node]);

  let chartNode = document.createTextNode('');
  if (histCount) {
    const benchByYm = {};
    state.months.forEach((mo) => { if (mo.nifty != null) benchByYm[mo.ym] = mo.nifty; });
    const histByYm = {};
    s.history.forEach((h) => { const y = labelToYm(h.month); if (y && typeof h.pct === 'number') histByYm[y] = h.pct; });
    const yms = Object.keys(histByYm).sort();
    // Plot over every month in the span (nulls for untracked months) so a sold-then-
    // rebought stock shows a real gap instead of one continuous line.
    const axis = yms.length ? monthRange(yms[0], yms[yms.length - 1]) : [];
    const stockVals = axis.map((ym) => (histByYm[ym] != null ? histByYm[ym] : null));
    const levels = axis.map((ym) => (benchByYm[ym] != null ? benchByYm[ym] : null));
    let base = null;
    for (const v of levels) { if (v != null) { base = v; break; } }
    const stockFirst = stockVals.find((v) => v != null && !isNaN(v)) || 0;
    const hasBench = base != null && levels.filter((v) => v != null).length >= 2;
    // Align Nifty to the stock's first point so the lines start together and you see divergence.
    const benchVals = hasBench ? levels.map((v) => (v != null ? stockFirst + (v / base - 1) * 100 : null)) : null;
    const series = [{ values: stockVals, color: '#38bdf8' }];
    if (benchVals) series.push({ values: benchVals, color: '#fbbf24', dash: '4 3' });

    const card = el('div', { class: 'chart-card tappable' }, [multiSparkline(series, 320, 90, '')]);
    card.appendChild(el('div', { class: 'hint' }, [
      el('span', { style: 'color:#38bdf8', text: '- Stock' }),
      benchVals ? el('span', { style: 'color:#fbbf24', text: ' - ' + bname }) : document.createTextNode(''),
      lh ? ' · Latest ' + lh.month + ' ' + fmtPct(lh.pct) : '',
    ]));
    card.appendChild(el('div', { style: 'text-align:center' }, [el('span', { class: 'tap-hint', text: 'tap to edit' })]));
    card.addEventListener('click', () => editorWrap.classList.toggle('hidden'));
    chartNode = card;
  }

  const histBlock = el('div', { class: 'field' }, [
    el('label', { text: 'Monthly returns (month-end %)' }),
    chartNode,
    editorWrap,
  ]);

  const save = async () => {
    if (!name.value.trim()) { toast('Name is required'); return; }
    const sold = status.value === 'sold';
    const buyP = num(buyPrice.value), curP = num(currentPrice.value);
    const hist = histEditor.collect();
    // Holding with both prices known -> auto-set THIS month's return from the price
    // (overwrites the current month, so updating the price never makes duplicates).
    if (!sold && buyP && curP) {
      const pct = Math.round(((curP - buyP) / buyP) * 10000) / 100;
      const lbl = ymToLabel(thisYm());
      const i = hist.findIndex((h) => h.month === lbl);
      if (i >= 0) hist[i] = { month: lbl, pct };
      else hist.push({ month: lbl, pct });
      hist.sort((a, b) => (labelToYm(a.month) || '').localeCompare(labelToYm(b.month) || ''));
    }
    const rec = {
      portfolio: state.portfolio,
      name: name.value.trim(),
      category: category.value.trim(),
      conviction: conviction.value,
      status: status.value,
      units: num(units.value),
      buyPrice: buyP,
      currentPrice: curP,
      soldPrice: sold ? num(soldPrice.value) : null,
      soldUnits: sold ? num(soldUnits.value) : null,
      soldDate: sold ? (soldDate.value || todayISO()) : null,
      notes: notes.value.trim(),
      history: hist,
      updatedAt: new Date().toISOString(),
    };
    if (isEdit) { rec.id = s.id; rec.createdAt = s.createdAt || rec.updatedAt; }
    else rec.createdAt = rec.updatedAt;
    await DB.put('stocks', rec);
    closeModal();
    toast(isEdit ? 'Saved' : 'Added');
    refresh();
  };

  const del = async () => {
    if (!confirm('Delete ' + (s.name || 'this stock') + '?')) return;
    await DB.del('stocks', s.id);
    closeModal();
    toast('Deleted');
    refresh();
  };

  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: isEdit ? 'Edit stock' : 'Add stock' }),
    catList,
    field('Name', name),
    el('div', { class: 'field-row' }, [field('Category', category), field('Conviction', conviction)]),
    field('Status', status),
    el('div', { class: 'field-row' }, [field('Units held', units), field('Avg buy price', buyPrice)]),
    field('Current price', currentPrice),
    soldBlock,
    histBlock,
    field('Notes', notes),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn primary', text: isEdit ? 'Save' : 'Add', onclick: save }),
    ]),
    isEdit ? el('div', { class: 'btn-row' }, [el('button', { class: 'btn danger', text: 'Delete this stock', onclick: del })]) : document.createTextNode(''),
  ]));
}

function saveSnapshot() {
  const cur = curOf(state.portfolio);
  const s = summarize(state.stocks);
  const benchmark = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'e.g. Nifty 50 level (optional)' });
  const dateInput = el('input', { type: 'date', value: todayISO() });
  const save = async () => {
    await DB.put('snapshots', {
      portfolio: state.portfolio,
      date: dateInput.value || todayISO(),
      totalInvested: s.invested,
      totalValue: s.value,
      totalPL: s.pl,
      plPct: s.plPct,
      positives: s.up,
      negatives: s.down,
      count: s.holdings,
      benchmark: num(benchmark.value),
      createdAt: new Date().toISOString(),
    });
    closeModal();
    toast('Snapshot saved');
    refresh();
  };
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Save snapshot' }),
    el('p', { class: 'hint', text: 'Stores this portfolio\'s totals for ' + dateInput.value + ': value ' + fmtCur(s.value, cur) + ', P/L ' + fmtPct(s.plPct) + '.' }),
    field('Date', dateInput),
    field('Benchmark (optional)', benchmark),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn primary', text: 'Save', onclick: save }),
    ]),
  ]));
}

function menuItem(icon, title, desc, onclick) {
  return el('button', { onclick }, [el('span', { text: icon }), el('div', {}, [el('div', { text: title }), el('div', { class: 'desc', text: desc })])]);
}
async function openMenu() {
  const items = [];
  if (deferredInstall) items.push(menuItem('⬇️', 'Install app', 'Add to home screen', doInstall));
  const lb = await DB.get('meta', 'lastBackup').catch(() => null);
  const lbDesc = lb && lb.value ? 'Last backup ' + new Date(lb.value).toLocaleDateString() : 'No backup yet - do this regularly';
  items.push(menuItem('🗄️', 'Backup & Restore', lbDesc, () => { closeModal(); openBackupSheet(); }));
  items.push(menuItem('📊', 'Import from X-MyNotes sheet', 'Download the "Stock" tab as CSV, then pick it here', () => { closeModal(); importSheetCSV(); }));
  const lockCfg = await getLockConfig();
  const lockDesc = lockCfg && lockCfg.enabled
    ? (lockCfg.biometric && lockCfg.biometric.enabled ? 'PIN + biometric · tap to manage' : 'PIN · tap to manage')
    : 'Protect this app with a PIN';
  items.push(menuItem('🔒', lockCfg && lockCfg.enabled ? 'App lock · on' : 'Set up app lock', lockDesc, () => { closeModal(); openLockEntry(); }));
  items.push(menuItem('📰', 'Feed settings', 'Marketaux API key for the news Feed', () => { closeModal(); openFeedSettings(); }));
  // Update item - label/description flip when a new SW is already waiting.
  const updTitle = window.__updateReady ? 'Update available - tap to apply' : 'Check for updates';
  const updDesc = window.__updateReady ? 'A new version is ready to install' : 'Pull the latest version from the server';
  items.push(menuItem('🔄', updTitle, updDesc, () => { closeModal(); checkForUpdates(); }));
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Menu' }),
    el('div', { class: 'menu-list' }, items),
    el('p', { class: 'hint', text: 'All data is stored only on this device. Export regularly so you have a backup.' }),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn ghost', text: 'Close', onclick: closeModal })]),
  ]));
}

// ---------- backup ----------
async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'mynote-stocks-backup-' + todayISO() + '.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  await DB.put('meta', { key: 'lastBackup', value: Date.now() });
  toast('Backup downloaded');
}

function importData() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!confirm('Importing will REPLACE all current data on this device. Continue?')) return;
    try {
      await DB.importAll(JSON.parse(await file.text()));
      await DB.put('meta', { key: 'lastBackup', value: Date.now() });
      toast('Backup imported');
      refresh();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  });
  input.click();
}

// ---------- backup & restore (folder-based) ----------
// Single entry point routes to: fallback (no FS Access API), setup (no folder
// picked yet), or main (folder ready, list + actions).

const _fmtBackupDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const _fmtBackupSize = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
};

async function openBackupSheet() {
  if (!fileSystemAccessSupported()) { openBackupFallbackSheet(); return; }
  const handle = await getSavedFolder();
  if (!handle) { openBackupSetupSheet(); return; }
  // The menu click is a valid user gesture - safe to request permission here.
  if (!(await ensureFolderPermission(handle, 'readwrite'))) {
    alert('Permission to use the backup folder was not granted. You can pick a different folder, or use the file-based restore at the bottom.');
    openBackupSetupSheet();
    return;
  }
  openBackupMainSheet(handle);
}

function openBackupSetupSheet() {
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Backup & Restore' }),
    el('p', { class: 'hint', text:
      'Pick a folder where your backups will be saved. The app keeps the newest ' + BACKUPS_KEEP +
      ' backups and removes older ones automatically. Backups never leave your phone.'
    }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', text: 'Choose folder', onclick: async () => {
        try { await pickFolder(); closeModal(); openBackupSheet(); }
        catch (e) { if (e.name !== 'AbortError') alert('Could not pick folder: ' + (e.message || e)); }
      }}),
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
    ]),
    el('div', { class: 'menu-foot' }, [
      el('button', { class: 'link-btn', text: 'Restore from a backup file...', onclick: () => { closeModal(); restoreFromOutsideFile(); } }),
    ]),
  ]));
}

async function openBackupMainSheet(handle) {
  const list = await listBackups(handle).catch(() => []);
  const lastBackupText = list.length ? 'Last: ' + _fmtBackupDate(list[0].date) : 'No backups yet';

  const backupNow = async () => {
    try {
      const data = await DB.exportAll();
      const result = await writeBackup(handle, data);
      await rotateBackups(handle);
      await DB.put('meta', { key: 'lastBackup', value: Date.now() });
      toast('Backup saved · ' + _fmtBackupDate(result.date));
      closeModal(); openBackupMainSheet(handle);
    } catch (e) { alert('Backup failed: ' + (e.message || e)); }
  };

  const restore = async (item) => {
    const ok = confirm(
      'Restore from ' + _fmtBackupDate(item.date) + '?\n\n' +
      'This REPLACES all your current data with the backup. Any edits made since that backup will be lost.\n\n' +
      'A safety snapshot of your current state will be saved as "prerestore" first.'
    );
    if (!ok) return;
    try {
      // Snapshot current state to prerestore - single-level "oops" undo.
      const current = await DB.exportAll();
      await writePreRestoreSnapshot(handle, current);
      const data = await readBackupByName(handle, item.name);
      await DB.importAll(data);
      toast('Restored · ' + _fmtBackupDate(item.date) + ' · reloading…');
      setTimeout(() => location.reload(), 900);
    } catch (e) { alert('Restore failed: ' + (e.message || e)); }
  };

  const changeFolder = async () => {
    try { await pickFolder(); closeModal(); openBackupSheet(); }
    catch (e) { if (e.name !== 'AbortError') alert(e.message || e); }
  };

  const rows = list.map((item) => el('div', { class: 'backup-row' }, [
    el('div', { class: 'backup-meta' }, [
      el('div', { class: 'backup-date', text: _fmtBackupDate(item.date) }),
      el('div', { class: 'backup-detail', text: _fmtBackupSize(item.size) }),
    ]),
    el('button', { class: 'btn small', text: 'Restore', onclick: () => restore(item) }),
  ]));

  const listSection = rows.length
    ? el('div', { class: 'backup-list' }, rows)
    : el('p', { class: 'hint', text: 'No backups yet - tap "Backup now" to create your first one.' });

  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Backup & Restore' }),
    el('div', { class: 'backup-folder' }, [
      el('span', { class: 'backup-folder-label', text: 'Folder: ' }),
      el('span', { class: 'backup-folder-name', text: handle.name || '(picked folder)' }),
      el('button', { class: 'link-btn backup-folder-change', text: 'Change', onclick: changeFolder }),
    ]),
    el('div', { class: 'backup-actions' }, [
      el('button', { class: 'btn primary', text: 'Backup now', onclick: backupNow }),
      el('div', { class: 'backup-last', text: lastBackupText }),
    ]),
    el('h3', { class: 'backup-section-title', text: 'Recent backups' }),
    listSection,
    el('p', { class: 'hint', text:
      'Same-day backups overwrite. Older backups in this folder are auto-removed when a new one is saved (keeps the newest ' +
      BACKUPS_KEEP + '). A "prerestore" snapshot is kept separately for one undo level.'
    }),
    el('div', { class: 'menu-foot' }, [
      el('button', { class: 'link-btn', text: 'Restore from a file outside this folder...', onclick: () => { closeModal(); restoreFromOutsideFile(); } }),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Close', onclick: closeModal }),
    ]),
  ]));
}

function openBackupFallbackSheet() {
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'Backup & Restore' }),
    el('p', { class: 'hint', text:
      'This browser doesn\'t support the dedicated-folder feature. Backups will download to your normal Downloads folder; you\'ll need to pick a file when restoring.'
    }),
    el('div', { class: 'menu-list' }, [
      menuItem('⬆️', 'Backup now', 'Downloads a JSON file', () => { closeModal(); exportData(); }),
      menuItem('📂', 'Restore from file', 'Pick a backup file to restore', () => { closeModal(); importData(); }),
    ]),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn ghost', text: 'Close', onclick: closeModal })]),
  ]));
}

async function restoreFromOutsideFile() {
  let data;
  try { data = await readBackupViaFilePicker(); }
  catch (e) { if (e.message !== 'No file picked' && e.name !== 'AbortError') alert('Could not read file: ' + (e.message || e)); return; }
  if (!confirm('Restore from this file?\n\nThis REPLACES all your current data. Any edits since the backup will be lost.')) return;
  try {
    const handle = await getSavedFolder();
    if (handle) {
      // If a backup folder is set, drop a prerestore there for one-level undo.
      const current = await DB.exportAll();
      await writePreRestoreSnapshot(handle, current).catch(() => {});
    }
    await DB.importAll(data);
    toast('Restored · reloading…');
    setTimeout(() => location.reload(), 900);
  } catch (e) { alert('Restore failed: ' + (e.message || e)); }
}

async function replacePortfolioStore(store, records, keyField) {
  const ports = Array.from(new Set(records.map((r) => r.portfolio)));
  for (const p of ports) {
    const existing = await DB.byPortfolio(store, p);
    for (const x of existing) await DB.del(store, x[keyField]);
  }
  for (const r of records) await DB.put(store, r);
}

function importSheetCSV() {
  const input = el('input', { type: 'file', accept: '.csv,text/csv' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let parsed;
    try {
      const { parseXMyNotesCSV } = await import('./csv.js'); // lazy: only loaded on import
      parsed = parseXMyNotesCSV(await file.text());
    } catch (e) {
      alert('Could not read CSV: ' + e.message);
      return;
    }
    const stocks = parsed.stocks || [];
    const monthly = parsed.monthly || [];
    if (!stocks.length) {
      alert('No stock rows found. Export the "Stock" tab from your sheet as CSV and try again.');
      return;
    }
    const by = {};
    stocks.forEach((r) => { by[r.portfolio] = (by[r.portfolio] || 0) + 1; });
    const msg = 'Found ' + stocks.length + ' stocks and ' + monthly.length + ' monthly records:\n'
      + '• Me · India: ' + (by['me-in'] || 0) + '\n'
      + '• Me · US: ' + (by['me-us'] || 0) + '\n'
      + '• Wife · India: ' + (by['wife-in'] || 0) + '\n\n'
      + 'This REPLACES stocks and monthly history in those portfolios (Trends snapshots are kept). Continue?';
    if (!confirm(msg)) return;
    await replacePortfolioStore('stocks', stocks, 'id');
    if (monthly.length) {
      await replacePortfolioStore('monthly', monthly, 'key');
      await syncNiftyAll(); // back-fill wife-in months with Nifty from me-in
    }
    toast('Imported ' + stocks.length + ' stocks · ' + monthly.length + ' months');
    refresh();
  });
  input.click();
}

// ---------- OCR: update prices from broker screenshot ----------
function _normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// OCR alias memory: when the user overrides the auto-match in the review modal
// (e.g. parsed "Adani Pwr" → mapped manually to stock "Adani Power Ltd"), we
// remember that mapping so next time the same parsed name auto-matches with
// full confidence - no re-tweaking. Keyed by portfolio so an alias in one
// portfolio can't leak into another. Lives in the existing `meta` store; small
// enough to load whole into memory on demand.
const _aliasKey = (portfolio, parsedName) => portfolio + '|' + _normName(parsedName);
async function _loadOcrAliases() {
  const rec = await DB.get('meta', 'ocr-aliases').catch(() => null);
  return (rec && rec.value) || {};
}
async function _saveOcrAlias(portfolio, parsedName, stockId) {
  const norm = _normName(parsedName);
  if (!norm) return;
  const aliases = await _loadOcrAliases();
  const key = _aliasKey(portfolio, parsedName);
  if (stockId) aliases[key] = stockId;
  else delete aliases[key];
  await DB.put('meta', { key: 'ocr-aliases', value: aliases });
}
function _findStockMatch(parsedName, stocks) {
  const t = _normName(parsedName);
  if (!t) return null;
  let best = null;
  for (const s of stocks) {
    if (s.status === 'sold') continue;
    const nn = _normName(s.name);
    if (!nn) continue;
    if (nn === t) return { stock: s, score: 1 };
    // substring (either way) - score by length ratio
    if (nn.includes(t) || t.includes(nn)) {
      const score = Math.min(nn.length, t.length) / Math.max(nn.length, t.length);
      if (!best || score > best.score) best = { stock: s, score };
      continue;
    }
    // looser fallback: count of shared leading letters / total
    let k = 0; const lim = Math.min(nn.length, t.length);
    while (k < lim && nn.charCodeAt(k) === t.charCodeAt(k)) k++;
    if (k >= 3) {
      const score = k / Math.max(nn.length, t.length);
      if (!best || score > best.score) best = { stock: s, score };
    }
  }
  // Always return the best - user can untick in the review if wrong.
  return best;
}

function showLoader(msg) {
  hideLoader();
  const overlay = el('div', { class: 'loader-overlay', id: '__loader' }, [
    el('div', { class: 'loader-card' }, [
      el('div', { class: 'spinner' }),
      el('div', { class: 'loader-msg', text: msg || 'Working…' }),
    ]),
  ]);
  document.body.appendChild(overlay);
  return overlay;
}
function setLoader(msg) { const m = document.querySelector('#__loader .loader-msg'); if (m) m.textContent = msg; }
function hideLoader() { const o = document.getElementById('__loader'); if (o) o.remove(); }

async function openOcrFlow() {
  // multiple: lets the OS picker accept 1-N screenshots (typical 4-5 for a long
  // holdings list that doesn't fit one screen). Sequential OCR with a shared
  // Tesseract worker - see ocrImages() in ocr.js.
  const input = el('input', { type: 'file', accept: 'image/*', multiple: '' });
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    showLoader('Loading OCR engine…');
    try {
      const mod = await import('./ocr.js');
      const total = files.length;
      const texts = await mod.ocrImages(files, (m) => {
        if (!m || !m.status) return;
        const idx = (m.fileIndex || 0) + 1;
        const pct = (m.progress != null && !isNaN(m.progress)) ? Math.round(m.progress * 100) : null;
        const status = m.status.charAt(0).toUpperCase() + m.status.slice(1);
        const prefix = total > 1 ? 'Image ' + idx + '/' + total + ' · ' : '';
        setLoader(prefix + status + (pct != null ? ' · ' + pct + '%' : ''));
      });
      // Merge rows from all images. Dedup by normalised stock name (first wins)
      // so a scroll-overlap between screenshot N and N+1 doesn't produce dupes.
      const seen = new Set();
      const allRows = [];
      for (const text of texts) {
        const rows = mod.parseBrokerRows(text, state.portfolio);
        for (const r of rows) {
          const key = mod.normName(r.name);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          allRows.push(r);
        }
      }
      hideLoader();
      // Note: the image Files go only to Tesseract for recognition. We never
      // persist them - only the parsed numbers reach the review screen.
      if (!allRows.length) { openOcrDebug(texts.join('\n\n----- next image -----\n\n')); return; }
      const aliases = await _loadOcrAliases();
      openOcrReview(allRows, aliases);
    } catch (e) {
      hideLoader();
      alert('OCR failed: ' + e.message);
    }
  });
  input.click();
}

function openOcrDebug(text) {
  const ta = el('textarea', { readonly: 'true', style: 'width:100%;min-height:240px;font-family:monospace;font-size:0.72rem;' });
  ta.value = text || '(empty)';
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'No holding rows detected' }),
    el('p', { class: 'note', text: 'OCR ran but the parser couldn\'t pick out any "units × avg / LTP:" pattern. The raw text below is what was read - share it so the parser can be tuned. Try cropping to just the holdings rows, or use a higher-resolution screenshot.' }),
    ta,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Copy text', onclick: () => { ta.select(); document.execCommand && document.execCommand('copy'); toast('Copied'); } }),
      el('button', { class: 'btn primary', text: 'Close', onclick: closeModal }),
    ]),
  ]));
}

function openOcrReview(rows, aliases) {
  const ym = thisYm();
  const monthLabel = ymToLabel(ym);
  // Groww/wife-in: the "Market Price" view shows units (e.g. "27 shares") and
  // current price, but not the average buy price. So we update units + price
  // and leave the saved avg untouched. The Avg column is hidden in the review
  // and the apply step gates avg writes - defense in depth.
  const noAvg = state.portfolio === 'wife-in';
  aliases = aliases || {};
  // Resolve each row's auto-match: saved alias (manual override from a prior
  // run) wins, otherwise fall back to the fuzzy matcher. An alias that points
  // to a now-sold or deleted stock is ignored.
  const matched = rows.map((r) => {
    const aliasId = aliases[_aliasKey(state.portfolio, r.name)];
    if (aliasId) {
      const stock = state.stocks.find((s) => s.id === aliasId && s.status !== 'sold');
      if (stock) return { ...r, match: { stock, score: 1, fromAlias: true } };
    }
    return { ...r, match: _findStockMatch(r.name, state.stocks) };
  });
  const matchedCount = matched.filter((m) => m.match).length;
  // Stocks shown in the per-row override dropdown - only active holdings, sorted
  // by name. Mirrors what _findStockMatch considers, so manual selection and
  // auto-match can never disagree on which pool is valid.
  const activeStocks = state.stocks.filter((s) => s.status !== 'sold')
    .slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // Big-jump heuristic: a stock's parsed price differing > 30% from its saved
  // currentPrice is almost always a wrong match or an OCR misread (not a real
  // 30%/day move). Flag for verification - separate from the ₹→3 suspect heuristic.
  const BIG_JUMP_THRESHOLD = 0.30;
  const isBigJump = (savedLtp, newLtp) =>
    savedLtp != null && newLtp != null && savedLtp > 0 &&
    Math.abs((newLtp - savedLtp) / savedLtp) > BIG_JUMP_THRESHOLD;

  const head = el('div', { class: 'ocr-head' + (noAvg ? ' no-avg' : '') },
    noAvg
      ? [el('span', { text: '' }), el('span', { text: 'Stock' }), el('span', { text: 'Units' }), el('span', { text: 'Price' })]
      : [el('span', { text: '' }), el('span', { text: 'Stock' }), el('span', { text: 'Units' }), el('span', { text: 'Avg' }), el('span', { text: 'LTP' })]
  );
  // Tesseract often misreads ₹ as the digit "3", inflating a price like ₹84.89
  // to "384.89". Flag any integer-part starting with "3" that has 3+ digits
  // ("3xx" up). Over-flagging is fine - the user just glances at highlights.
  const suspectLtp = (v) => v != null && /^3\d{2,}/.test(String(Math.trunc(v)));
  const refs = matched.map((m) => {
    const enabled = !!m.match;
    const cb = el('input', { type: 'checkbox' }); cb.checked = enabled; cb.disabled = !enabled;
    const unitsI = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.units != null ? m.units : '' });
    const avgI = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.avg != null ? m.avg : '' });
    const ltpI = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: m.ltp != null ? m.ltp : '' });
    if (suspectLtp(m.ltp)) {
      ltpI.classList.add('ocr-suspect');
      ltpI.title = 'OCR may have misread the ₹ symbol as "3". Verify against the screenshot.';
    }
    // Big-jump check uses the *currently-matched* stock; recomputed on dropdown
    // change too (different stock → different saved price → maybe no longer a jump).
    const flagBigJump = () => {
      const saved = ref.match && ref.match.stock ? ref.match.stock.currentPrice : null;
      const parsed = num(ltpI.value);
      if (isBigJump(saved, parsed)) {
        ltpI.classList.add('ocr-suspect');
        ltpI.title = 'Big change vs saved (₹' + saved + ' → ₹' + parsed + '). Confirm before applying.';
      } else if (!suspectLtp(num(ltpI.value))) {
        ltpI.classList.remove('ocr-suspect');
        ltpI.removeAttribute('title');
      }
    };
    // Dropdown to override the auto-matched stock. Pre-selects the best match;
    // user can pick a different stock, "+ Add as new stock" to create one from
    // this row, or "- Skip -" to drop the row. Selecting a stock auto-checks
    // the row; selecting Skip disables it.
    const sel = el('select', { class: 'ocr-match-sel' });
    sel.appendChild(el('option', { value: '', text: '- Skip (no match) -' }));
    sel.appendChild(el('option', { value: '__new__', text: '+ Add as new stock' }));
    for (const s of activeStocks) {
      const opt = el('option', { value: s.id, text: s.name });
      if (m.match && !m.match.fromAlias && m.match.stock.id === s.id) opt.selected = true;
      if (m.match && m.match.fromAlias && m.match.stock.id === s.id) {
        opt.selected = true; opt.textContent = '★ ' + s.name + ' (saved match)';
      }
      sel.appendChild(opt);
    }
    if (!m.match) sel.value = '';
    const nameCell = el('div', { class: 'ocr-name' }, [
      el('div', { class: 'ocr-parsed', text: m.name }),
      sel,
    ]);
    const row = el('div', { class: 'ocr-row' + (noAvg ? ' no-avg' : '') + (enabled ? '' : ' no-match') },
      noAvg ? [cb, nameCell, unitsI, ltpI] : [cb, nameCell, unitsI, avgI, ltpI]
    );
    // ref.allowAvg controls whether the apply step writes buyPrice from this
    // row. For me-in/me-us it's always true (avg column visible). For wife-in
    // (noAvg) it flips to true only when parsed units differ from the matched
    // stock's saved units - a unit change means a buy/sell happened and the
    // average buy price has definitely shifted, so we surface the Avg input
    // as an inline banner for that row only.
    const ref = { row, cb, unitsI, avgI, ltpI, match: m.match, allowAvg: !noAvg };
    flagBigJump();

    const checkAvgVisibility = () => {
      if (!noAvg) { ref.allowAvg = true; return; }
      // "+ Add as new" path keeps current behaviour: avg stays null (the user
      // can edit the new stock's avg from its detail card right after Apply).
      if (ref.match && ref.match.addNew) {
        ref.allowAvg = false;
        if (ref.avgBanner) ref.avgBanner.style.display = 'none';
        return;
      }
      const stock = ref.match && ref.match.stock;
      const savedUnits = stock ? num(stock.units) : null;
      const parsedUnits = num(unitsI.value);
      const changed = savedUnits != null && parsedUnits != null && Math.abs(parsedUnits - savedUnits) > 0.0001;
      ref.allowAvg = changed;
      if (changed) {
        if (!ref.avgBanner) {
          ref.avgMsg = el('div', { class: 'ocr-avg-msg' });
          ref.avgBanner = el('div', { class: 'ocr-avg-banner' }, [ref.avgMsg, avgI]);
          row.appendChild(ref.avgBanner);
        }
        ref.avgMsg.textContent =
          'Units changed (' + savedUnits + ' → ' + parsedUnits + ') - set new average buy price:';
        ref.avgBanner.style.display = '';
      } else if (ref.avgBanner) {
        ref.avgBanner.style.display = 'none';
      }
    };
    checkAvgVisibility();

    sel.addEventListener('change', async () => {
      if (!sel.value) {
        ref.match = null;
        cb.checked = false; cb.disabled = true;
        row.classList.add('no-match');
        // Remember "Skip" too - next time, the parser won't keep auto-mapping
        // a parsed name the user has explicitly rejected.
        await _saveOcrAlias(state.portfolio, m.name, null).catch(() => {});
      } else if (sel.value === '__new__') {
        // Sentinel: create a brand-new stock at Apply time. No alias saved
        // (the future stock has no id yet); next OCR will fuzzy-match the
        // newly-created stock by name and offer it in the dropdown normally.
        ref.match = { addNew: true, name: m.name };
        cb.disabled = false; cb.checked = true;
        row.classList.remove('no-match');
      } else {
        const stock = state.stocks.find((x) => x.id === sel.value);
        if (!stock) return;
        ref.match = { stock, score: 1 };
        cb.disabled = false; cb.checked = true;
        row.classList.remove('no-match');
        await _saveOcrAlias(state.portfolio, m.name, stock.id).catch(() => {});
      }
      flagBigJump();
      checkAvgVisibility();
    });
    ltpI.addEventListener('input', flagBigJump);
    unitsI.addEventListener('input', checkAvgVisibility);
    return ref;
  });

  const apply = async () => {
    let updated = 0, added = 0;
    for (const r of refs) {
      if (!r.cb.checked || !r.match) continue;
      const nU = num(r.unitsI.value), nA = num(r.avgI.value), nL = num(r.ltpI.value);

      // "+ Add as new" path - create the stock from the parsed row. Category
      // is left blank; the user can edit it from the stock card afterwards.
      // For wife-in (no Avg in Groww view), buyPrice is left null too.
      if (r.match.addNew) {
        const now = new Date().toISOString();
        const fresh = {
          portfolio: state.portfolio,
          name: r.match.name,
          category: '',
          conviction: '',
          status: 'holding',
          units: nU,
          buyPrice: r.allowAvg && nA != null ? nA : null,
          currentPrice: nL,
          soldPrice: null, soldUnits: null, soldDate: null,
          notes: '',
          history: [],
          createdAt: now, updatedAt: now,
        };
        if (fresh.buyPrice && fresh.currentPrice) {
          const pct = Math.round(((fresh.currentPrice - fresh.buyPrice) / fresh.buyPrice) * 10000) / 100;
          fresh.history.push({ month: monthLabel, pct });
        }
        await DB.put('stocks', fresh);
        added++;
        continue;
      }

      const fresh = await DB.get('stocks', r.match.stock.id);
      if (!fresh) continue;
      // Only overwrite a field if the screenshot provided a value (so brokers
      // that don't show Avg in the holdings view don't wipe what's already saved).
      // r.allowAvg gates the buyPrice write: always true for me-in/me-us; for
      // wife-in (Groww) it's true only when parsed units differ from the saved
      // units (a buy/sell happened) - the inline avg banner in the review
      // exposes the avg input only in that case.
      if (nU != null) fresh.units = nU;
      if (r.allowAvg && nA != null) fresh.buyPrice = nA;
      if (nL != null) fresh.currentPrice = nL;
      if (fresh.buyPrice && fresh.currentPrice) {
        const pct = Math.round(((fresh.currentPrice - fresh.buyPrice) / fresh.buyPrice) * 10000) / 100;
        const hist = (fresh.history || []).filter((h) => h.month !== monthLabel);
        hist.push({ month: monthLabel, pct });
        hist.sort((a, c) => (labelToYm(a.month) || '').localeCompare(labelToYm(c.month) || ''));
        fresh.history = hist;
      }
      fresh.updatedAt = new Date().toISOString();
      await DB.put('stocks', fresh);
      updated++;
    }
    closeModal();
    if (!updated && !added) { toast('Nothing applied'); return; }
    await refresh(); // reloads state.stocks
    // capture the current month's portfolio totals from the freshly updated holdings
    const s = summarize(state.stocks);
    const existing = state.months.find((x) => x.ym === ym);
    const rec = {
      key: monthKey(state.portfolio, ym),
      portfolio: state.portfolio, ym,
      invested: s.hasVal ? s.invested : null,
      value: s.hasVal ? s.value : null,
      profitLoss: s.hasVal ? s.pl : null,
      returnPct: s.hasVal ? Math.round(s.plPct * 100) / 100 : null,
      countProfit: s.up, countLoss: s.down,
      nifty: existing ? existing.nifty : null,
      source: 'ocr',
      updatedAt: new Date().toISOString(),
    };
    await syncNifty(rec);
    await DB.put('monthly', rec);
    const parts = [];
    if (updated) parts.push('Updated ' + updated);
    if (added) parts.push('Added ' + added);
    toast(parts.join(' · ') + ' · ' + monthLabel + ' captured');
    refresh();
  };

  openModal(el('div', { class: 'sheet ocr-sheet' }, [
    el('h2', { text: 'Update from screenshot' }),
    el('p', { class: 'note', text:
      matchedCount + ' of ' + rows.length + ' rows auto-matched to your ' + state.portfolio.replace('-', ' · ') + ' holdings. ' +
      'Use the dropdown under each row to override the match, choose "+ Add as new stock" to create a fresh holding from that row, or "Skip" to drop it. Manual matches are remembered - next OCR will auto-pick the same stock. ' +
      (noAvg
        ? 'Groww screenshots update units and current price - the average is kept as you saved it (Groww doesn\'t show it in this view). If a row\'s units have changed (you bought or sold), an "Avg" input appears for that row so you can enter the new average buy price. Untick anything wrong before Apply. '
        : 'Edit values if needed, untick anything wrong, then Apply. Blank fields keep the existing value. ') +
      'Heads-up: prices highlighted orange look suspect - either Tesseract misread the ₹ as a "3", or the value jumped > 30% from saved. Verify against the screenshot.'
    }),
    head,
    el('div', { class: 'ocr-list' }, refs.map((r) => r.row)),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn primary', text: 'Apply', onclick: apply }),
    ]),
  ]));
}

// ---------- app lock (PIN + optional biometric) ----------

// Shared keypad widget used by the lock screen, setup wizard and Change PIN.
// onPress receives the digit string ('0'..'9') or 'back'. onBio is optional -
// when provided, a fingerprint key appears in the bottom-left slot.
function buildKeypad(onPress, onBio) {
  const grid = el('div', { class: 'kpad' });
  const digit = (d) => el('button', { type: 'button', class: 'kp', text: d, onclick: () => onPress(d) });
  for (let d = 1; d <= 9; d++) grid.appendChild(digit(String(d)));
  if (onBio) {
    grid.appendChild(el('button', { type: 'button', class: 'kp kp-bio', text: '👆', 'aria-label': 'Use biometric', onclick: onBio }));
  } else {
    grid.appendChild(el('span', { class: 'kp kp-empty' }));
  }
  grid.appendChild(digit('0'));
  grid.appendChild(el('button', { type: 'button', class: 'kp kp-back', text: '⌫', 'aria-label': 'Backspace', onclick: () => onPress('back') }));
  return grid;
}

// Render the row of PIN-progress dots (filled vs empty) into `host`.
function renderPinDots(host, filled) {
  host.innerHTML = '';
  for (let i = 0; i < PIN_LENGTH; i++) host.appendChild(el('span', { class: 'pin-dot' + (i < filled ? ' filled' : '') }));
}

// Generic PIN-entry controller. Calls onComplete(pin) when 4 digits are in.
// Returns { reset, setError } so callers can drive multi-step flows.
function makePinController(dotsHost, errorHost, onComplete) {
  let entered = '';
  const render = () => renderPinDots(dotsHost, entered.length);
  const reset = () => { entered = ''; render(); };
  const setError = (msg) => {
    errorHost.textContent = msg || '';
    if (msg) setTimeout(() => { if (errorHost.textContent === msg) errorHost.textContent = ''; }, 1800);
  };
  const onPress = (k) => {
    if (k === 'back') { entered = entered.slice(0, -1); render(); return; }
    if (entered.length >= PIN_LENGTH) return;
    entered += k;
    render();
    if (entered.length === PIN_LENGTH) {
      const pin = entered;
      // Defer onComplete so the last dot paints before any verify work runs.
      setTimeout(() => onComplete(pin), 30);
    }
  };
  render();
  return { onPress, reset, setError };
}

// Full-screen lock overlay shown on app start when a PIN is set. Resolves when
// the user unlocks. The overlay covers any already-built chrome behind it.
async function showLockScreen() {
  const cfg = await getLockConfig();
  if (!cfg || !cfg.enabled) return; // no lock configured
  return new Promise((resolve) => {
    const hasBio = !!(cfg.biometric && cfg.biometric.enabled);
    const overlay = el('div', { class: 'lock-screen', id: '__lockScreen' });
    document.body.appendChild(overlay);
    document.body.classList.add('locked');

    const dots = el('div', { class: 'pin-dots' });
    const errorEl = el('div', { class: 'lock-error' });
    const subText = el('div', { class: 'lock-sub', text: hasBio ? 'Use biometric or enter your PIN' : 'Enter your PIN to unlock' });

    const finish = () => {
      overlay.classList.add('fade-out');
      document.body.classList.remove('locked');
      setTimeout(() => overlay.remove(), 240);
      resolve();
    };

    const ctrl = makePinController(dots, errorEl, async (pin) => {
      const ok = await verifyPin(pin).catch(() => false);
      if (ok) { finish(); return; }
      overlay.classList.add('shake');
      setTimeout(() => overlay.classList.remove('shake'), 420);
      ctrl.setError('Wrong PIN');
      ctrl.reset();
    });

    // silent=true on the auto-prompt: some browsers (notably Safari) require a
    // user gesture for credentials.get(), and we don't want a scary error toast
    // for that. The keypad 👆 button calls this with silent=false so a real
    // user cancel still shows feedback.
    const tryBio = async (silent) => {
      try {
        if (await verifyBiometric()) finish();
      } catch (e) {
        if (!silent) ctrl.setError('Biometric cancelled - use PIN');
      }
    };

    overlay.appendChild(el('div', { class: 'lock-card' }, [
      el('div', { class: 'lock-logo', text: '🔒' }),
      el('div', { class: 'lock-title', text: 'MyNote Stocks' }),
      subText,
      dots,
      errorEl,
      buildKeypad(ctrl.onPress, hasBio ? () => tryBio(false) : null),
      el('div', { class: 'lock-foot' }, [
        el('button', { type: 'button', class: 'link-btn', text: 'Forgot PIN? Reset app', onclick: () => forgotPinFlow() }),
      ]),
    ]));

    // Auto-prompt biometric - feels native on mobile (lock screen → fingerprint).
    // silent=true so a browser that blocks auto-prompts (Safari) fails quietly
    // and the user just uses the keypad's 👆 key or types the PIN.
    if (hasBio) setTimeout(() => tryBio(true), 350);
  });
}

async function forgotPinFlow() {
  const warn = 'Resetting will erase ALL local data on this device and turn off the lock.\n\n' +
    'Make sure you have a recent backup (Menu → Export). You can re-import after reset.\n\nContinue?';
  if (!confirm(warn)) return;
  if (!confirm('Last warning - reset now and lose all unsynced changes?')) return;
  try { await wipeAllData(); } catch (_) {}
  location.reload();
}

// First-time setup: enter PIN → confirm PIN → optional biometric.
async function openLockSetup() {
  const dots = el('div', { class: 'pin-dots' });
  const errorEl = el('div', { class: 'lock-error' });
  const title = el('div', { class: 'lock-title', text: 'Set up app lock' });
  const sub = el('div', { class: 'lock-sub', text: 'Choose a ' + PIN_LENGTH + '-digit PIN' });
  let stage = 'set';   // 'set' → 'confirm' → 'bio'
  let firstPin = '';

  const card = el('div', { class: 'lock-card lock-card-modal' });

  const showBioStep = async () => {
    stage = 'bio';
    sub.textContent = 'PIN saved. Want faster unlock with biometric?';
    dots.style.display = 'none';
    const keypad = card.querySelector('.kpad');
    if (keypad) keypad.style.display = 'none';
    const avail = await biometricAvailable();
    const enableBtn = el('button', {
      type: 'button', class: 'btn primary', text: avail ? 'Enable biometric' : 'Not available on this device',
      onclick: async () => {
        try {
          await registerBiometric();
          closeModal();
          toast('App lock enabled · biometric on');
        } catch (e) { errorEl.textContent = 'Could not enable: ' + (e.message || e); }
      },
    });
    if (!avail) enableBtn.disabled = true;
    card.appendChild(el('div', { class: 'lock-bio-row' }, [
      enableBtn,
      el('button', { type: 'button', class: 'btn ghost', text: 'Skip for now', onclick: () => { closeModal(); toast('App lock enabled'); } }),
    ]));
  };

  const ctrl = makePinController(dots, errorEl, async (pin) => {
    if (stage === 'set') {
      firstPin = pin; stage = 'confirm';
      sub.textContent = 'Confirm your PIN';
      ctrl.reset();
    } else if (stage === 'confirm') {
      if (pin === firstPin) {
        try { await setPin(firstPin); } catch (e) { ctrl.setError(e.message); ctrl.reset(); return; }
        showBioStep();
      } else {
        ctrl.setError('PINs didn\'t match - try again');
        firstPin = ''; stage = 'set';
        sub.textContent = 'Choose a ' + PIN_LENGTH + '-digit PIN';
        ctrl.reset();
      }
    }
  });

  card.appendChild(el('div', { class: 'lock-logo', text: '🔒' }));
  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(dots);
  card.appendChild(errorEl);
  card.appendChild(buildKeypad(ctrl.onPress, null));

  openModal(card);
}

// Change PIN flow: verify current PIN → new PIN → confirm new PIN.
async function openChangePin() {
  const dots = el('div', { class: 'pin-dots' });
  const errorEl = el('div', { class: 'lock-error' });
  const sub = el('div', { class: 'lock-sub', text: 'Enter current PIN' });
  let stage = 'old', newPin = '';
  const ctrl = makePinController(dots, errorEl, async (pin) => {
    if (stage === 'old') {
      if (!(await verifyPin(pin))) { ctrl.setError('Wrong PIN'); ctrl.reset(); return; }
      stage = 'new'; sub.textContent = 'Enter new PIN'; ctrl.reset();
    } else if (stage === 'new') {
      newPin = pin; stage = 'confirm'; sub.textContent = 'Confirm new PIN'; ctrl.reset();
    } else {
      if (pin === newPin) {
        try { await setPin(newPin); closeModal(); toast('PIN changed'); }
        catch (e) { ctrl.setError(e.message); ctrl.reset(); }
      } else {
        ctrl.setError('PINs didn\'t match'); stage = 'new'; sub.textContent = 'Enter new PIN'; newPin = ''; ctrl.reset();
      }
    }
  });
  openModal(el('div', { class: 'lock-card lock-card-modal' }, [
    el('div', { class: 'lock-logo', text: '🔒' }),
    el('div', { class: 'lock-title', text: 'Change PIN' }),
    sub, dots, errorEl, buildKeypad(ctrl.onPress, null),
  ]));
}

// Settings sheet shown when the user taps the menu item while lock is on.
async function openLockSettings() {
  const cfg = await getLockConfig();
  const bioAvail = await biometricAvailable();
  const items = [];
  items.push(menuItem('🔢', 'Change PIN', 'Set a new ' + PIN_LENGTH + '-digit PIN', () => { closeModal(); openChangePin(); }));
  if (cfg.biometric && cfg.biometric.enabled) {
    items.push(menuItem('👆', 'Disable biometric', 'Unlock with PIN only', async () => {
      await disableBiometric(); closeModal(); toast('Biometric disabled');
    }));
  } else if (bioAvail) {
    items.push(menuItem('👆', 'Enable biometric', 'Unlock with fingerprint or face', async () => {
      try { await registerBiometric(); closeModal(); toast('Biometric enabled'); }
      catch (e) { alert('Could not enable: ' + (e.message || e)); }
    }));
  }
  items.push(menuItem('🔓', 'Turn off app lock', 'Disable PIN and biometric', async () => {
    if (!confirm('Turn off the app lock?\n\nAnyone with this device will be able to open the app.')) return;
    await disableLock(); closeModal(); toast('App lock disabled');
  }));
  openModal(el('div', { class: 'sheet' }, [
    el('h2', { text: 'App lock' }),
    el('p', { class: 'hint', text: 'Lock state stays on this device only. No data leaves your phone.' }),
    el('div', { class: 'menu-list' }, items),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn ghost', text: 'Close', onclick: closeModal })]),
  ]));
}

// Entry point invoked from the main menu. Routes to setup or settings.
async function openLockEntry() {
  const cfg = await getLockConfig();
  if (cfg && cfg.enabled) openLockSettings();
  else openLockSetup();
}

// ---------- app updates (user-triggered) ----------

// Tap-to-update flow. Two paths:
//   1. A new SW is already waiting (detected at startup) → postMessage to
//      skip-wait → SW activates → controllerchange → page reloads.
//   2. No SW waiting → call reg.update() to ask the browser to fetch a fresh
//      service-worker.js. If a new one installs, same flow as #1. Otherwise
//      toast "up to date".
async function checkForUpdates() {
  if (!('serviceWorker' in navigator)) { toast('Updates not supported in this browser'); return; }
  const reg = window.__swReg || await navigator.serviceWorker.getRegistration();
  if (!reg) { toast('Service worker not registered'); return; }

  // Already waiting - just apply it.
  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    toast('Applying update…');
    return; // controllerchange handler will reload
  }

  toast('Checking for updates…');
  try {
    await reg.update();
  } catch (e) {
    toast('Could not reach server - try again later');
    return;
  }

  // If reg.update found something new, it's now in `installing`. Wait for it.
  if (reg.installing) {
    await new Promise((resolve) => {
      const sw = reg.installing;
      const done = () => { sw.removeEventListener('statechange', onChange); resolve(); };
      const onChange = () => {
        if (sw.state === 'installed' || sw.state === 'activated' || sw.state === 'redundant') done();
      };
      sw.addEventListener('statechange', onChange);
      // Safety timeout - don't block forever on a hung install.
      setTimeout(done, 8000);
    });
  }

  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    toast('Update found - applying…');
  } else {
    toast('You\'re on the latest version');
  }
}

// ---------- install ----------
function doInstall() {
  closeModal();
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.finally(() => { deferredInstall = null; });
}

// ---------- init ----------
function bind() {
  $('#addBtn').addEventListener('click', () => openStockForm(null));
  $('#ocrBtn').addEventListener('click', openOcrFlow);
  $('#mfAddBtn').addEventListener('click', () => openFundForm(null));
  $('#mfFetchBtn').addEventListener('click', () => fetchMfNavs());
  $('#fdAddBtn').addEventListener('click', () => openFdForm(null));
  $('#backBtn').addEventListener('click', () => setAppMode('home'));
  $('#menuBtn').addEventListener('click', openMenu);
  const onSearch = debounce(renderList, 120);
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; onSearch(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyTheme();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
}

// Ask the browser to make our storage durable so the OS won't evict it under
// storage pressure. Pure upside; the user may see a prompt (Firefox) or it
// auto-grants for installed PWAs (Chrome). Failures are silent.
async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) {}
  }
}

// One-time-per-session nudge if it's been more than 30 days since the last
// Export, so 10-year durability doesn't hinge on memory alone.
async function checkBackupReminder() {
  try {
    const stocks = await DB.all('stocks');
    if (!stocks.length) return;
    const m = await DB.get('meta', 'lastBackup');
    const last = m ? m.value : 0;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    if (days != null && days <= 30) return;
    if (sessionStorage.getItem('backupNudgeShown')) return;
    sessionStorage.setItem('backupNudgeShown', '1');
    setTimeout(() => toast(last ? 'Backup reminder · last backup ' + days + ' days ago' : 'Tip · export a backup soon (menu → Export)'), 1500);
  } catch (_) {}
}

function checkMonthEndSnapshotReminder() {
  if (!isMonthEndReminderWindow() || !missingCurrentMonthCapture(state.months)) return;
  const key = 'snapshotReminderShown_' + state.portfolio + '_' + thisYm();
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
  setTimeout(() => toast('Month-end reminder: capture ' + ymToLabel(thisYm()) + ' snapshot'), 2300);
}

async function init() {
  applyTheme();
  buildChrome();
  bind();
  // App-lock gate: if the user has set a PIN, block here until they unlock.
  // Data load happens *after* unlock - so even if the overlay is somehow
  // bypassed, the in-memory state is still empty until verification succeeds.
  try { await showLockScreen(); } catch (e) { console.error('lock screen error', e); }
  // Load the stock data (render() no-ops while appMode==='home'), then show the
  // Home launcher. Tapping "Stocks" just unhides the already-loaded surface.
  try { await refresh(); } catch (e) { console.error(e); toast('Could not open local database'); }
  setAppMode('home');
  if ('serviceWorker' in navigator) {
    try {
      // updateViaCache: 'none' ensures any update check (manual or browser-
      // initiated) bypasses the HTTP cache for the SW script - so we always
      // see the bumped CACHE = 'vNN'. We do NOT auto-call reg.update() here:
      // updates apply only when the user taps Menu → "Check for updates".
      const reg = await navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' });
      window.__swReg = reg;

      // Mark "update ready" if a new SW is already waiting (e.g. installed in
      // a previous tab/session) and we have an active controller serving us.
      const markReady = () => {
        if (navigator.serviceWorker.controller) {
          window.__updateReady = true;
          // If the menu is currently open, redraw it so the label flips.
          const openSheet = document.querySelector('.modal-host:not(.hidden) .sheet h2');
          if (openSheet && openSheet.textContent === 'Menu') { closeModal(); openMenu(); }
        }
      };
      if (reg.waiting) markReady();
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed') markReady();
        });
      });

      // controllerchange fires when the new SW claims the page (after the
      // user's tap triggered SKIP_WAITING). This reload is intentional.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    } catch (e) { console.warn('SW registration failed', e); }
  }
  requestPersistentStorage();
  checkBackupReminder();
  checkMonthEndSnapshotReminder();
  // Idempotent: back-fills wife-in (and reverse) months with the peer's Nifty
  // where one side is missing it. Cheap; a no-op once everything's in sync.
  syncNiftyAll().catch(() => {});
  // Silent feed refresh on app open - so the user doesn't have to visit the
  // Feed tab to get fresh news. Fires for the active portfolio when its
  // session-anchor sync is stale.
  _autoRefreshFeedOnInit().catch(() => {});
}

init();
