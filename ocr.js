// Lazy OCR for broker holdings screenshots. Pure: no DB / DOM. Tesseract.js is
// fetched from CDN on first use and cached by the browser after that — only the
// app shell needs to be precached for offline use.

const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let _tessLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tessLoading) return _tessLoading;
  _tessLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESS_CDN;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR engine did not initialise')));
    s.onerror = () => reject(new Error('Could not download OCR engine. Check your internet — first use is online.'));
    document.head.appendChild(s);
  });
  return _tessLoading;
}

export async function ocrImage(file, onProgress) {
  const T = await loadTesseract();
  const result = await T.recognize(file, 'eng', onProgress ? { logger: onProgress } : undefined);
  return result.data.text || '';
}

// Batch variant: one Tesseract worker shared across N images. Tesseract.recognize()
// spins up a fresh worker per call (1-2s cold start each), so for 4-5 screenshots
// a shared worker saves real wall-clock time. Progress events carry fileIndex /
// fileCount so the UI can render "Image 2/4 · 73%" without bookkeeping outside.
export async function ocrImages(files, onProgress) {
  const T = await loadTesseract();
  let curIdx = 0;
  const total = files.length;
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => {
      if (onProgress) onProgress({ ...m, fileIndex: curIdx, fileCount: total });
    },
  });
  const texts = [];
  try {
    for (let i = 0; i < files.length; i++) {
      curIdx = i;
      // Synthetic "starting" tick so the loader updates immediately on each
      // new image (Tesseract's own first logger event can lag a second or two).
      if (onProgress) onProgress({ status: 'reading image', progress: 0, fileIndex: i, fileCount: total });
      const { data } = await worker.recognize(files[i]);
      texts.push(data.text || '');
    }
  } finally {
    try { await worker.terminate(); } catch (_) {}
  }
  return texts;
}

// Parses a broker holdings screenshot's text into rows of {name, units, avg, ltp}.
// Heuristic: find "<units> x <avg>" lines, then the preceding non-numeric line
// is the name, and a nearby "LTP: <price>" line is the current price.
// Search anywhere in a line, not anchored — OCR often adds trailing whitespace,
// emoji glyphs, or stray characters that break ^...$ matching.
const UNITS_RE = /(\d{1,7})\s*[xX×*]\s*([\d,]+(?:\.\d+)?)/;
const LTP_RE = /LTP\s*[:\s]\s*([\d,]+(?:\.\d+)?)/i;
const NUMERIC_ONLY = /^[₹$\d.,()\-+%\s]+$/;
// Tesseract often joins the right-column value onto the name (e.g.
// "Aditya Birla Money ₹6,351.68" or "$6,351.68" if ₹ is misread). Strip it.
function cleanName(s) {
  let out = (s || '').trim();
  // drop trailing "<currency?> <number>" (possibly with sign / parens)
  out = out.replace(/\s+[-+]?\s*[₹$€£]?\s*[\d][\d,]*(?:\.\d+)?\s*(?:\([^)]*\))?\s*%?\s*$/i, '').trim();
  // strip leading/trailing non-letter junk (briefcase glyphs, dots, etc.)
  out = out.replace(/^[^\p{L}\d]+|[^\p{L}\d)%]+$/gu, '').trim();
  return out;
}

function n(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/[,\s]/g, ''));
  return isNaN(v) ? null : v;
}

// Layout A — "Kite/Zerodha-style": "<U> x <Avg>" line + "LTP: <P>" line, name above.
function parseZerodhaStyle(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [];
  const recent = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const u = ln.match(UNITS_RE);
    if (u) {
      let name = '';
      for (let j = recent.length - 1; j >= 0; j--) {
        const c = recent[j];
        if (NUMERIC_ONLY.test(c)) continue;
        if (/^LTP[:\s]/i.test(c)) continue;
        if (c.length < 2) continue;
        name = c; break;
      }
      let ltp = null;
      for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
        const m = lines[k].match(LTP_RE);
        if (m) { ltp = n(m[1]); break; }
      }
      const units = Number(u[1]);
      const avg = n(u[2]);
      const cleaned = cleanName(name);
      if (cleaned && !isNaN(units) && avg != null) rows.push({ name: cleaned, units, avg, ltp });
      recent.length = 0;
      continue;
    }
    recent.push(ln);
    if (recent.length > 6) recent.shift();
  }
  return rows;
}

const SHARES_RE = /(\d{1,7})\s+shares?\b/i;

