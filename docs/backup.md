# Backup & Restore

Folder-based backup using the File System Access API. Replaces the old separate Export/Import menu items.

## User-facing flow

Single menu item: **🗄️ Backup & Restore**.

### First time

The app shows a setup sheet: "Pick a folder where your backups will be saved." Tap **Choose folder** → OS folder picker → user picks a dedicated folder (e.g. `Documents/MyNoteBackups`). The folder handle is stored in IndexedDB `meta`.

### Subsequent times

A main sheet shows:
- Current backup folder name + Change link.
- **Backup now** button + "Last: 12 Jun 2026" indicator.
- **Recent backups** list (newest 5), each row with date + size + Restore button.
- **Restore from a file outside this folder...** link at the bottom — for cross-device restore.

## Naming convention

- Backups: `mynote-stocks-backup-YYYY-MM-DD.json`. **Date only, no time.** Multiple backups on the same day overwrite each other.
- Pre-restore snapshot: `mynote-stocks-prerestore.json`. Single file, overwritten on each restore — one "oops" undo level.
- Old format `mynote-stocks-backup-YYYY-MM-DD.json` is the same as the new format. Files exported via the previous flow still load fine.

## Rotation policy

After every successful **Backup now**:
1. `listBackups(handle)` enumerates files matching the strict regex `^mynote-stocks-backup-\d{4}-\d{2}-\d{2}\.json$`.
2. Sort by date descending.
3. Delete everything beyond the first 5.

**Important:** the rotation regex is strict. Files with any other name (including time-stamped backups, user-renamed copies, files from other apps) are **never** touched. This is deliberate — the user is expected to pick a dedicated folder, but if they pick a shared one, we won't surprise them by deleting unrelated files.

`BACKUPS_KEEP = 5` is the constant in `backup.js`. Change there if needed.

## Pre-restore snapshot

Before any restore (from the list OR from an outside file), the app silently calls `writePreRestoreSnapshot(handle, currentData)`. This writes `mynote-stocks-prerestore.json` in the backup folder.

If the user realises the restore was a mistake, they can use **Restore from a file outside this folder...** and pick `mynote-stocks-prerestore.json` to get back to pre-restore state. (We don't surface it in the list because there's only ever one, and it would clutter the UI.)

## Browser support & fallback

`fileSystemAccessSupported()` checks for `window.showDirectoryPicker`.

| Browser | Supported? | Behaviour |
|---|---|---|
| Chrome / Edge desktop | ✓ | Full flow |
| Chrome Android | ✓ | Full flow (the user's setup) |
| Safari / iOS | ✗ | Falls back to legacy export/import: Backup downloads to Downloads folder, Restore is a file picker |
| Firefox desktop | ✗ | Same fallback as Safari |

The fallback sheet (`openBackupFallbackSheet`) wraps the existing `exportData()` and `importData()` functions — they were kept exactly for this purpose. **Do not remove them.**

## Permission lifecycle

The `FileSystemDirectoryHandle` is stored in IndexedDB. Across sessions:
- `queryPermission({ mode: 'readwrite' })` returns `granted | prompt | denied`.
- If `prompt`, calling `requestPermission()` shows a confirmation dialog — requires a user gesture (the menu tap counts).
- If `denied`, the setup sheet is shown so the user can re-pick (possibly the same folder).
- Chrome sometimes re-prompts after long inactivity (~weeks). One tap to confirm.

## What happens after `Clear site data`

- IndexedDB is wiped → folder handle is lost, app data is gone.
- **The files in the picked folder are NOT wiped.** They live in the OS filesystem.
- User reopens app → no data → goes to **Backup & Restore** → app prompts to pick a folder → user picks the same folder → existing backups appear in the list → tap Restore → data back.

This is the disaster-recovery path. It's why the folder-based design is the right answer for durability.

## Key code locations

| What | Where |
|---|---|
| Folder picker + handle storage | `backup.js` → `pickFolder()`, `getSavedFolder()` |
| Permission helpers | `backup.js` → `ensureFolderPermission()` |
| List / read / write / rotate | `backup.js` → `listBackups()`, `readBackupByName()`, `writeBackup()`, `rotateBackups()` |
| Pre-restore snapshot | `backup.js` → `writePreRestoreSnapshot()`, `readPreRestoreSnapshot()` |
| File-picker fallback | `backup.js` → `readBackupViaFilePicker()` |
| UI: entry point + routing | `app.js` → `openBackupSheet()` |
| UI: setup sheet | `app.js` → `openBackupSetupSheet()` |
| UI: main sheet | `app.js` → `openBackupMainSheet(handle)` |
| UI: legacy fallback sheet | `app.js` → `openBackupFallbackSheet()` |
| UI: outside-file restore | `app.js` → `restoreFromOutsideFile()` |
| Menu item | `app.js` → `openMenu()` |

## Gotchas

- **The user expects same-day backups to overwrite.** Don't add timestamps to filenames without explicit ask — they considered and rejected this.
- **Don't delete files outside the strict regex during rotation.** The user's folder might contain other things; the strict regex is a safety contract.
- **`pickFolder()` throws `AbortError` if the user cancels the picker.** Callers should silently swallow `AbortError`, surface other errors.
- **Pre-restore is best-effort.** If permission is revoked at the moment of write, we don't fail the restore — just log and continue. Better to allow restore than to block it on a safety-net failure.
- **Legacy `exportData()` and `importData()` are still referenced** by the fallback sheet. They're not dead code.
- **`Last backup` toast/reminder** still uses `meta.lastBackup` — same key as before, set on both folder-based and fallback backup paths.
