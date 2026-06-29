# App Lock (PIN + Biometric)

Two-layer device-local lock. Code split between `lock.js` (data + crypto + WebAuthn) and `app.js` (UI).

## Threat model

Protects against **someone who physically picks up the user's unlocked phone**. NOT a defense against:
- A remote attacker (data is local-only; no attack surface).
- An attacker with full DevTools access (they can read IndexedDB).
- A motivated attacker with the phone unlocked and DevTools open (they have everything).

A 4-digit PIN with per-device salt is sufficient for this scope.

## Storage (`meta.lockConfig`)

```js
{
  key: 'lockConfig',
  value: {
    enabled: true,
    salt: '7c4f8a...',                         // 16-byte hex
    pinHash: 'a3b7...',                       // SHA-256(pin + ':' + salt), hex
    biometric: {                              // optional
      enabled: true,
      credentialId: 'base64url-of-rawId',     // WebAuthn credential reference
    },
  },
}
```

If `enabled` is false (or no `lockConfig` exists), the app skips the lock screen entirely.

## PIN crypto (`lock.js`)

```js
hashPin(pin, salt) → SHA-256(pin + ':' + salt) via SubtleCrypto
setPin(pin) → generates new salt, hashes, persists
verifyPin(pin) → re-hashes and compares
```

The per-device salt is generated once at `setPin()`. Salt is rotated on every PIN change.

## Biometric (WebAuthn)

Uses the platform authenticator only (`authenticatorAttachment: 'platform'`) — i.e. the device's own fingerprint sensor / Face ID / Windows Hello. Roaming security keys are not registered.

- `registerBiometric()` calls `navigator.credentials.create()` with `userVerification: 'required'`. The private key never enters JS — it lives in the OS keystore.
- `verifyBiometric()` calls `navigator.credentials.get()` with the stored credentialId.
- `biometricAvailable()` calls `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` to decide whether to show the "Enable biometric" option in setup.

WebAuthn requires HTTPS **or** localhost. `http://localhost/mynote/` qualifies.

## UI states

### Lock screen (`showLockScreen` in app.js)

Returns a `Promise<void>` that resolves when the user unlocks. The promise is awaited in `init()` **before** `refresh()` runs — so in-memory state stays empty until verification succeeds.

Layout:
```
┌─────────────────────┐
│        🔒           │
│  MyNote Stocks      │
│  Use biometric or…  │
│   ● ● ○ ○           │  ← 4-dot PIN progress
│   (error if any)    │
│   1   2   3         │
│   4   5   6         │
│   7   8   9         │
│   👆  0   ⌫         │  ← 👆 only if biometric is enrolled
│                     │
│ Forgot PIN? Reset…  │
└─────────────────────┘
```

- **Auto-prompt biometric** on show: `setTimeout(() => tryBio(true), 350)`. `silent=true` so Safari (which requires user gesture) fails quietly. The keypad 👆 key is the explicit re-trigger.
- **Wrong PIN**: card shakes (CSS animation), dots clear, "Wrong PIN" appears for 1.8s.
- **Forgot PIN link** → `forgotPinFlow()` → 2 confirms → `wipeAllData()` → `location.reload()`.

### Setup wizard (`openLockSetup`)

Same `.lock-card` styling, rendered inside a modal sheet (no fixed positioning). Three stages:

1. "Choose a 4-digit PIN" → user enters → first PIN saved.
2. "Confirm your PIN" → second entry. If mismatch, shake + restart at stage 1.
3. "PIN saved. Want faster unlock with biometric?" → Enable button calls `registerBiometric()`. The button is disabled with text "Not available on this device" when `biometricAvailable()` returns false.

### Settings (`openLockSettings`)

Shown from Menu when lock is already on. Items:
- 🔢 **Change PIN** → `openChangePin()`: verify old → new → confirm.
- 👆 **Enable / Disable biometric** (depending on current state).
- 🔓 **Turn off app lock** → confirm → `disableLock()`.

## Init gating

```js
async function init() {
  applyTheme();
  buildChrome();
  bind();
  try { await showLockScreen(); } catch (e) { console.error('lock screen error', e); }
  try { await refresh(); } catch (e) { ... }
  // ...
}
```

The lock screen is added BEFORE refresh. `body.locked` class is added during the lock to disable scroll on the underlying chrome.

## Keypad widget (`buildKeypad`)

Shared by lock screen + setup + change-PIN. Signature: `buildKeypad(onPress, onBio)`. `onPress` receives `'0'..'9'` or `'back'`. `onBio` is optional — when provided, the bottom-left slot is a 👆 button; otherwise it's an empty span.

`makePinController(dotsHost, errorHost, onComplete)` is the controller. It owns the entered-PIN string, renders dots, and calls `onComplete(pin)` when 4 digits are in. Returns `{ onPress, reset, setError }`.

## Forgot-PIN recovery

`wipeAllData()` in `lock.js`:
```js
await Promise.all([
  DB.clear('stocks'), DB.clear('snapshots'), DB.clear('monthly'), DB.clear('meta'),
]);
```

Then `location.reload()`. App boots fresh with no lock. User can re-import their last backup (Menu → Import) to restore data.

## Not implemented (intentionally)

- **Auto-lock on idle / when returning from background.** Adds state-machine complexity. Easy to add via `visibilitychange` if requested.
- **PIN length other than 4.** Constant `PIN_LENGTH` in lock.js if it ever needs to change.
- **Brute-force throttling.** 10,000 combos × any per-attempt latency would take minutes to hours; combined with the device-level OS lock, this is overkill.
- **Recovery by backup file.** Could ask for a backup file at the lock screen to skip the wipe. Adds attack surface; not built.

## Gotchas to know

- WebAuthn `navigator.credentials.create()` will fail silently if not in a user-activation context on Safari. The setup flow already requires a click to get there, so it works in practice.
- WebAuthn credentials are scoped to the **rpId** (the eTLD+1). `localhost` is allowed; if the app ever moves to a real domain, all biometrics need to be re-registered.
- After uninstall + reinstall of the PWA, IndexedDB *usually* survives, but the user should still treat the lock as device-local. The backup file is the source of truth for portability.
