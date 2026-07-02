# Features Built

This is the inventory. Each entry: **what** + **where** + **why it's that way**. Don't re-implement; if the user asks for a behavior in here, point them at the existing path.

## Navigation

- **Portfolio tabs** (top): Me · India / Wife · India / Me · US — in this order. `buildChrome()` in app.js.
- **Bottom nav**: Holdings · Heatmap · Trend · Overview. The labels were renamed (Monthly → Trend, Trends → Overview) by user request.
- **Filter chips** (Holdings tab): Holding · Sold · All — in that order. **Default is Holding** (not All). Set via `state.filter = 'holding'` initial value.

## Holdings tab

- **Tri-state sort buttons** (Name / Return % / Value): default → primary (DESC) → secondary (ASC) → default. Multi-tap cycle.
- **Sort always puts holdings before sold** (status-primary, then field-secondary). Single sort applies across the unified list.
- **Search box**: filters by name OR category.
- **Per-stock card**: shows current value, overall return %, invested, units, latest monthly change. Sold cards show realized P&L instead.
- **Stale price indicator**: active holdings with a current price show how many days ago the price was updated. At 30+ days the line turns warning-colored.
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
- Tap a point on mobile to show details (SVG `<title>` only triggers on hover, so we added a click handler + `.chart-info` div).

## Overview tab (was "Trends")

- Per-portfolio summary cards.
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
