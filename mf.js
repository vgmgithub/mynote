// Mutual-fund logic: XIRR, projections and the one-time seed data from the
// user's "Mutual Fund" sheet. Pure — no DOM, no storage, no side effects.
// Lazy-loaded from app.js (renderMF) so the Stocks app never pays for it.
//
// XIRR accuracy model: a fund's return is computed from DATED cashflows, not
// daily NAV. Each investment is one negative cashflow { date, amount }; the
// current value is a single positive cashflow on `valueAsOf`. So the user only
// needs to (a) log each investment with its date and (b) refresh the current
// value now and then — never a daily NAV.

const DAY = 86400000;
const CLAMP_LO = -0.5;   // projection-rate floor (a −50%/yr fund is already dead)
const CLAMP_HI = 0.35;   // projection-rate ceiling (35%/yr is generous long-term)

// ---------- derived totals ----------
export function investedOf(fund) {
  return (fund.contributions || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
}
// Total units held = Σ units across transactions (buys add, sells could subtract
// but the current model logs buys only; a sold fund realises via soldValue).
export function totalUnitsOf(fund) {
  return (fund.contributions || []).reduce((s, c) => s + (Number(c.units) || 0), 0);
}
// Weighted average purchase NAV = total invested ÷ total units.
export function avgNavOf(fund) {
  const u = totalUnitsOf(fund);
  return u > 0 ? investedOf(fund) / u : null;
}
export function latestValue(fund) {
  const vh = fund.valueHistory || [];
  if (!vh.length) return 0;
  const sorted = vh.slice().sort((a, b) => (a.ym || '').localeCompare(b.ym || ''));
  return Number(sorted[sorted.length - 1].value) || 0;
}

// ---------- XIRR (annualised internal rate of return, irregular cashflows) ----------
// cashflows: [{ date: 'YYYY-MM-DD', amount }] — negative = money invested,
// positive = value returned. Returns a decimal rate (0.16 == 16%) or null.
export function xirr(cashflows) {
  const cfs = (cashflows || [])
    .map((c) => ({ t: Date.parse(c.date), a: Number(c.amount) }))
    .filter((c) => !isNaN(c.t) && !isNaN(c.a) && c.a !== 0)
    .sort((a, b) => a.t - b.t);
  if (cfs.length < 2) return null;
  if (!cfs.some((c) => c.a > 0) || !cfs.some((c) => c.a < 0)) return null; // need both signs
  const t0 = cfs[0].t;
  const npv = (r) => {
    let s = 0;
    for (const c of cfs) s += c.a / Math.pow(1 + r, (c.t - t0) / DAY / 365);
    return s;
  };
  const dnpv = (r) => {
    let s = 0;
    for (const c of cfs) {
      const y = (c.t - t0) / DAY / 365;
      s += (-y * c.a) / Math.pow(1 + r, y + 1);
    }
    return s;
  };
  // Newton-Raphson from a few seeds; accept the first sane root.
  for (const seed of [0.1, 0, 0.3, -0.3, 1]) {
    let r = seed, ok = true;
    for (let i = 0; i < 80; i++) {
      const f = npv(r), d = dnpv(r);
      if (!isFinite(f) || !isFinite(d) || d === 0) { ok = false; break; }
      const next = r - f / d;
      if (!isFinite(next) || next <= -0.9999) { ok = false; break; }
      if (Math.abs(next - r) < 1e-8) { r = next; break; }
      r = next;
    }
    if (ok && r > -0.9999 && Math.abs(npv(r)) < 1e-4) return r;
  }
  // Bisection fallback over a wide bracket.
  let lo = -0.9999, hi = 100, flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (!isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-6) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// ---------- projections ----------
// Future value at the target date. stayInvested=false → let the current corpus
// grow only; true → also add the ongoing monthly SIP as an annuity.
export function projectCorpus(value, sip, rate, monthsLeft, stayInvested) {
  const r = Math.max(CLAMP_LO, Math.min(CLAMP_HI, Number(rate) || 0));
  const yrs = (Number(monthsLeft) || 0) / 12;
  const grown = (Number(value) || 0) * Math.pow(1 + r, yrs);
  if (!stayInvested) return grown;
  const s = Number(sip) || 0;
  if (s <= 0) return grown;
  const mR = Math.pow(1 + r, 1 / 12) - 1;
  const fvSip = Math.abs(mR) < 1e-9 ? s * monthsLeft : s * ((Math.pow(1 + mR, monthsLeft) - 1) / mR);
  return grown + fvSip;
}

// Months from `now` to December of the target year (never negative).
function monthsToTargetEnd(nowDate, targetYear) {
  return Math.max(0, (targetYear - nowDate.getFullYear()) * 12 + (11 - nowDate.getMonth()));
}

// Everything the UI needs for one fund. `nowMs` is injectable for testing.
export function computeFund(fund, nowMs) {
  const now = nowMs || Date.now();
  const nowDate = new Date(now);
  const invested = investedOf(fund);
  const totalUnits = totalUnitsOf(fund);
  const avgNav = avgNavOf(fund);
  const latestNav = fund.latestNav != null && fund.latestNav !== '' ? Number(fund.latestNav) : null;
  // A fund is "sold" (holding vs redeemed — independent of SIP status) when its
  // status is Sold or it carries a sold date. Sold funds realise at their sold
  // value/date. Held funds derive current value from units × latest NAV when both
  // are known (authoritative & self-consistent); otherwise fall back to the
  // manually-entered value snapshot (seeded/legacy funds with no per-unit data).
  const sold = fund.status === 'Sold' || !!fund.soldDate;
  let value, valueSource;
  if (sold) { value = Number(fund.soldValue) || 0; valueSource = 'sold'; }
  else if (totalUnits > 0 && latestNav != null && latestNav > 0) { value = totalUnits * latestNav; valueSource = 'nav'; }
  else { value = latestValue(fund); valueSource = 'manual'; }
  const valueDate = (sold ? (fund.soldDate || fund.valueAsOf) : (fund.navAsOf || fund.valueAsOf)) || nowDate.toISOString().slice(0, 10);
  const absReturnPct = invested > 0 ? ((value - invested) / invested) * 100 : 0;
  // The stored returnLow/High only move when a save persists them (see app.js's
  // lo()/hi() merge in every NAV-update path). Between saves, a live recompute
  // can already be a new high/low that hasn't been written yet - so anything
  // displaying "your range" should use these, not the raw stored fields, or a
  // fresh all-time-high would show above a stale (lower) high label.
  const liveReturnLow = fund.returnLow != null ? Math.min(Number(fund.returnLow), absReturnPct) : absReturnPct;
  const liveReturnHigh = fund.returnHigh != null ? Math.max(Number(fund.returnHigh), absReturnPct) : absReturnPct;

  const times = (fund.contributions || []).map((c) => Date.parse(c.date)).filter((t) => !isNaN(t)).sort((a, b) => a - b);
  const endT = sold ? (Date.parse(valueDate) || now) : now;
  const ageYears = times.length ? (endT - times[0]) / (365.25 * DAY) : 0;

  // XIRR: a held seeded fund shows the sheet's figure until the user logs real
  // investments (then `seeded` is cleared). Sold funds always compute a realised
  // XIRR from the dated investments to the sold value.
  let rate = null, xirrSource = 'none';
  if (!sold && fund.seeded && fund.seedXirrRef != null) {
    rate = Number(fund.seedXirrRef);
    xirrSource = 'sheet';
  } else if (invested > 0 && value > 0 && times.length) {
    const cfs = (fund.contributions || []).map((c) => ({ date: c.date, amount: -Math.abs(Number(c.amount) || 0) }));
    cfs.push({ date: valueDate, amount: value });
    rate = xirr(cfs);
    xirrSource = rate != null ? (sold ? 'realized' : 'computed') : 'none';
  }
  const xirrPct = rate != null ? rate * 100 : null;
  // Same live-vs-stored staleness fix as liveReturnLow/High, for the XIRR viz.
  const liveXirrLow = xirrPct == null ? (fund.xirrLow != null ? Number(fund.xirrLow) : null)
    : fund.xirrLow != null ? Math.min(Number(fund.xirrLow), xirrPct) : xirrPct;
  const liveXirrHigh = xirrPct == null ? (fund.xirrHigh != null ? Number(fund.xirrHigh) : null)
    : fund.xirrHigh != null ? Math.max(Number(fund.xirrHigh), xirrPct) : xirrPct;

  // ---------- benchmark status (return only — XIRR no longer factors in) ----------
  // A manual return target (benchReturnLow/High, user-defined, never auto-modified)
  // wins when the user has set one. Otherwise this falls back to the fund's own
  // auto-tracked historical range (returnLow/returnHigh — updated every time the
  // value changes, in every NAV-update path), so status always reflects reality
  // without requiring a separate manual "benchmark" to be saved first: hitting a
  // new all-time-high return reads Above the moment that NAV update lands.
  const th = (v) => (v != null && v !== '' ? Number(v) : null);
  const benchRetLo = th(fund.benchReturnLow), benchRetHi = th(fund.benchReturnHigh);
  // No longer used for benchStatus (return-only now), but still read for the
  // projection-rate fallback below and returned to the UI's Benchmark tab readout.
  const benchXirrLo = th(fund.benchXirrLow != null && fund.benchXirrLow !== '' ? fund.benchXirrLow : fund.benchXirr);
  const benchXirrHi = th(fund.benchXirrHigh);
  let benchStatus = null;
  if (invested > 0) {
    if (benchRetLo != null || benchRetHi != null) {
      const loP = benchRetLo != null ? benchRetLo * 100 : null;
      const hiP = benchRetHi != null ? benchRetHi * 100 : null;
      if (loP != null && absReturnPct < loP) benchStatus = 'below';
      else if (hiP != null && absReturnPct > hiP) benchStatus = 'above';
      else if (loP != null && hiP == null) benchStatus = 'above';   // lone low bound cleared → beats it
      else benchStatus = 'within';
    } else {
      const obsLo = fund.returnLow != null ? Number(fund.returnLow) : null;
      const obsHi = fund.returnHigh != null ? Number(fund.returnHigh) : null;
      if (obsLo != null && obsHi != null) {
        // >= / <= (not strict, with a small epsilon): matching your own best/worst
        // -ever return IS the Above/Below moment, not something that needs to be
        // exceeded further. The epsilon absorbs float noise between the value
        // stored at the last save and the value recomputed live right now — a
        // fund with only one data point (returnLow === returnHigh) would otherwise
        // flip between Above/Below on sub-cent rounding differences.
        const EPS = 0.01;
        if (absReturnPct >= obsHi - EPS) benchStatus = 'above';
        else if (absReturnPct <= obsLo + EPS) benchStatus = 'below';
        else benchStatus = 'within';
      }
    }
  }
  const beatsBenchmark = benchStatus === 'above' ? true : benchStatus === 'below' ? false : null;

  // Projections only apply to funds you still hold.
  const targetYear = Number(fund.targetYear) || 2030;
  const sip = Number(fund.sip) || 0;
  let monthsLeft = 0, projInvested2030 = null, projCorpusStop = null, projCorpusStay = null;
  if (!sold) {
    monthsLeft = monthsToTargetEnd(nowDate, targetYear);
    const projRate = rate != null ? rate : (benchXirrLo != null ? benchXirrLo : 0.10);
    projInvested2030 = invested + sip * monthsLeft;
    projCorpusStop = projectCorpus(value, sip, projRate, monthsLeft, false);
    projCorpusStay = projectCorpus(value, sip, projRate, monthsLeft, true);
  }

  const pct = (d) => (d != null ? d * 100 : null);
  return {
    invested, value, absReturnPct, liveReturnLow, liveReturnHigh, ageYears, sold, valueSource,
    totalUnits, avgNav, latestNav,
    soldValue: sold ? value : null, soldDate: sold ? valueDate : null,
    xirr: rate, xirrPct, xirrSource, liveXirrLow, liveXirrHigh,
    benchStatus, beatsBenchmark,
    benchReturnLowPct: pct(benchRetLo), benchReturnHighPct: pct(benchRetHi),
    benchXirrLowPct: pct(benchXirrLo), benchXirrHighPct: pct(benchXirrHi),
    targetYear, monthsLeft, projInvested2030, projCorpusStop, projCorpusStay,
  };
}

// ---------- SIP schedule generator (the "fill my monthly SIP" shortcut) ----------
export function generateSipSchedule(startYm, sip, endYm) {
  const out = [];
  const s = Number(sip) || 0;
  if (s <= 0) return out;
  let [y, m] = (startYm || '').split('-').map(Number);
  const [ey, em] = (endYm || '').split('-').map(Number);
  if (!y || !m || !ey || !em) return out;
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
    out.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, amount: s });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function monthsInclusive(startYm, endYm) {
  const [ay, am] = startYm.split('-').map(Number);
  const [by, bm] = endYm.split('-').map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}

// ---------- Paytm Money OCR parsers (pure) ----------
const _MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Resolve a (possibly OCR-mangled) month token → 1-12. OCR frequently swaps
// letters for look-alike digits inside a month ("Jul"→"Ju1", "Jun"→"Jvn"), which
// used to make the whole transaction unparseable. We (a) undo the common
// digit→letter confusions, then (b) if the 3-letter prefix still isn't an exact
// month, accept the nearest month whose prefix differs by at most one character.
function _monthNum(tok) {
  if (tok == null) return null;
  let s = String(tok).toLowerCase().replace(/[^a-z0-9]/g, '');
  s = s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/8/g, 'b').replace(/6/g, 'g').replace(/2/g, 'z');
  s = s.slice(0, 3);
  if (_MON3[s] != null) return _MON3[s];
  let best = null, bestD = 99;
  for (const n of Object.keys(_MON3)) {
    let d = 0; for (let j = 0; j < 3; j++) if (s[j] !== n[j]) d++;
    if (d < bestD) { bestD = d; best = n; }
  }
  return bestD <= 1 ? _MON3[best] : null;
}
// "6th Jul 26" / "22nd Jan 26" → "2026-07-06". 2-digit years are 20xx.
function _mfDate(day, mon, yr) {
  const d = parseInt(day, 10);
  const mo = _monthNum(mon);
  let y = parseInt(String(yr).replace(/[^\d]/g, ''), 10);
  if (!d || !mo || isNaN(y) || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Per-fund transaction history screen (Paytm Money): rows of
// "Buy · <date>" + "<units> / <nav>" + "₹<amount>". Returns
// [{ date, amount, units, nav, type }] — only 'buy' rows feed contributions.
//
// Robustness (this is a one-time bulk import, so a dropped row hurts): we anchor
// each transaction on its UNITS/NAV VALUE line (e.g. "42.443 / 11.7800"), NOT on
// its date. The value line is the most reliable thing OCR reads — the digits and
// the "/" come through cleanly — whereas the date is error-prone ("Jul"→"Ju1"),
// and anchoring on the date meant a single garbled month silently dropped the whole
// card (the classic "only 3 of 4 imported" bug). For each value line we then find
// the amount (same line or the next couple of lines; falls back to units×nav when
// the ₹ is misread) and the nearest date line at or above it (with fuzzy month
// parsing via _monthNum). Type defaults to buy; a nearby sell/redeem token flips it.
export function parsePaytmTransactions(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const SELL = /\b(sell|sold|redeem|redemption|withdraw|switch\s*out)\b/i;
  // Allow a mangled month token (letters or OCR-substituted digits) — _mfDate/_monthNum validate it.
  const DATE = /(\d{1,2})\s*(?:st|nd|rd|th)?[\s,.\-]+([A-Za-z0-9]{2,9})\.?[\s,.\-]+('?\d{2,4})\b/;
  // NAV part must carry a decimal (11.7800) so the header "Units / NAV" (no digits)
  // and stray fractions like "1 / 3" can't masquerade as a transaction row.
  const UNITS_NAV = /(\d+(?:\.\d+)?)\s*[\/|]\s*(\d[\d,]*\.\d+)/;
  const AMOUNT = /(?:₹|rs\.?|inr|z)\s*([\d,]+(?:\.\d+)?)/i;
  const out = [];
  const debug = { anchors: [], parsed: [], skipped: [] };
  lines.forEach((ln, idx) => {
    const m = ln.match(UNITS_NAV);
    if (!m) return;
    const units = parseFloat(m[1]);
    const nav = parseFloat(m[2].replace(/,/g, ''));
    if (!(nav > 0)) return;
    debug.anchors.push({ idx, line: ln });
    // Amount: this line or the next two; else derive from units×nav.
    let amount = null;
    for (let k = idx; k <= idx + 2 && k < lines.length; k++) {
      const am = lines[k].match(AMOUNT);
      if (am) { amount = parseFloat(am[1].replace(/,/g, '')); break; }
    }
    if (amount == null && units && nav) amount = Math.round(units * nav);
    if (!(amount > 0)) { debug.skipped.push({ line: ln, reason: 'No valid amount' }); return; }
    // Date: nearest parseable date at or above the value line (up to 5 lines up).
    let date = null;
    for (let k = idx; k >= 0 && k >= idx - 5; k--) {
      const dm = lines[k].match(DATE);
      if (dm) { const d = _mfDate(dm[1], dm[2], dm[3]); if (d) { date = d; break; } }
    }
    if (!date) { debug.skipped.push({ line: ln, reason: 'No date found near value line' }); return; }
    const neigh = (lines[idx - 2] || '') + ' ' + (lines[idx - 1] || '') + ' ' + (lines[idx] || '');
    const txn = { date, amount: Math.round(amount * 100) / 100, units, nav, type: SELL.test(neigh) ? 'sell' : 'buy' };
    out.push(txn);
    debug.parsed.push(txn);
  });
  console.log('OCR Parse Debug:', { totalLines: lines.length, anchors: debug.anchors.length, parsed: debug.parsed.length, skipped: debug.skipped });
  return out;
}

function _cleanFundName(s) {
  return (s || '')
    .replace(/[₹₨$€£]?\s*[\d][\d,]*(?:\.\d+)?\s*%?/g, ' ') // strip embedded amounts/percents
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}]+|[^\p{L})%]+$/gu, '')
    .trim();
}

