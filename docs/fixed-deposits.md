# Fixed Deposits (FD ladder)

A third surface inside the same PWA for tracking the user's **FD ladder** — one row per fixed deposit across small finance banks. Modelled on the user's Google Sheet "FD" tab (a monthly-contribution FD ladder at higher-rate small finance banks). The Stocks + Mutual Funds surfaces are untouched.

## Home launcher

The Home screen shows **three** cards: Stocks / Mutual Funds / **Fixed Deposits**. The FD card's subtext shows `{N} active · ₹{invested}` where `{N}` is the active count (active = maturity date not yet passed) and `₹{invested}` = Σ **active-FD effective principal** (fresh + rolled-in), matching the FD Overview's *Total invested value* headline. `setAppMode('fd')` shows/hides the FD surface + its own bottom nav + `#fdAddBtn`, exactly like the MF surface.

- Home **Total Invested / Total Earned** summary is **stocks + MF + matured FDs**. *Active* FDs stay excluded — still-locked-in capital, tracked in the FD surface's own totals (same reasoning as SGB gold bonds being carved out for a future Metal surface) — but a **matured** FD is a completed, realized outcome: its effective `principal` folds into Total Invested and its `maturityValue` (principal + interest earned) folds into the value side, so its realized interest flows into Total Earned like a stock/fund gain.
  - **No double-counting across a reinvestment chain.** In a ladder each new FD's principal telescopes the previous matured FD's principal + interest (you rolled it over — see Reinvestment chains below). So a matured FD is **skipped** on Home if the FD it was reinvested into (its child) has *also* matured — that newer matured FD already contains its money. Only the **latest matured link per chain** counts, plus any terminal cashed-out matured FDs. Verified: chain FD1(matured)→FD2(matured)→FD3(active) counts only FD2.

## Files

- **`fd.js`** — pure logic, lazy-loaded (`import('./fd.js')`). Exports `computeFd(fd, nowMs, seed)`, `resolveChain(fd, byId, nowMs, cache)`, `addMonths(iso, months)`, and the `FD_BANKS` / `FD_COMPOUNDING` constants. No DOM, no IO.
- **`app.js`** — `buildFdBottomNav`, `renderFD`, `_fdCard`, `_fdMonthLabel`, `openFdForm`; `setAppMode` handles the `'fd'` mode; `renderHome` adds the FD card + subtext.
- **`db.js`** — `fds` store (v5) + folded into `exportAll`/`importAll` (best-effort `.catch`, like `feed`/`funds`), so backup carries FD data — including `parentFdId` — with no change to `backup.js`.

## Data model — `fds` store (IndexedDB v5)

Key `id` (auto-increment), index `owner` (`'me'`).

```js
{
  id, owner: 'me',
  bank,                 // free text; datalist pre-fills the 3 small finance banks
  principal,            // ₹ FRESH money added to THIS FD only (top-up). NOT the whole deposit.
  rate,                 // annual % p.a.
  startDate, maturityDate,   // 'YYYY-MM-DD'
  compounding,          // 'quarterly' (default) | 'monthly' | 'half-yearly' | 'yearly' | 'simple'
  payout,               // 'cumulative' (reinvest) | 'payout' (interest paid out)
  parentFdId,           // id of the matured FD this one was reinvested from; null = fresh-only. Its maturity value seeds this FD's effective deposit.
  notes, createdAt, updatedAt,
}
```

There is **no stored `status`** and **no "broken"** — status is derived purely from the date (active before maturity, matured on/after). To drop an FD from the ladder, delete it.

Everything financial is **derived** (never stored → no drift):
- **Effective deposit** `P = principal (fresh) + seed`, where `seed` = the mapped parent's maturity value (resolved recursively up the chain by `resolveChain`; 0 for a fresh-only FD). Interest / maturity / current value all compute on `P` — the bank pays on the whole deposit. `computeFd` returns `principal` (= effective `P`), `freshPrincipal`, and `rolledIn` (= seed) so the UI can show the split.
- **Cumulative** FD compounds: `maturityValue = P·(1 + r/(100n))^(n·t)`, n = periods/yr (quarterly 4, monthly 12, half 2, yearly 1); `simple` uses `P·(1 + r·t/100)`. Interest = maturity − P.
- **Payout** FD returns just the principal at maturity (interest paid out along the way); total interest = `P·r·t/100`, monthly income = `P·r/1200`.
- **currentValue** = accrued value as of today (elapsed years clamped to the tenure), so a fresh FD reads ≈ P and a matured one reads its full maturity value.
- **effectiveStatus** — `matured` on/after the maturity date, else `active`. Fully date-derived; nothing manual.
- **Day-count convention (per-FD, tenure-dependent)** — `yearsBetween(a, b, inclusive365)` supports two conventions: the default **exclusive day-count over a 365.25-day year** (`(b−a)/365.25days`, UTC parse, no timezone drift), and an **inclusive day-count over a flat 365-day year** (`((b−a)/day + 1)/365` — deposit date counts as day 1). `computeFd` picks per-FD from the **contracted** tenure (`startDate`→`maturityDate`): **> 548 days (~18 months) → inclusive/365; ≤ 548 days → exclusive/365.25**, reused for `tenureYears` and `elapsedYears`. Tuned against two real FDs: ₹9,500 @ 7.75% quarterly, 18mo1day → bank ₹10,665.00, inclusive/365 gives ₹10,664.88 (12 paise off) vs exclusive/365.25's ₹10,661.79 (₹3.21 off); ₹2,000 @ 8.75% quarterly, 13mo → exclusive/365.25 tracked better. Different banks use different conventions — no single formula matches every bank to the rupee. `addMonths` fills the maturity date from a typed tenure.
- **Display rounding** — every pure *interest* figure in the FD UI (Interest to earn, Interest matured, income potential, per-FD card/ladder-badge/form-readout interest) is rounded to the nearest rupee via `fmtIntCur()` (app.js, shared with the Home screen) — no paise. Principal/invested/maturity-value figures keep the normal 2-decimal `fmtCur`. Underlying `computeFd` numbers stay full precision — only display is rounded.

