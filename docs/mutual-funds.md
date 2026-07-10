# Mutual Funds & Home launcher

A second surface inside the same PWA for tracking mutual funds (modelled on the user's Google Sheet "Mutual Fund" tab). The **Stocks app is untouched** — it renders exactly as before.

## Home launcher

On open (after the lock gate) the app shows a **Home** screen with two cards: **Stocks** and **Mutual Funds**. The stock chrome (portfolio tabs, bottom nav, FABs) is hidden on Home/MF; the header title-row — with the shared **⋮ menu** — stays on all three surfaces, so **Backup covers both** from one place.

- `state.appMode` — `'home' | 'stocks' | 'mf'` (default `'home'`). Sits *above* the stock `state.view` system.
- `setAppMode(mode)` (app.js) shows/hides the surfaces and flips the header title + back button. `render()` early-returns unless `appMode === 'stocks'`, so a stray call can't un-hide stock sections over Home.
- Boot: `init()` still runs the normal `await refresh()` (stock data + background tasks unchanged), then calls `setAppMode('home')` — the launcher overlays the already-rendered (hidden) stock app. Zero change to stock behaviour.
- `‹` back button (`#backBtn`) returns to Home from Stocks/MF. Home always opens first (not persisted).

## Files

- **`mf.js`** — pure logic + one-time seed data. Lazy-loaded (`import('./mf.js')`) from `renderMF`/`openMF`/`openFundForm` so the Stocks app never pays for it.
- **`app.js`** — `setAppMode`, `renderHome`, `openMF` (seed-on-first-open), `renderMF`, `_mfCard`, `buildContribEditor`, `openFundForm`.
- **`db.js`** — `funds` store (v4) + `funds` folded into `exportAll`/`importAll`.

## Data model — `funds` store (IndexedDB v4)

Key `id` (auto-increment), index `owner` (currently only `'me'` — room for a wife split later).

```js
{
  id, owner: 'me',
  name, type, category,          // 'Multi Cap', 'Equity'
  benchmark,                     // index name, display only
  status,                        // 'Investing' | 'Investing On/Off' | 'Investing Variable' | 'Stopped' | 'Sold'
  sip,                           // monthly SIP amount (0 = lumpsum)
  targetYear: 2030,
  benchXirr,                     // decimal, manual (no live feed)
  goodReturn, judgeAfter, remarks,
  contributions: [{ date:'YYYY-MM-DD', amount, notes }],  // dated investments (cashflows out) — the accuracy driver; notes is free text, optional
  valueHistory: [{ ym:'YYYY-MM', value }],         // monthly value snapshots (overwrite per month)
  valueAsOf: 'YYYY-MM-DD',
  soldValue, soldDate,           // set when status='Sold' (realized XIRR terminal)
  xirrLow, xirrHigh,             // auto-tracked min/max of XIRR % over time
  returnLow, returnHigh,         // auto-tracked min/max of return % over time
  seedXirrRef,                   // sheet's XIRR at seed (shown until first real edit)
  seeded,                        // true = still showing sheet figures
  createdAt, updatedAt,
}
```

- `invested` is **derived** = Σ contributions.amount (never stored → no drift). `currentValue` = last `valueHistory` entry.
- **Storage:** ~5 KB/fund over 10 yr (value history overwrites per month; contributions ~1 row/month). ~55 KB for 11 funds — flat, like `monthly`/`feed`.

## XIRR (mf.js)

`xirr(cashflows)` — annualised IRR over irregular dated cashflows (Newton-Raphson from several seeds, bisection fallback). Needs both signs. **No daily NAV** — only (a) each investment dated, and (b) one terminal value:

- **Held fund:** terminal = latest `valueHistory` value at `valueAsOf`.
- **Sold fund:** terminal = `soldValue` at `soldDate` → *realized* XIRR (`xirrSource: 'realized'`). Projections are `null`.
- **Seeded held fund:** shows `seedXirrRef` (`xirrSource: 'sheet'`) until the user saves a real edit (`seeded` → false), then computes from cashflows.

Verified: single lumpsum → XIRR == CAGR; sold 100k→150k over 2 yr → 22.47%.

`computeFund(fund, nowMs)` returns `{ invested, value, absReturnPct, ageYears, sold, soldValue, soldDate, xirr, xirrPct, xirrSource, benchXirr, benchXirrPct, beatsBenchmark, targetYear, monthsLeft, projInvested2030, projCorpusStop, projCorpusStay }`.

`projectCorpus(value, sip, rate, monthsLeft, stayInvested)` — FV to Dec of target year; rate clamped to −50%…+35% so a noisy short-history XIRR can't produce absurd projections. `stop` grows the current corpus only; `stay` adds the ongoing SIP annuity.

## UI (renderMF → `#mfView`, reuses stock CSS classes)

- **Bottom nav** (`#mfBottomNav`) — **Holdings | Overview**, a *second fixed bottom nav* built once (`buildMfBottomNav`) that looks exactly like the Stocks app's own `#bottomNav` (same `.bottom-nav` CSS, icon + label, accent when active). `setAppMode` shows it only in MF mode and hides the Stocks one, so the two never overlap. Tab state is `_mfTab` (`'holdings' | 'overview'`); clicking a nav button just flips `_mfTab` and calls `renderMF()` — `updateMfNavActive()` syncs the button's active class after each render.
  - **Holdings** — filter (`Investing | Sold`, live counts — holding vs redeemed, not SIP status) + sort (XIRR / Return / Invested / Name) + the fund card list + the update-values icon.
  - **Overview** — the summary card (*Current value / Invested / Overall gain / Portfolio XIRR / Beating benchmark / Proj 2030* for Investing; *Realized value / Realized gain / Realized XIRR / Sold funds* for Sold) + **Allocation by type** (`.bar-row`).
- **Fund cards** (`.card`) — name, type · status, beats/lags (or `sold`) badge, XIRR (labelled `XIRR` / `XIRR (sheet)` / `Realized XIRR`), Invested, Value/Sold for, Return, Bench, an auto-tracked **Range** line (XIRR & Return lo–hi, shown once it moves ≥0.1%), and remarks.
- **Update current values** — an icon button (📷) next to the filter/sort row on the Holdings tab, opens `openMfValueSheet()` (see OCR below).
- **`openFundForm`** — a **two-tab sheet** (`.seg`, plain — not the bottom nav): **Edit fund** (metadata: name, type, status, SIP, current value/as-of, sold value/date when Status=Sold, benchmark, target year, remarks) and **Fund Holdings** (the investment log + a 📷 icon bottom-right for OCR import). Each investment row is **date · amount · notes** (`contributions[].notes`, free text, optional). On save: writes the value snapshot, then updates `xirrLow/High` and `returnLow/High` from a fresh `computeFund` (the auto min/max observation), and clears `seeded`.

## OCR (Paytm Money) — two distinct flows

Both reuse `ocr.js` (`ocrImages` — shared Tesseract worker) and pure parsers in `mf.js`. Neither persists the image; only parsed numbers reach the app.

- **Per-fund transaction import** (button *inside* the fund form). `parsePaytmTransactions(text)` reads the fund's transaction-history screen (`Buy · <date>` + `<units> / <nav>` + `₹<amount>`) → `[{date, amount, units, nav, type}]`. `_mfOcrTransactions(editor)` merges the **buy** rows into the open editor via `editor.merge()`, which **dedupes by date** (one investment per day — a matching date updates the amount, never duplicates). Amount falls back to `units×nav` if the ₹ figure is misread. No nested modal — the form stays open and the merged rows are the review. Verified against the real screen: 6/6 rows, exact dates/amounts.
- **Common current-value update** (`📷 Update current values` on the MF surface → `openMfValueSheet`). A bulk grid of every **held** fund with an editable current value (pre-filled with the latest). `📷 Scan holdings screenshot` runs `parsePaytmHoldings(text)` and pre-fills funds matched by fuzzy name (`_findFundMatch`). Save **upserts one value per fund for the as-of month** (dedupe by `ym` → never a duplicate) and refreshes the auto min/max. Works fully by manual entry even if OCR matches nothing. `parsePaytmHoldings` is best-effort (name-line → following ₹ value) and will be tuned once a real holdings screenshot is captured.

## Seeding (once)

`openMF` seeds the **11 funds** from `SEED_FUNDS` on first open (guarded by `meta.mfSeeded`). Each: SIP funds spread the known invested evenly across months from start→now (approx that reproduces a realistic XIRR); lumpsum funds get one dated cashflow. Current value = `invested × (1 + returns)`. `xirrLow/High`, `returnLow/High` start at the seed figures.

A second one-time step (guarded by `meta.mfMidCapAdded`) adds **Quant Mid Cap Fund Direct - Growth** as a `Sold` **stub** (no fabricated figures) so it shows on the Sold tab — the user fills invested + sold value/date.

## Backup

`funds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch` like `feed`), so the existing folder-based backup carries mutual-fund data with no change to `backup.js`.

## Not built yet

- **Holdings-parser tuning** — `parsePaytmHoldings` (the common current-value scan) is best-effort until a real Paytm Money holdings/summary screenshot is captured; manual bulk entry works today regardless. The transaction parser is tuned to the real screen.
- No wife split (owner field reserved). No live NAV feed. Benchmark XIRR is manual.
