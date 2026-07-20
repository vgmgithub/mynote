# Bonds

A fourth surface inside the same PWA for tracking retail bonds (fixed-coupon debt instruments outside the FD ladder). Modelled on the user's X-MyNotes Google Sheet "BOND" tab (14th sheet). The Stocks + Mutual Funds + Fixed Deposits + Metals surfaces are untouched.

## Home launcher

The Home screen shows a **Bonds** card (🧾) after Dividends. Subtext: `{N} active · ₹{invested}` where `{N}` = bonds not yet matured and `₹{invested}` = Σ active bonds' `investAmount`. `setAppMode('bond')` shows/hides the Bonds surface + its own bottom nav + `#bondAddBtn`, exactly like FD/Metals.

- **Home Total Invested / Total Earned** folds in only **matured** bonds — active bonds are still-locked capital, tracked in the Bonds surface's own Overview totals, not Home's aggregate. Same rationale as Fixed Deposits (see [fixed-deposits.md](fixed-deposits.md)). The value side uses `principal + interestEarned` — the real logged-payout total once any exist, else the coupon-rate projection (see below).

## Files

- **`bonds.js`** — pure logic, lazy-loaded (`import('./bonds.js')`). Exports `computeBond(bond, nowMs)`, `addMonths(iso, months)`, `BOND_RATINGS`, `BOND_PAYOUT`, and the one-time seed `SEED_BONDS`. No DOM, no IO.
- **`app.js`** — `buildBondBottomNav`, `openBond` (seed-on-first-open), `renderBond`, `_bondCard`, `buildPayoutEditor` (the Payouts-tab ledger widget), `openBondForm`; `setAppMode` handles the `'bond'` mode; `renderHome` adds the Bonds card + subtext + totals.
- **`db.js`** — `bonds` store (v8) + folded into `exportAll`/`importAll` (best-effort `.catch`, like `feed`/`funds`/`metals`), so backup carries bond data with no change to `backup.js`.

## Data model — `bonds` store (IndexedDB v8)

Key `id` (auto-increment), index `owner` (`'me'`).

```js
{
  id, owner: 'me',
  name,                  // bond/issuer name, free text (e.g. "U FRO-2 Aug'25")
  rating,                 // credit rating, free text + datalist (AAA…D, Unrated)
  investAmount,           // ₹ principal
  rate,                   // annual coupon %
  bankRate,               // comparable bank/FD rate % for the "vs Bank" comparison (optional, blank = skip comparison)
  startDate, maturityDate,   // 'YYYY-MM-DD'
  payout,                 // 'cumulative' (compounds annually, value grows in place) | 'payout' (deposit value stays flat at principal; coupon is real cash tracked in `payouts`)
  maturityAmount,          // optional ₹ — the actual/promised amount you'll receive at maturity (from the term sheet). Overrides the rate-based projection when set
  payouts: [{ date, amount }],  // dated log of interest/coupon actually received — becomes the real "interest earned" figure once any entry exists
  createdAt, updatedAt,
}
```

There is **no reinvestment-chain concept** (unlike FD's `parentFdIds`) — bonds in this app don't ladder/merge the way the user's FDs do. There is also **no compounding-frequency picker** like FD's (quarterly/monthly/etc.) — retail bonds don't offer that. There is **no `notes` field and no `withdrawAmount`/`withdrawDate`** (removed at the user's request — early exit is just logged as a final payout entry, or the bond is deleted).

