# Features Built

This is the inventory. Each entry: **what** + **where** + **why it's that way**. Don't re-implement; if the user asks for a behavior in here, point them at the existing path.

## Home screen

**Two levels of navigation, not one.** The true top-level Home shows **six** section cards —
**💼 Investment · 🏦 Savings · 💳 Expense · 👛 Personal Finance · 🩺 Health Check · 🔐 My Passwords**
— and tapping **Investment** or **Savings** opens a SECOND launcher with its own card grid (Stocks /
Mutual Funds / Fixed Deposits / Metals / Bonds / Dividends under Investment; Emergency Fund / Bank
Savings under Savings). Several of the feature docs below (bonds.md, fixed-deposits.md,
mutual-funds.md, emergency-fund.md) were written when that second level *was* Home, and still say
"Home screen shows a Bonds card" etc. — read that as "the Investment/Savings launcher," which is
what it now is; nothing about those docs' card layout itself is wrong. Expense/Personal
Finance/Health Check/My Passwords go straight to their own tabbed surface with no second card layer.

- **Hero + summary** (Total Invested / Total Earned, with the ⓘ breakdown sheet), then the six
  section cards.
- **⏰ Coming Up** — a horizontally-scrolling strip of money/attention *arriving* soon, sitting
  between the summary and the section cards. `_homeUpcomingStrip()` in app.js. Three sources share
  one rail:
  - **FD** — maturing within `UPCOMING_DAYS` (7): the deposit matures (principal + interest as one
    lump). Maturity amounts come from `resolveChain()`, not `computeFd()` — an FD funded by rolled-in
    matured parents has a larger effective deposit, so the chain is the only way to get its payout right.
  - **BOND** — due within `UPCOMING_DAYS`: `computeBond().nextDue`, the next dated event on its
    schedule (interest + principal for that row; the schedule's final row *is* the maturity lump, so
    that case is covered). A plain **at-maturity bond has no schedule and therefore no `nextDue`** —
    for those the single payout event is the maturity itself, an explicit fallback. Sold/matured skipped.
  - **DIV** — stocks that have paid a dividend in **this calendar month** in some past year (their
    `dividends` record's `months` list, from `dividend.js`) but have **nothing logged for the current
    year yet** (`yearTotal(rec, curYear) <= 0`) — once you log this year's dividend the reminder drops
    that stock, since there's nothing left to check. Sourced from `_eligibleDividendRecords(mod,
    {write:false})`, the same read-only join Home's own live-stats block already uses, so it only
    considers stocks currently held and toggled "Dividend available". Both markets combine into one
    list — names only, no ₹/$, so India and US don't need separating here. No due date to sort by
    (it covers the whole month), so it's pinned to sort **after** every dated FD/BOND item.
  - **FD/BOND cards carry no instrument name** — just days left, the amount, and an **FD**/**BOND**
    badge; the **DIV** card instead shows its badge (e.g. **"Dividend of September"**) over the
    comma-separated stock names, since it has no single amount/date to show. Every card still reads as
    the same *kind* of thing whatever its source; each badge colour is deliberately distinct (FD accent
    blue, BOND amber, DIV teal).
  - **A tap goes to the relevant LIST page** — `setAppMode('fd')` / `openBond()` / `openDividend()` —
    *not* an individual record's edit form: the next thing you want is the whole list in context.
  - FD/BOND sorted soonest first; DIV always last. Cards inside 2 days get a **warn-coloured** left
    accent; the DIV card gets its own teal accent instead, since "soon" doesn't apply to it.
  - **Renders nothing at all when nothing is due** — no empty heading. Each source is independently
    try/catch-wrapped so one failing can't take out the other, and the whole call is wrapped again in
    `renderHome()` so it can never blank Home.
  - **Deliberately includes Emergency-Fund-linked records.** Linking a record removes it from a page's
    *totals*, never from its *listings*. "Cash arrives Thursday" is an action reminder, not a total, so
    it matters regardless of which surface counts the money — and the **EF** badge rides along beside
    the type badge so that money isn't mistaken for free cash.
  - An FD maturing **today** does *not* appear: `fd.js` derives status purely from the date and treats
    maturity day itself as already `matured`, so it moves to the FD page's Matured bucket instead (the
    user was warned the previous day as "Tomorrow"). A **bond** payout dated today legitimately can
    appear, which is why the "Today" label exists at all.
  - **Two fixed rows per chip card**, ~118px minimum: for FD/BOND, row 1 is "N Days left" with the
    type badge (**FD**/**BOND**) and **EF** badge top-right, row 2 is the amount with the maturity date
    bottom-right (year dropped — "3 Sep" — since nothing here is more than a week out); for DIV, row 1
    is the "Dividend of …" badge alone, row 2 is the stock-name list. Whatever a card needs to show, it
    grows **wider**, never taller — every card stays exactly two lines regardless of content
    (`white-space: nowrap`, no fixed/max width) — verified with a 5-name DIV card reaching 574px wide
    while staying the same 54px tall as every FD/BOND card next to it. Scrolls inside its own rail with
    scroll-snap (same technique as `.portfolio-tabs`), so the page body never scrolls sideways.
  - **Edge fade on the trailing edge** once the rail actually overflows (`.can-scroll`), clearing again
    at full scroll (`.at-end`) — the cue that more cards exist off-screen, without implying it when they
    don't. Recomputed on every scroll event. The width check runs via `setTimeout(fn, 0)`, not
    `requestAnimationFrame` — the rail isn't attached to the document yet when it's scheduled (the caller
    appends the returned strip right after), and rAF is fully suspended on a backgrounded tab (e.g. the
    screen just locked), while a plain macrotask still fires either way.
  - Verified at 375px: 1 card (no fade, correctly not scrollable) and 6 cards (fade shown while
    scrollable, clears at both scroll-start and scroll-end).

## Navigation

- **Portfolio tabs** (top): Me · India / Wife · India / Me · US — in this order. `buildChrome()` in app.js. Tap a tab, or **swipe left/right anywhere in the Stocks content** to step through them (swipe left = forward, matching the direction the content travels). Both routes go through one shared `selectPortfolio()` so they can't drift. Swipe specifics:
  - **Clamps at both ends** rather than wrapping — jumping from the last tab back to the first reads as a glitch, and three tabs are quick to tap.
  - **Ignored inside anything that scrolls horizontally itself** (the Heatmap's wide table): that element owns the gesture. Gated on actual scrollability, so a table narrow enough to fit still allows swiping.
  - Needs 55px of travel, `|dy|` under 0.6·`|dx|`, and under 700ms — so vertical scrolling, diagonal drags, and slow sideways drift don't trigger it. Touch-only: a mouse drag across a page is a text selection.
  - A brief directional slide (`main.swipe-in-left/right`, 0.18s) plays as the new portfolio lands so the gesture is confirmed visually; honors `prefers-reduced-motion`. Taps stay instant — a tap has no direction the user expressed.
- **Bottom nav**: Holdings · Heatmap · Trend · Overview. The labels were renamed (Monthly → Trend, Trends → Overview) by user request.
- **Filter chips** (Holdings tab): Holding · Sold · All — in that order. **Default is Holding** (not All). Set via `state.filter = 'holding'` initial value.

## Holdings tab

- **Tri-state sort buttons** (Name / Return % / Value): default → primary (DESC) → secondary (ASC) → default. Multi-tap cycle.
- **Sort always puts holdings before sold** (status-primary, then field-secondary). Single sort applies across the unified list.
- **Search box**: filters by name OR category.
- **Per-stock card**: shows current value, overall return %, invested, units, latest monthly change. Sold cards instead show the exit verdict badge and, when a buy price and unit count are on record, three P/L figures vs. that avg buy price: **Booked** (realised, `soldUnits × (soldPrice − buyPrice)`), **If held** (hypothetical, `soldUnits × (currentPrice − buyPrice)`), and **vs. exit** (Booked minus If held, matching the card's top-to-bottom order — positive shown green, negative shown red). Without a buy price or unit count (e.g. an old CSV import), none of the three can be measured, so none render — only the badge and the sale/current-price lines show.
- **Prices-updated indicator**: shown **once per portfolio** (not per stock), in two places, computed as the most recent price update among that portfolio's active holdings (Me · India / Wife · India / Me · US tracked separately; 30+ days warning-colored):
  - **Holdings tab** — bottom-right corner of the top summary card (`#summary`, `.summary-upd`), for the currently-selected portfolio tab.
  - **Overview tab** — a tiny line under each portfolio's up/down % on the **Portfolios** card (`.stat-upd`), all three at once.
