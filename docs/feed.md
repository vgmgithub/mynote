# Feed & Recommendations

A bottom-nav tab that pulls last-24h news for the user's current holdings, then folds news sentiment + local price history into a conservative per-stock label. Online fetch via Marketaux. Recommendation engine is fully offline.

## Why this design

- **No paid APIs, no backend, no server-side code.** Marketaux's free tier (100 req/day) is the only network call. Direct browser fetch — CORS works.
- **Privacy:** only stock NAME + the user's API key leave the device. No prices, no balances, no identity. The fetch function in `feed.js` is passed `{id, name}` objects, not full stock records.
- **Offline-first:** recommendation logic is a pure function — works whenever cached news exists, no network needed.
- **Honest:** 24h news for a 10-year horizon is noisy. Rules are deliberately conservative; many "Hold" outputs.

## User flow

1. **First time** — user taps Feed tab. No API key set → onboarding card with sign-up link.
2. **API key entry** — Menu → "Feed settings" → paste key → Save. Stored in `meta.feedApiKey`.
3. **Refresh** — tap "Refresh now", or let the app auto-sync when the portfolio is stale for the current market session.
4. **View** — per-stock card with recommendation badge + reason. Tap card to expand news list.

## File: `feed.js` (~250 lines)

Lazy-loaded module (`await import('./feed.js')` from `renderFeed()` / `openFeedSettings()`). Users who never visit Feed never download it.

### Exports

| Name | Purpose |
|---|---|
| `FEED_CACHE_TTL_MS` | Legacy 12h constant; current auto-refresh uses `shouldAutoRefresh()` session anchors. |
| `MARKETAUX_FREE_LIMIT` | 100, informational. |
| `getApiKey()` / `saveApiKey(key)` | Reads/writes `meta.feedApiKey`. |
| `getCachedFeed(portfolio)` | Returns `Map<stockId, entry>` from the `feed` store. |
| `saveFeedEntry(entry)` | Persists one stock's feed entry. |
| `getLastFetch(portfolio)` / `setLastFetch(portfolio, ms)` | Per-portfolio fetch timestamps in `meta`. |
| `shouldAutoRefresh(lastFetchMs, portfolio, nowMs)` | Stale check based on IST session anchors: 08:30 for India portfolios, 18:30 for US. |
| `fetchNewsForStocks(stocks, apiKey, onProgress, signal)` | Online fetch. Sequential per stock — Marketaux `search=` doesn't batch. Returns `Map<stockId, {items, error}>`. |
| `computeRecommendation(stock, items, history)` | Pure function. Returns `{label, color, reason, severity}`. |
| `applyKeywordSentiment(text)` | Fallback sentiment scorer (used when Marketaux article has no entity sentiment). |

### Marketaux query

```
GET https://api.marketaux.com/v1/news/all
  ?api_token=<KEY>
  &search=<stockName>
  &filter_entities=true
  &language=en
  &limit=3
  &published_after=<24h ago, ISO>
```

We use `search=` for **all** portfolios. Marketaux's `symbols=` supports multi-symbol batching but requires tickers we don't capture today (would need `.NS`/`.BO` suffixes for Indian stocks). Search-by-name keeps the data model simple and works equally for India and US.

Per article we record `{title, summary, source, url, publishedAt, sentiment}`. Sentiment comes from Marketaux's per-entity `sentiment_score` (averaged across entities in the article); when missing, falls back to the offline keyword classifier.

## File: `db.js` — new `feed` store (v3 migration)

```js
if (!db.objectStoreNames.contains('feed')) {
  const s = db.createObjectStore('feed', { keyPath: 'key' });
  s.createIndex('portfolio', 'portfolio', { unique: false });
}
```

Entry shape:

```js
{
  key: 'me-in|42',                  // portfolio | stockId
  portfolio: 'me-in',
  stockId: 42,
  stockName: 'Adani Power',
  items: [{title, summary, source, url, publishedAt, sentiment}, ...],
  recommendation: { label, color, reason, severity },
  lastFetched: 1733049600000,
  lastError: null,
}
```

`exportAll()` / `importAll()` were extended to include the `feed` store. Older v2 backups (no `feed` field) restore cleanly — the importer treats missing feed as `[]`.

## Recommendation rules (in `computeRecommendation`)

First match wins:

