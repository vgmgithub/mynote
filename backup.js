// Folder-based backup & restore using the File System Access API.
//
// Goal: backups live in a dedicated user-chosen folder (no Downloads clutter),
// the app rotates them automatically (newest 5 kept), and "Restore" is one tap.
//
// Persistence model: the user picks the folder ONCE; we stash the FileSystem-
// DirectoryHandle in IndexedDB.meta. If site data is wiped, the handle is lost
// but the FILES remain in the folder — re-pick it once and the list reappears.
// That's the durability story this whole design hinges on.
//
// Browser support: Chrome/Edge desktop & Android (yes), Safari/iOS (no). The
// caller must check fileSystemAccessSupported() and fall back to the legacy
// download-+-pick flow on unsupported browsers.

import { DB } from './db.js';

const HANDLE_KEY = 'backupFolderHandle';
// Strict pattern: only date-stamped MyNote backups are rotated/listed. Anything
// else the user happens to put in the folder is left untouched.
const BACKUP_FILE_RE = /^mynote-stocks-backup-(\d{4}-\d{2}-\d{2})\.json$/;
const PRE_RESTORE_FILE = 'mynote-stocks-prerestore.json';
const KEEP = 5;

export const BACKUPS_KEEP = KEEP;

export function fileSystemAccessSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

// ---- folder handle storage ----

export async function getSavedFolder() {
  const rec = await DB.get('meta', HANDLE_KEY).catch(() => null);
  return (rec && rec.value) || null;
}

async function putSavedFolder(handle) {
  await DB.put('meta', { key: HANDLE_KEY, value: handle });
}

export async function clearSavedFolder() {
  await DB.put('meta', { key: HANDLE_KEY, value: null });
}

// ---- permission ----

// `mode: 'readwrite'` requires re-prompt on some browsers after long inactivity.
// Caller must invoke this from a user-gesture context (button click) so the
// permission prompt is allowed to appear.
export async function ensureFolderPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (_) {
    return false;
  }
}

// ---- folder pick ----

// Opens the OS folder-picker. Stores the handle on success. Throws on user
// cancel (AbortError) so the caller can ignore vs surface other errors.
export async function pickFolder() {
  if (!fileSystemAccessSupported()) {
    throw new Error('File System Access API not supported on this browser.');
  }
  const handle = await window.showDirectoryPicker({
    id: 'mynote-backups',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await putSavedFolder(handle);
  return handle;
}

// ---- list / read / write ----

// Returns matching backup files sorted newest-first. Each entry:
// { name, date: 'YYYY-MM-DD', size, modified }.
export async function listBackups(handle) {
  if (!handle) return [];
  if (!(await ensureFolderPermission(handle, 'read'))) return [];
  const out = [];
  for await (const [name, h] of handle.entries()) {
    if (h.kind !== 'file') continue;
    const m = name.match(BACKUP_FILE_RE);
    if (!m) continue;
    try {
      const file = await h.getFile();
      out.push({ name, date: m[1], size: file.size, modified: file.lastModified });
    } catch (_) { /* skip unreadable */ }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export async function readBackupByName(handle, name) {
  const fh = await handle.getFileHandle(name);
  const f = await fh.getFile();
  return JSON.parse(await f.text());
}

// `data` is the object returned by DB.exportAll(). Same-day backup overwrites
// the existing file with that date. Returns { name, date }.
export async function writeBackup(handle, data) {
  if (!(await ensureFolderPermission(handle, 'readwrite'))) {
    throw new Error('Folder permission denied.');
  }
  const t = new Date();
  const date = t.getFullYear() + '-' +
    String(t.getMonth() + 1).padStart(2, '0') + '-' +
    String(t.getDate()).padStart(2, '0');
  const name = 'mynote-stocks-backup-' + date + '.json';
  const fh = await handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(data));
  await w.close();
  return { name, date };
}

// Keeps the newest `keep` files matching BACKUP_FILE_RE, deletes the rest.
// Pre-restore file (different prefix) is never touched here.
export async function rotateBackups(handle, keep = KEEP) {
  const list = await listBackups(handle);
  for (const item of list.slice(keep)) {
    try { await handle.removeEntry(item.name); }
    catch (e) { console.warn('rotateBackups: cannot delete', item.name, e); }
  }
}

// Writes a single "prerestore" file (overwrites). One undo level for the user
// when they realise a restore was a mistake.
export async function writePreRestoreSnapshot(handle, data) {
  if (!(await ensureFolderPermission(handle, 'readwrite'))) return;
  try {
    const fh = await handle.getFileHandle(PRE_RESTORE_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(data));
    await w.close();
  } catch (e) { console.warn('prerestore snapshot failed', e); }
}

export async function readPreRestoreSnapshot(handle) {
  if (!handle) return null;
  if (!(await ensureFolderPermission(handle, 'read'))) return null;
  try {
    const fh = await handle.getFileHandle(PRE_RESTORE_FILE);
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  } catch (_) { return null; }
}

// ---- outside-folder restore (fallback / cross-device) ----

// Lets the user pick any backup file via the OS file picker — useful when
// restoring from an email attachment, USB transfer, or older Export downloads.
export async function readBackupViaFilePicker() {
  if (typeof window.showOpenFilePicker === 'function') {
    const [fh] = await window.showOpenFilePicker({
      types: [{ description: 'MyNote backup', accept: { 'application/json': ['.json'] } }],
      multiple: false,
    });
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  }
  // Older-browser fallback — same as the legacy importData flow.
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) { reject(new Error('No file picked')); return; }
      try { resolve(JSON.parse(await f.text())); }
      catch (e) { reject(e); }
    };
    inp.click();
  });
}