- **Tap a card** → opens detail with monthly history list + per-month % editor.
- **➕ FAB** → add new stock.
- **📷 FAB** → OCR upload. **Only visible on Holdings tab**, and only on portfolios with an OCR parser (me-in, wife-in, me-us — all three now).

## Heatmap tab

- Sheet-style grid: stock × month, color-coded by monthly %.
- **Excludes sold stocks** (they shouldn't drag the visual signal).
- Two-decimal precision (user requested — no rounding to ints).
- The "current month" sticker moved to bottom-right (was clipping at top).

## Trend tab (was "Monthly")

- "Capture this month" button — saves current portfolio totals as a monthly snapshot.
- Note under the button explains what Capture does (small font, user-requested).
- **Month-end snapshot reminder**: during the final 7 calendar days of a month, if the current month has not been captured, the Trend tab shows a reminder banner with **Capture now**. App open also shows a once-per-session reminder toast for the active portfolio.
- **Value-by-month chart** with Nifty 50 / Nasdaq overlay on second axis.
- Per-month MoM calculation: `value - prev.value` (kept simple per user — was overengineered with profit-loss deltas, reverted).
- **Per-month gain badge**: each card in the Months list shows a small `+₹X`/`-₹X` badge (reusing `.badge good`/`.badge bad`) right next to that month's Value, from the already-stored `m.profitLoss` (= that month's value − invested). Deliberately distinct from the MoM figure beside it — MoM is the change vs. the *previous* month, this badge is the standalone return *for* that month, so both read at a glance without eyeballing a diff. No badge when `profitLoss` is null (invested or value missing on a manually-entered month).
- Tap a point on mobile to show details (SVG `<title>` only triggers on hover, so we added a click handler + `.chart-info` div).

