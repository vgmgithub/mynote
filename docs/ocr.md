# OCR System

OCR is the most intricate part of the app and the source of most user-visible bugs. Read this before touching `ocr.js` or `openOcrReview` / `openOcrFlow` in `app.js`.

## High-level flow

```
[1-N image files]
     ↓
ocrImages(files, onProgress)        ← ocr.js, shared Tesseract worker
     ↓
[raw text per image]
     ↓
parseBrokerRows(text, portfolio)    ← ocr.js, per-portfolio dispatch
     ↓
[rows: {name, units, avg, ltp}]
     ↓
dedup by normalized name (first wins)   ← app.js, openOcrFlow
     ↓
_findStockMatch + alias lookup      ← app.js, openOcrReview
     ↓
[matched rows: {name, units, avg, ltp, match}]
     ↓
review modal (dropdown override + edit)
     ↓
apply() → DB writes + monthly snapshot
```

## Parser dispatch (per portfolio)

```js
// ocr.js
export function parseBrokerRows(text, portfolio) {
  if (portfolio === 'me-in')   return parseZerodhaStyle(text);
  if (portfolio === 'me-us')   return parseUSStyle(text);
  if (portfolio === 'wife-in') return parseGrowwStyle(text);
  return [];
}
```

Each portfolio is tied to exactly one broker. Trying "all parsers" was rejected — produces false positives across layouts.

### Zerodha/Kite (me-in)

Layout:
```
<Name>
<units> x <avg>
LTP: <price>
```

Returns `{ name, units, avg, ltp }`. All four fields trusted.

### INDmoney US (me-us)

Layout (one row spread across two lines):
```
<Name> <Qty> Qty
$<LTP> ▲ <chg%> Avg: $<Avg>
```

All four fields trusted.

### Groww (wife-in)

Layout:
```
<Name> ₹<Price>
<units> shares <day-change>
```

**No average price in this view** — Groww doesn't show it. So:
- `avg` is always `null` from this parser.
- The review modal hides the Avg column for wife-in (`noAvg` flag).
- The apply step gates avg writes via a per-row `ref.allowAvg` flag.
- **Units + price** are both written; **avg is preserved as-is** from the saved data.

#### Avg banner: unit-change escalation (wife-in only)

When the parsed units differ from the matched stock's saved units (i.e. the user bought or sold shares since the last update), the row appends an inline orange-tinted banner: *"Units changed (27 → 32) — set new average buy price:"* + an Avg input field.

Logic in `openOcrReview` → `checkAvgVisibility()`:
- For me-in / me-us: `ref.allowAvg = true` always (Avg column is in the main row).
- For wife-in:
  - `+ Add as new` rows → `allowAvg = false` (no baseline to compare; user can edit avg on the new stock card after Apply).
  - Existing match → compare `parsed.units` vs `match.stock.units` with tolerance `0.0001`. If different, show banner and set `allowAvg = true`.
- Re-evaluated on **dropdown change** (different stock = different saved units = maybe no banner) and on **units input change** (user edits the value in the review).
- Apply gate: `if (r.allowAvg && nA != null) fresh.buyPrice = nA`.

The banner spans the full row width via `grid-column: 1 / -1` — see `.ocr-row .ocr-avg-banner` in `styles.css`.

This solves the "unit count changed but Groww never shows avg" gap: users get prompted exactly when the avg needs updating, and never prompted when it doesn't.

#### Groww parser quirks (these cost real time, do not undo)

1. **₹ glued to digits.** Tesseract reads `Adani Power ₹230.03` with NO whitespace between `₹` and `230`. Old regex required whitespace before digits and silently dropped rows. Fix: tolerant regex that allows an optional currency glyph between name and digits:
   ```js
   /^(.*?\S)\s*[₹₨$€£]?\s*([\d,]+(?:\.\d+)?)\s*$/
   ```
2. **₹ misread as "3".** Sometimes Tesseract reads `₹230.03` as `3230.03`. The row still parses, but the price is wrong. Flagged in the review modal — see "suspect LTP" below.
3. **Sparkline noise lines.** Each Groww row has a tiny chart between the name and the shares count. Tesseract sometimes outputs a junk line there. Parser looks back **1–2 lines** to find the name+price pair, not just 1.

## Dedup across multiple images

`openOcrFlow` accumulates rows from all parsed texts, then deduplicates by `normName(r.name)` keeping the first occurrence. This handles scroll-overlap: the last stock of screenshot 1 might also appear as the first stock of screenshot 2 — keep the one from image 1 and skip the duplicate.

## Matching parsed rows to existing stocks

