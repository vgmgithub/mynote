# Fixed Deposits (FD ladder)

A third surface inside the same PWA for tracking the user's **FD ladder** — one row per fixed deposit across small finance banks. Modelled on the user's Google Sheet "FD" tab (a monthly-contribution FD ladder at higher-rate small finance banks). The Stocks + Mutual Funds surfaces are untouched.

## Home launcher

The Home screen now shows **three** cards: Stocks / Mutual Funds / **Fixed Deposits**. The FD card's subtext shows `{N} active · ₹{invested}` where `{N}` is the active count (active = not matured/broken by status **or** by date) and `₹{invested}` = **active-FD principal only**, matching the FD Overview's *Total invested value* headline. `setAppMode('fd')` shows/hides the FD surface + its own bottom nav + `#fdAddBtn`, exactly like the MF surface.

- Home **Total Invested / Total Earned** summary is **stocks + MF + matured FDs**. *Active* FDs stay excluded — still-locked-in capital, a separate asset class tracked in the FD surface's own totals (same reasoning as SGB gold bonds being carved out for a future Metal surface) — but a **matured** FD is a completed, realized outcome: its `principal` folds into Total Invested and its `maturityValue` (principal + interest earned) folds into the value side, so the interest it actually earned flows into Total Earned exactly like a stock/fund gain does. Broken FDs are excluded either way (`effectiveStatus` is never `'matured'` for a broken FD).
  - **No double-counting across a reinvestment chain.** In a ladder, each new FD's principal already telescopes the previous matured FD's principal + interest (you rolled it over — see `parentFdId` / the Reinvestment chains section below). So a matured FD is **skipped** on Home if the FD it was reinvested into (its child) has *also* matured — that newer matured FD already contains its money. Only the **latest matured link in each chain** counts (its principal = all recycled principal+interest to date; its interest = the freshly realized gain), plus any terminal cashed-out matured FDs. Verified: chain FD1(₹2,000→matured)→FD2(₹2,200→matured)→FD3(active) counts only FD2, not FD1.

## Files

- **`fd.js`** — pure logic, lazy-loaded (`import('./fd.js')`). Exports `computeFd(fd, nowMs)`, `addMonths(iso, months)`, and the `FD_BANKS` / `FD_COMPOUNDING` / `FD_STATUS` constants. No DOM, no IO.
- **`app.js`** — `buildFdBottomNav`, `renderFD`, `_fdCard`, `_fdMonthLabel`, `openFdForm`; `setAppMode` handles the `'fd'` mode; `renderHome` adds the FD card + subtext.
- **`db.js`** — `fds` store (v5) + folded into `exportAll`/`importAll` (best-effort `.catch`, like `feed`/`funds`), so backup carries FD data with no change to `backup.js`.

## Data model — `fds` store (IndexedDB v5)

Key `id` (auto-increment), index `owner` (`'me'`).

```js
{
  id, owner: 'me',
  bank,                 // free text; datalist pre-fills the 3 small finance banks
  principal,            // ₹
  rate,                 // annual % p.a.
  startDate, maturityDate,   // 'YYYY-MM-DD'
  compounding,          // 'quarterly' (default) | 'monthly' | 'half-yearly' | 'yearly' | 'simple'
  payout,               // 'cumulative' (reinvest) | 'payout' (interest paid out)
  status,               // 'active' | 'broken'  ('matured' is derived from the date, never stored)
  brokenDate,           // 'YYYY-MM-DD' — set only when status='broken' (early closure)
  parentFdId,           // id of the matured FD this one was reinvested from (chain link); null = fresh money
  notes, createdAt, updatedAt,
}
```

