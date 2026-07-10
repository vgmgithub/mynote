# Architecture

## File layout

```
C:\Apache24\htdocs\mynote\
├── index.html              ← PWA shell, also has ?reset=1 SW-killer
├── manifest.webmanifest    ← PWA install metadata
├── service-worker.js       ← stale-while-revalidate, auto-reload-on-update
├── styles.css              ← light + dark themes, all UI styles
├── app.js                  ← UI, state, wiring (BIGGEST FILE, ~1600 lines)
├── core.js                 ← pure calculations (no DOM, no IO)
├── db.js                   ← IndexedDB layer
├── csv.js                  ← X-MyNotes sheet import (lazy-loaded)
├── ocr.js                  ← Tesseract OCR + per-broker parsers (lazy-loaded)
├── lock.js                 ← PIN + WebAuthn biometric (data layer + crypto)
├── backup.js               ← folder-based backup & restore (File System Access)
├── feed.js                 ← news fetch (Marketaux) + offline recommendation engine
├── mf.js                   ← mutual-fund logic (XIRR, projections) + seed data (lazy-loaded)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── docs/                   ← these docs
```

## Module dependencies

```
app.js  ──→  core.js   (pure helpers, formatters, calculations)
       ──→  db.js     (IndexedDB CRUD)
       ──→  lock.js   (PIN/biometric)
       ──→  backup.js (folder-based backup)
       ──→  csv.js    (dynamic import)
       ──→  ocr.js    (dynamic import)
       ──→  feed.js   (dynamic import)
       ──→  mf.js     (dynamic import)

lock.js   ──→  db.js   (meta store)
backup.js ──→  db.js   (meta store — folder handle persistence)
feed.js   ──→  db.js   (meta store + feed store)
mf.js     ──→  (pure — no db.js; app.js does the funds-store CRUD)
```

`csv.js`, `ocr.js`, `feed.js` and `mf.js` use dynamic `import('./…')` — code-split so users who never import a sheet, use OCR, open the Feed, or open Mutual Funds never download those modules. Tesseract.js itself loads from CDN on first OCR use only.

## State shape (in-memory, `app.js`)

```js
state = {
  appMode: 'home',             // 'home' | 'stocks' | 'mf' — top-level surface (above `view`)
  portfolio: 'me-in',          // 'me-in' | 'wife-in' | 'me-us'
  view: 'holdings',            // 'holdings' | 'monthly' | 'heatmap' | 'trends' | 'feed'
  filter: 'holding',           // 'all' | 'holding' | 'sold' (default Holding)
  sortField: 'name',           // 'name' | 'pct' | 'value'
  sortStage: 0,                // 0 default (name A-Z), 1 primary, 2 secondary
  search: '',
  stocks: [],                  // loaded from DB on refresh()
  months: [],                  // monthly aggregates from DB
}
```

`refresh()` reloads `state.stocks` + `state.months` from IndexedDB. `render()` is the master view dispatcher for the **Stocks** surface — it toggles which section is `.hidden` and calls the right sub-renderer, and early-returns unless `appMode === 'stocks'`. `setAppMode()` sits above it and switches between Home / Stocks / Mutual Funds. See [mutual-funds.md](mutual-funds.md).

## IndexedDB schema

Database: `mynote-stocks`, version `4`.

### `stocks` store
- Key: `id` (auto-increment).
- Index: `portfolio`.

```js
{
  id: 42,
  portfolio: 'me-in',          // 'me-in' | 'wife-in' | 'me-us'
  name: 'Adani Power',
  category: 'Power',
  conviction: 'high',          // 'low' | 'medium' | 'high' | ''
  status: 'holding',           // 'holding' | 'sold'
  units: 27,
  buyPrice: 198.50,
  currentPrice: 230.03,
  soldPrice: null,             // populated when status='sold'
  soldUnits: null,
  soldDate: null,              // ISO date — present means status='sold'
  notes: '',
  history: [                   // monthly % returns
    { month: 'May 2026', pct: 12.5 },
    { month: 'Jun 2026', pct: 15.8 },
  ],
  createdAt: '2026-01-15T...',
  updatedAt: '2026-06-13T...',
}
```