## Overview tab (was "Trends")

- Per-portfolio summary cards (value · label · up/down % · a tiny per-portfolio "prices updated" line).
- Allocation view.
- Per-month value movement, insights.

## Per-stock editor

- Status: Holding / Sold.
- Holding fields: name, category, units, buyPrice, currentPrice, conviction, notes.
- Sold-only fields: soldPrice, soldUnits, soldDate. Hidden via `.sold-only.hidden`.
- Monthly history: editable, sorted by month.

## OCR (📷)

See [ocr.md](ocr.md) for the deep dive. Summary:
- **Multi-image upload** (4–5 screenshots typical, shared Tesseract worker).
- Per-portfolio parser dispatch: Zerodha (me-in), Groww (wife-in, no-avg), INDmoney US (me-us).
- Review modal with per-row dropdown override, alias memory, "+ Add as new", big-jump warning, ₹→3 misread detection.

## Backup & Restore

Single menu item: **🗄️ Backup & Restore**. Folder-based via File System Access API. See [backup.md](backup.md) for the full design.

- First time: prompts user to pick a dedicated folder (e.g. `Documents/MyNoteBackups`).
- Backup now: writes `mynote-stocks-backup-YYYY-MM-DD.json` to that folder. Same-day backups overwrite.
- Auto-rotates: keeps newest 5, deletes older ones (only files matching the strict pattern).
- Recent backups list shown in the sheet → one-tap Restore.
- Pre-restore snapshot written silently before any restore → single-level undo via "Restore from outside file".
- Browsers without the API (Safari/iOS) fall back to legacy export/import (download + file picker). Old downloaded backups still import.
- 30-day reminder toast on app open if last backup is older.
- Tracks `meta.lastBackup` timestamp.