// Layout C (legacy) — older INDmoney US Stocks view: row 1 "<Name> <Qty> Qty",
// row 2 "$<LTP> ▲/▼ <chg%> Avg: $<Avg>". Everything's in one shot.
const US_QTY_RE = /^(.+?)\s+([\d.,]+)\s*Qty\b/i;
const US_AVG_RE = /Avg:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i;
const US_PRICE_RE = /\$\s*([\d,]+(?:\.\d+)?)/;
function parseUSStyleLegacy(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(US_QTY_RE);
    if (!m) continue;
    const name = cleanName(m[1]);
    const units = parseFloat(String(m[2]).replace(/,/g, ''));
    if (!name || !isFinite(units) || units <= 0) continue;
    let ltp = null, avg = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const l = lines[j];
      if (ltp == null) { const pm = l.match(US_PRICE_RE); if (pm) ltp = parseFloat(pm[1].replace(/,/g, '')); }
      if (avg == null) { const am = l.match(US_AVG_RE); if (am) avg = parseFloat(am[1].replace(/,/g, '')); }
      if (ltp != null && avg != null) break;
    }
    rows.push({ name, units, avg, ltp });
  }
  return rows;
}

// Layout C2 — current INDmoney US Stocks card view. Each holding is a card of
// two columns; visually:
//   [icon] <Name>                     Avg. $<Avg>
//          🌙 $<LTP> ▼<chg%>          Qty <units>
//   Invested Value   Current Value    Total (▲/▼ <pct>%)
//   $<inv>           $<cur>           +/-$<pl>
// Two things broke the old parser when the app was redesigned: "Avg." now uses
// a period (not "Avg:"), and "Qty" is a label BEFORE the number instead of a
// suffix after it — so neither legacy regex above matches any more.
//
// Tesseract's line order for a two-column layout is not predictable: it may
// join each visual row into one line ("Broadcom Inc. Avg. $350.07") or emit the
// columns separately. So anchor on the unambiguous "Qty <number>" line and
// search outward BY PROXIMITY for avg/ltp/name. Crucially, a candidate name
// line is not rejected for containing "$"/"%" (the name shares its row with
// "Avg. $X"); instead the numeric fragments are stripped and whatever text
// remains is the name.
const US2_QTY_RE = /\bQty\b\s*[:\s]?\s*([\d.,]+)/i;
const US2_AVG_RE = /Avg\.?:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i;
// Between the $price and the trailing "<pct>%" sits a daily-change arrow glyph
// (▲/▼) that Tesseract frequently misreads as a stray letter/digit rather than
// dropping cleanly — so allow a few arbitrary characters there instead of
// matching a fixed arrow-character class.
const US2_LTP_RE = /\$\s*([\d,]+(?:\.\d+)?)[^\n$%]{0,6}?[\d.]+\s*%/;
const US2_LABEL_RE = /^(invested value|current value|total\b|qty\b|avg\b)/i;

// Remove every price/percent/label fragment that can share a line with the
// company name, leaving just the name text ("Broadcom Inc. Avg. $350.07" →
// "Broadcom Inc."; a pure price line collapses to "" and is skipped).
function stripUSNoise(s) {
  return String(s || '')
    .replace(US2_AVG_RE, ' ')
    .replace(/\bAvg\.?\b/gi, ' ')
    .replace(/\bQty\b\s*[:\s]?\s*[\d.,]+/gi, ' ')
    .replace(/\bQty\b/gi, ' ')
    .replace(/[\d.]+\s*%/g, ' ')
    .replace(/[₹$€£]\s*[\d,]+(?:\.\d+)?/g, ' ')
    .replace(/[▲▼△▽↑↓]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Line indices ordered by distance from `i` (i, i-1, i+1, i-2, …) so the
// nearest match wins regardless of which way Tesseract ordered the columns.
function nearbyIndices(i, len, back, fwd) {
  const out = i >= 0 && i < len ? [i] : [];
  for (let d = 1; d <= Math.max(back, fwd); d++) {
    if (d <= back && i - d >= 0) out.push(i - d);
    if (d <= fwd && i + d < len) out.push(i + d);
  }
  return out;
}

// A real company name always has at least one run of 2+ letters. Stray glyphs
// left over from a stripped price line (the moon icon and the ▼ arrow can OCR
// as "D" and "v", leaving "D v") are isolated single letters, so they fail this.
const NAME_WORD = /\p{L}{2,}/u;

function parseUSStyleCards(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const qm = lines[i].match(US2_QTY_RE);
    if (!qm) continue;
    const units = parseFloat(String(qm[1]).replace(/,/g, ''));
    if (!isFinite(units) || units <= 0) continue;

    let avg = null;
    for (const j of nearbyIndices(i, lines.length, 3, 1)) {
      const am = lines[j].match(US2_AVG_RE);
      if (am) { avg = n(am[1]); break; }
    }

    let ltp = null;
    for (const j of nearbyIndices(i, lines.length, 4, 1)) {
      const lm = lines[j].match(US2_LTP_RE);
      if (lm) { ltp = n(lm[1]); break; }
    }

    // Nearest preceding line that still has a real word once the numbers are
    // stripped. The "$<price> ▼<pct>%" line is skipped outright — when the
    // columns come through separately it sits between the name and the Qty
    // anchor, and its leftover glyphs would otherwise win.
    let name = '';
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const c = lines[j];
      if (!c || US2_LABEL_RE.test(c) || US2_LTP_RE.test(c)) continue;
      const stripped = cleanName(stripUSNoise(c));
      if (!stripped || !NAME_WORD.test(stripped)) continue;
      name = stripped;
      break;
    }
    if (name) rows.push({ name, units, avg, ltp });
  }
  return rows;
}

