# Context & Objective

## The user

- India-based retail investor.
- Manages 3 portfolios:
  - **Me · India** — Zerodha/Kite broker.
  - **Wife · India** — Groww broker.
  - **Me · US** — INDmoney for US stocks.
- Source of truth before this app: a Google Sheet called **X-MyNotes**, specifically the **"Stock" tab** (gid `1300160237`). This sheet is a monthly portfolio performance tracker — the app was built to replace/complement that workflow on mobile.
- Tech literate but **not a frontend specialist**. Comfortable with PHP/MySQL/Mongo/Node/Python on Windows. No native mobile build tools installed — that's why we went PWA.

## Hard constraints (do not violate)

| Constraint | Why it matters |
|---|---|
| **Offline-first** | Phone has spotty connectivity; app must work without internet. |
| **No paid APIs** | User has stated this multiple times. No Alpha Vantage, no Yahoo Finance Pro, no live price feeds. |
| **No live prices** | Confirmed by user: "let it be offline". All prices are manually entered or OCR-ed. |
| **Phone storage only** | Data never leaves the device. No cloud sync, no Firebase, no backend. IndexedDB is the only store. |
| **No native build** | The app must be installable from the browser. No Cordova/Capacitor/React Native. PWA only. |
| **Free** | No subscriptions, no API keys with billing. |
| **Apache-served** | Lives under `C:\Apache24\htdocs\mynote\`, served at `http://localhost/mynote/`. No Node/Vite dev server. |
| **10-year horizon** | Must remain fast and reliable as data accumulates. |

## What success looks like for the user

> "Can it be my best private tracker?" — direct quote.

That means: simple, fast, private, reliable, no surprises. The user treats this as their **primary** portfolio tracker, not a toy. Treat data loss as the worst possible outcome.

## Workflow that drives the app

1. User opens broker app → takes screenshot of holdings (sometimes 4–5 screenshots if list is long).
2. Opens MyNote Stocks → taps 📷 → uploads screenshot(s).
3. OCR reads prices/units, fuzzy-matches to existing holdings, user reviews/corrects in modal, Apply.
4. App auto-captures the month's portfolio totals (invested/value/profit-loss + Nifty/Nasdaq benchmark).
5. Over months, the Trend + Heatmap + Overview tabs build up a real history.

Anything that breaks this loop loses the user's trust quickly. Test the OCR flow end-to-end when changing OCR code.

## Communication style with the user

- They prefer **terse, action-oriented** responses. Long preambles annoy them.
- They DO want **clear explanations of root causes** when something goes wrong. Don't just patch — explain *why*.
- They iterate fast. Be ready to revert an approach if they say so ("revert to previous version").
- They sometimes type fragmented phrases like "still its there" or "nothing changed..done hard refresh" — treat these as signals, not finished sentences. Read the screenshot if attached.

## Memory persistence

The user has a persistent memory file at `C:\Users\016142\.claude\projects\C--Apache24-htdocs-mynote\memory\MEMORY.md`. Read it via system context at session start. Today's date is auto-injected. Other facts there:
- User profile (India-based retail investor)
- X-MyNotes sheet reference
- Stock app project status
