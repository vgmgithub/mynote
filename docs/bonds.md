# Bonds

A fourth surface inside the same PWA for tracking retail bonds (fixed-coupon debt instruments outside the FD ladder). Modelled on the user's X-MyNotes Google Sheet "BOND" tab (14th sheet). The Stocks + Mutual Funds + Fixed Deposits + Metals surfaces are untouched.

## Home launcher

The Home screen shows a **Bonds** card (🧾) after Dividends. Subtext: `{N} active · ₹{invested}` where `{N}` = bonds not yet matured/withdrawn and `₹{invested}` = Σ active bonds' `investAmount`. `setAppMode('bond')` shows/hides the Bonds surface + its own bottom nav + `#bondAddBtn`, exactly like FD/Metals.

- **Home Total Invested / Total Earned** folds in only **matured or withdrawn** bonds — active bonds are still-locked capital, tracked in the Bonds surface's own Overview totals, not Home's aggregate. Same rationale as Fixed Deposits (see [fixed-deposits.md](fixed-deposits.md)).

## Files

- **`bonds.js`** — pure logic, lazy-loaded (`import('./bonds.js')`). Exports `computeBond(bond, nowMs)`, `addMonths(iso, months)`, `BOND_RATINGS`, `BOND_PAYOUT`, and the one-time seed `SEED_BONDS`. No DOM, no IO.
- **`app.js`** — `buildBondBottomNav`, `openBond` (seed-on-first-open), `renderBond`, `_bondCard`, `openBondForm`; `setAppMode` handles the `'bond'` mode; `renderHome` adds the Bonds card + subtext + totals.
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
  payout,                 // 'cumulative' (compounds annually) | 'payout' (simple interest, paid out)
  withdrawAmount, withdrawDate,  // set when redeemed (early exit or at maturity) — actual realized amount, overrides projected accrual
  notes, createdAt, updatedAt,
}
```

There is **no reinvestment-chain concept** (unlike FD's `parentFdIds`) — bonds in this app don't ladder/merge the way the user's FDs do. There is also **no compounding-frequency picker** like FD's (quarterly/monthly/etc.) — retail bonds don't offer that; `cumulative` compounds annually, `payout` pays simple interest out periodically.

Everything financial is **derived** (never stored → no drift) by `computeBond`:
- **Day-count**: a single convention (exclusive day-count over a 365.25-day year) — unlike `fd.js`'s dual convention, there's no real bond data yet to tune a second convention against.
- **Maturity value**: `payout` → `P·(1 + rate·years/100)` (simple); `cumulative` → `P·(1+rate/100)^years` (compounds annually).
- **Current/accrued value**: same formula using elapsed years, clamped to tenure once matured.
- **`effectiveStatus`**: `withdrawn` (if `withdrawAmount` set) > `matured` (past maturity date) > `active`. Fully derived; nothing manual.
- **`vsBank`**: when `bankRate` is set, compares the bond's own interest (realized if withdrawn, else accrued-to-date) against what the same principal would have earned at `bankRate` (simple interest) over the same elapsed period. `null` when `bankRate` is blank — the comparison is entirely optional.

## UI (renderBond → `#bondView`, reuses stock/MF/FD CSS classes)

- **Bottom nav** (`#bondBottomNav`) — **Bonds | Overview** (`_bondTab`), a fourth fixed bottom nav built once (`buildBondBottomNav`). No Ladder tab (see "Not built" below).
- **Bonds (holdings)** — filter `Active | Matured | Withdrawn | All` (live counts) + sort `Maturity | Amount | Rate` + the bond card list. Each card: name, rating · rate · type (cumulative/payout), status badge, interest headline (labelled "realized" when withdrawn), invested, maturity date + days-to-maturity, maturity value, and a small "±₹X vs bank" line when `bankRate` is set.
- **Overview** — summary card (*Active invested* / *Interest to earn* / *Interest realized* [matured + withdrawn] / *Return %* [not annualized, same caveat as FD] / *vs Bank* total / *Active bonds*) + **Allocation by rating** (`.bar-row`) + **Next maturity**.
- **`openBondForm`** — a single-content sheet (`.sheet.has-fixed-footer`, no tabs — no Chain tab like FD's since there's no reinvestment-chain feature): name, rating (text + datalist), coupon rate, bank rate (optional), start/maturity dates, a tenure-months → fills-maturity-date helper (`addMonths`), type (cumulative/payout), withdrawn amount/date (always visible, not gated behind a toggle — matches FD's sold fields), notes, and a live readout (Tenure/Maturity/Interest, recomputed on every input change via `computeBond`). Footer: Save / Delete (edit only) / Cancel.

## Seeding (once)

`openBond` seeds the **3 real bonds** from the sheet's BOND tab on first open, guarded by `meta.bondsSeeded` (only seeds an empty store — never overwrites real data, matching the Metals/MF seeding precedent):

| name | rating | investAmount | rate | bankRate | startDate → maturityDate |
|---|---|---|---|---|---|
| U FRO-2 Aug'25 | A+ | 5961 | 11.50% | 5.80% | 2025-08-01 → 2026-03-01 (7mo) |
| Wint Capital | BBB- | 10044.49 | 11.75% | 6.60% | 2026-04-01 → 2027-11-01 (19mo) |
| Moothoot | BBB | 5978 | 10.50% | 6.00% | 2026-05-01 → 2027-02-01 (9mo) |

Start dates are **approximate** — the sheet only gives month+year (e.g. "Aug 25"), defaulted to the 1st of the stated month. The user can correct exact dates via Edit.

**U FRO-2 Aug'25 caveat**: the sheet shows this bond as already exited (`Withdraw: 6000`), but that figure doesn't reconcile cleanly against the sheet's own `Int Amount: 6321.3`, and the exact exit date isn't recorded — so it's seeded **without** a `withdrawAmount` (shows as `matured`, interest still computing from the coupon rate) rather than guessing a wrong realized figure. The user can fill in the real exit details via Edit.

## Backup

`bonds` is in `DB.exportAll()`/`importAll()` (best-effort `.catch`, like `feed`/`funds`/`metals`), so the existing folder-based backup carries bond data with no change to `backup.js`.

## Not built (yet)

- **No reinvestment chain / Ladder tab** — unlike FD, bonds here don't merge/roll into new bonds, so there's no `parentFdIds`-equivalent, no Chain tab, and no Ladder view. Revisit if the user starts reinvesting matured bond proceeds into new ones.
- **No dual day-count convention** — `fd.js` tuned two conventions (exclusive/365.25 vs inclusive/365) against real FD data; `bonds.js` uses one (exclusive/365.25) since there's no real bond maturity data yet to tune a second against.
- **No online rating/price fetch** — bonds are fixed at purchase (like FDs), so there's nothing live to pull. All manual.
- No wife split (owner field reserved, mirrors MF/FD).