## UI (renderFD → `#fdView`, reuses stock/MF CSS classes)

- **Bottom nav** (`#fdBottomNav`) — **FDs | Overview | Ladder** (`_fdTab`), a third fixed bottom nav built once (`buildFdBottomNav`), shown only in FD mode.
- **FDs (holdings)** — filter `Active | Matured | All` (live counts) + sort `Maturity (soonest) | Amount | Rate` + the FD card list. Each card: bank, `rate% · compounding` + status badge + **chain badges** (`↻ from {parent bank}`, `↻ rolled over`), interest headline, invested (effective, with a `₹fresh + ₹rolled` sub-line when money was rolled in), maturity date + days-to-maturity, and the maturity-value card. **Superseded matured FDs are hidden** from the list — a matured FD whose child has *also* matured is absorbed into that newer link, so the matured list shows only the latest matured link per chain and can't grow unbounded. (Superseded FDs stay in the data and are visible via the Chain tab.)
- **Overview** — summary card for the rolling ladder (all figures over **active** FDs unless noted): headline *Total invested value* (= Σ active **effective** principal, fresh + rolled) with a *Fresh invested* sub-line (= Σ active **fresh** principal — your out-of-pocket still in active FDs), *Interest to earn* (Σ active interest), then a grid of *Reinvested* (= Σ active `rolledIn` — recycled money currently working) / *Interest matured* (green — Σ realized interest from **non-superseded** matured FDs) / *Return %* (= Interest to earn ÷ effective invested × 100; **not annualized** — a longer-tenure ladder reads higher at the same bank rate) / *Active FDs*. Below: **Invested by bank** (`.bar-row`) + **Interest income potential** (avg ₹/month + ₹/year across active FDs) + **Next maturity**.
- **Ladder** — walks **every month from the first maturity to the last**; each FD is a rung (month/year date chip, bank, `₹principal @ rate% · Nd left`, and a green badge showing the **interest** landing at that maturity — `+₹{interest}`), and any month with **no FD maturing** gets a dashed **"No maturity"** gap card (`.fd-ladder-gap`) so gaps are visible. Matured rungs dim (`.fd-done`). Tap a rung → edit (gap cards aren't tappable). A 600-month guard caps the walk.
- **`openFdForm`** — a **tabbed** sheet (`.sheet.has-fixed-footer`, `.seg` tabs — mirrors the MF fund form). **Details** tab: bank (datalist), **Fresh principal (top-up only)**, rate, start/maturity dates, a **tenure-months → fills maturity date** helper, compounding, type (cumulative/payout), a **"Funded by (matured FD)"** dropdown (the reinvestment link — lists matured FDs that don't already fund another FD; sets `parentFdId`; adds that parent's payout to the deposit), notes, and a **live readout** (tenure / maturity / interest, plus a *Deposit ₹X (₹fresh + ₹rolled)* line when a parent is mapped). **Chain** tab (edit only): the full reinvestment chain — walks up via `parentFdId` and down via the child map, one row per link (bank · `₹effective @ rate% · status · mat date` + interest), current FD highlighted (`.fd-chain-current`), other links tappable. Footer: Save / Delete (edit only) / Cancel.

## Reinvestment chains (`parentFdId`)

The user runs a rolling ladder: each month an FD matures and its proceeds are reinvested into a new FD, topped up with a spare ₹100–200. The model keeps this duplication-free **structurally**:

- **`principal` stores only the fresh money** you add to each FD. So `Σ principal` across every FD = your true out-of-pocket, with no double-count, forever — no matter how many times the ladder loops.
- **Effective deposit = fresh + mapped parent's maturity value**, resolved recursively by `resolveChain` (memoized, cycle-guarded). Interest computes on the effective amount; the card lists it (e.g. ₹2,000 fresh + ₹2,195 rolled = ₹4,195).
- **Set** the link via the Details tab's "Funded by" dropdown; **view** it via the Chain tab + card `↻` badges.
- **Matured list + Home supersede rule:** a matured FD is hidden/skipped once its child has *also* matured (its money is telescoped into that newer matured link). So the matured list and Home each show only the latest matured link per chain + terminal cashed-out FDs. Example (user's): Jan-2025 → Jan-2026 → Jan-2027(active). After Jan-2027 is booked, the matured list shows only Jan-2026 (Jan-2025 hidden, absorbed); Home counts only Jan-2026.
- `computeFd` itself ignores `parentFdId` (takes the resolved `seed`); the chain walking is app-layer (`resolveChain` + `childByParent` maps in `renderFD`/`openFdForm`/`renderHome`).

## Not built (yet)

- **No auto-seed from the sheet** — the sheet's FD tab is monthly-contribution rows, not one-row-per-FD, so there's no clean list to seed. FDs are entered by hand via the form.
- No online rate/maturity fetch — FDs are fixed at booking, so there's nothing live to pull (unlike MF NAV). All manual.
- No wife split (owner field reserved, mirrors MF).
- **No penalty-rate modelling for early closure** — the "broken" concept was removed; if you close an FD early, delete it (or edit its maturity date/value to reflect what you actually got).
