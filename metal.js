// Metals-tracker logic (gold + silver). Pure except for the one best-effort
// price-fetch helper. Lazy-loaded from app.js (openMetal / renderMetal) so the
// rest of the app never pays for it until the user opens the Metals surface.
//
// One row per transaction (store: 'metals'):
//   { id, metal:'gold'|'silver', date:'YYYY-MM-DD',
//     grams,                 // + buy/interest, − sell
//     amount,                // ₹: + invested, − sale proceeds; interest rows = 0 (free grams)
//     via,                   // 'Aura' | 'Physical' | 'Employer' | 'Opening' | free text
//     type:'buy'|'sell'|'interest',
//     note, createdAt, updatedAt }
// Sovereign Gold Bonds are NOT tracked here — they live in the `stocks` store and
// are only *listed* on the Metals SGB tab.

export const METALS = ['gold', 'silver'];
export const GRAMS_PER_OZ = 31.1035;          // troy ounce → grams
export const TXN_TYPES = ['buy', 'sell', 'interest'];

// Net grams + cash invested for one metal. Interest rows add free grams, so their
// ₹ never counts toward invested (keeps the free-gram windfall in P/L, not cost).
export function rollup(txns, metal) {
  let grams = 0, invested = 0;
  for (const t of txns) {
    if (t.metal !== metal) continue;
    grams += Number(t.grams) || 0;
    if (t.type !== 'interest') invested += Number(t.amount) || 0;
  }
  return { grams, invested };
}

// Full summary for one metal at a given ₹/gram price.
export function summary(txns, metal, pricePerGram) {
  const { grams, invested } = rollup(txns, metal);
  const price = Number(pricePerGram) || 0;
  const value = grams * price;
  const pl = value - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : null;
  return { grams, invested, value, pl, plPct, price };
}

// Seed a single opening-balance ledger row from the sheet's net position.
export function buildOpeningEntry(metal, grams, invested, nowIso, dateISO) {
  return {
    metal,
    date: dateISO,
    grams: Number(grams) || 0,
    amount: Number(invested) || 0,
    via: 'Opening',
    type: 'buy',
    note: 'Opening balance from sheet — verify & edit',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
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
