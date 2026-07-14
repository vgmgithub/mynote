# Fixed Deposits (FD ladder)

A third surface inside the same PWA for tracking the user's **FD ladder** — one row per fixed deposit across small finance banks. Modelled on the user's Google Sheet "FD" tab (a monthly-contribution FD ladder at higher-rate small finance banks). The Stocks + Mutual Funds surfaces are untouched.

## Home launcher

The Home screen now shows **three** cards: Stocks / Mutual Funds / **Fixed Deposits**. The FD card's subtext shows `{N} active · ₹{invested}` where `{N}` is the active count (active = not matured/broken by status **or** by date) and `₹{invested}` is **total invested principal** (principal only, no interest) across all non-broken FDs — active + matured — matching the FD Overview's *Total invested value*. `setAppMode('fd')` shows/hides the FD surface + its own bottom nav + `#fdAddBtn`, exactly like the MF surface.

- Home **Total Invested / Total Earned** summary is **stocks + MF only** — FDs are a separate asset class and deliberately **not** folded into that equity-oriented figure (same reasoning as SGB gold bonds being carved out for a future Metal surface).

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
  notes, createdAt, updatedAt,
}
```

Everything financial is **derived** by `computeFd` (never stored → no drift):
- **Cumulative** FD compounds: `maturityValue = P·(1 + r/(100n))^(n·t)`, n = periods/yr (quarterly 4, monthly 12, half 2, yearly 1); `simple` uses `P·(1 + r·t/100)`. Interest = maturity − principal.
- **Payout** FD returns just the principal at maturity (interest paid out along the way); total interest = `P·r·t/100`, monthly income = `P·r/1200`.
- **currentValue** = accrued value as of today (elapsed years clamped to the effective term), so a fresh FD reads ≈ principal and a matured one reads its full maturity value.
- **Broken FD (early closure)** — when `status='broken'`, the effective term ends on `brokenDate` (falls back to today if unset), not the maturity date. Interest accrues only up to then, at the same rate (no penalty rate modelled). So `maturityValue`/`totalInterest` become the *exit* value and interest-earned-to-broken-date, and `currentValue` = that exit value. A normal FD is unaffected (its term end is the maturity date, exactly as before).
- **effectiveStatus** — `broken` wins; otherwise an FD still marked `active` past its maturity date reads `matured`. So the only status a human ever sets is **broken** (via a checkbox) — active↔matured is fully derived from the dates.
- Dates use whole-day math (`365.25`-day years, UTC parse) so there's no timezone drift; `addMonths` fills the maturity date from a typed tenure.

## UI (renderFD → `#fdView`, reuses stock/MF CSS classes)

- **Bottom nav** (`#fdBottomNav`) — **FDs | Overview | Ladder** (`_fdTab`), a third fixed bottom nav built once (`buildFdBottomNav`), shown only in FD mode.
- **FDs (holdings)** — filter `Active | Matured | All` (live counts) + sort `Maturity (soonest) | Amount | Rate | Bank` + the FD card list. Each card: bank, `rate% · compounding` + status badge, interest headline, invested, maturity date + days-to-maturity, and the maturity-value card.
- **Overview** — summary card modelled on the **rolling ladder** (reinvest matured proceeds into new FDs): headline *Total invested value* (Σ principal across active + matured FDs) with a *Current invested* sub-line (= **active** principal − Reinvested, i.e. the fresh capital still locked in active FDs, with the rolled-over portion stripped out), *Interest to earn* (active), then a grid of *Reinvested (P+I)* (Σ maturity value of matured FDs — the proceeds rolled into new FDs) / *Maturity value (active)* / *Avg rate* / *Active FDs*. **Broken FDs are excluded** from these ladder totals (early exit, not a rung). Below: **Invested by bank** (`.bar-row`) + **Interest income potential** (avg ₹/month + ₹/year across active FDs) + **Next maturity**.
- **Ladder** — walks **every month from the first maturity to the last**; each FD shows as a rung (month/year date chip, bank, `₹principal @ rate% · Nd left`, and a green badge showing the **interest** landing at that maturity — `+₹{interest}`, not the maturity value; the principal is already on the sub-line), and any month with **no FD maturing** gets a dashed **"No maturity"** gap card (`.fd-ladder-gap`) — the ladder's whole point is every month having some interest land, so gaps are surfaced to plug. Matured rungs dim (`.fd-done`). Tap any rung → edit (gap cards aren't tappable). A 600-month guard caps the walk.
- **`openFdForm`** — a single sheet (`.sheet.has-fixed-footer`): bank (datalist), principal, rate, start/maturity dates, a **tenure-months → fills maturity date** helper, compounding, type (cumulative/payout), a **"Broken (closed early)" checkbox** (replaces the old active/matured/broken dropdown — active↔matured is derived from dates, so broken is the only manual status) that reveals a **Broken-on date** field when ticked, notes, and a **live readout** (tenure / maturity — or *exit* value when broken / interest). Save / Delete (edit only) / Cancel.

## Not built (yet)

- **No auto-seed from the sheet** — the sheet's FD tab is monthly-contribution rows, not one-row-per-FD, so there's no clean list to seed. FDs are entered by hand via the form. (The user reported ~14 active FDs to add.)
- No online rate/maturity fetch — FDs are fixed at booking, so there's nothing live to pull (unlike MF NAV). All manual.
- No wife split (owner field reserved, mirrors MF).
