# MyNotes

Private, offline-first personal-finance PWA served by Apache from:

`C:\Apache24\htdocs\mynote\`

Local URL:

`http://localhost/mynote/`

## What it is

Started as a stock portfolio tracker (Me - India, Wife - India, Me - US) and has grown into the user's primary personal-finance app. Home now opens six sections: **Investment** (Stocks/Mutual Funds/Fixed Deposits/Metals/Bonds/Dividends), **Savings** (Emergency Fund/Bank Savings), **Expense** (Credit Card/Allocation/Tracker/Review), **Personal Finance** (own Card/UPI spend), **Health Check** (family medical records), and **My Passwords** (an encrypted vault).

All app data lives in browser IndexedDB on the device. There is no backend and no cloud sync. The only network calls are opt-in and narrow: stock names to Marketaux for news, fund names to mfapi.in for free mutual-fund NAV. Everything else is entered manually or updated through broker-screenshot OCR.

## Main features

- Stocks: Holdings, Heatmap, Trend, Overview, and Feed tabs; OCR updates from Zerodha, Groww, and INDmoney screenshots.
- Mutual Funds, Fixed Deposits, Bonds, Metals, Dividends — each its own surface with its own math (XIRR, amortization schedules, ladders).
- Emergency Fund — a family lending pot with a written interest-rate rulebook.
- Expense section — Credit Card ledger, an annual Allocation plan, a monthly Expense sheet, a household spend Tracker (with an insights panel), and a current-month Review/forecast.
- Personal Finance — the user's own Card/UPI spend, tracked separately from household spend.
- Health Check — family medical records: people, custom parameters with gender-specific reference ranges, trend graphs, a Family Health comparison table.
- My Passwords — an encrypted, PIN/biometric-gated password vault.
- Month-end snapshot reminder during the final 7 days of each month.
- Stale price indicator on holding cards after 30 days without a price update.
- Portfolio health score in Overview based on freshness, price coverage, concentration, sector exposure, and conviction flags.
- Folder-based Backup & Restore with legacy export/import fallback. **Known gap: Health Check data is not yet included** — see `docs/health-check.md`.
- 4-digit app lock with optional biometric unlock.
- PWA install support and offline service worker cache.
- Feed tab with Marketaux news sentiment and offline recommendation logic.

## Important workflow

1. Update prices manually or with OCR.
2. Capture the monthly snapshot near month end.
3. Keep local backups current through Menu -> Backup & Restore.
4. After code changes, bump `CACHE` in `service-worker.js`.
5. In the browser, use Menu -> Check for updates to apply a new version.

## Docs

Start with `docs/README.md` — it lists every doc in reading order. Most useful:

- `docs/context.md`, `docs/architecture.md`, `docs/features.md`
- `docs/expense.md`, `docs/health-check.md`, `docs/emergency-fund.md`
- `docs/ocr.md`, `docs/backup.md`, `docs/feed.md`
- `docs/gotchas.md`, `docs/future.md`