### `monthly` store
- Key: `${portfolio}|${ym}` (e.g. `me-in|2026-06`). Re-saving overwrites.
- Index: `portfolio`.

```js
{
  key: 'me-in|2026-06',
  portfolio: 'me-in',
  ym: '2026-06',
  invested: 240000,
  value: 285000,
  profitLoss: 45000,
  returnPct: 18.75,
  countProfit: 7,
  countLoss: 3,
  nifty: 0.83,                 // % change for that month
  source: 'ocr',               // 'ocr' | 'manual' | 'import' | etc
  updatedAt: '...',
}
```

Nifty is the same across me-in and wife-in for any given month (Indian benchmark). `syncNiftyAll()` back-fills missing nifty values between the two portfolios — idempotent, called on init.

### `meta` store
- Key: `key`. Free-form value.

Known keys:
- `lastBackup` → `{ key: 'lastBackup', value: 1718200000000 }` (epoch ms)
- `ocr-aliases` → `{ key: 'ocr-aliases', value: { 'me-in|adanipwr': 17, ... } }` — parsed name to stock-id map. See [ocr.md](ocr.md).
- `lockConfig` → `{ key: 'lockConfig', value: { enabled, pinHash, salt, biometric: {...} } }`. See [app-lock.md](app-lock.md).

### `snapshots` store
- Currently unused. Legacy from an early design. Don't remove (export/import iterates it) but no new code writes to it.

### `feed` store (v3+)
- Key: `${portfolio}|${stockId}`.
- Index: `portfolio`.
- Holds cached last-24h news + computed recommendation per stock. See [feed.md](feed.md).
- Wiped/repopulated on every "Refresh now" tap in the Feed tab.

Meta keys added in v3:
- `feedApiKey` → user's Marketaux API token (or empty string).
- `feedLastFetch_<portfolio>` → ms timestamp of last successful fetch per portfolio.

### `funds` store (v4+)
- Key: `id` (auto-increment).
- Index: `owner` (currently only `'me'`).
- One row per mutual fund: dated `contributions`, monthly `valueHistory`, `soldValue`/`soldDate`, auto-tracked `xirrLow/High` + `returnLow/High`, seed metadata. Full shape and logic in [mutual-funds.md](mutual-funds.md).

Meta keys added in v4:
- `mfSeeded` → `true` once the 11 sheet funds have been seeded.
- `mfMidCapAdded` → `true` once the Quant Mid Cap sold stub has been added.

## Service worker — caching strategy

- **Stale-while-revalidate** on every same-origin GET.
- Precache on `install` with `cache: 'reload'` (bypass HTTP cache) so a fresh deploy lands cleanly.
- Revalidation fetch uses `cache: 'no-store'` so the browser HTTP cache can't serve a stale copy.
- New service workers install into the waiting slot. They activate only when the user taps **Menu -> Check for updates** / **Update available**.
- `app.js` posts `{ type: 'SKIP_WAITING' }` to the waiting worker, then listens to `controllerchange` and reloads exactly once. No surprise reloads.

To force-update everything: bump `const CACHE = 'mynote-stocks-vNN'`. Always do this on any change to a precached file. See [gotchas.md](gotchas.md) for the manual cache-flush procedure when the SW gets stuck.

## Theming

- Auto light/dark by hour of day. Light: 06:00–18:59. Dark: 19:00–05:59.
- `applyTheme()` sets `data-theme="light"` on `<html>`; CSS variables flip.
- Triggered on init and on `visibilitychange` (so it updates when you return to a backgrounded tab).

## Currency display

- `curOf(portfolio)` returns `'₹'` for `me-in`/`wife-in`, `'$'` for `me-us`.
- `fmtCur(value, portfolio)` uses cached `Intl.NumberFormat` instances per portfolio.

## Benchmark

- Me · India + Wife · India → **Nifty 50**.
- Me · US → **Nasdaq**.
- `benchmarkName(portfolio)` returns the label.
