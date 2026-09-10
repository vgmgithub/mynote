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
export const VAULT_FIELDS = ['title', 'account', 'username', 'password', 'url', 'notes',
  'category', 'icon'];

// ---------- What kind of thing it is ----------
//
// A fixed list rather than free text. Categories are only worth having if two
// entries that belong together actually land on the same one, and a typed
// field guarantees they will not: "bank", "Bank", "Banking", "HDFC bank".
// Each carries its own icon, which is what an entry falls back to when its
// title says nothing recognisable.
//
// Optional throughout. Nothing here refuses to save without one.
export const VAULT_CATEGORIES = [
  { name: 'Logins', icon: '\u{1F511}' },
  { name: 'App', icon: '\u{1F4F1}' },
  { name: 'Email', icon: '\u2709\uFE0F' },
  { name: 'Banks', icon: '\u{1F3E6}' },
  { name: 'Card Details', icon: '\u{1F4B3}' },
  { name: 'Investments', icon: '\u{1F4C8}' },
  { name: 'Documents', icon: '\u{1F4C4}' },
  { name: 'Government ID', icon: '\u{1F6C2}' },
  { name: 'Insurance', icon: '\u{1F6E1}\uFE0F' },
  { name: 'Shopping', icon: '\u{1F6D2}' },
  { name: 'Social', icon: '\u{1F4AC}' },
  { name: 'Entertainment', icon: '\u{1F3AC}' },
  { name: 'Work', icon: '\u{1F4BC}' },
  { name: 'Wi-Fi', icon: '\u{1F4F6}' },
  { name: 'Other', icon: '\u{1F5C2}\uFE0F' },
];

// What a title tends to mean. Checked in order, first match wins, so the
// narrow patterns come before the broad ones - "jiocinema" has to be caught by
// the streaming line before "jio" is caught by the broadband one.
//
// This is a convenience, never a decision: it only ever fills in an icon
// nobody chose, and choosing one overrides it permanently.
const TITLE_ICONS = [
  [/netflix|prime ?video|hotstar|jio ?cinema|sony ?liv|zee5|youtube|spotify|disney|apple ?tv/, '\u{1F3AC}'],
  [/gmail|outlook|yahoo|proton ?mail|zoho ?mail|\bmail\b|e-?mail/, '\u2709\uFE0F'],
  [/demat|zerodha|groww|upstox|angel ?one|kite|mutual ?fund|nsdl|cdsl|trading|smallcase/, '\u{1F4C8}'],
  // Ahead of the banks: "ICICI Credit Card" is a card that a bank happens to
  // have issued, and the half of the title saying what it IS should win over
  // the half saying who it is with. The looser card words stay below, where
  // "HDFC card" still reads as the bank.
  [/credit ?card|debit ?card|master ?card|\bvisa\b|rupay|\bamex\b/, '\u{1F4B3}'],
  [/bank|hdfc|icici|\bsbi\b|axis|kotak|indusind|canara|\bpnb\b|\bidfc\b|\bboi\b|net ?banking/, '\u{1F3E6}'],
  [/\bupi\b|g ?pay|google ?pay|phone ?pe|paytm|bhim|amazon ?pay/, '\u{1F4B8}'],
  [/\bcard\b/, '\u{1F4B3}'],
  [/amazon|flipkart|myntra|ajio|big ?basket|blinkit|zepto|swiggy|zomato|shop|store/, '\u{1F6D2}'],
  [/insta|facebook|twitter|linked ?in|whats ?app|telegram|reddit|snapchat|threads|pinterest/, '\u{1F4AC}'],
  [/wi-?fi|router|broadband|airtel|\bjio\b|\bbsnl\b|fibernet|hathway|modem/, '\u{1F4F6}'],
  [/aadhaar|aadhar|\bpan\b|passport|licen[cs]e|voter|income ?tax|\bepf\b|\buan\b|digilocker|\bgst\b/, '\u{1F6C2}'],
  [/insur|policy|\blic\b|term ?plan|mediclaim|health ?cover/, '\u{1F6E1}\uFE0F'],
  [/github|gitlab|jira|slack|confluence|office ?365|teams|zoom|\bvpn\b|sify|\bwork\b|payroll/, '\u{1F4BC}'],
  [/steam|epic ?games|play ?station|xbox|nintendo|\bgame/, '\u{1F3AE}'],
  [/crypto|binance|wazirx|coin ?dcx|bitcoin|wallet/, '\u{1FA99}'],
  [/hospital|clinic|doctor|apollo|practo|pharma|medic/, '\u{1F3E5}'],
  [/school|college|university|course|udemy|coursera|exam/, '\u{1F393}'],
  [/electric|\bgas\b|water ?bill|\bbescom\b|utility|municipal|property ?tax/, '\u{1F4A1}'],
  [/aws|azure|godaddy|hosting|domain|cloud|server|admin ?panel/, '\u2699\uFE0F'],
];

