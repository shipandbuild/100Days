// Offline-first service worker. App files are cached on install and served from the cache.
// IMPORTANT: bump VERSION whenever you deploy a change to any app file, so installed copies pick it up.
const VERSION = '1.0.1';
const CACHE = 'my100days-' + VERSION;
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './model.js', './db.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache:'reload' bypasses the HTTP cache so a fresh deploy is never half-old, half-new.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('my100days-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page asks for activation once the person taps "Refresh" on the update banner (so nothing reloads mid-typing).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
