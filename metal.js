// Metals-tracker logic (gold + silver). Pure except for the one best-effort
// price-fetch helper. Lazy-loaded from app.js (openMetal / renderMetal) so the
// rest of the app never pays for it until the user opens the Metals surface.
//
// One row per transaction (store: 'metals'):
//   { id, metal:'gold'|'silver', date:'YYYY-MM-DD',
//     grams,                 // + buy/interest, − sell
//     amount,                // ₹ (always stored positive): buy = invested,
//                            //   sell = sale proceeds, interest = ₹ value of free grams
//     via,                   // 'Aura' | 'Sify' | 'Physical' | free text
//     type:'buy'|'sell'|'interest',
//     note, seed?, createdAt, updatedAt }
// Sovereign Gold Bonds are NOT tracked here — they live in the `stocks` store and
// are only *listed* on the Metals SGB tab / referenced on the Overview tab.

export const METALS = ['gold', 'silver'];
export const GRAMS_PER_OZ = 31.1035;          // troy ounce → grams
export const TXN_TYPES = ['buy', 'sell', 'interest'];

// Net position for one metal, computed chronologically with average-cost basis:
// a SELL removes grams AND the proportional cost basis of those grams (so selling
// part of a holding doesn't leave a phantom loss), mirroring mf.js redemptions.
// INTEREST rows add free grams (no cost). `realized` = Σ(proceeds − basis removed).
export function rollup(txns, metal) {
  const rows = (txns || []).filter((t) => t.metal === metal)
    .slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let grams = 0, invested = 0, realized = 0;
  for (const t of rows) {
    const g = Number(t.grams) || 0;
    if (t.type === 'sell') {
      const sold = Math.min(Math.abs(g), grams);
      if (sold > 0 && grams > 0) {
        const basis = (sold / grams) * invested;
        invested -= basis;
        grams -= sold;
        realized += (Number(t.amount) || 0) - basis;   // proceeds − cost basis
      }
    } else if (t.type === 'interest') {
      grams += g;                                       // free grams, no cost
    } else {
      grams += g;
      invested += Number(t.amount) || 0;
    }
  }
  return { grams, invested, realized };
}

// Full summary for one metal at a given ₹/gram price.
export function summary(txns, metal, pricePerGram) {
  const { grams, invested, realized } = rollup(txns, metal);
  const price = Number(pricePerGram) || 0;
  const value = grams * price;
  const pl = value - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : null;
  return { grams, invested, value, pl, plPct, price, realized };
}

// Composition of a metal's current grams by source (Aura / Sify / Interest …).
// Grams net of sells (a sell's `via` subtracts from that same source); `bought`
// is gross buy ₹ for that source (interest = free). For a quick "where did my
// grams come from" view — not a cost-basis reconciliation.
export function sourceBreakdown(txns, metal) {
  const map = new Map();
  (txns || []).filter((t) => t.metal === metal).forEach((t) => {
    const src = t.type === 'interest' ? 'Interest (free)' : (t.via || 'Other');
    const e = map.get(src) || { source: src, grams: 0, bought: 0 };
    e.grams += Number(t.grams) || 0;
    if (t.type === 'buy') e.bought += Number(t.amount) || 0;
    map.set(src, e);
  });
  return [...map.values()].filter((e) => Math.abs(e.grams) > 1e-9).sort((a, b) => b.grams - a.grams);
}

