# MyNote Stocks

Private, offline-first stock portfolio tracker served by Apache from:

`C:\Apache24\htdocs\mynote\`

Local URL:

`http://localhost/mynote/`

## What it tracks

- Me - India
- Wife - India
- Me - US

All app data lives in browser IndexedDB on the device. There is no backend, no cloud sync, and no live-price API. Prices are entered manually or updated through broker screenshot OCR.

## Main features

- Holdings, Heatmap, Trend, Overview, and Feed tabs.
- OCR updates from Zerodha, Groww, and INDmoney screenshots.
- Month-end snapshot reminder during the final 7 days of each month.
- Stale price indicator on holding cards after 30 days without a price update.
- Portfolio health score in Overview based on freshness, price coverage, concentration, sector exposure, and conviction flags.
- Folder-based Backup & Restore with legacy export/import fallback.
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

Start with `docs/README.md`. The most useful files are:

- `docs/context.md`
- `docs/architecture.md`
- `docs/features.md`
- `docs/ocr.md`
- `docs/backup.md`
- `docs/feed.md`
- `docs/gotchas.md`
- `docs/future.md`