Everything financial is **derived** (never stored → no drift) by `computeBond`:
- **Day-count**: a single convention (exclusive day-count over a 365.25-day year) — unlike `fd.js`'s dual convention, there's no real bond data yet to tune a second convention against.
- **Projected maturity value**: an entered `maturityAmount` always wins (it's real data from the term sheet). Absent that, projects from `rate`: `payout` → `P·(1 + rate·years/100)` (simple — each coupon paid out, not reinvested); `cumulative` → `P·(1+rate/100)^years` (compounds annually).
- **`currentValue`** (the deposit's own value, not the interest): `payout` bonds stay flat at `P` (the coupon is paid out as cash, tracked separately in `payouts`); `cumulative` bonds grow in place (`P + projectedAccrued`).
- **`interestEarned`** — the headline figure. Once the bond has **any** logged `payouts` entry, `payoutsTotal` (the real Σ received) is authoritative; otherwise falls back to the projection (`totalInterest` once matured, the pro-rated `projectedAccrued` while active).
- **`basis`** — a human-readable string (e.g. `"simple interest at 11.5% p.a."` or `"entered maturity amount (₹6,500)"`) explaining what produced the projected figures. Surfaced directly on each bond card and in the form's live readout — "how is this calculated" is never a mystery.
- **`effectiveStatus`**: `matured` (past maturity date) or `active`. Fully date-derived, same as FD — no separate "withdrawn" state.
- **`vsBank`**: when `bankRate` is set, compares `interestEarned` against what the same principal would have earned at `bankRate` (simple interest) over the same elapsed period. `null` when `bankRate` is blank.

## UI (renderBond → `#bondView`, reuses stock/MF/FD CSS classes)

- **Bottom nav** (`#bondBottomNav`) — **Bonds | Overview** (`_bondTab`), a fourth fixed bottom nav built once (`buildBondBottomNav`). No Ladder tab (see "Not built" below).
- **Bonds (holdings)** — filter `Active | Matured | All` (live counts) + sort `Maturity | Amount | Rate` + the bond card list. Each card: name, rating · rate · type, status badge, an interest figure (matured bonds show **both** the projected `totalInterest` and the real `interestEarned` on separate lines; active bonds show one `projectedAccrued` figure labelled "(est.)"), invested, maturity date + days-to-maturity, maturity value, a **"Basis: …"** line explaining the calculation, a "₹X received · N payouts" line once any are logged, and a "±₹X vs bank" line when `bankRate` is set.
- **Overview** — summary card (*Active invested* / *Interest to earn* [active, projected] / *Interest earned* [matured, real-or-projected] / *Received to date* [Σ actual payouts across every bond] / *Return %* / *vs Bank* total) + **Allocation by rating** (`.bar-row`) + **Next maturity**.
- **`openBondForm`** — a **two-tab sheet** (`.sheet.has-fixed-footer`, mirrors FD's Details/Chain shape):
  - **Details** — name, rating (text + datalist), coupon rate, bank rate (optional), start/maturity dates, a tenure-months → fills-maturity-date helper (`addMonths`), type (cumulative/payout), **maturity amount** (optional override), and a live readout (Tenure/Maturity/Interest + the "Basis: …" explanation, recomputed on every input change via `computeBond`).
  - **Payouts** (`buildPayoutEditor`) — a dated ledger: each row is **date + ₹ amount received**, with **+ Add payout** (defaults the new row's date to one month after the last one logged) and a running "N payouts · Received ₹X" summary. Mirrors `buildContribEditor`'s (Mutual Funds) add/remove/summary shape, simplified to a single list — no buy/sell split, no derived third field.
  - Footer: Save / Delete (edit only) / Cancel.

## Seeding (once)

`openBond` seeds the **3 real bonds** from the sheet's BOND tab on first open, guarded by `meta.bondsSeeded` (only seeds an empty store — never overwrites real data, matching the Metals/MF seeding precedent). No `payouts` are seeded — the sheet's own payout-schedule sub-table mixes "promised" and "actual" figures ambiguously, so real entries are left for the user to log via the Payouts tab:

| name | rating | investAmount | rate | bankRate | startDate → maturityDate |
|---|---|---|---|---|---|
| U FRO-2 Aug'25 | A+ | 5961 | 11.50% | 5.80% | 2025-08-01 → 2026-03-01 (7mo) |
| Wint Capital | BBB- | 10044.49 | 11.75% | 6.60% | 2026-04-01 → 2027-11-01 (19mo) |
| Moothoot | BBB | 5978 | 10.50% | 6.00% | 2026-05-01 → 2027-02-01 (9mo) |

Start dates are **approximate** — the sheet only gives month+year (e.g. "Aug 25"), defaulted to the 1st of the stated month. The user can correct exact dates via Edit, and log real payouts via the Payouts tab.

## Backup

`bonds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch`, like `feed`/`funds`/`metals`), so the existing folder-based backup carries bond data (including the `payouts` ledger) with no change to `backup.js`.

## Not built (yet)

- **No reinvestment chain / Ladder tab** — unlike FD, bonds here don't merge/roll into new bonds, so there's no `parentFdIds`-equivalent, no Chain tab, and no Ladder view. Revisit if the user starts reinvesting matured bond proceeds into new ones.
- **No dual day-count convention** — `fd.js` tuned two conventions (exclusive/365.25 vs inclusive/365) against real FD data; `bonds.js` uses one (exclusive/365.25) since there's no real bond maturity data yet to tune a second against.
- **No online rating/price fetch** — bonds are fixed at purchase (like FDs), so there's nothing live to pull. All manual.
- No wife split (owner field reserved, mirrors MF/FD).