// Try the current card layout first; fall back to the older row layout in
// case an old screenshot (or a different INDmoney build) is uploaded.
function parseUSStyle(text) {
  const rows = parseUSStyleCards(text);
  return rows.length ? rows : parseUSStyleLegacy(text);
}

// Layout B — "Groww · Market Price" view: row = "<Name> <Price>" then
// "<N> shares …". No avg in this view (kept null; Apply leaves the existing
// buy price untouched, so OCR never overwrites a real avg with a wrong one).
//
// Quirks this parser tolerates (each one was dropping rows silently before):
//   1. ₹ is glued to the price ("Adani Power ₹230.03") — the old regex needed
//      whitespace right before the digits, which fails when ₹ sits between.
//      Allow an optional currency glyph (₹ ₨ $ € £) between name and digits.
//   2. ₹ misread by Tesseract as "3" ("Adani Power 3230.03") — those still
//      match; the inflated value is flagged orange in the review for manual fix.
//   3. Sparkline / chart-noise line injected between the name+price line and
//      the "<N> shares" line — look back up to 2 lines, not just 1.
function parseGrowwStyle(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Trailing price tolerant of glued/missing currency glyph. `.*?\S` is non-
  // greedy so the engine extends only until digits can match at the tail.
  const PRICE_TAIL = /^(.*?\S)\s*[₹₨$€£]?\s*([\d,]+(?:\.\d+)?)\s*$/;
  const HAS_LETTER = /\p{L}/u;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const sh = lines[i].match(SHARES_RE);
    if (!sh) continue;
    const units = Number(sh[1]);
    if (isNaN(units)) continue;
    // Search the 1-2 preceding lines for "<name> <price>" — Tesseract sometimes
    // injects a noisy intermediate line from the row's sparkline graphic.
    let pm = null;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const m = lines[j].match(PRICE_TAIL);
      if (m && HAS_LETTER.test(m[1])) { pm = m; break; }
    }
    if (!pm) continue;
    const name = cleanName(pm[1]);
    const ltp = n(pm[2]);
    if (!name || ltp == null) continue;
    rows.push({ name, units, avg: null, ltp });
  }
  return rows;
}

// Each portfolio is tied to a specific broker, so we dispatch by portfolio
// rather than trying every parser — keeps OCR predictable and avoids cross-
// broker false positives.
//   me-in   → Zerodha/Kite style (units × avg, LTP:)
//   me-us   → INDmoney US Stocks (Name + Qty / $LTP / Avg: $X)
//   wife-in → Groww "Market Price" view. Layout shows only price (no avg), and
//             Tesseract often misreads the ₹ glyph as "3", so the review modal
//             gates writes to currentPrice only — units & buyPrice are never
//             overwritten from this layout.
//   anything else → unsupported (no rows)
export function parseBrokerRows(text, portfolio) {
  if (portfolio === 'me-in') return parseZerodhaStyle(text);
  if (portfolio === 'me-us') return parseUSStyle(text);
  if (portfolio === 'wife-in') return parseGrowwStyle(text);
  return [];
}

export const OCR_SUPPORTED = new Set(['me-in', 'me-us', 'wife-in']);

// Normalised name used for fuzzy matching parsed broker names to existing stocks.
export const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
