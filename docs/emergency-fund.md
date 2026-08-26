# Emergency Fund

A family lending pot with its own rulebook — not a passive savings pot. Money comes in from two
equal monthly contributions, is parked in mutual funds / a bond / (later) an FD, is lent out to self
and family under a written interest policy, and is measured against a ladder of targets.

Logic in `emergency.js` (pure, no DOM/IO); `app.js` owns the `emergency`-store CRUD and the surface.

## The one thing to understand first

**The fund's investments do NOT live in the `emergency` store.** They are ordinary `funds` / `bonds` /
`fds` records carrying `emergencyFund: true`. Consequences, all deliberate:

- They keep the **existing live NAV fetch** (`fetchMfNavs()` sweeps the whole `funds` store), so an
  emergency Liquid fund updates exactly like any other fund — no duplicated fetch code, no second
  API loop, **zero extra network calls**.
- They stay **listed on their own page** with a purple **EF** badge, but are **excluded from that
  page's invested/return totals** — mixing an emergency Liquid fund into long-term equity XIRR would
  misrepresent both.
- They are **excluded from Home's Total Invested and Total Earned**, and the Emergency Fund
  contributes **no row of its own** either. Nothing about this fund touches the Home headline.

This is the same split SGBs already have: the record lives in the `stocks` store, but the Metals
surface is what counts it. See the contract comment above `homeInvestedBreakdown()` (app.js).

⚠ **Linking a holding lowers Home's Total Invested** by whatever that holding was contributing.
That is the intended correction — the money is now reported on this page instead.

## Record shapes (`emergency` store, IndexedDB v9)

One store, three logical tables, discriminated by `kind` (indexed) so each is one `DB.byIndex` call.

```js
{ id, kind:'contribution', date, mine, spouse, note }      // one row per month; both sides usually equal
{ id, kind:'target', name, amount, ladder:'add'|'absorb', order, expectedClosure, note }
{ id, kind:'loan', loanKind:'self'|'emergency'|'gift', who, purpose, amount,
  takenDate, expectedDate, closedDate, rate, interestOverride, interestPaid,
  repayments:[{ date, amount }], note }
```

## Loans — one entity, three interest regimes

An "emergency spend" is **not** a separate concept from a loan; it's a loan with a different grace
period. `EF_FREE_MONTHS` is the whole difference:

| `loanKind` | Free for | Then |
|---|---|---|
| `self` | — | priced from day one (rule 4) |
| `emergency` | 3 months (rule 7) | priced |
| `gift` | 5 months (rule 9, ≤25% of corpus) | priced |

Modelling them separately would make a legitimate record look like a bug: a family loan repaid over
**4 months** correctly charges **₹0**, which only makes sense once you see it as a rule-9 gift rather
than a mispriced self loan.

### Interest formula

```
interest = CEILING(amount × rate% × multiplier, ₹100)      rate defaults to EF_RATE = 2%
multiplier = max(1, ceil(months / 3))                       → 1× ≤3m, 2× 4–6m, 3× 7–9m, 4× 10–12m
```

The multiplier table is expressed as **arithmetic, not a lookup** — it reproduces every stated band
*and* keeps working past 12 months instead of running off the end of the table.

Worked example: `₹20,000` at 2% repaid in 6 months → multiplier 2 → `20000 × 0.02 × 2 = 800`, already
a round hundred, so ₹800. The same loan repaid in 3 months → multiplier 1 → ₹400. A `₹15,000` loan at
3 months → `300` exactly; at 4 months it crosses into the 2× band → `600`.

The implementation was validated against a full set of real historical loans (closed and open, all
three kinds) before shipping — every figure matched, including the interest-free cases.

- **`interestOverride`** wins outright — the rule is the default, not a straitjacket.
- Months are **whole calendar months**, day ignored: the rules are stated in months and the source
  records dates as `Mon-YY`, so day precision would invent accuracy and would put a loan taken on
  the 28th in a different band from one taken on the 2nd.
