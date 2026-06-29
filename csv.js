// X-MyNotes "Stock" tab parser. Pure (no DOM/storage) and lazy-loaded on demand,
// since importing is an occasional action that shouldn't weigh down startup.
import { monthToDate, cleanNum, labelToYm, monthKey } from './core.js';

// Standard CSV tokenizer (handles quotes, embedded commas/newlines, "" escapes).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) endRow();
  return rows;
}

const MONTH_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s*\d{4}/i;
const SUMMARY_LABELS = new Set([
  '', 'STOCK', 'US Stocks', 'Rs', 'Total Investment', 'AVG Investment', 'Nifty 50',
  'Total Return', 'Profit', 'AVG %', 'Total Stocks', 'Negative Stocks', 'Positive Stocks',
  'Tobe Focused', 'To be More Focused', 'GPT REPORTS', 'AVERAGE SHARE', 'Stock', 'Growth Catalysts',
  'Negative', 'balance', 'loss',
]);
const stripEmoji = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✋️‍]/gu, '').replace(/\s+/g, ' ').trim();

// Block 1 (STOCK) -> me-in, (US Stocks) -> me-us, block 2 (STOCK) -> wife-in.
// Returns { stocks, monthly } — monthly holds the per-block summary rows
// (total invested, total return, Nifty, profit/loss counts) keyed by month.
export function parseXMyNotesCSV(text) {
  const rows = parseCSV(text);
  const stocks = [];
  const monthly = [];
  let portfolio = null;
  let months = [];
  let stockBlocks = 0;
  let agg = null;

  const flush = () => {
    if (!portfolio || !agg || !months.length) return;
    const now = new Date().toISOString();
    for (const m of months) {
      const L = m.label;
      const invested = agg.invested[L], ret = agg.ret[L], nifty = agg.nifty[L], pos = agg.pos[L], neg = agg.neg[L];
      if (invested == null && ret == null && nifty == null && pos == null && neg == null) continue;
      const ym = labelToYm(L);
      if (!ym) continue;
      monthly.push({
        key: monthKey(portfolio, ym),
        portfolio, ym,
        invested: invested != null ? invested : null,
        value: (invested != null && ret != null) ? invested + ret : (invested != null ? invested : null),
        profitLoss: ret != null ? ret : null,
        returnPct: (invested && ret != null) ? (ret / invested) * 100 : null,
        countProfit: pos != null ? pos : null,
        countLoss: neg != null ? neg : null,
        nifty: nifty != null ? nifty : null,
        source: 'import',
        updatedAt: now,
      });
    }
  };

  for (const row of rows) {
    const c1 = (row[1] || '').trim();
    const c2 = (row[2] || '').trim();

    if (c2 === 'STOCK' || c2 === 'US Stocks') {
      flush();
      months = [];
      for (let j = 3; j < row.length; j++) {
        const v = (row[j] || '').trim();
        if (MONTH_RE.test(v)) months.push({ idx: j, label: v });
        else if (months.length) break;
      }
      if (c2 === 'US Stocks') portfolio = 'me-us';
      else { stockBlocks++; portfolio = stockBlocks === 1 ? 'me-in' : 'wife-in'; }
      agg = { invested: {}, ret: {}, nifty: {}, pos: {}, neg: {} };
      continue;
    }
    if (!portfolio || !months.length) continue;

    // Block summary rows -> monthly aggregates.
    if (agg) {
      const into = (bucket) => { for (const m of months) { const n = cleanNum(row[m.idx]); if (n != null) bucket[m.label] = n; } };
      if (c2 === 'Rs' || c2 === '$') { into(agg.invested); continue; }
      if (c2 === 'Nifty 50') { into(agg.nifty); continue; }
      if (c2 === 'Positive Stocks') { into(agg.pos); continue; }
      if (c2 === 'Negative Stocks') { into(agg.neg); continue; }
      if (c1 === 'Total Return') { into(agg.ret); continue; }
    }

    const raw = c2;
    if (!raw || SUMMARY_LABELS.has(raw) || raw.length > 40) continue;

    let conviction = '';
    if (raw.indexOf('👎') >= 0) conviction = 'down';
    else if (raw.indexOf('👍') >= 0) conviction = 'up';
    else if (raw.indexOf('✋') >= 0) conviction = 'watch';
    const name = stripEmoji(raw);
    if (!name) continue;

    const history = [];
    let sold = null;
    for (const m of months) {
      const cell = (row[m.idx] || '').trim();
      if (!cell) continue;
      if (/^-?\d+(\.\d+)?%$/.test(cell)) {
        history.push({ month: m.label, pct: parseFloat(cell) });
        continue;
      }
      const xm = cell.match(/(-?\d+(?:\.\d+)?)\s*[x×]\s*(-?\d+(?:\.\d+)?)/);
      if (xm) sold = { price: parseFloat(xm[1]), units: parseFloat(xm[2]), month: m.label, raw: cell };
    }
    if (!history.length && !sold) continue;

    const now = new Date().toISOString();
    stocks.push({
      portfolio,
      name,
      category: c1,
      conviction,
      status: sold ? 'sold' : 'holding',
      units: null,
      buyPrice: null,
      currentPrice: null,
      soldPrice: sold ? sold.price : null,
      soldUnits: sold ? sold.units : null,
      soldDate: sold ? monthToDate(sold.month) : null,
      notes: sold ? 'Imported sell: ' + sold.raw : '',
      history,
      createdAt: now,
      updatedAt: now,
    });
  }
  flush();
  return { stocks, monthly };
}
