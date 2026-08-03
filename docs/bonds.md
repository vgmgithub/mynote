# Bonds

A fourth surface inside the same PWA for tracking retail bonds (fixed-coupon debt instruments outside the FD ladder). Modelled on the user's X-MyNotes Google Sheet "BOND" tab (14th sheet). The Stocks + Mutual Funds + Fixed Deposits + Metals surfaces are untouched.

## Home launcher

The Home screen shows a **Bonds** card (🧾) after Dividends. Subtext: `{N} active · ₹{invested}` where `{N}` = bonds not yet matured and `₹{invested}` = Σ active bonds' `investAmount`. `setAppMode('bond')` shows/hides the Bonds surface + its own bottom nav + `#bondAddBtn`, exactly like FD/Metals.

- **Home Total Invested / Total Earned** — a DIFFERENT basis from Fixed Deposits (see [fixed-deposits.md](fixed-deposits.md)), deliberately: invested = **active** bond principal (still-live capital), earned = **realised interest from closed (matured + sold) bonds only** — an active bond's accrued-but-unpaid interest never counts. Matured/sold principal has been returned, so it's no longer "invested" once it's back; an active bond's principal genuinely still is. The row's Return % is suppressed (`—`) since Invested and Earned describe different bonds — a ratio between them isn't a real return. See `homeInvestedBreakdown()` in `app.js`.

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
  soldDate,                // 'YYYY-MM-DD' — set = exited early (or redeemed at/after maturity via the sold toggle instead of just letting it age out)
  soldAmount,              // ₹ TOTAL credited on exit, INCLUDING principal — never just the gain/loss
  createdAt, updatedAt,
}
```

There is **no reinvestment-chain concept** (unlike FD's `parentFdIds`) — bonds in this app don't ladder/merge the way the user's FDs do. There is also **no compounding-frequency picker** like FD's (quarterly/monthly/etc.) — retail bonds don't offer that. There is **no `notes` field**.

Early exit used to have no dedicated fields — the guidance was "just log a final payout entry, or delete the bond". That turned out to be actively wrong advice once Home started using realised interest: a payout row recording the sale proceeds and a naive `interestEarned` formula would double-count the principal. `soldDate`/`soldAmount` now make exit first-class (see `isSold` below), and `computeBond` explicitly excludes any payout dated on/after the sale from "extra interest" so the old advice's leftover data doesn't silently break the new math.

Everything financial is **derived** (never stored → no drift) by `computeBond`:
- **Day-count**: a single convention (exclusive day-count over a 365.25-day year) — unlike `fd.js`'s dual convention, there's no real bond data yet to tune a second convention against.
- **Projected maturity value**: an entered `maturityAmount` always wins (it's real data from the term sheet). Absent that, projects from `rate`: `payout` → `P·(1 + rate·years/100)` (simple — each coupon paid out, not reinvested); `cumulative` → `P·(1+rate/100)^years` (compounds annually).
- **`currentValue`** (the deposit's own value, not the interest): `payout` bonds stay flat at `P` (the coupon is paid out as cash, tracked separately in `payouts`); `cumulative` bonds grow in place (`P + projectedAccrued`). Freezes at the exit date once sold (see `asOf` below).
- **Sold bonds — `isSold`/`soldGain`/`payoutsBeforeExit`**: `soldGain = soldAmount − principal`. `payoutsBeforeExit` is the payouts ledger total with any row dated **on/after** `soldDate` excluded — that row is the exit itself, not extra interest (`payoutsAfterExit` is the leftover, surfaced as a cleanup nudge in the form). "Elapsed" freezes at `soldDate` (via an internal `asOf`, clamped so a same-day sale never reads as future-dated against UTC `today`) — a bond sold years early stops accruing projected interest it never received, and `vsBank` compares over the period actually held rather than stretched to today.
- **`interestEarned`** — the headline figure. **Sold**: `payoutsBeforeExit + soldGain` — basis-independent (`payout` bonds carry the return through their coupons with `soldGain≈0`; `cumulative` bonds carry it entirely in `soldGain`; a mixed case adds up correctly too). **Not sold**: once the bond has **any** logged `payouts` entry, `payoutsTotal` is authoritative; otherwise the projection (`totalInterest` once matured, the pro-rated `projectedAccrued` while active).
- **`basis`** — a human-readable string (e.g. `"simple interest at 11.5% p.a."`, `"entered maturity amount (₹6,500)"`, or `"sold 2026-06-01 for ₹12,000 (realised) — projection was …"`) explaining what produced the headline figure. Surfaced directly on each bond card and in the form's live readout — "how is this calculated" is never a mystery.
- **`effectiveStatus`**: `'sold'` (soldDate set — wins over the maturity check) → else `'matured'` (past maturity date) → else `'active'`. `pastMaturity` itself stays date-only and does NOT fold in `isSold`, so a bond sold after its own maturity date is `pastMaturity===true` but `effectiveStatus:'sold'` — every filter in the UI keys off `effectiveStatus`, never `pastMaturity`, or it would double-count that bond into both buckets.
- **`vsBank`**: when `bankRate` is set, compares `interestEarned` against what the same principal would have earned at `bankRate` (simple interest) over the same elapsed period — frozen at the exit date for a sold bond, so it stays an apples-to-apples comparison over the period actually held.

## UI (renderBond → `#bondView`, reuses stock/MF/FD CSS classes)