Everything financial is **derived** by `computeFd` (never stored → no drift):
- **Cumulative** FD compounds: `maturityValue = P·(1 + r/(100n))^(n·t)`, n = periods/yr (quarterly 4, monthly 12, half 2, yearly 1); `simple` uses `P·(1 + r·t/100)`. Interest = maturity − principal.
- **Payout** FD returns just the principal at maturity (interest paid out along the way); total interest = `P·r·t/100`, monthly income = `P·r/1200`.
- **currentValue** = accrued value as of today (elapsed years clamped to the effective term), so a fresh FD reads ≈ principal and a matured one reads its full maturity value.
- **Broken FD (early closure)** — when `status='broken'`, the effective term ends on `brokenDate` (falls back to today if unset), not the maturity date. Interest accrues only up to then, at the same rate (no penalty rate modelled). So `maturityValue`/`totalInterest` become the *exit* value and interest-earned-to-broken-date, and `currentValue` = that exit value. A normal FD is unaffected (its term end is the maturity date, exactly as before).
- **effectiveStatus** — `broken` wins; otherwise an FD still marked `active` past its maturity date reads `matured`. So the only status a human ever sets is **broken** (via a checkbox) — active↔matured is fully derived from the dates.
- **Day-count convention (per-FD, tenure-dependent)** — `yearsBetween(a, b, inclusive365)` supports two conventions: the default **exclusive day-count over a 365.25-day year** (`(b−a)/365.25days`, UTC parse, no timezone drift), and an **inclusive day-count over a flat 365-day year** (`((b−a)/day + 1)/365` — the deposit date itself counts as day 1). `computeFd` picks per-FD, once, from the FD's **contracted** tenure (`startDate`→`maturityDate`, computed before any broken-date logic): **> 548 days (~18 months) → inclusive/365; ≤ 548 days → exclusive/365.25.** This same choice is then reused consistently for `tenureYears`, `termYears` (broken FDs included — decided from the *original* contract, not the shortened broken term, so breaking an FD never flips its convention), and `elapsedYears` — a single FD never switches convention partway through its life. Tuned against two real FDs: ₹9,500 @ 7.75% quarterly, 18mo1day → bank ₹10,665.00, inclusive/365 gives ₹10,664.88 (12 paise off) vs exclusive/365.25's ₹10,661.79 (₹3.21 off); ₹2,000 @ 8.75% quarterly, 13mo → exclusive/365.25 tracked better there. Different banks use different conventions — no single formula matches every bank to the rupee. `addMonths` fills the maturity date from a typed tenure.
- **Display rounding** — every pure *interest* figure in the FD UI (Interest to earn, Interest matured, income potential, the per-FD card/ladder-badge/form-readout interest amounts) is shown rounded to the nearest rupee via `fmtIntCur()` (app.js, renamed from `fmtFdInt` once the Home screen started using it too) — no paise. Principal/invested/maturity-value figures keep the normal 2-decimal `fmtCur`. The underlying `computeFd` numbers are untouched (still full precision) — only display is rounded.

## UI (renderFD → `#fdView`, reuses stock/MF CSS classes)