| # | Condition | Output |
|---|---|---|
| 1 | Any item title/summary matches `/\b(fraud\|bankrupt\|delist\|scam\|sebi investigation\|sec investigation\|raid\|arrest)/i` | **Critical event — review thesis** (red) |
| 2 | `items.length === 0` | **Hold** (grey) — "No news in last 24h" |
| 3 | `avgSentiment ≤ -0.4` AND `last3MonthSum < -10` AND `stock.conviction === 'high'` | **Consider averaging** (blue) |
| 4 | `avgSentiment ≤ -0.4` AND `last3MonthSum < -10` | **Watch carefully** (orange) |
| 5 | `avgSentiment ≥ 0.4` | **Hold** (green) — "Positive news supports your position" |
| 6 | otherwise | **Hold** (grey) — "Mixed signals" |

Inputs:
- `avgSentiment`: mean of items' sentiment in `[-1, 1]`.
- `last3MonthSum`: sum of last 3 monthly returns from `stock.history`.
- `stock.conviction`: existing field ('high' / 'medium' / 'low' / '').

A disclaimer banner above the card list reinforces "not financial advice."

## Data retention

- **7-day rolling window:** articles are accumulated over 7 days. New fetches APPEND articles; articles older than 7 days are auto-deleted.
- **Sentiment computed:** both `sentiment24h` (today's news) and `sentiment7d` (week's trend) to smooth out noise.
- **Example:** Mon fetch = 2 articles, Tue fetch = 3 articles (total 5), Wed = 4 articles (total 9). By next Monday, the first day's articles expire, keeping a rolling 7-day window.

## Refresh model

- **Manual:** "Refresh now" button on the Feed tab. Always works (subject to API key + network).
- **Auto:** triggers silently on app open for the active portfolio if online and stale for the current session. It also triggers when entering the Feed tab if stale. UI shows cached results while it runs.
- **Lock:** the `_feedFetchInFlight` flag prevents double-tap and overlapping fetches.

## Filter toggle

- **All holdings** vs **Has news only** toggle to reduce clutter when many stocks have no recent news coverage.

## Privacy

| Data leaving device | Going to |
|---|---|
| Stock NAME (only) | Marketaux `/v1/news/all` |
| User's API key | Marketaux (as `api_token` query param) |
| **Nothing else** — no prices, no balances, no portfolio sums, no user identity, no IP-level identifier beyond what HTTP normally exposes | — |

Enforced at the call site in `refreshFeedNow()`:
```js
const sanitised = holdings.map((s) => ({ id: s.id, name: s.name }));
mod.fetchNewsForStocks(sanitised, apiKey, ...);
```
Other stock fields (units, prices, etc.) **never** reach `fetchNewsForStocks`.

## UI layout (`renderFeed` in app.js)

1. **Disclaimer card** — small, muted: "Recommendations are based on… Not financial advice. Only stock names…"
2. **Action row** — Refresh now button + "Last updated 4h ago" + status pill (Online / Offline / API key needed).
3. **Empty state** — if no holdings: "No active holdings — Feed is empty."
4. **Per-stock card list** — for the current portfolio's active (non-sold) holdings. Each card:
   - Name + colored recommendation badge.
   - 1-line reason.
   - Article count or "No news today".
   - Tap to expand → list of articles with title (link), source, relative time, sentiment chip.

CSS classes: `.feed-disclaimer`, `.feed-actions`, `.feed-status` (with `.online/.offline/.nokey`), `.feed-card`, `.feed-badge` (with `.red/.orange/.green/.blue/.grey`), `.feed-articles`, `.feed-article-*`. See `styles.css`.

## Gotchas

- **Marketaux Indian coverage is patchy.** Small/mid-caps may return zero results — Feed shows "No news today" for those, which is correct (better than fake news).
- **Auto-refresh can fire on app open for the active portfolio.** It is still gated by the session anchor and `_feedFetchInFlight`, so it should not double-fetch repeatedly.
- **`navigator.onLine`** is the best signal we have for offline; it's not perfectly reliable on all browsers, but it's good enough for "show cached + don't bother fetching."
- **External links open with `rel="noopener" target="_blank"`** so a malicious news source can't reach back into the app via `window.opener`.
- **The card tap toggles article visibility**, but clicks on the actual `<a>` are excluded so external navigation still works (see `if (e.target.tagName === 'A') return;` in the handler).