`_findStockMatch(parsedName, stocks)` in app.js:

1. **Exact** normalized match (alphanumeric lowercase) → returns immediately, score 1.
2. **Substring** either way → score = `min(len) / max(len)`.
3. **Shared leading letters** ≥ 3 → score = `k / max(len)`.
4. Always returns the best match, **no threshold**. User can untick or override in review.

Sold stocks are excluded from matching.

## Alias memory (user corrections persist)

`meta.ocr-aliases` is a `{ [portfolio|normName]: stockId }` map.

When the user changes the dropdown in the review modal:
- Picking a stock → `_saveOcrAlias(portfolio, parsedName, stockId)`.
- Picking "Skip" → `_saveOcrAlias(portfolio, parsedName, null)` (removes alias).

Next OCR run, `openOcrReview` checks aliases **before** the fuzzy matcher. If alias points to a live (non-sold) stock, that match is used and the dropdown labels it `★ Stock Name (saved match)`.

This is the single biggest UX improvement — "manual matches are remembered" means OCR gets better with use.

## Suspect LTP highlighting (orange)

Two heuristics, both add `.ocr-suspect` class to the LTP input:

1. **`suspectLtp(v)`**: `v != null && /^3\d{2,}/.test(String(Math.trunc(v)))`.
   Catches Tesseract's "₹ → 3" misread (₹84 read as "384", ₹230 as "3230"). Over-flags slightly — that's fine, user just glances.
   Tooltip: *"OCR may have misread the ₹ symbol as '3'. Verify against the screenshot."*

2. **`isBigJump(savedLtp, parsedLtp)`**: `Math.abs((b - a) / a) > 0.30`.
   Flags rows where the new price is > 30% off the saved currentPrice. Catches wrong matches and big OCR errors.
   Recomputed whenever the dropdown match changes (different stock → different saved price).
   Tooltip: *"Big change vs saved (₹230 → ₹3230). Confirm before applying."*

## Review modal layout

Two variants:

| Variant | Columns | Used by |
|---|---|---|
| Full (5-col) | ☐ · Stock · Units · Avg · LTP | me-in, me-us |
| No-avg (4-col) | ☐ · Stock · Units · Price | wife-in |

The "Stock" cell contains the parsed name + a `<select>` dropdown for manual override. The dropdown options:

1. `— Skip (no match) —` (empty value)
2. `+ Add as new stock` (sentinel `__new__`)
3. All active holdings in the current portfolio, A–Z.

The current match is pre-selected. Picking Skip disables the row. Picking `+ Add as new` flips `ref.match` to `{ addNew: true, name }` — at Apply time this creates a brand-new stock instead of updating an existing one.

## Apply logic (`apply()` inside `openOcrReview`)

For each enabled row:
- If `ref.match.addNew`: create a fresh stock with the OCR values (status: holding, category: '', empty notes). Avg is left null for wife-in.
- Else: read existing stock from DB, overwrite the fields OCR provided (gating avg for wife-in), recompute the current-month history entry from buy/current, save.

At the end, `monthly` store is updated with the post-apply totals — so OCR Apply auto-captures the month.

Toast shows: `Updated 6 · Added 2 · Jun 2026 captured`.

## Tesseract worker reuse

`ocrImages(files, onProgress)` creates **one** `createWorker('eng')` and reuses it across all images. Per-image overhead of `T.recognize()` (the convenience API) is ~1–2s of worker startup; for 4–5 images that adds up.

Per-image progress is reported via the shared `logger` with `{ fileIndex, fileCount }` injected so the loader shows `Image 2/4 · Recognizing · 73%`.

Tesseract.js itself is **CDN-loaded on first use** (`https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js`). The first OCR session online; subsequent are cached by the browser.

## Debug fallback

When `parseBrokerRows` returns zero rows across all images, `openOcrDebug(text)` shows the raw OCR text in a textarea so the user can copy it and we can tune the parser. This has been invaluable when Groww layouts change.

## Things that will surprise a new session

- The 📷 button's visibility is controlled by `render()` in app.js. CSS `.hidden` used to lose to `.fab.fab-secondary { display: flex }` on specificity — see [gotchas.md → CSS specificity](gotchas.md#css-specificity-the-hidden-utility-trap). It now uses `!important`.
- Wife/Groww OCR was once disabled (`return []`) because of the ₹ glyph issues. It is now re-enabled with the price+units flow and the no-avg flag. **Do not re-disable** without asking.
- `parseGrowwStyle` is exported and dispatched from `parseBrokerRows`. Earlier it was defined but unreachable — that was deliberate at one point, no longer.