// Common holdings/summary screen (Paytm Money): best-effort pairing of a fund
// name line with the ₹ value that follows it → [{ name, value }]. Used only to
// PRE-FILL the bulk value sheet; the user reviews before saving. Tuned further
// once a real holdings screenshot is available.
export function parsePaytmHoldings(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const AMT = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i;
  const HAS_NAME = /\p{L}{3,}/u;
  const LABEL = /^(current|invested|value|returns?|xirr|units?|nav|today|1d|1y|total|gains?|loss|amount|folio|direct|growth|regular)\b/i;
  const out = [];
  let name = null;
  for (const ln of lines) {
    const looksName = HAS_NAME.test(ln) && !AMT.test(ln) && !LABEL.test(ln) && !/^[\d.,%+\-₹$\s]+$/.test(ln);
    if (looksName) { name = _cleanFundName(ln); continue; }
    const am = ln.match(AMT);
    if (am && name) {
      const value = parseFloat(am[1].replace(/,/g, ''));
      if (value > 0) { out.push({ name, value }); name = null; }
    }
  }
  return out;
}

// ---------- seed data (from the user's Google Sheet "Mutual Fund" tab) ----------
// Rates are decimals. `returns` is the absolute (not annualised) gain used to
// derive a seed current value. `seedXirrRef` is the sheet's XIRR, shown as-is
// until the user logs a real investment.
export const SEED_FUNDS = [
  { name: 'Quant Multi Cap Fund Direct - Growth', type: 'Multi Cap', category: 'Equity', sip: 1000, invested: 199000, status: 'Investing On/Off', startYear: 2020, benchXirr: 0.1624, returns: 0.7927, seedXirrRef: 0.1618, goodReturn: '15%+ XIRR is good', judgeAfter: '', remarks: '✅ Top performer, keep holding' },
  { name: 'Tata Digital India Fund Direct - Growth', type: 'Technology', category: 'Equity', sip: null, invested: 150000, status: 'Investing On/Off', startYear: 2021, benchXirr: 0.1171, returns: 0.1176, seedXirrRef: 0.0216, goodReturn: '12–15%+ over 5 yrs', judgeAfter: '2026', remarks: '⚠️ Sector-specific, volatile' },
  { name: 'Mirae Asset ELSS Tax Saver Fund Direct - Growth', type: 'Tax Saver', category: 'Equity', sip: null, invested: 50000, status: 'Stopped', startYear: 2019, benchXirr: 0.1856, returns: 0.662, seedXirrRef: 0.1628, goodReturn: '12–15%+ XIRR is good', judgeAfter: '', remarks: '✅ Strong long-term hold' },
  { name: 'Quant ELSS Tax Saver Fund Direct - Growth', type: 'Tax Saver', category: 'Equity', sip: 2000, invested: 36000, status: 'Investing On/Off', startYear: 2023, benchXirr: 0.1628, returns: 0.2233, seedXirrRef: 0.1628, goodReturn: '12-15% after 3 yrs', judgeAfter: '2026', remarks: '🔄 Too early to judge' },
  { name: 'Quant Small Cap Fund Direct Plan - Growth', type: 'Small Cap', category: 'Equity', sip: 2000, invested: 57000, status: 'Investing On/Off', startYear: 2023, benchXirr: 0.0782, returns: 0.2011, seedXirrRef: 0.0782, goodReturn: '15-18% over 5–7 yrs', judgeAfter: '', remarks: '⚠️ Moderate so far; small caps take time' },
  { name: 'Edelweiss Greater China Equity Off-shore Fund Direct - Growth', type: 'International', category: 'Equity', sip: 500, invested: 17000, status: 'Investing', startYear: 2025, benchXirr: 0.6597, returns: 0.3854, seedXirrRef: 0.473, goodReturn: '10%+ long term', judgeAfter: '2030', remarks: '⚠️ High XIRR due to recent NAV jumps, monitor geopolitics' },
  { name: 'Kotak Nifty Next 50 Index Fund Direct - Growth', type: 'Large Cap', category: 'Equity', sip: 1000, invested: 13000, status: 'Investing', startYear: 2025, benchXirr: 0.138, returns: 0.0897, seedXirrRef: 0.0961, goodReturn: '10–14%+ over 5 yrs', judgeAfter: '2030', remarks: '🚨 Unrealistic XIRR due to short duration' },
  { name: 'DSP Healthcare Fund Direct - Growth', type: 'Pharma', category: 'Equity', sip: 1000, invested: 15000, status: 'Investing', startYear: 2025, benchXirr: 0.1536, returns: 0.1397, seedXirrRef: 0.1536, goodReturn: '12–15%+ if sector revives', judgeAfter: '', remarks: '🚧 Too early, sectoral fund' },
  { name: 'JioBlackRock Flexi Cap Fund Direct-Growth', type: 'Flexi Cap', category: 'Equity', sip: 500, invested: 4700, status: 'Investing Variable', startYear: 2025, benchXirr: 0.0467, returns: 0.0201, seedXirrRef: 0.0439, goodReturn: '12–15%+ over 5 yrs', judgeAfter: '2030', remarks: '' },
  { name: 'ICICI Prudential Energy Opportunities Fund Direct-Growth', type: 'Energy', category: 'Equity', sip: 500, invested: 1500, status: 'Investing', startYear: 2026, benchXirr: null, returns: 0.0351, seedXirrRef: 0.3787, goodReturn: '', judgeAfter: '', remarks: '' },
  { name: 'HDFC Click2Wealth Flexi Cap Fund', type: 'Flexi Cap', category: 'Equity', sip: 3000, invested: 99000, status: 'Investing', startYear: 2023, benchXirr: 0.0474, returns: 0.0681, seedXirrRef: 0.0486, goodReturn: '12–15%+ over 5 yrs', judgeAfter: '2028', remarks: 'CAGR should be more than 10% at 5th year | 12% very good (10% - 2.33L, 12% - 2.44L)' },
];

