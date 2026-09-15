# My Passwords (Vault)

An encrypted password manager — Home's 🔐 "My Passwords" card, lazy-loaded (`vault.js`, ~443 lines) via `setAppMode('vault')`. Separate from [App Lock](app-lock.md): App Lock is a PIN/biometric gate on the whole app; the Vault has its own independent master password that only it knows.

## Threat model

Stated plainly at the top of `vault.js`, same shape as App Lock's: protects against a picked-up unlocked phone, a stolen backup file, or someone poking directly at IndexedDB. **Does NOT** protect against malware/a hostile script running inside the page itself (it can read the key while the vault is open), someone who knows or guesses the master password, or a phone with no screen lock of its own. "This is a lock on a drawer, not a safe, and the page says so."

## Storage — `vault` store (v17), and what's actually readable

```js
{ id, updatedAt, iv, ct }   // AES-GCM envelope: only these fields are ever in the clear
```

Everything else — title, account, username, password, URL, notes, category, icon, person — lives **inside the encrypted blob as one unit**, not field-by-field: "so the store leaks nothing at all, not even which entries have a note or how long a username is. Searching and sorting happen in memory after unlock, on a few dozen rows." `meta.vaultPeople` (the list of person names used to tag entries) is encrypted with the same key for the same reason — names aren't password-grade secrets, but "a store that gives up a family's names to anyone reading the database is not a store that leaks nothing."

`vault` **is** included in `exportAll()`/`importAll()` (correctly, unlike Health Check — see [health-check.md](health-check.md)) — "a backup carries the vault without carrying the passwords: without the master password these rows are noise."

## Crypto

- **Key derivation:** PBKDF2-SHA256, **200,000 iterations** — "at the upper end of what a mid-range phone will do without a visible pause," which is why the unlock screen derives on a debounce (320ms after the last keystroke) rather than on every keystroke, so the cost lands once.
- The derived AES-GCM 256-bit key is **non-extractable** — the browser will not hand the raw bytes back to script even if something later asks for them.
- **Encryption:** AES-GCM, a fresh random 12-byte IV per write. Decryption returns `null` on failure rather than throwing — "a row that will not open is a row to skip and report, not a reason to blank the whole list."
- **No stored password hash.** Unlock re-derives the key and tries to decrypt a known verifier phrase (`meta.vaultVerify`); AES-GCM is authenticated, so a wrong key fails to decrypt rather than returning garbage — there's no separate hash to store, and no way to test a guess without doing the full 200k-iteration derivation.
- Salt (`meta.vaultSalt`, 16 random bytes) is the one thing stored in the clear that's actually needed — without it the same password can't re-derive the same key.
- **The key itself is never persisted anywhere.** It's derived on unlock, held in one in-memory variable, and gone the moment the section is left or the page reloads. Stated at setup, not discovered later: "if you forget it the vault cannot be opened or recovered by anyone, including you." There is deliberately no recovery path.

## Master password — separate secret from the App Lock PIN

App Lock's 4-digit PIN gates entering the app at all ([app-lock.md](app-lock.md)). The Vault's master password is a second, unrelated secret used only for its own PBKDF2 derivation — arbitrary length and content, no enforced strength floor ("whose vault it is decides what is worth locking it with; the meter below says what the choice buys and then gets out of the way"). First run vs. unlock is decided purely by whether `meta.vaultSalt`/`meta.vaultVerify` exist yet.

- **Setup** asks for the password twice (a typo guard only, since it's unrecoverable) and an explicit confirm dialog spells out the consequence before committing: *"Set this as your master password? It is never stored, so if you forget it the vault cannot be opened or recovered by anyone, including you."* If encrypted rows already exist (an earlier setup, or a restored backup) the user is asked whether to wipe them — they can never be opened with a new password.
- **A copy of the master password is itself saved as a vault entry** (`title === 'MasterPassword'`), filtered out of the normal list, purely to pre-fill "Change master password." It plays no part in unlock — the verifier is what's actually checked — "so this copy can only ever be a convenience, never the lock itself."
- **Auto-lock while backgrounded** — `VAULT_AWAY_MS = 30000`. "A phone put down with the vault open, screen off, picked up an hour later by somebody else, is one tap from every password in it," so leaving relocks it and returning re-prompts — but not instantly, since locking on every hide would make the vault's own copy button demand the master password on every single tap-away. Two triggers cover mobile's unreliable background timers: a hide-timer (which a frozen tab may never get to run) and an elapsed-time check on return (which catches whatever the timer missed) — plus an unconditional relock on `pagehide`.

## A vault entry (`VAULT_FIELDS`)

`title, account, username, password, url, notes, category, icon, person`. `category` is one of 15 fixed options (Logins, App, Email, Banks, Card Details, Investments, Documents, Government ID, Insurance, Shopping, Social, Entertainment, Work, Wi-Fi, Other) rather than free text — "categories are only worth having if two entries that belong together actually land on the same one, and a typed field guarantees they will not: 'bank', 'Bank', 'Banking', 'HDFC bank'." `icon` resolution is manual pick > title/URL pattern match > category default > first-letter fallback, explicitly "a convenience, never a decision — it only ever fills in an icon nobody chose."

## Password generator

Excludes visually-ambiguous characters (O/0, l/1/I, brackets) — "a password you cannot read off the screen to type into a TV or a card machine is one you will replace with a worse one." Uses rejection sampling (not modulo) for uniform character selection, and scores strength by **search-space bits**, not a composition checklist — "a checklist rates 'Password1!' as strong, which is the whole problem with checklists" — further capped against a small dictionary of common password bases so a dressed-up common word doesn't score well either.

## Gotchas

- **CSV export/import is plain text, deliberately, and says so.** "A CSV only this app could read would be no use for the one thing a CSV is for... which also means readable by anyone who finds it." The export screen states this in those words; the app makes no claim the file is safe, and the hint on it tells the user to delete it once used.
- **Forgotten master password = permanently lost vault.** No recovery path exists or is planned — this is intentional, not a gap.
