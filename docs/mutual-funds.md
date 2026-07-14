# Mutual Funds & Home launcher

A second surface inside the same PWA for tracking mutual funds (modelled on the user's Google Sheet "Mutual Fund" tab). The **Stocks app is untouched** — it renders exactly as before.

## Home launcher

On open (after the lock gate) the app shows a **Home** screen with two cards: **Stocks** and **Mutual Funds**. The stock chrome (portfolio tabs, bottom nav, FABs) is hidden on Home/MF; the header title-row — with the shared **⋮ menu** — stays on all three surfaces, so **Backup covers both** from one place.

- `state.appMode` — `'home' | 'stocks' | 'mf'` (default `'home'`). Sits *above* the stock `state.view` system.
- `setAppMode(mode)` (app.js) shows/hides the surfaces and flips the header title + back button. `render()` early-returns unless `appMode === 'stocks'`, so a stray call can't un-hide stock sections over Home.
- Boot: `init()` still runs the normal `await refresh()` (stock data + background tasks unchanged), then calls `setAppMode('home')` — the launcher overlays the already-rendered (hidden) stock app. Zero change to stock behaviour.
- `‹` back button (`#backBtn`) returns to Home from Stocks/MF. Home always opens first (not persisted).
- **Home MF card subtext** (`{N} funds · ₹{invested}`) — `investing` funds only (`status !== 'Sold' && !soldDate`), invested = Σ `investedOf(f)` from `mf.js` (the canonical average-cost-basis rollup — a partial-sell contribution reduces invested proportionally, not a raw sum of every contribution's `amount`, which would wrongly add sell proceeds as if they were new investment). Matches the top Total Invested summary's method (`computeFund().invested`).

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
  contributions: [{ date:'YYYY-MM-DD', amount, units, nav, type }],  // dated buys (type omitted/'buy') and partial sells (type:'sell'); a sell reduces units/invested via average-cost-basis (mf.js's _rollup) and is a POSITIVE XIRR cashflow
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

- `invested`/`totalUnits` are **derived** (never stored → no drift) by processing `contributions` chronologically: a **buy** adds `amount`/`units`; a **sell** removes `units` and reduces `invested` proportionally (average-cost-basis — a partial redemption doesn't leave the remaining units looking like a paper loss). `avgNav` = invested ÷ totalUnits, of the units still held.
- **Current value** = `totalUnits × latestNav` when both are known (`valueSource: 'nav'`), else the last `valueHistory` entry (`valueSource: 'manual'`, for seeded/legacy funds with no units), else `soldValue` for sold funds. This is the one design pivot: the periodic update is now a single **latest NAV** per fund, not a hand-typed value.
- **Storage:** ~5 KB/fund over 10 yr; ~55 KB for 11 funds — flat, like `monthly`/`feed`.

## XIRR (mf.js)

`xirr(cashflows)` — annualised IRR over irregular dated cashflows (Newton-Raphson from several seeds, bisection fallback). Needs both signs. **No daily NAV** — only (a) each investment dated (buys negative, partial-sell rows positive), and (b) one terminal value:

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
- **`openFundForm`** — a **three-tab sheet** (`.seg`, plain — not the bottom nav). The sheet's `<h2>` shows the **fund's name** when editing (just "Add fund" when creating one) rather than a generic "Edit fund" label, and has a fixed Save/Delete/Cancel footer (`.sheet.has-fixed-footer`) — Delete only renders on the Edit fund tab.
  - **Edit fund** — name, type, category, status, SIP, **Latest NAV / NAV as of**, sold value/date (when Status=Sold), good return, target year, remarks.
  - **Fund Holdings** (`buildContribEditor`) — its own **Buy | Sell** sub-tabs (`.seg`, Buy default). No label/hint above the log anymore.
    - **Buy** — the investment log (each row is two lines: **date · amount invested**, then **units purchased · NAV**; leave any one of the three blank and it derives from the other two on blur) + **+ Add investment** + **Generate SIP schedule**.
    - **Sell** — a separate log of partial redemptions (each row: **date · proceeds received**, then **units sold · NAV**; units sold is the one required field) + **+ Add sale**. A sell reduces `totalUnits`/`invested` via average-cost-basis and is a positive XIRR cashflow (money back), independent of the full-redemption `soldValue`/`soldDate`/Status=Sold flow for exiting a fund entirely.
    - Both sub-tabs share one `refs` array under the hood, so `collect()` returns a single combined, date-sorted log tagged by `type`; **Generate SIP schedule** only wipes Buy rows, never Sell rows.
  - **Benchmark** — the four user-defined thresholds (low/high return, low/high XIRR) + a live readout of current return/XIRR and the resulting Below/Within/Above badge. These bands widen (never narrow) automatically on NAV update — see Benchmark status above.
  - On save: `buildRec()` gathers all three tabs; `computeFund` then updates `xirrLow/High` and `returnLow/High` (the observed auto min/max — separate from the benchmark thresholds) and runs `widenBenchBands`; `seeded` is cleared. `valueHistory` is preserved untouched as the fallback value.

## Online NAV fetch (AMFI via mfapi.in — free, no key)

The **☁️ secondary FAB** (next to + on the MF surface, `#mfFetchBtn` → `fetchMfNavs`) pulls the latest NAV for every held fund. Marketaux (the news API) can't do Indian MF NAVs; **AMFI** publishes them daily and **mfapi.in** wraps that as CORS-friendly JSON, so it works straight from the browser with no backend/key.

- **Scheme resolution:** first run resolves each fund's AMFI scheme code from its name via `GET /mf/search?q=…`, scored to prefer **Direct + Growth** and reject IDCW/Regular (`_scoreScheme`), then **caches `schemeCode`/`schemeName` on the fund** so later runs skip the search.
- **Update:** `GET /mf/{code}` (full daily history, not just `/latest` — see Stats tab below) → the newest entry sets `latestNav` + `navAsOf` (AMFI's `dd-mm-yyyy` → ISO); value/return/XIRR/benchmark recompute; observed `xirrLow/High` + `returnLow/High` refresh; `widenBenchBands` runs too.
- **No once-per-day gate** — the user removed it (mfapi.in has no stated rate limit), so every click re-fetches all held funds. AMFI itself only publishes once daily, so a same-day re-click typically just confirms the same NAV — harmless, no real limitation to guard against.
- **Cross-origin** so it bypasses the same-origin service-worker fetch handler; fails gracefully offline. Funds not on AMFI (e.g. ULIPs like HDFC Click2Wealth) are reported as unmatched → set NAV manually.

## Stats tab (Day/Month/Year vs Nifty 50)

A 4th bottom-nav tab (`Holdings | Overview | Benchmark | Stats`) showing each held fund's NAV change over the **last day / month / year**, compared against **Nifty 50**.

- **Nifty 50 is a proxy, not the real index.** The raw NSE index level can't be fetched browser-only — NSE's own API needs session cookies and blocks CORS, and Yahoo's `^NSEI` is CORS-blocked too. mfapi.in only wraps AMFI *mutual fund* NAVs, with no index endpoint. So the app uses a **Nifty 50 index fund's NAV** (`NIFTY50_PROXY = '120716'`, UTI Nifty 50 Index Fund - Direct Growth) as the benchmark — its % change tracks the real index within a small tracking-error/expense-ratio drift, and it comes from the exact same `mfapi.in` endpoint already used for fund NAVs.
- **Populated by the ☁️ NAV fetch** (`fetchMfNavs`), not a separate button — that function now calls `GET /mf/{code}` (full history) instead of `/mf/{code}/latest` for every held fund, plus one extra call for the Nifty proxy. One tap refreshes NAV *and* Stats; the tradeoff is a heavier payload per tap (full history vs a single latest reading).
- **Storage: deltas only, not history.** `navChangePct(hist, daysBack)` computes day/month/year % from the fetched history in memory, then only `fund.stats = { d1, m1, y1, asOf }` (~4 numbers) is persisted on the fund record — a schemaless field, no DB version bump. The Nifty proxy's own `{d1,m1,y1,asOf}` goes in `meta.mfNiftyStats`. Raw daily history is never stored (would be ~50 KB/fund over 10 yr); the deltas add roughly 1 KB total across all funds — negligible against typical ~500–600 KB backups.
- **Day/Month/Year are rolling, not calendar periods** — day = vs the previous trading day, month = vs ~30 days back, year = vs ~365 days back (nearest available trading date at-or-before the target, since markets are closed weekends/holidays).
- **UI:** Day/Month/Year sub-tabs (`_mfStatsTab`, mirrors `_mfBenchTab`'s pattern) above a Nifty header row and a sorted fund list (best period-performer first); each fund row shows its own % plus a small delta-vs-Nifty badge. Funds unmatched on mfapi (no `stats`) show `—` rather than being hidden. Empty state before the first ☁️ fetch: "Tap ☁️ to fetch NAV history…".

## OCR (Paytm Money)

Reuses `ocr.js` (`ocrImages` — shared Tesseract worker) and pure parsers in `mf.js`. Neither persists the image; only parsed numbers reach the app.

- **Per-fund transaction import** — *removed from the UI.* The 📷 icon on the fund form's Fund Holdings tab (and its `_mfOcrTransactions` handler) was dropped at the user's request; investments are logged by hand (Buy/Sell sub-tabs) there now. `parsePaytmTransactions(text)` remains in mf.js unused; `buildContribEditor`'s `merge()` was removed along with the button since nothing called it.
- **Bulk latest-NAV update** (`📷 Update latest NAV` on the Holdings tab → `openMfValueSheet`). A grid of every **held** fund with an editable **latest NAV** (pre-filled with the fund's stored `latestNav`); each row shows `units → derived value` live. `📷 Scan holdings screenshot` runs `parsePaytmHoldings(text)`, fuzzy-matches funds (`_findFundMatch`), and pre-fills **NAV = parsed current value ÷ known total units** (so it needs units logged). Save stores `latestNav` + `navAsOf` per filled fund and refreshes the observed auto min/max. Works fully by manual entry. `parsePaytmHoldings` is best-effort until a real holdings screenshot is captured.

## Seeding (once)

`openMF` seeds the **11 funds** from `SEED_FUNDS` on first open (guarded by `meta.mfSeeded`). Each: SIP funds spread the known invested evenly across months from start→now (approx that reproduces a realistic XIRR); lumpsum funds get one dated cashflow. Current value = `invested × (1 + returns)`. `xirrLow/High`, `returnLow/High` start at the seed figures.

A second one-time step (guarded by `meta.mfMidCapAdded`) adds **Quant Mid Cap Fund Direct - Growth** as a `Sold` **stub** (no fabricated figures) so it shows on the Sold tab — the user fills invested + sold value/date.

## Backup

`funds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch` like `feed`), so the existing folder-based backup carries mutual-fund data with no change to `backup.js`.

## Not built yet

- **Holdings-parser tuning** — `parsePaytmHoldings` (the holdings-screenshot scan) is best-effort until a real Paytm Money holdings/summary screenshot is captured; manual bulk entry works today regardless. The transaction parser is tuned to the real screen and no longer requires the "Buy" keyword.
- No wife split (owner field reserved). Live NAV **is** now fetched daily from AMFI (see above). Benchmark thresholds are user-defined.
