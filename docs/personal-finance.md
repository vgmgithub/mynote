# Personal Finance (Home → 👛 Personal Finance)

The user's own Card/UPI spend, tracked separately from the household Tracker in the [Expense section](expense.md). Lives entirely inside `app.js` — no dedicated module, unlike Bonds/FD/MF.

> "The Tracker in Expense is HOUSEHOLD spending, measured against a kitty of House Exp doubled. This is the other half of the card bill: what gets spent on the person rather than the house, against its own allowance. Kept apart from household spending everywhere — own store, own categories, own limits — because the two answer different questions and only the household half is credited back on a card. Mixing them is how a month's household total quietly starts including a haircut."

## Data model — `personalSpends` (v16, indexed by `ym`)

```js
{
  id, ym, date, category, amount,   // amount negative = a refund
  method: 'Card' | 'UPI',
  cardId,                            // only when method === 'Card'
  forOthers,                         // excluded from limits/Review
  tags, note, createdAt, updatedAt,
}
```

- **Only two methods** (`PF_METHODS = ['Card', 'UPI']`) — no cash line, since "a personal allowance is held on a card and a UPI handle, and a method nobody uses is one more tap on every entry."
- **Categories** (`PERSONAL_CATEGORIES`, editable, stored in `meta.pfCategories`) — Food / Shopping / Travel / Health / Fun / Other, e.g. `Eat Out, Order In, Tea & Snacks, Coffee` under Food. Kept in a completely separate list from the household `SPEND_CATEGORIES`: "Household and personal stay SEPARATE. They are genuinely different vocabularies: one has Rent and Milk in it, the other Gym and Movies, and merging them would make every picker twice as long and half as useful."
- **Refunds** — the shared `REFUND_CAT`/`isRefund` convention (see [expense.md](expense.md)): a refund is a category storing a negative amount, not a flag, "so this is one constant serving both sides rather than two that could drift apart."
- **`PF_START_YM = '2026-09'`** — the month tracking began here, bounding the timeline range.
- Tracking started later than the household Tracker; there's no seed data before that month.

## Tabs (`_pfTab`)

`'spends' | 'limits' | 'review' | 'cards' | 'tags'`, dispatched by `buildPfBottomNav()`/`renderPersonal()`:

- **Spends** — the entry log, where rows go in.
- **Limits** — Card and UPI balances against their allowances (below).
- **Review** — the same "vs your own history" style of insight as the household Review tab, read against this store instead.
- **Card check** — reconciles what's been *logged* here against a card versus what the card's own statement says (below).
- **Tags** — shared with the household side; lives only on this nav (see "Tags lives in Personal Finance, not [the Expense nav]" — a second copy on the Expense nav would have been the same page reached two ways, and that nav was the one running out of room).

## Limits

- **Card allowance** (`_pfCardLimit(ym, allocs)`) is read **live from the Allocation tab's `card` field** for that year — "the one place the household budget is already written down — so it is read live rather than copied." This is **not** the same number as a credit card's own bank-sanctioned `creditLimit` (entered per-card on the Credit Card tab) — the Allocation `card` figure only feeds this Personal Finance allowance.
- **UPI allowance** (`_pfUpiLimit()`) is its own setting — `meta.pfUpiLimit`, defaulting to `PF_UPI_LIMIT_DEFAULT` (₹2,000) until the user sets one, "since the UPI one has no home in that budget."
- `forOthers` rows are excluded from both limit totals (but kept in the raw entry list) — money spent *for* someone else shouldn't count against the user's own allowance.

## "Counted month" is method-dependent

- **UPI** — a calendar-month allowance, counted in the month of the spend.
- **Card** — the allowance is really a bill, so it counts on the statement that bill lands on, using that specific card's own billing cycle (`credit.js`'s `statementYmFor`). On a 21→20 card, the 25th of August is already September's money. "Two cards on different cycles therefore split the same calendar month differently, which is correct rather than untidy."

## Relationship to the Credit Card tab

A Card-method spend here is **tagged** with `cardId` but never posted against that card's own totals. The Credit Card tab's picker note says it plainly: "Recorded against this card so the Card check tab can tell you how much of its bill is yours rather than the house's. The card's own totals are left alone."

**Nothing is written back to the card.** This is the opposite of the household Tracker's behaviour: a household Card spend generates a reimbursement (the house owes that money to whoever swiped); a personal Card spend does not — "a personal spend is the swiper's own bill - crediting it back would tell them they owe less than they do."

`loggedOn(cardRec, ym)` (Credit Card tab) derives what's actually explained by both trackers, live on every render: it sums matching `spends` (household) **and** `personalSpends` rows falling inside that card's billing-cycle window, "derived on every render rather than written onto the card, so it cannot drift from the entries it is a sum of, and cannot double up with the statement figure typed in beside it." The gap between that sum and the card's own billed figure is what was swiped and never logged anywhere.