// Turn a SEED_FUNDS entry into a full fund record. Lumpsum funds (no SIP) get a
// single dated cashflow at the start year; SIP funds spread the known invested
// amount evenly across the months from start to now — an approximation that
// reproduces a realistic XIRR and self-corrects as real investments are logged.
export function buildSeedFund(seed, nowMs) {
  const now = nowMs || Date.now();
  const nowDate = new Date(now);
  const curYm = nowDate.toISOString().slice(0, 7);
  const startYm = `${seed.startYear}-01`;
  const isLump = !seed.sip;
  let contributions;
  if (isLump) {
    contributions = [{ date: `${seed.startYear}-01-01`, amount: seed.invested }];
  } else {
    const n = Math.max(1, monthsInclusive(startYm, curYm));
    const per = Math.round((seed.invested / n) * 100) / 100;
    contributions = [];
    let [y, m] = startYm.split('-').map(Number);
    for (let i = 0; i < n; i++) {
      contributions.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, amount: per });
      m++; if (m > 12) { m = 1; y++; }
    }
    // Absorb rounding drift into the last row so the sum equals `invested` exactly.
    const drift = Math.round((seed.invested - per * n) * 100) / 100;
    const last = contributions[contributions.length - 1];
    last.amount = Math.round((last.amount + drift) * 100) / 100;
  }
  const value = Math.round(seed.invested * (1 + (Number(seed.returns) || 0)) * 100) / 100;
  const iso = nowDate.toISOString();
  // Auto-tracked low/high (in %) start at the seed figures and widen as the user
  // refreshes values over time.
  const seedRetPct = Math.round((Number(seed.returns) || 0) * 10000) / 100;
  const seedXirrPct = seed.seedXirrRef != null ? Math.round(seed.seedXirrRef * 10000) / 100 : null;
  return {
    owner: 'me',
    name: seed.name, type: seed.type, category: seed.category,
    benchmark: '', status: seed.status, sip: seed.sip || 0,
    targetYear: 2030,
    // Latest NAV unknown at seed time — value falls back to the manual snapshot
    // until the user logs transactions with units and enters a latest NAV.
    latestNav: null, navAsOf: null,
    // Benchmark thresholds (user-defined). The sheet's single benchmark XIRR seeds
    // the low XIRR bound; the rest are blank for the user to fill on the Benchmark tab.
    benchReturnLow: null, benchReturnHigh: null,
    benchXirrLow: seed.benchXirr != null ? seed.benchXirr : null, benchXirrHigh: null,
    goodReturn: seed.goodReturn || '', judgeAfter: seed.judgeAfter || '',
    remarks: seed.remarks || '',
    contributions,
    valueHistory: [{ ym: curYm, value }],
    valueAsOf: iso.slice(0, 10),
    soldValue: null, soldDate: null,
    seedXirrRef: seed.seedXirrRef != null ? seed.seedXirrRef : null,
    xirrLow: seedXirrPct, xirrHigh: seedXirrPct,
    returnLow: seedRetPct, returnHigh: seedRetPct,
    seeded: true,
    createdAt: iso, updatedAt: iso,
  };
}