## Sheet import

- **Menu → 📊 Import from X-MyNotes sheet** — paste CSV from the Stock tab.
- `csv.js` is dynamic-imported (only loaded when user picks "Import").
- Handles the X-MyNotes column layout specifically (not a generic CSV parser).

## PWA shell

- Install prompt: `beforeinstallprompt` deferred; "Install app" menu item appears when available.
- `navigator.storage.persist()` called on init — asks the OS to mark the storage as durable so it won't be evicted under storage pressure.
- Apple/iOS meta tags for home-screen install.

## App updates (user-triggered)

- **Menu → 🔄 Check for updates** — pulls the latest service-worker.js from the server.
- Label flips automatically when a new version is already waiting: **"Update available — tap to apply"**.
- New SW versions install silently in the background but **only activate when the user taps**. No surprise reloads.
- After tap: SW activates → page reloads with the new code.
- See [gotchas.md → Service worker updates](gotchas.md#service-worker-updates--user-triggered-v44) for the full lifecycle.

## Service worker

- See [architecture.md → Service worker](architecture.md#service-worker--caching-strategy).
- `?reset=1` URL handler in `index.html` head — wipes SW + caches and reloads. The escape hatch.

## Theme

- Auto light/dark by hour. Re-evaluated on `visibilitychange`.
- `data-theme="light"` on `<html>` flips CSS variables.

## Feed & Recommendations (5th tab)

See [feed.md](feed.md) for the full design. Summary:

- **🗒️ Feed tab** in bottom nav (5th item).
- Pulls last-24h news for the current portfolio's active holdings from **Marketaux** (free tier, 100 req/day, direct browser fetch — no proxy).
- Privacy: only stock NAMES + user's API key leave the device. No prices, no portfolio data.
- Per-stock card shows recommendation badge (Hold / Watch / Consider averaging / Critical event) + 1-line reason + units suggestion (e.g., "Buy 5-10 units") + collapsible article list with sentiment chips.
- Shows **both 24h + 7d sentiment** for stability (7-day smooths out noise).
- **Filter toggle:** "All holdings" vs "Has news only" to reduce clutter.
- **7-day rolling window:** articles accumulate over 7 days; older articles auto-expire. Provides stable sentiment signal.
- Recommendation engine is **fully offline** — pure function combining cached news sentiment with local price history. See `feed.js → computeRecommendation`.
- API key entered via Menu → 📰 Feed settings.
- Auto-refresh runs silently on app open for the active portfolio when stale, and also on Feed tab open when stale. Manual "Refresh now" button always available.
- Disclaimer banner: "Not financial advice."

## Portfolio Analyzer (in Overview tab)

- New subsection on the Holdings/Overview tab showing current portfolio health.
- **Portfolio health score:** 0-100 score based on price coverage, stale prices, top holding concentration, sector exposure, and "Avoid" conviction flags. It is a conservative review signal, not investment advice.
- **Concentration risk:** flags stocks >15% of portfolio.
- **Top holdings + sentiment:** shows top 5 holdings with their 7-day sentiment (color-coded).
- **Sector breakdown:** displays how many stocks in each sector (IT, Finance, Pharma, etc.).
- **Data sources:** uses local holdings + cached feed sentiment (if Feed has been used).
- **Long-term focus:** shows structural imbalances, not timing signals.

## Bonds (6th Home card)

See [bonds.md](bonds.md) for the full design. Summary:

- **🧾 Bonds** card on Home, after Dividends.
- Tracks retail bonds (name, rating, coupon rate, start/maturity dates, optional bank-rate comparison, optional maturity-amount override, optional sold/redeemed-early exit).
- Bonds | Overview tabs (bottom nav). Filter Active/Matured+Sold/All, sort by Maturity/Amount/Rate.
- **Interest payout** and **Principal repaid** frequency pickers (Details tab) — At maturity / Monthly / Quarterly / Half-yearly / Yearly / Staggered (custom), set independently. The interest picker is hidden for *Cumulative* bonds, which are "at maturity" by definition. Periodic dates for both count **backward from the maturity date**, not forward from when you bought in — a bond maturing 26/07/2027 pays on the 26th of every month regardless of your own purchase date, matching how these bonds are actually issued.
- **Amortizing bonds** — when principal comes back in installments rather than one lump, the card and form show **how much principal each installment returns**, how much is still **outstanding**, and the **next due date**. Interest is then projected on the *reducing balance*, so each coupon is smaller than the last and the projected total is meaningfully lower than rate × full principal × tenure. *Active invested* (and the Home ⓘ Bonds row) count only the outstanding principal — capital already repaid is back in your pocket. Bonds set to "At maturity" (i.e. every bond predating this feature) are completely unaffected.
- **First repayment override** (optional) — for the rare bond whose real first principal repayment genuinely isn't on the maturity-anchored date (a moratorium period, or a one-off first installment). Left blank, the correct maturity-anchored schedule applies automatically.
- **Schedule tab** (per bond) — the projected cash-flow timeline: one row per date with interest, principal, and the balance left, past rows dimmed. Warns when staggered principal installments don't add up to the amount invested. This is the *plan*; Payouts is the *actuals*.
- **Payouts tab** (per bond, in the edit form) — log each interest/coupon payment actually received, dated, **plus optionally how much principal came back with it**. Once any interest is logged, it becomes the real "interest earned" figure, overriding the coupon-rate projection; once any principal is logged, it becomes the real Outstanding/Invested figure, overriding the projected schedule the same way.
- **Sold / redeemed early** toggle (Details tab) — records the sale date and total amount received; realised interest is derived (`payoutsBeforeExit + soldGain`), never typed. A sold bond appears in the Matured/Sold bucket alongside bonds that aged to maturity.
- Each card shows a **"Basis: …"** line explaining exactly how the interest figure was calculated (coupon rate, an entered maturity amount, or the realised sale arithmetic).
- Seeded once from the user's X-MyNotes BOND sheet (3 real bonds), editable afterward — no payouts pre-seeded, logged by the user.
- Home's Total Invested/Earned uses a basis **different from Fixed Deposits, on purpose**: invested = active bonds' *outstanding* principal (still-live capital); earned = realised interest from closed (matured + sold) bonds only, never an active bond's accrued-but-unpaid interest. The row's Return % is computed against the closed bonds' own principal (interest ÷ the principal that earned it), not against Invested.

## Emergency Fund (7th Home card)

See [emergency-fund.md](emergency-fund.md) for the full design. Summary:

- **🚨 Emergency Fund** card on Home (under the Savings section). Tabs: **Funds | Targets | Loans | Log | Rules**. The **+** FAB is hidden on Funds and Rules (nothing to add on either — link a holding from its own form instead) and shown on the other three.
- **Rules tab**: the family's written policy (10 numbered rules, including the 1×/2×/3×/4× interest-multiplier bands), displayed verbatim as reference. The figures it quotes and the footer's interest formula are pulled from `emergency.js`'s own constants, so the text can't drift from what Loans actually charges.
- A family lending pot with a rulebook — two equal monthly contributions in, parked across MFs/bond/FD, lent out to self and family under a written interest policy, measured against a ladder of targets.
- **Its investments stay in the `funds`/`bonds`/`fds` stores**, flagged via a **"Part of Emergency Fund"** switch on those surfaces' own forms (Bonds, MF, and FD all have it). They keep the existing live NAV fetch (no duplicated code, no extra network calls), stay listed there with a purple **EF** badge, but leave that page's invested/return totals.
- **Funds tab**: interest split into **Realised** (from lending, received from investments — real cash) vs **Pending/unrealised** (mark-to-market, due on open loans), each row iconed and colour-accented. The "Invested in" list groups linked holdings by category — Mutual Funds / Bonds / Fixed Deposits — each with a header subtotal, instead of one flat list.
- **Nothing about this fund enters Home's Total Invested or Total Earned** — not the parked holdings, not the idle cash, not the loans, and there's no Emergency Fund row either. Same treatment SGBs get (record in one store, a different surface counts it) and same as Dividends, which also contributes nothing. ⚠ Linking a holding therefore *lowers* Home's Total Invested by whatever it was contributing — the intended correction, since it's now reported on the fund's own page.
- **Loans**: one entity with three grace periods — `self` (priced from day one), `emergency` (free for 3 months), `gift` (free for 5 months). Interest is **computed** as `CEILING(amount × 2% × multiplier, ₹100)` with `multiplier = max(1, ceil(months/3))`, and a **per-loan override** for exceptions. Open loans show both what's accrued so far and what it'll cost if repaid on time. Instalment ledger per loan; the interest clock stops at closure.
- **Targets** use an `add`/`absorb` flag — `absorb` replaces the rung below rather than stacking on it (a joint fund supersedes the single-person one it already covers), which stops a naive running sum from permanently overstating how far away the final goal is.
- **Reconciliation** is shown explicitly (`collected − invested − lent = available`) and warns in plain language when it doesn't add up, rather than rendering a bare negative.
- No seed data — the user logs their own contributions, targets and loans.

## Bank Savings (2nd Savings-section card)

- **🐷 Bank Savings** card on Home, next to Emergency Fund under the Savings section. Deliberately the
  simplest surface in the app: one flat list of savings accounts, each holding its **current balance**
  (typed in by hand — there's no bank API to fetch it live) plus the date that balance was last
  checked. No sub-tabs, no derived interest math.
- Fields: bank (free text with a common-banks datalist), an optional account label (e.g. "Salary",
  "Joint" — for telling apart two accounts at the same bank), balance, as-of date, notes.
- Summary shows the total across every account plus the per-account average; cards are sorted balance
  descending. Tap a card to edit or delete it.
- **Not counted in Home's Total Invested** — it's cash in hand, not capital at work, same treatment as
  Emergency Fund's idle cash and Dividends.
- Own `bankSavings` IndexedDB store (v10), in `exportAll`/`importAll` for backup.

## Metals (Investment launcher)

Gold/silver ledger, `metal.js` (lazy-loaded). Sovereign Gold Bonds are deliberately **not** tracked
here — they live in the `stocks` store and are only *listed* on the Metals surface's SGB tab
(counted as gold "since end of the day it's gold").

- **`metals` store** (v7, indexed by `metal`): one row per transaction — `metal` (gold/silver), `date`,
  `grams` (negative on a sell), `amount` (always stored positive; sign comes from `type`), `via`
  (Aura/Sify/Physical/free text), `type` (buy/sell/interest), note.
- **Average-cost basis** (`rollup()`): a sell removes both the grams and their proportional cost
  basis, so a partial sale doesn't leave the remaining holding looking like a paper loss — same
  approach `mf.js` uses for a mutual fund redemption. An `interest` row adds free grams at no cost.
- **Tabs**: Gold | Silver (ledger + a by-source breakdown + a manually-set ₹/gram price — no live
  fetch) | Overview (combined totals, allocation bars, and a Gold-vs-Silver table where the Gold row
  **includes SGB grams** priced at the gold rate) | SGB (read-only, points back at the Stocks tab to
  edit).
- **Folds into Home's Total Invested/Earned** — one of the contributing buckets in
  `homeInvestedBreakdown()`, unlike Dividends and Bank Savings (see below).

## Dividends (Investment launcher)

Per-stock dividend tracking, `dividend.js` (lazy-loaded).

- **`dividends` store** (v6, indexed by `market`): one row per tracked stock — `months` (historical
  payout months) + one entry per `year` (India: `units`/`perUnit`/`perMonth`; US: `perMonth`, older
  rows may carry a flat `amount`). India (₹) and US ($) are never summed together.
- **Membership tracks a stock's own `divAvailable` toggle live**, not a manual add/delete list — every
  render re-joins eligible holdings against this store; toggling a stock off *hides* its record rather
  than deleting it, so re-enabling later restores the history.
- **YoY analysis** (`annualAnalysis`) only lists a year that actually has a figure recorded — "a year
  nobody entered a figure for is not a year of no dividend, it is a year with nothing to say" — and
  always compares against the nearest *earlier year with a figure*, not literally year−1.
- **Home's "DIV" upcoming-strip reminder** (see the Home section above) fires per calendar month, per
  stock, only when that stock has historically paid in this month **and** nothing is logged against
  *this specific month* yet (`isMonthPending` — deliberately per-month rather than per-year, since a
  quarterly payer would otherwise vanish from reminders for the rest of the year after its first
  payout). India and US produce **separate** reminder cards.
- **Excluded from Home's Total Invested/Earned** — same treatment class as Emergency Fund holdings and
  Bank Savings: the money is reported on one surface only.

## Personal Finance (Home card)

The user's own Card/UPI spend, deliberately kept separate from the household Tracker. Lives entirely
in `app.js` (no dedicated module). See [personal-finance.md](personal-finance.md) for the full design
— data model (`personalSpends`, v16), the Spends/Limits/Review/Card check/Tags tabs, how a Card
allowance is read live from the Allocation tab, and how it reconciles against the Credit Card tab
without ever writing back to it.

## Health Check (Home card)

Family medical records — people, user-editable parameters with gender-specific reference ranges,
trend graphs, a Family Health comparison table. `health.js` (lazy-loaded). See
[health-check.md](health-check.md) for the full design and **a real backup gap**: `healthPeople` /
`healthChecks` / `healthParams` are not yet in `exportAll()`/`importAll()`, so folder-based Backup &
Restore currently drops all Health Check data.

## My Passwords / Vault (Home card)

An encrypted password manager with its own master password, independent of the App Lock PIN.
`vault.js` (lazy-loaded). See [vault.md](vault.md) for the full design — AES-GCM + PBKDF2 (200k
iterations), the never-stored key, the auto-relock-on-backgrounding behaviour, and why the master
password is unrecoverable by design.

## Expense section (💳 Home card)

Five tabs on `#expBottomNav`: **Credit Card | Expense | Tracker | Review | Allocation**. The **+** FAB
appears on Credit Card (add a card) and Tracker (add a household spend) only. See
[expense.md](expense.md) for the full design of all five tabs — this section covers Credit Card in
depth since it predates the others; Allocation, the Expense sheet, the Tracker (with its insights
panel and All-Months heatmap) and Review are documented there instead of here.

### Credit Card tab

Reproduces the source sheet's `credit` tab (columns A:AB — the label column plus 27 months). See
`credit.js` for the record shape and the math.

- **Add a card**: name, issuing bank (free text + datalist of common Indian issuers), optional credit
  limit, billing-cycle start/end day, notes. Tap a card to edit or delete it.
- **Per-card month ledger** on the form's **Months** tab (`buildCcMonthEditor`): one row per statement
  month — a **Billed ₹** figure and a status dropdown (**Unpaid / Ontime / Late Payment**), not a typed
  "paid ₹" amount. `paidOn` stamps automatically the moment status first moves off Unpaid. `+ Add
  month` pre-fills the month after the newest one logged, so filling a card in needs no date typing.
  Duplicate months are deduped last-wins by `normaliseMonths()`; fully-empty rows are dropped rather
  than creating a phantom month.
- **Reimbursement is a single combined figure per MONTH, not per card** (`ccReimbursements` store, v13,
  keyed by `ym`) — set once below the card list, shared across every card billed that month. It
  represents household/personal spend logged elsewhere that will come back as a credit, which was
  never naturally splittable by card in the first place; it can be auto-derived from what's actually
  logged against cards that month, or overridden by hand (`_reimbMap` — a typed figure always wins
  over the derived one, "since a correction that a recount quietly undid would be worthless").
- **`toBePaid = billed − reimbursed`** (`credit.js`'s `computeCredit`), floored at zero. "vs last
  month" (`m.diff`) compares **To be paid** against the previous *entry in the series*, not the raw
  billed total and not the previous calendar month — a reimbursement changes what's actually still
  owed, so that's the figure that should move. Colours are **deliberately inverted** vs. the rest of
  the app: a falling bill is the good direction, so down is green.
- **Month-by-month grid**: one row per card, one column per month (billed figure, struck through once
  marked Ontime/Late — red-tinted if Late), with **Total / To be paid** summary rows underneath, the
  latter heat-coloured and bold-green once every card billed that month has a status set. Scrolls
  horizontally with a sticky first column (reuses the Heatmap's `.heatmap-scroll` mechanics); 27 months
  can't fit a phone screen and shrinking them would make the figures unreadable.
- **Summary grid** above the cards: Cards count, **Avg / month** (`g.averagePerMonth` — the average
  *To be paid* across every month any card has billed or been reimbursed; this already answers "what
  does the wallet cost in a typical month," see [expense.md](expense.md)), Total billed, Total
  reimbursed.
- **Utilisation** per card = latest statement ÷ credit limit. A card with no limit on record gets
  **no badge** rather than a misleading 0%.
- **Nothing here counts toward Home's Total Invested** — card bills are money going out.
- Own `creditCards` IndexedDB store (v11), in `exportAll`/`importAll` for backup. Stored per-card with
  its own `months[]` array rather than column-per-month, so a new month never needs a schema change.

## App lock

See [app-lock.md](app-lock.md) for details. Summary:
- 4-digit PIN (SHA-256 + per-device salt), stored in `meta.lockConfig`.
- Optional biometric via WebAuthn platform authenticator (fingerprint/Face/Windows Hello).
- Full-screen lock overlay on app open, with on-screen numeric keypad, dot indicator, shake-on-wrong-PIN.
- Setup wizard (PIN → confirm → biometric? → done).
- Settings sheet (Change PIN, Toggle biometric, Disable lock).
- "Forgot PIN" → wipe-and-reload recovery.
- Data load is **gated behind unlock** — `refresh()` runs only after `showLockScreen()` resolves.

## What's deliberately NOT here

These came up in conversation and the user explicitly deferred or rejected them:

- **Live prices / market data APIs** — "let it be offline".
- **Multi-broker per portfolio** — each portfolio is one broker; that's why OCR dispatch is per-portfolio.
- **Tax reports** — deferred but on the radar; see [future.md](future.md).
- **Native APK** — PWA only; explicitly re-deferred by the user on 2026-09-15 ("leave it as of now") when asked whether to scaffold one — if it comes up again, Android Studio was the discussed toolchain (bundles JDK+SDK+Gradle) over a headless install, since the machine had no prior Android/JVM tooling.

Two items that were on this list have since been **built** and now have their own docs — remove them from any future "not built" mental model: **Mutual funds as a separate concept** (now the `funds` store + its own surface, see [mutual-funds.md](mutual-funds.md)) and **Dividends** (see the Dividends section above).