- **Bottom nav** (`#fdBottomNav`) — **FDs | Overview | Ladder** (`_fdTab`), a third fixed bottom nav built once (`buildFdBottomNav`), shown only in FD mode.
- **FDs (holdings)** — filter `Active | Matured | All` (live counts) + sort `Maturity (soonest) | Amount | Rate | Bank` + the FD card list. Each card: bank, `rate% · compounding` + status badge + **chain badges** (`↻ from {parent bank}` if funded from a matured FD, `↻ rolled over` if reinvested into a newer FD), interest headline, invested, maturity date + days-to-maturity, and the maturity-value card. **Matured filter trimming:** the matured list shows only the most recent **N** matured FDs where **N = active-FD count** (the current ladder width, per user) — older reinvested links are hidden from the list (data + `parentFdId` chains kept intact) with a "showing last N · M older hidden" note, so the matured list can't grow unbounded as the ladder loops.
- **Overview** — summary card modelled on the **rolling ladder** (reinvest matured proceeds into new FDs): headline *Total invested value* (= **active**-FD principal, as-is) with a *Current invested* sub-line (= Total invested − Reinvested (P+I) — the fresh capital still your own once recycled matured proceeds are stripped back out), *Interest to earn* (active), then a grid of *Reinvested (P+I)* (Σ maturity value of matured FDs — the proceeds rolled into new FDs) / *Interest matured* (green — Reinvested minus matured principal, i.e. interest already realized from matured FDs; forward-looking "Interest to earn" above is for active FDs, this is the realized counterpart for matured ones) / **Return %** / *Active FDs*. **Return %** = Interest to earn ÷ Total invested value × 100 — a simple reverse-calculated figure from the two headline numbers already on the card. **Not annualized**: it's total interest over each active FD's own remaining tenure, not per year, so a ladder skewed toward longer-tenure FDs reads higher here even at the same underlying bank rate. (Two more rigorous alternatives — a principal-weighted average of nominal rates, and a tenure-aware Portfolio XIRR via `mf.js`'s `xirr()` — were tried and replaced by this simpler figure per user preference.) **Broken FDs are excluded** from these ladder totals (early exit, not a rung). Below: **Invested by bank** (`.bar-row`) + **Interest income potential** (avg ₹/month + ₹/year across active FDs) + **Next maturity**.
- **Ladder** — walks **every month from the first maturity to the last**; each FD shows as a rung (month/year date chip, bank, `₹principal @ rate% · Nd left`, and a green badge showing the **interest** landing at that maturity — `+₹{interest}`, not the maturity value; the principal is already on the sub-line), and any month with **no FD maturing** gets a dashed **"No maturity"** gap card (`.fd-ladder-gap`) — the ladder's whole point is every month having some interest land, so gaps are surfaced to plug. Matured rungs dim (`.fd-done`). Tap any rung → edit (gap cards aren't tappable). A 600-month guard caps the walk.
- **`openFdForm`** — a **tabbed** sheet (`.sheet.has-fixed-footer`, `.seg` tabs — mirrors the MF fund form). **Details** tab: bank (datalist), principal, rate, start/maturity dates, a **tenure-months → fills maturity date** helper, compounding, type (cumulative/payout), a **"Funded by (matured FD)"** dropdown (the reinvestment link — lists matured FDs that don't already fund another FD; sets `parentFdId`), a **"Broken (closed early)" checkbox** (replaces the old active/matured/broken dropdown — active↔matured is derived from dates, so broken is the only manual status) that reveals a **Broken-on date** field when ticked, notes, and a **live readout** (tenure / maturity — or *exit* value when broken / interest). **Chain** tab (edit only): the full reinvestment chain this FD belongs to — walks up via `parentFdId` and down via the child map, one row per link (bank · `₹principal @ rate% · status · mat date` + interest), current FD highlighted (`.fd-chain-current`), other links tappable to open them. Footer: Save / Delete (edit only) / Cancel.

## Reinvestment chains (`parentFdId`)

The user runs a rolling ladder: each month an FD matures and its proceeds (principal + interest) are reinvested into a new FD, sometimes topped up with a spare ₹100–200. `parentFdId` links each new FD to the matured FD it was funded from (1:1, monthly). Tenure is irrelevant to the link (13-month, 18-month, mixed — all fine).

- **Set** via the Details tab's "Funded by" dropdown; **viewed** via the Chain tab and the card `↻` badges.
- **Why it matters (no double-count):** each new FD's principal already contains the previous matured FD's principal + interest. Counting every matured FD on Home would count the same rupees every cycle. So Home skips a matured FD whose child has also matured (superseded — telescoped into the newer one) and counts only the latest matured link per chain + terminal cashed-out FDs. See the Home launcher bullet above.
- Derived per FD in `renderFD`/`openFdForm` from a `childByParent` map (no reverse field stored). `computeFd` ignores `parentFdId` entirely — it's pure app-layer chain logic.

## Not built (yet)

- **No auto-seed from the sheet** — the sheet's FD tab is monthly-contribution rows, not one-row-per-FD, so there's no clean list to seed. FDs are entered by hand via the form. (The user reported ~14 active FDs to add.)
- No online rate/maturity fetch — FDs are fixed at booking, so there's nothing live to pull (unlike MF NAV). All manual.
- No wife split (owner field reserved, mirrors MF).
