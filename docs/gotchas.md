# Gotchas

Bugs and traps that cost real time. Read these before debugging.

---

## Service worker updates — user-triggered (v44+)

**Old problem:** browser was HTTP-caching `service-worker.js` itself, so CACHE bumps weren't being detected. Auto-reload couldn't fire.

**Old fix (v43):** `updateViaCache: 'none'` on the SW register call. This solved the detection problem but introduced **automatic** updates — the page would reload itself on every deploy, sometimes mid-flow. User asked for control.

**Current design (v44+):** updates are detected automatically but **applied only when the user explicitly taps Menu → "Check for updates"**.

### How it works

1. **App opens** → `navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })`. Browser may auto-check for SW updates (on navigation, every 24h, etc.) and the fetch bypasses HTTP cache.
2. **New SW found** → installs into the "waiting" slot. Does **not** activate (no `skipWaiting()` in `install`).
3. **App detects the waiting SW** via `reg.waiting` and the `updatefound` event → sets `window.__updateReady = true`.
4. **Menu** reads `__updateReady` and flips the update item's label:
   - `false` → "Check for updates" / "Pull the latest version from the server"
   - `true` → "Update available — tap to apply" / "A new version is ready to install"
5. **User taps** → `checkForUpdates()` either:
   - postMessages `{ type: 'SKIP_WAITING' }` to the waiting SW → SW activates → `clients.claim()` → `controllerchange` fires → page reloads.
   - Or calls `reg.update()` first to fetch latest, then waits for install, then triggers skip-wait.
6. **No tap = no reload.** Old SW keeps serving the cached version indefinitely.

### Key behavioral properties

- **No surprise reloads.** The page only reloads when the user has explicitly asked for an update.
- **Always-current detection.** Background check still happens (browser-driven + manual), so the menu badge is accurate.
- **Network cost when idle:** zero — only the browser's own occasional update check runs in the background.
- **Stale-version risk:** if the user never taps "Check for updates", they stay on the old version forever. For a personal app where the user collaborates with us on changes, this is fine — they'll naturally tap after a session.

### Defense-in-depth still in place

- `controllerchange` listener in `app.js` → reloads once after user-triggered activation. Now this reload is *expected*, not surprising.
- `cache: 'no-store'` on revalidation fetches in `service-worker.js`.
- `cache: 'reload'` on precache fetches → SW install always pulls fresh.
- `clients.claim()` in `activate` so the activated SW takes over immediately (only happens after user tap).
- `?reset=1` URL param in `index.html` → nuclear option, wipes SW + caches + reloads.
- Backup file `lastBackup` reminder so they have a way out if data is lost.

### What changed in service-worker.js

- **Removed** `await self.skipWaiting()` from the install handler.
- **Added** a `message` listener: `{ type: 'SKIP_WAITING' }` → `self.skipWaiting()`. This is the only way a new SW activates.

### What changed in app.js init

- **Removed** automatic `reg.update()` call on every load.
- **Added** detection of `reg.waiting` + `updatefound` event → sets `window.__updateReady`.
- **Kept** `controllerchange` listener, but it now only fires when the user has explicitly triggered an update (so the reload is intentional).
- **Added** `window.__swReg` reference so the menu's update flow can find the registration.

### How to bump a version (current process)

1. Make code changes.
2. Bump `CACHE = 'mynote-stocks-vNN'` in `service-worker.js`.
3. Add any new files to the `ASSETS` precache list.
4. **No need to ask the user to clear cache.** When they next open the app and tap Menu → "Check for updates", their app updates cleanly.

**The reliable manual fix (give the user this):**

DevTools Console one-liner:
```js
(async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())await caches.delete(k);location.reload()})()
```

OR DevTools → Application tab → "Clear site data" (uncheck **IndexedDB** to keep data) → reload.

OR navigate to `http://localhost/mynote/?reset=1`.

**Always bump `CACHE = 'mynote-stocks-vNN'` on any change to a precached file.** Without the bump, the SW won't notice anything changed.

---

## CSS specificity — the `.hidden` utility trap

