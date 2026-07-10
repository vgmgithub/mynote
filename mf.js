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
  const value = latestValue(fund);
  const absReturnPct = invested > 0 ? ((value - invested) / invested) * 100 : 0;

  const times = (fund.contributions || []).map((c) => Date.parse(c.date)).filter((t) => !isNaN(t)).sort((a, b) => a - b);
  const ageYears = times.length ? (now - times[0]) / (365.25 * DAY) : 0;

  // XIRR: seeded funds show the sheet's figure until the user logs real
  // investments (then `seeded` is cleared and we compute from the cashflows).
  let rate = null, xirrSource = 'none';
  if (fund.seeded && fund.seedXirrRef != null) {
    rate = Number(fund.seedXirrRef);
    xirrSource = 'sheet';
  } else if (invested > 0 && value > 0 && times.length) {
    const cfs = (fund.contributions || []).map((c) => ({ date: c.date, amount: -Math.abs(Number(c.amount) || 0) }));
    cfs.push({ date: fund.valueAsOf || nowDate.toISOString().slice(0, 10), amount: value });
    rate = xirr(cfs);
    xirrSource = rate != null ? 'computed' : 'none';
  }

  const benchXirr = fund.benchXirr != null && fund.benchXirr !== '' ? Number(fund.benchXirr) : null;
  const beatsBenchmark = rate != null && benchXirr != null ? rate >= benchXirr : null;

  const targetYear = Number(fund.targetYear) || 2030;
  const monthsLeft = monthsToTargetEnd(nowDate, targetYear);
  const sip = Number(fund.sip) || 0;
  const projRate = rate != null ? rate : (benchXirr != null ? benchXirr : 0.10);
  const projInvested2030 = invested + sip * monthsLeft;
  const projCorpusStop = projectCorpus(value, sip, projRate, monthsLeft, false);
  const projCorpusStay = projectCorpus(value, sip, projRate, monthsLeft, true);

  return {
    invested, value, absReturnPct, ageYears,
    xirr: rate, xirrPct: rate != null ? rate * 100 : null, xirrSource,
    benchXirr, benchXirrPct: benchXirr != null ? benchXirr * 100 : null, beatsBenchmark,
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
  return {
    owner: 'me',
    name: seed.name, type: seed.type, category: seed.category,
    benchmark: '', status: seed.status, sip: seed.sip || 0,
    targetYear: 2030,
    benchXirr: seed.benchXirr,
    goodReturn: seed.goodReturn || '', judgeAfter: seed.judgeAfter || '',
    remarks: seed.remarks || '',
    contributions,
    valueHistory: [{ ym: curYm, value }],
    valueAsOf: iso.slice(0, 10),
    seedXirrRef: seed.seedXirrRef != null ? seed.seedXirrRef : null,
    seeded: true,
    createdAt: iso, updatedAt: iso,
  };
}