- **Bottom nav** (`#bondBottomNav`) — **Bonds | Overview** (`_bondTab`), a fourth fixed bottom nav built once (`buildBondBottomNav`). No Ladder tab (see "Not built" below).
- **Bonds (holdings)** — filter `Active | Matured / Sold | All` (live counts — the "Matured / Sold" bucket is `effectiveStatus === 'matured'` rows concatenated with `=== 'sold'` rows) + sort `Maturity | Amount | Rate` (sorting by date uses `soldDate || maturity` per row, since a sold bond's real exit date is what happened, not its possibly-still-future maturity date) + the bond card list. Each card: name, rating · rate · type, status badge (`active` good / `sold` warn / `matured` muted), an interest figure — **sold** shows one sign-safe `interestEarned` figure labelled "realised" (can be negative — a loss-making sale); **matured** shows **both** the projected `totalInterest` and the real `interestEarned` on separate lines; **active** shows one `projectedAccrued` figure labelled "(est.)" — invested, a status line (`Sold <date>` / `Matures … · Nd` / `Matured <date>`), a value line (**Received** + actual proceeds for sold, vs **Maturity** + projected value otherwise), a **"Basis: …"** line, a "₹X received · N payouts" line once any are logged, a cleanup warning when a sold bond has payouts dated on/after the sale, and a "±₹X vs bank" line when `bankRate` is set.
- **Overview** — summary card (*Active invested* / *Interest to earn (full tenure)* [active, projected] / *Interest earned (realised)* [matured + sold, sign-safe] / *Coupons received* [Σ actual payouts across every bond — excludes sale proceeds, which are a separate, larger figure on the sold card itself] / *Return %* / *vs Bank* total) + **Allocation by rating** (`.bar-row`) + **Next maturity**.
- **`openBondForm`** — a **two-tab sheet** (`.sheet.has-fixed-footer`, mirrors FD's Details/Chain shape):
  - **Details** — name, rating (text + datalist), coupon rate, bank rate (optional), start/maturity dates, a tenure-months → fills-maturity-date helper (`addMonths`), type (cumulative/payout), **maturity amount** (optional override), a **Sold / redeemed early** toggle (a checkbox switch, not a stored status field — status stays fully date-derived) revealing **Amount received (₹, total incl. principal)** + **Sold on**, and a live readout (Tenure + Maturity-or-Received + Interest-or-Realised, the derived realised-interest arithmetic spelled out once sold, a payouts-after-exit warning, and the "Basis: …" explanation — all recomputed on every input change via `computeBond`). Saving with the toggle on but no amount entered is rejected (the realised figure is derived, never typed, so it can't silently fall back to 0).
  - **Payouts** (`buildPayoutEditor`) — a dated ledger: each row is **date + ₹ amount received**, with **+ Add payout** (defaults the new row's date to one month after the last one logged) and a running "N payouts · Received ₹X" summary. Mirrors `buildContribEditor`'s (Mutual Funds) add/remove/summary shape, simplified to a single list — no buy/sell split, no derived third field. A row dated on/after a bond's `soldDate` is excluded from "interest earned" (see `payoutsBeforeExit`) — it's the sale itself, not extra interest.
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
- **No interest-payout-frequency field or staggered/amortizing principal repayment** — some real bonds pay interest monthly/quarterly/half-yearly (not just at maturity) and return principal in tranches (e.g. every 7 months, quarterly, or a mix, rather than one lump sum at maturity). `computeBond` currently assumes a flat principal for the whole tenure. Planned as a follow-up: a payout-frequency label (informational — real payouts are still logged via the existing Payouts ledger regardless of label) plus a dated principal-repayment ledger (same pattern as Payouts, logged as actuals arrive) so interest can be projected against whatever principal is actually outstanding rather than the original investAmount. Not yet designed in detail.
