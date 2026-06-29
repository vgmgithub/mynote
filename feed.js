// Feed & Recommendations — Marketaux news fetch + offline recommendation engine.
//
// Online path: pulls last-24h news per stock from Marketaux's free tier
// (100 requests/day). Each article carries a per-entity sentiment score from
// the API; we record it alongside the headline. Nothing leaves the device
// except the stock NAME and the user's API key.
//
// Offline path: combines the cached sentiment with the user's local price
// history (already in IndexedDB) to produce a conservative per-stock label.
// Pure JS, no external libs, no LLM. See computeRecommendation() for the rules.
//
// Data retention: 7-day rolling window. Articles older than 7 days are auto-deleted.
// Sentiment computed as both 24h (today's news) and 7d (week's trend) for stability.

import { DB } from './db.js';

const MARKETAUX_BASE = 'https://api.marketaux.com/v1/news/all';

export const FEED_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const FEED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day rolling window
export const MARKETAUX_FREE_LIMIT = 100; // per-day cap on the free tier (informational)

// ---- Cache & meta layer ----

// YYYY-MM-DD in IST (UTC+5:30) for a given epoch ms.
function toISTDateStr(ms) {
  const d = new Date(ms + (5 * 60 + 30) * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// getCachedFeed returns a Map<stockId, aggregatedEntry> where each entry merges
// all daily buckets for that stock from the last 7 days. The returned shape is
// identical to what app.js expects (items, sentiment24h, sentiment7d, lastFetched),
// so callers don't change.
export async function getCachedFeed(portfolio) {
  const all = await DB.byPortfolio('feed', portfolio).catch(() => []);
  const todayStr = toISTDateStr(Date.now());

  // Group rows by stockId — one row per day per stock (plus any old-format rows).
  const grouped = new Map();
  for (const row of all || []) {
    if (!grouped.has(row.stockId)) grouped.set(row.stockId, []);
    grouped.get(row.stockId).push(row);
  }

  const map = new Map();
  for (const [stockId, rows] of grouped) {
    // Sort newest first (daily bucket keys sort lexicographically: YYYY-MM-DD).
    rows.sort((a, b) => (b.dateStr || '').localeCompare(a.dateStr || ''));
    const newest = rows[0];

    // Aggregate articles across all buckets, dedup by URL → title.
    const seen = new Set();
    const allItems = [];
    for (const row of rows) {
      for (const it of row.items || []) {
        const k = it.url || it.title;
        if (!k || seen.has(k)) continue;
        seen.add(k);
        allItems.push(it);
      }
    }

    // sentiment24h: average over articles in today's bucket (if it exists today).
    const todayRow = newest && newest.dateStr === todayStr ? newest : null;
    const items24h = todayRow ? (todayRow.items || []) : [];
    const sentiment24h = items24h.length
      ? items24h.reduce((s, it) => s + (Number(it.sentiment) || 0), 0) / items24h.length
      : 0;

    // sentiment7d: average over all aggregated articles.
    const sentiment7d = allItems.length
      ? allItems.reduce((s, it) => s + (Number(it.sentiment) || 0), 0) / allItems.length
      : 0;

    // Per-day breakdown for the timeline dots (oldest→newest, only days with articles).
    const days = rows.slice().reverse()
      .filter((r) => r.items && r.items.length)
      .map((row) => {
        const its = row.items || [];
        let pos = 0, neg = 0;
        for (const it of its) {
          const sc = Number(it.sentiment) || 0;
          if (sc > 0.15) pos++; else if (sc < -0.15) neg++;
        }
        return {
          dateStr: row.dateStr || '',
          count: its.length,
          sentiment: pos > neg ? 'pos' : neg > pos ? 'neg' : 'neu',
        };
      });

    map.set(stockId, {
      key: newest ? newest.key : portfolio + '|' + stockId,
      portfolio,
      stockId,
      stockName: newest ? newest.stockName : '',
      items: allItems,           // full 7-day aggregated (used in All tab)
      todayItems: items24h,      // today's bucket only (used in Today's Stocks tab)
      sentiment24h,
      sentiment7d,
      lastFetched: newest ? (newest.lastFetched || 0) : 0,
      dateStr: newest ? newest.dateStr : '',
      days,
      todayCount: items24h.length,
    });
  }
  return map;
}

// saveFeedEntry writes a single daily bucket (portfolio|stockId|YYYY-MM-DD).
// Re-syncing the same day merges new articles with the existing bucket (dedup).
// After writing, buckets older than 7 days for this stock are pruned.
// Also removes any legacy single-row key (portfolio|stockId, no date) so old
// data migrates out naturally on the first sync.
export async function saveFeedEntry(entry, dateStr) {
  const now = Date.now();
  const key = entry.portfolio + '|' + entry.stockId + '|' + dateStr;

  // Same-day re-sync: merge with existing bucket so articles accumulate.
  const existing = await DB.get('feed', key).catch(() => null);
  let items = entry.items || [];
  if (existing && existing.items && existing.items.length) {
    const combined = [...existing.items, ...items];
    const seen = new Set();
    items = combined.filter((it) => {
      const k = it.url || it.title;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const items24h = items.filter((it) => {
    const parsed = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
    return !isNaN(parsed) && (now - parsed) <= 24 * 60 * 60 * 1000;
  });
  const sentiment24h = items24h.length
    ? items24h.reduce((s, it) => s + (Number(it.sentiment) || 0), 0) / items24h.length
    : 0;
  const sentiment7d = items.length
    ? items.reduce((s, it) => s + (Number(it.sentiment) || 0), 0) / items.length
    : 0;

  await DB.put('feed', {
    key,
    portfolio: entry.portfolio,
    stockId: entry.stockId,
    stockName: entry.stockName,
    dateStr,
    items,
    sentiment24h,
    sentiment7d,
    lastFetched: now,
    lastError: null,
  });

  // Prune buckets older than 7 days for this stock.
  const cutoff = toISTDateStr(now - FEED_WINDOW_MS);
  const stockPrefix = entry.portfolio + '|' + entry.stockId + '|';
  const allRows = await DB.byPortfolio('feed', entry.portfolio).catch(() => []);
  for (const row of allRows) {
    if (!row.key.startsWith(stockPrefix)) continue;
    const rowDate = row.key.slice(stockPrefix.length);
    if (rowDate < cutoff) await DB.del('feed', row.key).catch(() => {});
  }

  // Migration: delete legacy single-row key (portfolio|stockId without date).
  const legacyKey = entry.portfolio + '|' + entry.stockId;
  const legacyRow = await DB.get('feed', legacyKey).catch(() => null);
  if (legacyRow && !legacyRow.dateStr) await DB.del('feed', legacyKey).catch(() => {});
}

export async function getLastFetch(portfolio) {
  const rec = await DB.get('meta', 'feedLastFetch_' + portfolio).catch(() => null);
  return (rec && rec.value) || 0;
}

export async function setLastFetch(portfolio, ms) {
  await DB.put('meta', { key: 'feedLastFetch_' + portfolio, value: ms });
}

export async function getApiKey() {
  const rec = await DB.get('meta', 'feedApiKey').catch(() => null);
  return (rec && rec.value) || '';
}

export async function saveApiKey(key) {
  await DB.put('meta', { key: 'feedApiKey', value: key || '' });
}

// ---- Refresh schedule ----

const _IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // UTC+5:30 in ms

// Returns true when a fresh fetch is due.
//
// Anchor times (IST):
//   India portfolios (me-in, wife-in) → 08:30 — NSE pre-open starts at 09:00.
//   US portfolio (me-us)              → 18:30 — NYSE opens; market closes ~22:30 IST.
//
// Logic: find the most recent anchor point before now. If the last fetch
// happened before that anchor, we are stale and need a sync. This ensures
// each portfolio gets exactly one auto-sync per trading session regardless
// of how many times the user opens the app.
export function shouldAutoRefresh(lastFetchMs, portfolio, nowMs) {
  if (!lastFetchMs) return true;

  const isUS = portfolio === 'me-us';
  const anchorH = isUS ? 18 : 8;
  const anchorM = 30;

  // Build a Date whose UTC fields read as IST local time (shift by +5:30).
  const nowIST = new Date(nowMs + _IST_OFFSET_MS);

  // Today's anchor expressed in "shifted UTC" then converted to real UTC ms.
  const todayAnchorShiftedMs = Date.UTC(
    nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(),
    anchorH, anchorM
  );
  const todayAnchorMs = todayAnchorShiftedMs - _IST_OFFSET_MS;

  const nowISTMins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  const anchorISTMins = anchorH * 60 + anchorM;

  // If we haven't reached today's anchor yet, the last anchor was yesterday's.
  const lastAnchorMs = nowISTMins >= anchorISTMins
    ? todayAnchorMs
    : todayAnchorMs - 24 * 60 * 60 * 1000;

  return lastFetchMs < lastAnchorMs;
}

// ---- Offline sentiment fallback (used when an article has no API score) ----

const POSITIVE_WORDS = new Set([
  'beat', 'beats', 'beating', 'growth', 'grew', 'growing', 'surge', 'surged',
  'outperform', 'outperformed', 'raised', 'raise', 'expand', 'expanded',
  'record', 'rally', 'rallied', 'upgrade', 'upgraded', 'profit', 'profits',
  'gain', 'gains', 'gained', 'approves', 'approved', 'wins', 'won',
  'milestone', 'success', 'successful', 'strong', 'robust', 'positive',
  'jump', 'jumped', 'climb', 'climbed', 'rise', 'rose', 'boost', 'boosted',
  'exceeds', 'exceeded', 'higher', 'best', 'better', 'launch', 'launched',
]);

const NEGATIVE_WORDS = new Set([
  'miss', 'missed', 'misses', 'decline', 'declined', 'declining',
  'fall', 'fell', 'falling', 'downgrade', 'downgraded', 'loss', 'losses',
  'fraud', 'investigation', 'investigated', 'delisting', 'delisted',
  'bankruptcy', 'bankrupt', 'scam', 'warning', 'regulatory', 'fine',
  'fined', 'penalty', 'penalized', 'plunge', 'plunged', 'slump', 'slumped',
  'crash', 'crashed', 'weak', 'weakness', 'concern', 'concerned',
  'worry', 'worries', 'lawsuit', 'sued', 'probe', 'raid', 'lower', 'worst',
]);

const MAJOR_EVENT_RE = /\b(fraud|bankrupt|delist|scam|sebi investigation|sec investigation|raid|arrest)/i;

export function applyKeywordSentiment(text) {
  if (!text) return 0;
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  if (!words.length) return 0;
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  // Normalise by /5 so a 25-word headline with 3 negative words ≈ score -0.6
  const score = (pos - neg) / Math.max(1, words.length / 5);
  return Math.max(-1, Math.min(1, score));
}

// ---- Online fetch ----

// Normalise a company name for fuzzy matching: lowercase, strip legal suffixes,
// collapse whitespace. "Bharat Electronics Limited" → "bharat electronics".
function _normCompanyName(s) {
  return (s || '').toLowerCase()
    .replace(/\b(ltd|limited|corp|corporation|inc|co|pvt|private|plc|llc|group|holdings?)\b\.?/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns true when a Marketaux entity looks like it refers to our stock.
// Handles both full names ("BEML Limited" ↔ "BEML") and tickers ("IOB.NS" ↔ "IOB").
function _entityMatchesStock(entity, stockName) {
  const eName  = _normCompanyName(entity.name || '');
  const eSym   = (entity.symbol || '').toUpperCase().split('.')[0]; // strip .NS / .BO suffix
  const sName  = _normCompanyName(stockName);
  const sUpper = stockName.trim().toUpperCase();

  if (eName && sName && (eName.includes(sName) || sName.includes(eName))) return true;
  if (eSym  && sUpper && eSym === sUpper) return true;
  return false;
}

async function fetchOne(stock, apiKey, signal) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    api_token: apiKey,
    search: stock.name,
    filter_entities: 'true',
    language: 'en',
    limit: '3',
    published_after: since,
  });
  const res = await fetch(MARKETAUX_BASE + '?' + params.toString(), { signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch (_) {}
    throw new Error('Marketaux ' + res.status + (detail ? ' · ' + detail : ''));
  }
  const data = await res.json();
  const articles = [];
  for (const a of (data.data || [])) {
    const entities = Array.isArray(a.entities) ? a.entities : [];

    // Find the entity that corresponds to our stock. If entities are present but
    // none match, the article is about something else — skip it entirely.
    // (e.g. a general IT-sector article tagged Infosys/TCS shouldn't appear under BEML)
    const match = entities.find((e) => _entityMatchesStock(e, stock.name));
    if (entities.length > 0 && !match) continue;

    // Use the matched entity's own sentiment score so the signal reflects how
    // this specific company is covered, not a diluted average across all mentions.
    let sentiment;
    if (match && match.sentiment_score != null) {
      sentiment = Number(match.sentiment_score);
    } else {
      sentiment = applyKeywordSentiment((a.title || '') + ' ' + (a.description || a.snippet || ''));
    }
    articles.push({
      title: a.title || '',
      summary: a.description || a.snippet || '',
      source: a.source || '',
      url: a.url || '',
      publishedAt: a.published_at || '',
      sentiment: Math.max(-1, Math.min(1, Number(sentiment) || 0)),
    });
  }
  return articles;
}

// Sequential fetch per stock. Marketaux's `search=` doesn't accept multiple
// keywords, so batching isn't possible — but 1 request per stock × ~30 stocks
// in a portfolio stays well under the 100/day free-tier cap.
//
// `onProgress` receives { done, total, current } so the UI can show "fetching
// 7 of 25 · Reliance". `out` maps stockId → { items, error }.
export async function fetchNewsForStocks(stocks, apiKey, onProgress, signal) {
  if (!apiKey) throw new Error('Marketaux API key not set.');
  const out = new Map();
  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];
    if (signal && signal.aborted) throw new Error('Aborted');
    if (onProgress) onProgress({ done: i, total: stocks.length, current: stock.name });
    try {
      const items = await fetchOne(stock, apiKey, signal);
      out.set(stock.id, { items, error: null });
    } catch (e) {
      out.set(stock.id, { items: [], error: String(e.message || e) });
    }
  }
  if (onProgress) onProgress({ done: stocks.length, total: stocks.length, current: null });
  return out;
}

// ---- Recommendation engine (pure, offline) ----

// Conservative, deterministic rules. Many "Hold" outputs by design — daily news
// is genuinely noisy for a long-term holding strategy, and a confident-sounding
// recommendation on weak signal is worse than no recommendation at all.
//
//   stock:      { name, conviction ('up'|'watch'|'down'|''), buyPrice, currentPrice, ... }
//   items:      cached news items for the period (each with sentiment in [-1, +1])
//   history:    stock.history (array of { month, pct })
//   sentiment24h, sentiment7d: pre-computed score averages (fallback when days[] is thin)
//   days:       per-day breakdown [{dateStr, count, sentiment:'pos'|'neg'|'neu'}], oldest-first
export function computeRecommendation(stock, items, history, sentiment24h, sentiment7d, days) {
  // Rule 1 — critical event keyword anywhere in title/summary.
  for (const it of items || []) {
    if (MAJOR_EVENT_RE.test((it.title || '') + ' ' + (it.summary || ''))) {
      return {
        label: 'Critical event — review thesis',
        color: 'red',
        reason: 'A news item flagged a major event (fraud / bankruptcy / regulatory).',
        severity: 'critical',
      };
    }
  }

  // Price history — sort ascending, sum last 3 months.
  const sortedHist = (history || []).slice().sort((a, b) => (a.month || '').localeCompare(b.month || ''));
  const last3Sum = sortedHist.slice(-3).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  // conviction values from CONVICTIONS: 'up' | 'watch' | 'down' | ''
  const conviction = (stock.conviction || '').toLowerCase();

  // Rule 2 — no news in 7-day window.
  if (!items || !items.length) {
    if (last3Sum < -15) {
      return { label: 'Hold — price declining', color: 'grey', reason: 'No news this week, but price has been falling. Keep monitoring.', severity: 'neutral' };
    }
    return { label: 'Hold', color: 'grey', reason: 'No news in the last 7 days.', severity: 'neutral' };
  }

  // Count-based 7d signal — consistent with feed card verdicts (majority vote per day).
  // Falls back to score-based thresholds when fewer than 2 days of data are available.
  const validDays = (days || []).filter(d => d.count > 0);
  const negDays = validDays.filter(d => d.sentiment === 'neg').length;
  const posDays = validDays.filter(d => d.sentiment === 'pos').length;
  const totalDays = validDays.length;
  const negRatio = totalDays > 0 ? negDays / totalDays : 0;
  const posRatio = totalDays > 0 ? posDays / totalDays : 0;
  const hasEnoughDays = totalDays >= 2;
  const strongNeg = hasEnoughDays ? negRatio > 0.6  : sentiment7d <= -0.4;
  const mildNeg   = hasEnoughDays ? (negRatio >= 0.4 && !strongNeg) : false;
  const strongPos = hasEnoughDays ? posRatio > 0.6  : sentiment7d >= 0.4;

  // Below cost basis? Averaging down is only meaningful when already at a loss.
  const belowCost = stock.buyPrice && stock.currentPrice &&
    Number(stock.currentPrice) > 0 && Number(stock.buyPrice) > 0 &&
    Number(stock.currentPrice) < Number(stock.buyPrice);

  // Rule 3 — improving: mostly negative week but today turned positive.
  // Don't act yet — wait for a clearer trend.
  if (strongNeg && sentiment24h > 0.15) {
    return {
      label: 'Watch — possibly turning',
      color: 'orange',
      reason: `Week had mostly negative news (${negDays}/${totalDays} days) but today looks positive. Wait for a clearer trend before acting.`,
      severity: 'caution',
    };
  }

  // Rule 4 — strong negative week + falling 3m price + high conviction → averaging hint.
  if (strongNeg && last3Sum < -10 && conviction === 'up') {
    const dropMagnitude = Math.abs(last3Sum) / 10; // 10% drop = 1.0
    const sentimentWeight = negRatio || 0.5;
    const baseUnits = Math.max(1, Math.floor(dropMagnitude * sentimentWeight * 10));
    const minUnits = Math.max(1, Math.floor(baseUnits * 0.5));
    const maxUnits = Math.floor(baseUnits * 1.5);
    const unitsStr = minUnits === maxUnits ? String(minUnits) : `${minUnits}-${maxUnits}`;
    const costNote = belowCost ? ' Stock is below your buy price.' : '';
    return {
      label: 'Consider averaging',
      color: 'blue',
      reason: `Negative news ${negDays}/${totalDays} days + price down — if thesis holds, consider adding ${unitsStr} units.${costNote}`,
      severity: 'opportunity',
      suggestedUnits: { min: minUnits, max: maxUnits },
    };
  }

  // Rule 5 — strong negative week + falling 3m price (lower/no conviction) → caution.
  if (strongNeg && last3Sum < -10) {
    return {
      label: 'Watch carefully',
      color: 'orange',
      reason: `Negative news ${negDays}/${totalDays} days + price falling — review your thesis.`,
      severity: 'caution',
    };
  }

  // Rule 6 — mild or strong negative + some price weakness (< -5%) → monitor.
  if ((strongNeg || mildNeg) && last3Sum < -5) {
    return {
      label: 'Monitor',
      color: 'orange',
      reason: 'Some negative news this week with mild price weakness. Watch fundamentals.',
      severity: 'caution',
    };
  }

  // Rule 7 — strong positive week.
  if (strongPos) {
    return {
      label: 'Hold',
      color: 'green',
      reason: `Positive news ${posDays}/${totalDays} days this week. Thesis appears intact.`,
      severity: 'positive',
    };
  }

  // Rule 8 — mixed / neutral.
  return {
    label: 'Hold',
    color: 'grey',
    reason: 'Mixed signals this week — no strong direction.',
    severity: 'neutral',
  };
}
