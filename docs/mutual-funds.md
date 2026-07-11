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
  latestNav, navAsOf,            // latest NAV + its date → current value = ΣunitsΣ × latestNav
  // Benchmark thresholds — user-set (decimals). Blank = ignore. Widen-only on NAV update (widenBenchBands): a set band the value overshoots expands to it; never narrows.
  benchReturnLow, benchReturnHigh,
  benchXirrLow, benchXirrHigh,   // legacy single `benchXirr` is read as benchXirrLow
  goodReturn, judgeAfter, remarks,
  contributions: [{ date:'YYYY-MM-DD', amount, units, nav, notes }],  // dated buys; units→totalUnits, amount→invested, nav per-unit, notes free text
  valueHistory: [{ ym:'YYYY-MM', value }],         // FALLBACK value when a fund has no units yet (seeded/legacy)
  valueAsOf: 'YYYY-MM-DD',
  soldValue, soldDate,           // set when status='Sold' (realized XIRR terminal)
  xirrLow, xirrHigh,             // auto-tracked OBSERVED min/max of XIRR % over time (≠ benchmark)
  returnLow, returnHigh,         // auto-tracked OBSERVED min/max of return % over time (≠ benchmark)
  seedXirrRef,                   // sheet's XIRR at seed (shown until first real edit)
  seeded,                        // true = still showing sheet figures
  createdAt, updatedAt,
}
```

- `invested` = Σ contributions.amount; `totalUnits` = Σ contributions.units; `avgNav` = invested ÷ totalUnits — all **derived** (never stored → no drift).
- **Current value** = `totalUnits × latestNav` when both are known (`valueSource: 'nav'`), else the last `valueHistory` entry (`valueSource: 'manual'`, for seeded/legacy funds with no units), else `soldValue` for sold funds. This is the one design pivot: the periodic update is now a single **latest NAV** per fund, not a hand-typed value.
- **Storage:** ~5 KB/fund over 10 yr; ~55 KB for 11 funds — flat, like `monthly`/`feed`.

## XIRR (mf.js)

`xirr(cashflows)` — annualised IRR over irregular dated cashflows (Newton-Raphson from several seeds, bisection fallback). Needs both signs. **No daily NAV** — only (a) each investment dated, and (b) one terminal value:

- **Held fund:** terminal = current value (`totalUnits × latestNav`, or the `valueHistory` fallback) at `navAsOf`.
- **Sold fund:** terminal = `soldValue` at `soldDate` → *realized* XIRR (`xirrSource: 'realized'`). Projections are `null`.
- **Seeded held fund:** shows `seedXirrRef` (`xirrSource: 'sheet'`) until the user saves a real edit (`seeded` → false), then computes from cashflows.

Verified (Node, real module): 200 units × ₹150 = ₹30 000 value, return 36.36%, XIRR 14.82%; manual fallback still works for a unit-less seeded fund; single lumpsum → XIRR == CAGR.

## Benchmark status (mf.js)

**Return-only** — XIRR does not factor into `benchStatus` at all. On every recompute `computeFund` derives it from `absReturnPct`, in priority order:

1. **Manual override** — if the user set `benchReturnLow`/`benchReturnHigh` (own aspirational target), those win: **Below** at/under the low bound, **Above** at/over the high bound, **Within** between. A lone bound is the bar to beat (exceeding a lone low bound reads Above, not stuck Within). These bands **widen (never narrow) on NAV update**: `widenBenchBands(rec, c)` runs in every recompute-and-save path (fund-form save, bulk NAV sheet, AMFI fetch) and, when the fresh return/XIRR crosses a *set* band, expands that band to the new value. So a manual band the value overshoots becomes the new band permanently; a blank band stays blank. (`benchXirrLow/High` widen the same way even though XIRR no longer drives `benchStatus` — they still bound the Benchmark tab's XIRR graph.)
2. **Auto-tracked fallback** (used when no manual return threshold is set — the common case) — compares current return to the fund's own **observed** historical range, `returnLow`/`returnHigh`. These are updated to the running min/max every time a fund's value changes (fund-form save, bulk NAV-update sheet, AMFI online fetch all refresh them in the same write as the new value) — so **Above**/**Below** appear the moment a new all-time high/low return lands, with no separate save step. A ±0.01 epsilon absorbs float noise between the stored and freshly-recomputed value (matters most for a fund with only one data point, where `returnLow === returnHigh`).
3. No status (`null`) only when there's no invested amount or no observed range yet (fresh/unseeded fund).

`computeFund(fund, nowMs)` returns `{ invested, value, absReturnPct, liveReturnLow, liveReturnHigh, ageYears, sold, valueSource, totalUnits, avgNav, latestNav, soldValue, soldDate, xirr, xirrPct, xirrSource, liveXirrLow, liveXirrHigh, benchStatus, beatsBenchmark, benchReturnLowPct, benchReturnHighPct, benchXirrLowPct, benchXirrHighPct, targetYear, monthsLeft, projInvested2030, projCorpusStop, projCorpusStay }`.

`liveReturnLow/High` and `liveXirrLow/High` fold the current reading into the stored observed range (`fund.returnLow/High`, `fund.xirrLow/High`) without waiting for a save — the Benchmark tab's graph bounds use these, not the raw stored fields, so a fresh all-time-high/low never shows below/above a stale bound.

`projectCorpus(value, sip, rate, monthsLeft, stayInvested)` — FV to Dec of target year; rate clamped to −50%…+35% so a noisy short-history XIRR can't produce absurd projections. `stop` grows the current corpus only; `stay` adds the ongoing SIP annuity.

## UI (renderMF → `#mfView`, reuses stock CSS classes)