// Best-effort live price ESTIMATE in ₹/gram for gold & silver.
// Source is international spot (USD/troy-ounce) via api.gold-api.com, converted
// with a keyless FX rate. This runs ~25-30% BELOW Indian retail (duty + GST +
// premium), so it's only a starting estimate the user adjusts. Throws on any
// failure (offline / CORS / bad shape) so the caller falls back to manual entry.
export async function fetchSpotEstimate(signal) {
  const j = async (url) => {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const [xau, xag, fx] = await Promise.all([
    j('https://api.gold-api.com/price/XAU'),
    j('https://api.gold-api.com/price/XAG'),
    j('https://api.frankfurter.app/latest?from=USD&to=INR'),
  ]);
  const usdInr = fx && fx.rates && Number(fx.rates.INR);
  const goldUsdOz = Number(xau && xau.price);
  const silverUsdOz = Number(xag && xag.price);
  if (!(usdInr > 0) || !(goldUsdOz > 0) || !(silverUsdOz > 0)) throw new Error('bad price data');
  const perGram = (usdOz) => (usdOz * usdInr) / GRAMS_PER_OZ;
  return {
    gold: Math.round(perGram(goldUsdOz) * 100) / 100,
    silver: Math.round(perGram(silverUsdOz) * 100) / 100,
    source: 'intl-spot',
  };
}

// One-time seed: the real non-SGB transactions from the user's "Metal" sheet
// (Aura digital buys, the one gold sell, bond/SGB interest credited as grams, and
// the free employer silver). SGB bond purchases are intentionally excluded — they
// live in the Stocks store and only surface on the Metals SGB tab.
// amount is always positive; sign/meaning comes from `type` (+ grams for buy/
// interest, − grams for sell). Dates use the sheet's month, day 01.
export const SEED_METAL_TXNS = [
  // ---- Gold · Aura digital buys ----
  { metal: 'gold', date: '2025-03-01', grams: 0.0112, amount: 100, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-03-01', grams: 0.011, amount: 100, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-03-01', grams: 0.0011, amount: 10, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-03-01', grams: 0.0449, amount: 420.31, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-03-01', grams: 0.0527, amount: 500, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-03-01', grams: 0.0963, amount: 900, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-04-01', grams: 0.0872, amount: 1400, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-04-01', grams: 0.0152, amount: 150, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-05-01', grams: 0.1492, amount: 1500, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-06-01', grams: 0.087, amount: 900, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-07-01', grams: 0.068, amount: 700, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-08-01', grams: 0.085, amount: 900, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-09-01', grams: 0.044, amount: 500, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-10-01', grams: 0.1153, amount: 1500, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-11-01', grams: 0.0429, amount: 550, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-12-01', grams: 0.0372, amount: 500, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2025-12-01', grams: 0.0766, amount: 1050, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2026-01-01', grams: 0.0606, amount: 900, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2026-03-01', grams: 0.0039, amount: 70.2, via: 'Aura', type: 'buy' },
  { metal: 'gold', date: '2026-06-01', grams: 0.0032, amount: 50, via: 'Aura', type: 'buy' },
  // ---- Gold · the one sell (sold the whole digital position; +₹1,813 realized) ----
  { metal: 'gold', date: '2025-11-01', grams: -0.9831, amount: 12789.5, via: 'Aura', type: 'sell', note: 'Sold digital gold' },
  // ---- Gold · interest credited as gold (SGB + bond interest — free grams) ----
  { metal: 'gold', date: '2025-09-01', grams: 0.0686, amount: 800, via: 'SGB interest', type: 'interest' },
  { metal: 'gold', date: '2025-10-01', grams: 0.0035, amount: 46, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2025-11-01', grams: 0.0038, amount: 50, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2025-12-01', grams: 0.0032, amount: 46, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2026-03-01', grams: 0.0133, amount: 220, via: 'SGB interest', type: 'interest' },
  { metal: 'gold', date: '2026-03-01', grams: 0.0028, amount: 43, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2026-04-01', grams: 0.0499, amount: 800, via: 'SGB interest', type: 'interest' },
  { metal: 'gold', date: '2026-04-01', grams: 0.0032, amount: 52, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2026-05-01', grams: 0.0088, amount: 147, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2026-06-01', grams: 0.0063, amount: 95, via: 'Bond interest', type: 'interest' },
  { metal: 'gold', date: '2026-06-01', grams: 0.0147, amount: 220, via: 'SGB interest', type: 'interest' },
  // ---- Silver · free employer grams (Sify) ----
  { metal: 'silver', date: '2024-11-01', grams: 25, amount: 0, via: 'Sify', type: 'buy', note: 'Employer — free' },
  // ---- Silver · Aura digital buys ----
  { metal: 'silver', date: '2025-03-01', grams: 2, amount: 205.05, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-03-01', grams: 2, amount: 209.28, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-03-01', grams: 2, amount: 209.17, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-03-01', grams: 2, amount: 212.9, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-03-01', grams: 2, amount: 217.66, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-03-01', grams: 0.0527, amount: 0, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-04-01', grams: 2, amount: 194.46, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-04-01', grams: 13.79, amount: 1450, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-05-01', grams: 14.56, amount: 1550, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-06-01', grams: 12.55, amount: 1450, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-07-01', grams: 6.23, amount: 750, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-08-01', grams: 11.95, amount: 1500, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-09-01', grams: 6.21, amount: 850, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-10-01', grams: 8.62, amount: 1500, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-11-01', grams: 3.41, amount: 550, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-12-01', grams: 4.98, amount: 1050, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2025-12-01', grams: 0.9023, amount: 200, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2026-01-01', grams: 1.15, amount: 300, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2026-02-01', grams: 1.16, amount: 309.79, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2026-02-01', grams: 0.1, amount: 26.62, via: 'Aura', type: 'buy' },
  { metal: 'silver', date: '2026-03-01', grams: 0.75, amount: 240.88, via: 'Aura', type: 'buy' },
  // ---- Silver · interest credited as silver (free grams) ----
  { metal: 'silver', date: '2026-01-01', grams: 0.131, amount: 46, via: 'Bond interest', type: 'interest' },
  { metal: 'silver', date: '2026-02-01', grams: 0.1591, amount: 46, via: 'Bond interest', type: 'interest' },
];