- **The clock stops at closure.** Otherwise a settled loan would keep climbing bands and its interest
  would drift after the fact. Settled = explicit `closedDate`, or repayments covering the amount
  (0.5 slack so a rounding remainder can't leave a loan permanently open).
- Open loans expose **two** figures, because they answer different questions: `interestAccrued` (what
  it has cost so far) and `interestProjected` (what it will cost if repaid on the expected date).
  The sheet's own open-loan numbers are the projection, so that's what the card headlines.

## Targets — the `ladder` flag

`absorb` **replaces** the running total instead of adding to it. A hand-maintained cumulative column
can look inconsistent until read this way; with the flag, every rung resolves. Illustrative ladder:

| Rung | ladder | cumulative |
|---|---|---|
| Single-person emergency, 1 unit | add | 1 unit |
| Joint emergency, 2 units | **absorb** (already 2× the rung above) | 2 units |
| Small medical, 2 units | add | 4 units |
| Big medical, 5 units | **absorb** (covers small medical) | 5 units |
| Long-term goal, 7 units | add | 12 units |

A naive running sum would give 17 units instead of 12 — permanently overstating how far away the
final goal is, on every render. Progress is measured against `corpusIn`. `remaining` is clamped at 0;
an exceeded target reports `surplus` instead.

## Derived figures (`computeEmergencyFund`)

```
corpusIn       = contributions + loanInterestRealised + parkedRealised   // everything ever taken in
lentOut        = Σ outstanding on open loans
marketInterest = parkedValue − parkedInvested                            // live, unrealised
cashInHand     = corpusIn − parkedInvested − lentOut
fundValue      = parkedValue + cashInHand + lentOut
totalInterest  = loanInterestRealised + marketInterest + parkedRealised
```

### Each parked holding decomposes into three quantities

Conflating these loses real money, so `efParked()` tracks them separately:

| | meaning | goes into |
|---|---|---|
| `invested` | capital still deployed (0 once closed — principal is back as cash) | `parkedInvested` |
| `value` | what that deployed capital is worth now (unrealised) | `parkedValue` |
| `income` | cash the holding has **already paid into the fund** | `parkedRealised` → `corpusIn` |

`income` is the one that's easy to miss, and getting it wrong was a real bug caught after the first
commit. **A payout bond's `currentValue` stays flat at its principal** because every coupon leaves as
cash — and a **payout FD** behaves identically. So `value − invested` is **0** for both, and their
actual receipts vanish entirely unless income is tracked on its own axis. A bond that had paid two
coupons was reporting ₹0 interest earned and ₹0 available.

Counted once per path, verified:

| Holding | `invested` | unrealised (`value−invested`) | `income` |
|---|---|---|---|
| Cumulative bond, active | principal | the whole accrual | 0 (nothing paid out) |
| Payout bond, active | outstanding principal | **0** | coupons banked (`payoutsBeforeExit`) |
| Bond sold / matured | **0** | 0 | `interestEarned` = coupons + sale gain |
| Payout FD, active | principal | **0** | `accruedInterest` |
| Cumulative FD, active | principal | the accrual | 0 |
| MF, held | invested | mark-to-market | 0 (units × NAV carries it all) |
| MF, redeemed | **0** | 0 | realised gain |

A payout row dated **on/after** a bond's sale is excluded from `income` (it's the exit itself, not
extra interest) — the same rule `payoutsBeforeExit` already applies on the Bonds surface.

For a closed holding the principal leaves `parkedInvested`, so `cashInHand` rises by it
automatically, and only the gain is added to `corpusIn` on top.

**`cashInHand` is a derived residual, so it can go negative** — meaning more has been parked and lent
than the log says was collected (usually a missing contribution). That's surfaced as an explicit
`shortfall` with a plain-language warning, never rendered as a bare negative under a heading like
"Available".

## UI

Three tabs on `#efBottomNav`. The summary card (fund value, interest earned, collected / invested /
lent out / available) shows on **all** of them, so the headline never leaves the screen.

- **Fund** — interest split into two groups: **Realised** (from lending · received from investments —
  cash already in the fund) and **Pending / unrealised** (unrealised on investments · due on open
  loans — projections). Each row has an icon, a one-line explanation of what it means, and a coloured
  left accent (green for realised, amber for pending) so the split reads at a glance instead of as four
  flat numbers. Below that, the live "Invested in" list is grouped by category — **Mutual Funds**,
  **Bonds**, **Fixed Deposits** — each with its own header showing the holding count and a subtotal
  (capital still deployed in that category, or once everything in it has closed, the interest it
  realised). Then the `corpusIn − invested − lent = available` reconciliation, and the target ladder
  with progress bars. A holding that has paid interest out says so on its own line ("₹X interest
  received (already cash in the fund)"), and its right-hand figure is labelled **unrealised** rather
  than "gain" — otherwise a payout bond showing "gain ₹0" reads as if it had earned nothing. A closed
  holding's right-hand figure is its actual realised interest/gain (`income`), not a separate `gain`
  field — an earlier version referenced a field that was never set, so every closed holding silently
  showed "+₹0 realised" regardless of what it actually earned.
- **Loans** — Open / Closed / All, with a warning strip counting overdue loans and loans **about to**
  start accruing (warn *before* the free window closes, not after). Card badges: `closed` /
  `overdue` / `interest-free` / `Nm left` / `N× band`.
- **Log** — the contribution ledger. `mine` mirrors into `spouse` on entry since both sides pay the
  same, still editable when a month differs.

The `+` FAB is **tab-aware**: target on Fund, loan on Loans, contribution on Log.

The loan form's readout spells the arithmetic out (`amount × rate × multiplier (N months) = X,
rounded up to Y`) because the figure is derived — a wrong date silently changes the band, and that's
otherwise invisible. It also names the next band and when it hits.

## Backup

`emergency` is in `exportAll()`/`importAll()` (verified round-trip: 7 rows and both `emergencyFund`
flags survive). A **pre-v9 backup with no `emergency` key imports cleanly** — the `(data.emergency || [])`
guard means it just restores an empty fund, same semantics as every other store.

## Not built (deliberately, for v1)

- The sheet's **investment-performance grid** — derived live from the linked records instead.
- The **12-month forward repayment plan**.
- The **notional 25%-per-family-group entitlement split** and rule 10's one-allocation-per-cycle.
- **No seed data**: the user logs their own. The source spreadsheet's own totals didn't reconcile
  (several conflicting "balance" cells), so seeding would have imported that discrepancy as fact.

## Gotcha found while building this

A **version bump blocks** while another tab holds the old version open. `db.js` had no `onblocked`
handler, so the open promise never settled and the app hung on a blank screen with nothing in the
console. Now rejects with an actionable message. This was latent before v9 — any future bump would
have hit it too.