// The icon for an entry, in strict order of who decided it:
//   1. an emoji picked by hand - always wins, and is why the picker exists
//   2. what the title or the site name looks like
//   3. the category it was filed under
//   4. its own first letter, on a colour of its own
// Never blank. A row of entries where some have an icon and some have a gap
// is harder to read down than one where every line starts the same way.
export function iconFor(rec) {
  const r = rec || {};
  if (r.icon) return { emoji: String(r.icon) };
  const hay = (String(r.title || '') + ' ' + String(r.url || '')).toLowerCase();
  if (hay.trim()) {
    const hit = TITLE_ICONS.find((t) => t[0].test(hay));
    if (hit) return { emoji: hit[1] };
  }
  const cat = VAULT_CATEGORIES.find((c) => c.name === r.category);
  if (cat) return { emoji: cat.icon };
  // Array.from, not charAt: a title starting with an emoji or a Devanagari
  // letter would otherwise be cut in half and render as a broken box.
  const first = Array.from(String(r.title || '').trim())[0] || '?';
  return { letter: first.toUpperCase() };
}

// A colour for the letter tile, fixed by the title, so an entry keeps the same
// one for life and the list can be found by colour before it is read.
export function iconHue(text) {
  const s = String(text || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// The first character of a string, where "character" means what a person
// would call one. Array.from would do for most of the palette, but not for
// what a phone keyboard can produce: a flag is two regional indicators, a
// thumbs-up with a skin tone is a base plus a modifier, and a family is four
// people joined by zero-width joiners. Splitting any of those in half yields
// a stray box. Intl.Segmenter knows where the boundaries are; the fallback is
// only reached on a browser old enough not to have it.
export function firstGlyph(str) {
  const t = String(str || '').trim();
  if (!t) return '';
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const g of seg.segment(t)) return g.segment;
  } catch (_) { /* no Segmenter here */ }
  return Array.from(t)[0] || '';
}

// Is that actually an emoji? The box the user types into is a plain text
// input - there is no way to ask a phone for "emoji only" - so a word typed
// into it by mistake would otherwise become an icon reading "P", which looks
// like the automatic first-letter tile but is not one, and cannot be told
// apart from it later.
//
// Extended_Pictographic covers the pictures, including the older ones like
// U+2764 that predate the emoji blocks; Regional_Indicator covers flags,
// which are pairs of letters and match nothing else.
export function isEmoji(glyph) {
  const g = String(glyph || '');
  if (!g) return false;
  try {
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);
  } catch (_) {
    // No Unicode property escapes: fall back to "not plain ASCII", which is
    // wrong at the edges and right for everything a keyboard emoji key emits.
    return /[^\u0000-\u00FF]/.test(g);
  }
}

// The palette the picker offers. Deliberately a couple of dozen rather than
// every emoji there is: a picker you have to scroll and search is slower than
// accepting the default, and the default is usually right.
export const ICON_CHOICES = [
  '\u{1F511}', '\u{1F510}', '\u{1F4F1}', '\u{1F4BB}', '\u2709\uFE0F', '\u{1F3E6}',
  '\u{1F4B3}', '\u{1F4B0}', '\u{1F4B8}', '\u{1F4C8}', '\u{1F4C4}', '\u{1F5C2}\uFE0F',
  '\u{1F6C2}', '\u{1F6E1}\uFE0F', '\u{1F3E5}', '\u{1F393}', '\u{1F6D2}', '\u{1F381}',
  '\u{1F4AC}', '\u{1F4F7}', '\u{1F3AC}', '\u{1F3B5}', '\u{1F3AE}', '\u{1F4F6}',
  '\u{1F4A1}', '\u{1F697}', '\u2708\uFE0F', '\u{1F3E0}', '\u{1F4BC}', '\u2699\uFE0F',
  '\u{1F310}', '\u{1F4CE}', '\u{1F464}', '\u{1F465}', '\u2B50', '\u2764\uFE0F',
];

