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
  // Benchmark thresholds — USER-DEFINED, never auto-modified (decimals). Blank = ignore.
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

Four optional **user-defined** thresholds (`benchReturnLow/High`, `benchXirrLow/High`) — never touched automatically. On every recompute `computeFund` derives `benchStatus`:

- **Below** if current return < `benchReturnLow` **OR** current XIRR < `benchXirrLow`.
- **Above** if current return > `benchReturnHigh` **OR** current XIRR > `benchXirrHigh`.
- **Within** otherwise. Below takes precedence (worst case wins) — a fund whose return is under its low bound but whose XIRR is over its high bound reads **Below**. Any blank threshold is skipped; no thresholds → `benchStatus: null`.

`computeFund(fund, nowMs)` returns `{ invested, value, absReturnPct, ageYears, sold, valueSource, totalUnits, avgNav, latestNav, soldValue, soldDate, xirr, xirrPct, xirrSource, benchStatus, beatsBenchmark, benchReturnLowPct, benchReturnHighPct, benchXirrLowPct, benchXirrHighPct, targetYear, monthsLeft, projInvested2030, projCorpusStop, projCorpusStay }`.

`projectCorpus(value, sip, rate, monthsLeft, stayInvested)` — FV to Dec of target year; rate clamped to −50%…+35% so a noisy short-history XIRR can't produce absurd projections. `stop` grows the current corpus only; `stay` adds the ongoing SIP annuity.

## UI (renderMF → `#mfView`, reuses stock CSS classes)

- **Bottom nav** (`#mfBottomNav`) — **Holdings | Overview**, a *second fixed bottom nav* built once (`buildMfBottomNav`) that looks exactly like the Stocks app's own `#bottomNav` (same `.bottom-nav` CSS, icon + label, accent when active). `setAppMode` shows it only in MF mode and hides the Stocks one, so the two never overlap. Tab state is `_mfTab` (`'holdings' | 'overview'`); clicking a nav button just flips `_mfTab` and calls `renderMF()` — `updateMfNavActive()` syncs the button's active class after each render.
  - **Holdings** — filter (`Investing | Sold`, live counts — holding vs redeemed, not SIP status) + sort (XIRR / Return / Invested / Name) + the fund card list + the update-values icon.
  - **Overview** — the summary card (*Current value / Invested / Overall gain / Portfolio XIRR / Above benchmark / Proj 2030* for Investing; *Realized value / Realized gain / Realized XIRR / Sold funds* for Sold) + **Allocation by type** (`.bar-row`).
- **Fund cards** (`.card`) — name, type · status, **benchmark status** badge (`above bench` green / `within bench` grey / `below bench` red) or `sold`, XIRR (labelled `XIRR` / `XIRR (sheet)` / `Realized XIRR`), Invested, Value, Return, a value-source tag (*From NAV* / *Value entered*), a **units · avg NAV · latest NAV** line when unit data exists, the auto-tracked observed **Range** line, and remarks.
- **Update latest NAV** — an icon button (📷) next to the filter/sort row on the Holdings tab, opens `openMfValueSheet()` (see OCR below).
- **`openFundForm`** — a **three-tab sheet** (`.seg`, plain — not the bottom nav):
  - **Edit fund** — name, type, category, status, SIP, **Latest NAV / NAV as of**, sold value/date (when Status=Sold), good return, target year, remarks. (Current-value, single-benchmark-XIRR, benchmark-name and judge-after inputs were removed — value comes from NAV, benchmark from its own tab; the removed fields' stored values are preserved through save.)
  - **Fund Holdings** — the investment log (each row **date · amount · units · NAV · notes**; leave units *or* NAV blank and it derives from the other two on blur) + a 📷 icon bottom-right for OCR import.
  - **Benchmark** — the four user-defined thresholds (low/high return, low/high XIRR) + a live readout of current return/XIRR and the resulting Below/Within/Above badge.
  - On save: `buildRec()` gathers all three tabs; `computeFund` then updates `xirrLow/High` and `returnLow/High` (the observed auto min/max — separate from the benchmark thresholds); `seeded` is cleared. `valueHistory` is preserved untouched as the fallback value.

## OCR (Paytm Money) — two distinct flows

Both reuse `ocr.js` (`ocrImages` — shared Tesseract worker) and pure parsers in `mf.js`. Neither persists the image; only parsed numbers reach the app.

- **Per-fund transaction import** (📷 inside the fund form's Fund Holdings tab). `parsePaytmTransactions(text)` reads the transaction-history screen (`Buy · <date>` + `<units> / <nav>` + `₹<amount>`) → `[{date, amount, units, nav, type}]`. `_mfOcrTransactions(editor)` merges the **buy** rows via `editor.merge()`, which **dedupes by date** and now carries **units + NAV** onto each row (not just amount). Amount falls back to `units×nav` if the ₹ figure is misread. Verified against the real screen: 6/6 rows, exact dates/amounts.
- **Bulk latest-NAV update** (`📷 Update latest NAV` on the Holdings tab → `openMfValueSheet`). A grid of every **held** fund with an editable **latest NAV** (pre-filled with the fund's stored `latestNav`); each row shows `units → derived value` live. `📷 Scan holdings screenshot` runs `parsePaytmHoldings(text)`, fuzzy-matches funds (`_findFundMatch`), and pre-fills **NAV = parsed current value ÷ known total units** (so it needs units logged). Save stores `latestNav` + `navAsOf` per filled fund and refreshes the observed auto min/max. Works fully by manual entry. `parsePaytmHoldings` is best-effort until a real holdings screenshot is captured.

## Seeding (once)

`openMF` seeds the **11 funds** from `SEED_FUNDS` on first open (guarded by `meta.mfSeeded`). Each: SIP funds spread the known invested evenly across months from start→now (approx that reproduces a realistic XIRR); lumpsum funds get one dated cashflow. Current value = `invested × (1 + returns)`. `xirrLow/High`, `returnLow/High` start at the seed figures.

A second one-time step (guarded by `meta.mfMidCapAdded`) adds **Quant Mid Cap Fund Direct - Growth** as a `Sold` **stub** (no fabricated figures) so it shows on the Sold tab — the user fills invested + sold value/date.

## Backup

`funds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch` like `feed`), so the existing folder-based backup carries mutual-fund data with no change to `backup.js`.

## Not built yet

- **Holdings-parser tuning** — `parsePaytmHoldings` (the common current-value scan) is best-effort until a real Paytm Money holdings/summary screenshot is captured; manual bulk entry works today regardless. The transaction parser is tuned to the real screen.
- No wife split (owner field reserved). No live NAV feed. Benchmark XIRR is manual.
