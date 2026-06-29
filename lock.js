// App lock — PIN + optional biometric (WebAuthn platform authenticator).
// Pure data layer: meta read/write, SHA-256, WebAuthn glue. The UI (lock
// screen, setup wizard, settings sheet) lives in app.js so it can reuse the
// shared el()/openModal/closeModal helpers.
//
// Security model: this is "device-local" protection against someone who
// physically has your unlocked phone — not against a remote attacker. The PIN
// is stored as SHA-256(pin + ":" + per-device-salt). A 4-digit PIN with salt
// is cryptographically weak against an offline attacker with the salt, but the
// attacker would already need to have IndexedDB access, which means they have
// everything anyway. Biometric uses the OS keystore via WebAuthn — keys never
// touch JS, the browser/OS gates each authentication.

import { DB } from './db.js';

const LOCK_KEY = 'lockConfig';
const PIN_LEN = 4;

// ---- low-level helpers ----

const bytesToHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
const bytesToB64url = (b) => btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- meta read/write ----

export async function getLockConfig() {
  const rec = await DB.get('meta', LOCK_KEY).catch(() => null);
  return (rec && rec.value) || null;
}

async function putLockConfig(cfg) {
  await DB.put('meta', { key: LOCK_KEY, value: cfg });
}

export async function disableLock() {
  await DB.put('meta', { key: LOCK_KEY, value: { enabled: false } });
}

// ---- PIN ----

export const PIN_LENGTH = PIN_LEN;

function genSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}

async function hashPin(pin, salt) {
  const enc = new TextEncoder().encode(String(pin) + ':' + salt);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return bytesToHex(buf);
}

export async function setPin(pin) {
  if (!/^\d{4}$/.test(String(pin))) throw new Error('PIN must be exactly 4 digits.');
  const salt = genSalt();
  const pinHash = await hashPin(pin, salt);
  const cfg = (await getLockConfig()) || {};
  cfg.enabled = true;
  cfg.salt = salt;
  cfg.pinHash = pinHash;
  await putLockConfig(cfg);
}

export async function verifyPin(pin) {
  const cfg = await getLockConfig();
  if (!cfg || !cfg.pinHash || !cfg.salt) return false;
  return (await hashPin(pin, cfg.salt)) === cfg.pinHash;
}

// ---- Biometric (WebAuthn platform authenticator) ----

export function biometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}

// "Available" = the device has a platform authenticator (fingerprint sensor,
// face cam, Windows Hello, etc.) and the browser can use it. The setup UI
// hides the biometric option when this returns false.
export async function biometricAvailable() {
  if (!biometricSupported()) return false;
  try {
    return !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (_) { return false; }
}

export async function registerBiometric() {
  if (!biometricSupported()) throw new Error('Biometric not supported on this browser.');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'MyNote Stocks' },
      user: { id: userId, name: 'mynote-user', displayName: 'MyNote User' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },    // ES256
        { type: 'public-key', alg: -257 },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',  // device-local sensor only
        userVerification: 'required',         // require fingerprint/face/PIN at OS level
      },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error('Registration cancelled.');
  const cfg = (await getLockConfig()) || {};
  cfg.biometric = { enabled: true, credentialId: bytesToB64url(cred.rawId) };
  await putLockConfig(cfg);
}

export async function verifyBiometric() {
  const cfg = await getLockConfig();
  if (!cfg || !cfg.biometric || !cfg.biometric.enabled || !cfg.biometric.credentialId) {
    throw new Error('Biometric not enrolled.');
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: b64urlToBytes(cfg.biometric.credentialId) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!assertion;
}

export async function disableBiometric() {
  const cfg = await getLockConfig();
  if (!cfg) return;
  delete cfg.biometric;
  await putLockConfig(cfg);
}

// Wipe local data — used by the "Forgot PIN" recovery path on the lock screen.
// Caller is expected to reload the page after this resolves.
export async function wipeAllData() {
  await Promise.all([
    DB.clear('stocks').catch(() => {}),
    DB.clear('snapshots').catch(() => {}),
    DB.clear('monthly').catch(() => {}),
    DB.clear('meta').catch(() => {}),
  ]);
}