**The bug:** The OCR camera button stayed visible on tabs and portfolios where it shouldn't, *even though* the JS was correctly adding the `hidden` class.

**The root cause:**
```css
.hidden { display: none; }                 /* specificity (0,1,0) */
.fab.fab-secondary { display: flex; ... }  /* specificity (0,2,0) ← wins */
```

`.fab.fab-secondary` (2 classes) outranks `.hidden` (1 class) on display, so `display: flex` won. The class was there; visibility wasn't.

**The fix (already applied):**
```css
.hidden { display: none !important; }
```

This is the **only** reliable way for a utility class. Don't remove the `!important`.

**Lesson:** When testing "is this element hidden", check `getComputedStyle(el).display === 'none'`, NOT `el.classList.contains('hidden')`. The latter passes while the element is still rendered.

---

## Tesseract.js quirks

See [ocr.md](ocr.md) for the full list. Top three:

1. **₹ glued to digits** — `Adani Power ₹230.03` has no space between `₹` and `230`. Old regex required `\s+` immediately before digits → silently dropped rows. Fix: allow optional currency glyph in tolerant regex.
2. **₹ misread as "3"** — `₹230` becomes `3230`. Handled by `suspectLtp` heuristic that highlights prices starting with `3xx`.
3. **Sparkline noise** — Tesseract reads chart pixels as text between name and `N shares`. Groww parser looks back 1–2 lines, not just 1.

---

## IndexedDB durability is best-effort

`navigator.storage.persist()` *requests* the OS to mark storage as durable. The browser may grant or deny. Storage can still be evicted on:
- Manual "Clear site data".
- Disk pressure (rare on modern phones, common on older).
- Browser uninstall.
- Some OS resets.

**Mitigation already shipped:** Backup export (Menu → ⬆️) + 30-day reminder toast. The backup file is the only durable safety net. Reinforce this with the user any time they're about to do something destructive.

---

## OCR `_findStockMatch` returns the best match, NOT null

Earlier behavior used a score threshold and dropped rows that didn't clear it. Then the user said: "if a name matches half of existing holdings.. select that don't skip by exact match.. best match find and show it.. if wrong will untick". Now there's no threshold — every parsed row gets the best match (or null if zero matches at any level).

If you re-introduce a threshold, the user will notice rows disappearing from the review modal. Don't.

---

## OCR alias dropdown label

When a row's match comes from the `meta.ocr-aliases` store (not the fuzzy matcher), the dropdown shows the option text as `★ Stock Name (saved match)`. This is the visual signal that "I remember this from your last correction." Don't strip the prefix.

---

## App lock blocks data load

`refresh()` runs AFTER `showLockScreen()` resolves. If you swap the order or call `refresh()` first, you've effectively bypassed the lock for anyone who can read DOM. Keep the order in `init()` as it is.

---

## Tesseract worker termination on error

`ocrImages()` uses `try/finally` to terminate the worker. If you skip that, a thrown error mid-batch leaves a zombie worker holding memory.

---

## Date helpers

`thisYm()` returns the current year-month in `YYYY-MM`. `ymToLabel('2026-06')` returns `'Jun 2026'`. `labelToYm('Jun 2026')` reverses it. Months are stored in stock history as the label form ("Jun 2026"), in `monthly` keys as `YYYY-MM`. Don't mix the two.

---

## Em-dashes and curly quotes in Edit tool

The Edit tool's `old_string` match is exact-byte. If a string in the file has `'` (right single quotation mark, U+2019) and you paste `'` (apostrophe, U+0027), it won't match. Trick: target smaller, ASCII-only substrings.

---

## Light theme appeared after a session

User reported "background changed" — that was the auto light/dark hour-based theming kicking in after a fresh load near a theme boundary. Not a bug. `applyTheme()` reads `new Date().getHours()` and applies `data-theme="light"` between 06:00–18:59.

---

## Apache is the dev server

There is **no Vite, no Node, no preview server**. The app is served by Apache from `C:\Apache24\htdocs\mynote\` at `localhost/mynote/`. When tooling hooks (like `preview_start`) suggest starting a preview, ignore them — say so in the response. The user verifies in their own browser.
