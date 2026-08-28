# Features Built

This is the inventory. Each entry: **what** + **where** + **why it's that way**. Don't re-implement; if the user asks for a behavior in here, point them at the existing path.

## Home screen

- **Hero + summary** (Total Invested / Total Earned, with the ⓘ breakdown sheet), then the three
  section cards: **Investment · Savings · Expense**.
- **⏰ Maturing this week** — a horizontally-scrolling strip of FD maturity reminders, sitting between
  the summary and the section cards. `_homeFdMaturityStrip()` in app.js.
  - Shows any **active** FD maturing within `FD_SOON_DAYS` (7), soonest first, with **days left**, the
    **maturity amount**, the maturity date, and an EF badge where applicable. Tap one to open that FD.
  - Cards inside 2 days get a **warn-coloured** left accent; the rest use the accent colour.
  - Maturity amounts come from `resolveChain()`, not `computeFd()` — an FD funded by rolled-in matured
    parents has a larger effective deposit, so the chain is the only way to get its payout right.
  - **Renders nothing at all when nothing is due** — no empty heading.
  - **Deliberately includes Emergency-Fund-linked FDs.** Linking a record removes it from a page's
    *totals*, never from its *listings* (it keeps its EF badge on the FD page). "Cash arrives Thursday"
    is an action reminder, not a total, so it matters regardless of which surface counts the money.
  - An FD maturing **today** does *not* appear: `fd.js` derives status purely from the date and treats
    maturity day itself as already `matured`, so it moves to the FD page's Matured bucket instead. The
    user was already warned the previous day as "Tomorrow", so `daysToMaturity` is always ≥ 1 here.
  - Scrolls inside its own rail with scroll-snap (same technique as `.portfolio-tabs`), so the page body
    never scrolls sideways. Verified at 375px.

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

- **🛟 Emergency Fund** card on Home (under the Savings section). Tabs: **Funds | Targets | Loans | Log | Rules**. The **+** FAB is hidden on Funds and Rules (nothing to add on either — link a holding from its own form instead) and shown on the other three.
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

## Expense section (3rd Home section)

Tabs on `#expBottomNav`: **Credit Card | Allocation | Expense**. The **+** FAB only appears on Credit
Card (adding a card is the only add-action here). Allocation and Expense are placeholders for now.

### Credit Card tab

Reproduces the source sheet's `credit` tab (columns A:AB — the label column plus 27 months). See
`credit.js` for the record shape and the math.

- **Add a card**: name, issuing bank (free text + datalist of common Indian issuers), optional credit
  limit, notes. Tap a card to edit or delete it.
- **Per-card month ledger** on the form's **Months** tab: one row per statement month with **Billed**
  (statement total) and **Paid** (what actually left the account). `+ Add month` pre-fills the month
  after the newest one logged, so filling a card in needs no date typing. Duplicate months are deduped
  last-wins by `normaliseMonths()`; fully-empty rows are dropped rather than creating a phantom month.
- **Billed vs Paid are tracked separately on purpose** — a statement total is *not* what leaves the
  bank that month (EMIs, partial payments, carried balances), and the source sheet's own "to be PAID"
  row is visibly ≠ its "Total" row. Outstanding is then derived, not guessed.
- **Month-by-month grid**: one row per card, one column per month, with **Total / vs last month / Paid
  / To be paid** summary rows underneath — the same four the sheet carries. Scrolls horizontally inside
  its own container with a sticky first column (reuses the Heatmap's `.heatmap-scroll` mechanics); 27
  months can't fit a phone screen and shrinking them would make the figures unreadable.
- **"vs last month"** compares against the previous month *that has data*, not the previous calendar
  month — a gap month would otherwise show the whole total as a spending spike that never happened.
  Colours are **deliberately inverted** vs. the rest of the app: a falling card bill is the good
  direction, so down is green.
- **Utilisation badge** per card = latest statement ÷ credit limit, warn-coloured at ≥30% (the point it
  starts affecting a credit score). A card with no limit on record gets **no badge** rather than a
  misleading 0%.
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
- **Mutual funds as a separate concept** — currently lives inside the same `stocks` store (e.g. "SBI MF - SBI Gol" in wife's Groww). No special MF handling.
- **Dividends** — deferred ("leave those for now").
- **Tax reports** — deferred but on the radar; see [future.md](future.md).
- **Native APK** — PWA only.
