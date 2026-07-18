const CACHE = 'mynote-stocks-v190';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './core.js',
  './csv.js',
  './db.js',
  './ocr.js',
  './lock.js',
  './backup.js',
  './feed.js',
  './mf.js',
  './fd.js',
  './dividend.js',
  './metal.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/gold-bars.png',
];

// Precache fresh copies (bypass the HTTP cache so we never bake in a stale file).
// IMPORTANT: no skipWaiting() here. A new SW installs but stays in the "waiting"
// slot until the user explicitly opts in via Menu → "Check for updates". The
// page postMessages { type: 'SKIP_WAITING' } when the user taps Apply, which
// triggers the listener below — that's the only way the new SW takes over.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (u) => {
      try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await c.put(u, r); } catch (_) {}
    }));
  })());
});

// User-triggered activation: app.js postMessages SKIP_WAITING when the user
// taps "Apply update" in the menu. SW activates → clients.claim() →
// controllerchange fires on the page → page reloads (intentional, expected).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: serve cache instantly (fast + offline), refresh in the
// background. The revalidation bypasses the HTTP cache so a redeploy always lands
// on the next load.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || network;
    })
  );
});
