# Expense section (Home → 💳 Expense)

Five tabs on `#expBottomNav`, ordered "by how often a tab is actually opened, left to right": **Credit Card | Expense | Tracker | Review | Allocation**. The `+` FAB only means something on Credit Card (add a card) and Tracker (add a household spend) — hidden on the other three, the same pattern Emergency Fund uses for its Funds/Rules tabs. Dispatch is `renderHomeExpense()` in app.js, keyed on `_expTab`.

This is the **household** side of spending — see [personal-finance.md](personal-finance.md) for the user's own Card/UPI spend, which is a deliberately separate store, categories and limits.

## Allocation tab (`renderAllocation`)

The annual plan — set once per year, glanced at rather than edited daily, which is why it sits at the far end of the nav rather than second.

- **`allocations` store** — one row per year: `{ year, salary, home, houseExp, card, mf, emergency, fd, indStock, usStock, metal, savings }`. Everything is a flat ₹ figure the user types in for that year; nothing here is derived.
- **Year selector** (`_allocYear`, falls back to the latest year on record) + one card per non-zero category showing the amount and a **step-up %** vs the same category the previous year (`▲`/`▼`/`—`, ±5% dead zone before it's colored as a real move).
- **Balance card** — `salary − everything else`, always shown (even at zero, "since 'nothing left' is the answer the card exists to give"), never stored or independently editable — it can only ever agree with the figures above it.
- **`House Exp` is the one field every other Expense tab reads.** It feeds `_kittyFor()` (below), and `Card` feeds the Credit Card tab's per-card utilisation comparison (via the year's allocation).

## Credit Card tab (`renderCreditCards`)

Reproduces the source sheet's `credit` tab (columns A:AB — label column + 27 months). See `credit.js` for the record shape and math; summarized in the "Credit Card tab" entry in [features.md](features.md).

- **`g.averagePerMonth`** ("Avg / month" on the summary grid) is the average **To be paid** (billed − reimbursed) across every month any card has billed or been reimbursed — this already answers "what does the credit-card wallet cost me in a typical month," so nothing further was needed there when the same question came up for the Tracker (below).

## Expense tab (`renderExpenseSheet`, the section's default view)

The **monthly Expense sheet** — a direct digital form of the source spreadsheet's own Expense tab, distinct from the Tracker's day-by-day log below. Each box is a running total you can type into directly (`"2000+5000"` sums the terms live), or fetch from its source with ↻.

`Available Balance = (In Hand + Virtual Bal) − every red row`. **In Hand** starts from the Allocation tab's Salary figure; **Monthly Expense** starts from the Tracker's kitty balance left for the month — either can be typed over for a month that genuinely differed, or cleared to go back to following its source. **Virtual Bal** and **Other Expense** are itemised lists (tap `+`) rather than single boxes, with the row showing their total.

## Tracker tab (`renderSpendTracker`) — the household kitty log

The day-to-day log this section is actually opened for most often. One row per household spend (`spends` store, v15, indexed by `ym`), rolled up by category.

- **The kitty** = `_kittyFor(ym, allocs, loans)` = `max(0, houseExp × 2 + this month's Emergency-Fund draw − this month's repayment earmark)`. House Exp is doubled because both partners contribute the same figure into one household pot; floored at zero so an earmark bigger than the month's own budget reads as "everything is already committed" rather than a negative kitty, which would look like a bug.
- **Fixed categories** (`SPEND_CATEGORIES`, user-editable via the gear icon, stored in `meta.spendCategories`): Fixed (Rent, Electricity, Internet, Water, GAS), Home, Grocery, Lifestyle, Other. **Refund** is a category too — stored as a **negative amount**, not a flag, so it flows correctly through every sum on the page (kitty spent, category shares, insights) without a single special case.
- **Month timeline strip** (sticky under the app header, height measured via `appHeader.offsetHeight` since CSS doesn't auto-stack two `position:sticky` siblings at `top:0`) plus a **▦ All months heatmap** (`_trkHeatmapGrid`) — one row per category, one column per month, a **Kitty** row on top and **Spent / Left / Days left / Per day** summary rows underneath. Tapping a header cell or a category cell opens that month's/category's actual entries.
- **Insights panel** (`_trackerInsights`, shown on the "By category" view only) — five independent, data-backed observations, none of them a projection or a tuned threshold:
  1. **vs last calendar month** (shown even when last month was zero — "nothing last month" is itself worth knowing).
  2. **vs the running average of every earlier month** (needs ≥2 prior months with data).
  3. **The category that moved most, up and down**, vs last month, plus a **🆕 New this month** line for a category with nothing behind it last month.
  4. **Where the money actually goes** — the single biggest category, only surfaced once it clears 30% of the month's gross spend (measured against gross, not net-of-refunds, matching the roll-up above it).
  5. **Apart from Rent** *(added 2026-09-15)* — averages `(month total − that month's Rent)` across every month with any spend logged. Deliberately **not** computed as `average(Spent) − average(Rent)`: the two only agree when both divide by the same month count, and any month missing a Rent entry (before it was tracked, or paid outside the app) would otherwise skew the Rent average alone and throw the subtraction off.

## Review tab (`renderReview`)

**Always the current month — there is no month strip here.** Deliberately: every figure on this tab is either a forecast of where the month is heading or advice for what's left of it, and running that against a closed month would be "a forecast of a month that has already happened, advice for days that are gone." History isn't hidden — it's exactly what every comparison here is made *against* — it's just not something to browse on this tab (browse it on the Tracker instead).

- **Rest-of-month forecast** — deliberately *not* `spent / days-so-far × days-in-month`. Household spending isn't spread evenly across a month (rent/EMIs/bills land in the first week), so that naive formula way overshoots on the 6th and way undershoots by the 25th — both errors large and predictable, and therefore removable. Instead: what's already spent is a **fact**, only the remainder is estimated.
- **Each category compared against its own historical median** (`REVIEW_MIN_HISTORY = 2` prior months minimum before a median is quoted at all) — not a fixed target, and not an average, "which one unusual month would skew."
- **Fixed-group categories and Medicine are excluded from "spend less" suggestions** (`_reviewIgnores`) — Rent/bills are contractual and medicine isn't a lifestyle choice, so flagging either as overspend would be both useless and slightly crass.
