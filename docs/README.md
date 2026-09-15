# MyNotes — Documentation

This folder exists so a fresh chat session can pick up where the last one left off without re-litigating decisions or re-discovering hard-won gotchas.

## Read in this order

1. **[context.md](context.md)** — who the user is, what we're building, hard constraints. Start here every time.
2. **[architecture.md](architecture.md)** — files, modules, IndexedDB schema, how the app is wired together.
3. **[features.md](features.md)** — what's already built. Don't re-implement these.
4. **[ocr.md](ocr.md)** — the OCR system is the most intricate part; read this before touching `ocr.js` or the review modal.
5. **[app-lock.md](app-lock.md)** — PIN + biometric lock implementation details.
6. **[backup.md](backup.md)** — folder-based backup & restore via File System Access API. **Note:** Health Check data is currently NOT covered by it — see [health-check.md](health-check.md).
7. **[feed.md](feed.md)** — Feed & Recommendations tab (Marketaux news + offline recommendation engine).
8. **[mutual-funds.md](mutual-funds.md)** — Home launcher (Stocks / Mutual Funds) + the Mutual Funds surface (XIRR, sold funds, seeding). The Stocks app is untouched.
9. **[fixed-deposits.md](fixed-deposits.md)** — the Fixed Deposits surface (FD ladder: maturity/interest calc, FDs/Overview/Ladder tabs).
10. **[bonds.md](bonds.md)** — the Bonds surface (retail bonds: coupon/maturity calc, Bonds/Overview tabs).
11. **[emergency-fund.md](emergency-fund.md)** — the family lending pot: contributions, targets ladder, loan interest rules.
12. **[expense.md](expense.md)** — the Expense section: Credit Card, Allocation, the Expense sheet, the household Tracker, Review/forecast.
13. **[health-check.md](health-check.md)** — family medical records: people/parameters, avatars, trend graphs, Family Health table — and the backup gap above.
14. **[gotchas.md](gotchas.md)** — bugs that cost real time. Read before debugging "the app isn't updating" — it's almost always cache.
15. **[future.md](future.md)** — discussed but not built. Don't pick these up unprompted; user has views on each.

## Project at a glance

- **What:** A private, offline-first personal-finance PWA. What started as a stock tracker has grown into the user's primary money app. A Home launcher opens six section cards:
  - **💼 Investment** — Stocks (3 portfolios: Me·India, Wife·India, Me·US — monthly returns, heatmap, insights, OCR price updates, news Feed), Mutual Funds (SIP/XIRR), Fixed Deposits (ladder), Metals (gold/silver ledger), Bonds (coupon/maturity), Dividends.
  - **🏦 Savings** — Emergency Fund (family lending pot with an interest rulebook), Bank Savings.
  - **💳 Expense** — Credit Card, Allocation (annual plan), the Expense sheet, the household spend Tracker, Review (forecast). See [expense.md](expense.md).
  - **👛 Personal Finance** — the user's own Card/UPI spend, kept deliberately separate from household spending.
  - **🩺 Health Check** — family medical records. See [health-check.md](health-check.md).
  - **🔐 My Passwords** — an encrypted, PIN/biometric-gated password vault.

  Shared ⋮ menu + backup across all six.
- **Where it runs:** Apache on the user's Windows 11 laptop at `http://localhost/mynote/`. Same code installs as a PWA on their Android phone.
- **Data:** IndexedDB only. Nothing ever leaves the device (two narrow exceptions, both opt-in and name-only: stock names to Marketaux for news, fund names to mfapi.in for NAV).
- **No paid APIs.** No live prices except free mutual-fund NAV. Everything else is manually entered or OCR-ed from broker screenshots.
- **Target lifespan:** 10+ years of data, must stay fast on phone.

## How to verify changes

The app is **served by Apache**, not a Node dev server. There's no preview server to start. Verification happens in the user's own browser at `localhost/mynote/`. If you make changes and they don't appear, read [gotchas.md → Service worker stale cache](gotchas.md#service-worker-stale-cache) — *do not* assume your edit didn't land.

## SW version cadence

Every code change bumps `CACHE = 'mynote-stocks-vNN'` in `service-worker.js`. Current version after adding the Tracker's "apart from Rent" average (see [expense.md](expense.md)): **v442**. The next change should be v443. (IndexedDB schema is a separate version, currently v19 — see [architecture.md](architecture.md#indexeddb-schema).)

**Updates are user-triggered (v44+).** New versions are detected in the background but only applied when the user taps **Menu → "Check for updates"**. No more cache flushes, no more surprise reloads. See [gotchas.md → Service worker updates](gotchas.md#service-worker-updates--user-triggered-v44).