// ---------- CSV, in and out ----------
//
// Plain text, deliberately. A CSV only this app could read would be no use for
// the one thing a CSV is for: getting the list out into a spreadsheet or
// another password manager, and back in from one. So the file is readable by
// anything - which also means readable by anyone who finds it. The screen that
// offers it says so in those words; nothing here pretends the file is safe.
//
// Quoting follows RFC 4180: a field is wrapped in quotes when it contains a
// comma, a quote or a newline, and its own quotes are doubled. Passwords
// contain all three often enough that joining on commas loses data quietly,
// which is the worst way for a password export to fail.
export const CSV_COLUMNS = [
  ['title', 'Title'], ['category', 'Category'], ['account', 'Account'],
  ['username', 'Username'], ['password', 'Password'], ['url', 'Website/URL'],
  ['notes', 'Notes'], ['icon', 'Icon'],
];

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.map((c) => csvCell(c[1])).join(',')];
  (rows || []).forEach((r) => lines.push(CSV_COLUMNS.map((c) => csvCell(r[c[0]])).join(',')));
  return lines.join('\r\n') + '\r\n';
}

// Character at a time, not split(','), for the reason above - and because the
// file being imported was probably written by something else, whose idea of a
// line ending and an empty field may not match ours.
export function parseCsvRaw(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (s[i + 1] === '"') { cell += '"'; i++; continue; }   // a doubled quote is one quote
      quoted = false;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === ',') { endCell(); continue; }
    if (ch === '\r') { if (s[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows.filter((r) => r.length > 1 || String(r[0] || '').trim() !== '');
}

// Column names other exports use for the same thing. Matching on the header
// rather than on position is what lets a file from Chrome or Bitwarden come
// straight in, and is also the only safe way to read one: a file whose columns
// are in a different order would otherwise write the username into the
// password field without a word.
const CSV_ALIASES = {
  title: ['title', 'name', 'item name', 'account name'],
  account: ['account'],
  // Other managers call this a folder or a group; it is the same idea, and an
  // imported name that matches none of ours is simply kept as it came.
  category: ['category', 'folder', 'group'],
  icon: ['icon', 'emoji'],
  username: ['username', 'user', 'user name', 'login', 'login_username', 'email', 'login name'],
  password: ['password', 'pass', 'login_password'],
  url: ['website/url', 'url', 'website', 'web site', 'site', 'login_uri', 'login uri', 'urls'],
  notes: ['notes', 'note', 'comment', 'comments', 'extra'],
};

// Trimmed everywhere except the password and the notes: a password may
// legitimately start or end with a space, and a note may legitimately be
// several lines. Tidying either would be silent corruption.
const CSV_KEEP_RAW = { password: 1, notes: 1 };

export function parseCsv(text) {
  const rows = parseCsvRaw(text);
  if (!rows.length) return { entries: [], columns: [], skipped: 0, unmatched: [] };
  const head = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const idx = {};
  VAULT_FIELDS.forEach((f) => {
    const i = head.findIndex((h) => (CSV_ALIASES[f] || []).indexOf(h) >= 0);
    if (i >= 0) idx[f] = i;
  });
  // Nothing recognisable in the header line. Reading on would mean guessing
  // which column holds the secret, so it stops here and says which columns it
  // did find, which is usually enough to see what went wrong.
  if (idx.title == null && idx.password == null) {
    return { entries: [], columns: [], skipped: rows.length - 1, unmatched: head };
  }
  const entries = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rec = {};
    VAULT_FIELDS.forEach((f) => {
      const raw = idx[f] == null ? '' : String(r[idx[f]] == null ? '' : r[idx[f]]);
      rec[f] = CSV_KEEP_RAW[f] ? raw : raw.trim();
    });
    if (!rec.title && !rec.password && !rec.username) { skipped++; continue; }
    // A row with a password and no title is worth keeping - it just needs
    // something to be listed under.
    if (!rec.title) rec.title = rec.url || rec.username || 'Untitled';
    entries.push(rec);
  }
  return { entries, columns: Object.keys(idx), skipped, unmatched: [] };
}