- **Bottom nav** (`#mfBottomNav`) — **Holdings | Overview**, a *second fixed bottom nav* built once (`buildMfBottomNav`) that looks exactly like the Stocks app's own `#bottomNav` (same `.bottom-nav` CSS, icon + label, accent when active). `setAppMode` shows it only in MF mode and hides the Stocks one, so the two never overlap. Tab state is `_mfTab` (`'holdings' | 'overview'`); clicking a nav button just flips `_mfTab` and calls `renderMF()` — `updateMfNavActive()` syncs the button's active class after each render.
  - **Holdings** — filter (`Investing | Sold`, live counts — holding vs redeemed, not SIP status) + sort (XIRR / Return / Invested / Name) + the fund card list + the update-values icon.
  - **Overview** — the summary card (*Current value / Invested / Overall gain / Portfolio XIRR / Above benchmark / Proj 2030* for Investing; *Realized value / Realized gain / Realized XIRR / Sold funds* for Sold) + **Allocation by type** (`.bar-row`).
- **Fund cards** (`.card`) — name, type · status, **benchmark status** badge (`above bench` green / `within bench` grey / `below bench` red) or `sold`, XIRR (labelled `XIRR` / `XIRR (sheet)` / `Realized XIRR`), Invested, Value, Return, a value-source tag (*From NAV* / *Value entered*), a **units · avg NAV · latest NAV** line when unit data exists, the auto-tracked observed **Range** line, and remarks.
- **Update latest NAV** — an icon button (📷) next to the filter/sort row on the Holdings tab, opens `openMfValueSheet()` (see OCR below).
- **`openFundForm`** — a **three-tab sheet** (`.seg`, plain — not the bottom nav):
  - **Edit fund** — name, type, category, status, SIP, **Latest NAV / NAV as of**, sold value/date (when Status=Sold), good return, target year, remarks. (Current-value, single-benchmark-XIRR, benchmark-name and judge-after inputs were removed — value comes from NAV, benchmark from its own tab; the removed fields' stored values are preserved through save.)
  - **Fund Holdings** — the investment log (each row is two lines: **date · amount invested**, then **units purchased · NAV**; leave units *or* NAV blank and it derives from the other two on blur) + a 📷 icon bottom-right for OCR import. (Per-transaction notes were dropped.)
  - **Benchmark** — the four user-defined thresholds (low/high return, low/high XIRR) + a live readout of current return/XIRR and the resulting Below/Within/Above badge.
  - On save: `buildRec()` gathers all three tabs; `computeFund` then updates `xirrLow/High` and `returnLow/High` (the observed auto min/max — separate from the benchmark thresholds); `seeded` is cleared. `valueHistory` is preserved untouched as the fallback value.

## Online NAV fetch (AMFI via mfapi.in — free, no key)

The **☁️ secondary FAB** (next to + on the MF surface, `#mfFetchBtn` → `fetchMfNavs`) pulls the latest NAV for every held fund. Marketaux (the news API) can't do Indian MF NAVs; **AMFI** publishes them daily and **mfapi.in** wraps that as CORS-friendly JSON, so it works straight from the browser with no backend/key.

- **Scheme resolution:** first run resolves each fund's AMFI scheme code from its name via `GET /mf/search?q=…`, scored to prefer **Direct + Growth** and reject IDCW/Regular (`_scoreScheme`), then **caches `schemeCode`/`schemeName` on the fund** so later runs skip the search.
- **Update:** `GET /mf/{code}/latest` → sets `latestNav` + `navAsOf` (AMFI's `dd-mm-yyyy` → ISO); value/return/XIRR/benchmark recompute; observed `xirrLow/High` + `returnLow/High` refresh; `widenBenchBands` runs too.
- **No once-per-day gate** — the user removed it (mfapi.in has no stated rate limit), so every click re-fetches all held funds. AMFI itself only publishes once daily, so a same-day re-click typically just confirms the same NAV — harmless, no real limitation to guard against.
- **Cross-origin** so it bypasses the same-origin service-worker fetch handler; fails gracefully offline. Funds not on AMFI (e.g. ULIPs like HDFC Click2Wealth) are reported as unmatched → set NAV manually.

## OCR (Paytm Money)

Reuses `ocr.js` (`ocrImages` — shared Tesseract worker) and pure parsers in `mf.js`. Neither persists the image; only parsed numbers reach the app.

- **Per-fund transaction import** — *removed from the UI.* The 📷 icon on the fund form's Fund Holdings tab (and its `_mfOcrTransactions` handler) was dropped at the user's request; investments are logged by hand there now. `parsePaytmTransactions(text)` and `editor.merge()` remain in the code, just no longer wired to a button.
- **Bulk latest-NAV update** (`📷 Update latest NAV` on the Holdings tab → `openMfValueSheet`). A grid of every **held** fund with an editable **latest NAV** (pre-filled with the fund's stored `latestNav`); each row shows `units → derived value` live. `📷 Scan holdings screenshot` runs `parsePaytmHoldings(text)`, fuzzy-matches funds (`_findFundMatch`), and pre-fills **NAV = parsed current value ÷ known total units** (so it needs units logged). Save stores `latestNav` + `navAsOf` per filled fund and refreshes the observed auto min/max. Works fully by manual entry. `parsePaytmHoldings` is best-effort until a real holdings screenshot is captured.

## Seeding (once)

`openMF` seeds the **11 funds** from `SEED_FUNDS` on first open (guarded by `meta.mfSeeded`). Each: SIP funds spread the known invested evenly across months from start→now (approx that reproduces a realistic XIRR); lumpsum funds get one dated cashflow. Current value = `invested × (1 + returns)`. `xirrLow/High`, `returnLow/High` start at the seed figures.

A second one-time step (guarded by `meta.mfMidCapAdded`) adds **Quant Mid Cap Fund Direct - Growth** as a `Sold` **stub** (no fabricated figures) so it shows on the Sold tab — the user fills invested + sold value/date.

## Backup

`funds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch` like `feed`), so the existing folder-based backup carries mutual-fund data with no change to `backup.js`.

## Not built yet

- **Holdings-parser tuning** — `parsePaytmHoldings` (the holdings-screenshot scan) is best-effort until a real Paytm Money holdings/summary screenshot is captured; manual bulk entry works today regardless. The transaction parser is tuned to the real screen and no longer requires the "Buy" keyword.
- No wife split (owner field reserved). Live NAV **is** now fetched daily from AMFI (see above). Benchmark thresholds are user-defined.
