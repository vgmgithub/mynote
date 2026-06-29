# Future Work / Discussed but Not Built

Each item below has been mentioned in conversation. Do NOT pick these up unprompted — the user has views on each. When they ask, you'll have the context to ship fast.

---

## 1. Auto-capture monthly snapshot

**User goal:** "I always want to note the month-end value" without having to remember to tap **Capture this month**.

**Current state:** OCR Apply auto-captures the current month. The standalone "Capture this month" button is the manual fallback.

**Options discussed (user is choosing):**

| Option | Behavior | Cost |
|---|---|---|
| **A. Banner** *(recommended)* | When app opens in a new month, show a "📌 May snapshot not captured — Capture now" banner on the Trend tab. One tap captures or dismisses. | Cheap |
| **B. Silent auto-capture** | First open in a new month auto-snapshots the previous month using current app values. | Cheap, but if prices weren't updated to month-end, the snapshot is stale. |
| **C. Last-captured indicator** | "Last captured 12 days ago" line on Trend tab. Pure visibility, no automation. | Smallest. |

Recommendation: **A + C together.** Awaiting user decision.

---

## 2. STCG / LTCG tax summary

**User goal:** A view that helps at Indian tax-filing time.

**Layout sketch:**
```
FY 2025-26 (Apr 2025 – Mar 2026)
├── Short-Term (held <1yr, 15%)
│   ├── Stock A: bought ₹1,000 → sold ₹1,500 = +₹500
│   └── Total STCG: ₹12,000 → tax ≈ ₹1,800
└── Long-Term (held >1yr, 10% above ₹1L exempt)
    ├── Stock B: bought ₹2,000 → sold ₹3,500 = +₹1,500
    └── Total LTCG: ₹1,80,000 → taxable ₹80,000 → tax ≈ ₹8,000
```

**Schema check (good news):** `stocks` already has `soldDate`, `soldPrice`, `soldUnits`, and `buyPrice`. No migration needed. Holding period = `soldDate - createdAt`.

**Caveat:** "createdAt" is when the record was added to the app, not the actual buy date. The user may need a separate "buyDate" field for accurate tax math. Ask before adding.

**Where it goes:** New section in Overview tab. Or a new "Tax" tab. User to choose.

---

## 3. Notes / thesis per stock

User already tracks investment notes ("buy reason", "target price") in their X-MyNotes sheet. A `notes` field exists on the stock record (`notes: ''`) but UI is minimal.

**To build:** Larger textarea in the stock editor, prominent display on the detail screen. Possibly a "Target price" with a soft alert when LTP crosses it.

---

## 4. Dividend tracking

User said "leave those for now". Re-raise at user's prompt.

If built: a `dividends` store keyed by `(stockId, date)`, sum into the stock's realized return.

---

## 5. Auto-lock on idle / when returning from background

App lock is currently "unlock once per app open". Could re-lock after N minutes of inactivity or on `visibilitychange`.

Implementation hooks:
- `visibilitychange` listener.
- Idle timer reset on each user interaction.
- `showLockScreen()` is already a promise-returning function — can be called again to re-lock.

Easy to add; not done because user hasn't asked.

---

## 6. Multi-broker per portfolio

Currently each portfolio = one broker. A future user might want to track e.g. Zerodha + ICICI Direct under the same "Me · India" umbrella. Would need either:
- A broker field on the stock record.
- Or per-portfolio sub-pools.

Not a current need. Don't preempt.

---

## 7. PIN length other than 4

`PIN_LENGTH = 4` in `lock.js`. If user requests 6-digit, change the constant and update CSS (`.pin-dots` gap may need tuning at 6 dots).

---

## 8. Recovery via backup file at lock screen

Instead of `wipeAllData()` on Forgot PIN, allow the user to upload a backup file at the lock screen to restore *and* reset the lock. Adds attack surface (an attacker with a stolen backup file could bypass the PIN). Not built; intentional.

---

## 9. Sell date as buy date proxy

For tax math (#2), we may need a true `buyDate`. Currently the closest field is `createdAt` (when added to the app). Migration plan if needed:
- DB v3: add `buyDate` field.
- Backfill from `createdAt` (best-effort).
- Editor adds a buyDate input.

---

## 10. Things explicitly NOT to build

- **Live prices API** — user wants offline.
- **Cloud sync** — user wants device-local.
- **Native APK** — PWA only.
- **Mutual funds as a separate concept** — they live inside `stocks` (e.g. "SBI MF" rows in wife's Groww).
- **Multi-user / family sharing** — single-user app.
- **Charts beyond what's already there** — keep visual surface minimal.
