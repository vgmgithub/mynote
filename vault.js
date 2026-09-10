// vault.js — Password vault: key derivation, encryption, strength. No DOM, no IO.
// app.js owns the `vault` IndexedDB store and every screen; this file only
// turns a master password into a key and a secret into ciphertext.
//
// WHAT THIS PROTECTS AGAINST, and what it does not.
//
// Protects: someone who picks up the unlocked phone and opens the app, someone
// who gets hold of a backup file, and anyone poking at IndexedDB directly. The
// rows hold ciphertext; the master password is never written anywhere, so
// there is nothing on the device to read it out of.
//
// Does NOT protect: malware or a hostile script running inside the page, which
// can read the key while the vault is open; anyone who knows or guesses the
// master password; or a phone with no screen lock, since unlocking the vault
// is only ever one correct password away. This is a lock on a drawer, not a
// safe, and the page says so.
//
// THE KEY IS NEVER STORED. It is derived on unlock, held in memory, and gone
// on reload. That is also why a forgotten master password cannot be recovered
// and the vault is simply lost - stated plainly at setup rather than
// discovered later.

// PBKDF2-SHA256. 200k is at the upper end of what a mid-range phone will do
// without a visible pause, and the unlock screen derives on a debounce rather
// than on every keystroke so the cost lands once.
const ITERATIONS = 200000;
const SALT_BYTES = 16;
const IV_BYTES = 12;                  // AES-GCM standard nonce length

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const unb64 = (str) => {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const randomSaltB64 = () => b64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

// Master password + salt -> AES-GCM key. Not extractable: the browser will not
// hand the raw bytes back to script even if something later asks for them.
export async function deriveKey(password, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

// Returns null rather than throwing on a bad key: a row that will not open is
// a row to skip and report, not a reason to blank the whole list.
export async function decryptJson(key, env) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return JSON.parse(dec.decode(pt));
  } catch (_) { return null; }
}

// How the unlock screen knows the password is right: a known phrase encrypted
// at setup. AES-GCM is authenticated, so a wrong key fails to decrypt rather
// than returning rubbish - there is no separate hash to store and no way to
// test a guess without doing the full derivation.
const VERIFY_PHRASE = 'mynote-vault-v1';
export const makeVerifier = (key) => encryptJson(key, VERIFY_PHRASE);
export async function checkVerifier(key, env) {
  if (!env || !env.iv || !env.ct) return false;
  return (await decryptJson(key, env)) === VERIFY_PHRASE;
}

// ---------- Generating one ----------
//
// Ambiguous characters are left out on purpose: a password you cannot read off
// the screen to type into a TV or a card machine is one you will replace with
// a worse one. No O/0, l/1/I, or the brackets that vary by keyboard.
const GEN_SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digit: '23456789',
  symbol: '!@#$%^&*-_=+?',
};

// Rejection sampling, not modulo: taking a random byte mod 25 makes the first
// few letters of the alphabet measurably likelier, which is a real if small
// bias in the one thing here that must be uniform.
function pick(chars) {
  const max = 256 - (256 % chars.length);
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) return chars[buf[0] % chars.length];
  }
}

export function generatePassword(o) {
  const opt = Object.assign({ length: 18, upper: true, digits: true, symbols: true }, o || {});
  const len = Math.max(8, Math.min(64, Math.floor(opt.length) || 18));
  const pools = [GEN_SETS.lower];
  if (opt.upper) pools.push(GEN_SETS.upper);
  if (opt.digits) pools.push(GEN_SETS.digit);
  if (opt.symbols) pools.push(GEN_SETS.symbol);
  const all = pools.join('');
  // One from each chosen pool first, so "include symbols" is a guarantee
  // rather than a probability - then fill, then shuffle so the guaranteed
  // characters are not always at the front.
  const out = pools.map((p) => pick(p));
  while (out.length < len) out.push(pick(all));
  // Fisher-Yates with crypto randomness.
  for (let i = out.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out.join('');
}

// ---------- How strong is it ----------
//
// Scored on SEARCH SPACE, not on a checklist of "has a capital, has a digit".
// A checklist rates "Password1!" as strong, which is the whole problem with
// checklists. log2(pool^length) is what an attacker actually has to get
// through, and length moves it far more than variety does - which is the one
// thing worth teaching the person typing.
//
// Entropy alone is not enough either, though: "Password1!" is ten characters
// from a 95-symbol pool and scores 66 bits, while in reality it is one of the
// first guesses anybody makes. A password built on a word from this list is
// capped, because its real search space is the list, not the alphabet.
const COMMON_BASES = [
  'password', 'passw0rd', 'qwerty', 'asdfgh', 'zxcvbn', 'letmein', 'welcome',
  'admin', 'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'abc123', '123456', '111111', '000000', 'master', 'login', 'india', 'secret',
];
export function strength(pw) {
  const s = String(pw || '');
  if (!s) return { bits: 0, label: '', pct: 0, cls: '' };
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9]/.test(s)) pool += 33;
  let bits = s.length * (Math.log(pool || 1) / Math.log(2));

  // A run of one character, or a straight alphabet/keyboard run, buys far less
  // than its length suggests. Docked rather than modelled precisely - the aim
  // is to stop "aaaaaaaaaaaa" scoring like twelve random letters.
  if (/^(.)\1+$/.test(s)) bits = Math.min(bits, 12);
  else if (/(.)\1{2,}/.test(s)) bits -= 8;
  if (/(abc|bcd|cde|def|123|234|345|456|567|678|789|qwe|wer|ert|asd)/i.test(s)) bits -= 10;
  // Built on a word everyone tries: capped near the length of what is left
  // once that word is taken as a single guess. Decorating it with a capital
  // and a "!" is exactly what the cap exists to stop scoring well.
  const bare = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = COMMON_BASES.find((w) => bare.indexOf(w) >= 0);
  if (hit) bits = Math.min(bits, 8 + Math.max(0, bare.length - hit.length) * 4);
  bits = Math.max(0, Math.round(bits));

  const label = bits < 40 ? 'Weak' : bits < 60 ? 'Fair' : bits < 80 ? 'Good' : 'Strong';
  const cls = bits < 40 ? 'is-weak' : bits < 60 ? 'is-fair' : bits < 80 ? 'is-good' : 'is-strong';
  return { bits, label, cls, pct: Math.min(100, Math.round((bits / 100) * 100)) };
}

// The fields a vault entry holds. The whole record is encrypted as one blob -
// not field by field - so the store leaks nothing at all, not even which
// entries have a note or how long a username is. Searching and sorting happen
// in memory after unlock, on a few dozen rows.
export const VAULT_FIELDS = ['title', 'account', 'username', 'password', 'url', 'notes'];
