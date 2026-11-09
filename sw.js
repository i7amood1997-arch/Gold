// Offline shell. Network-first for our own files so a redeploy shows up on
// the next launch; the cache only answers when there is no network. Price
// APIs are cross-origin and never touched here — the app caches the last
// good price itself.
const CACHE = 'iyar-v2';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './fonts.css',
  './manifest.json',
  './js/app.js',
  './js/calc.js',
  './js/prices.js',
  './js/store.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './fonts/plex-arabic-arabic-400.woff2',
  './fonts/plex-arabic-arabic-500.woff2',
  './fonts/plex-arabic-arabic-600.woff2',
  './fonts/plex-arabic-latin-400.woff2',
  './fonts/plex-arabic-latin-500.woff2',
  './fonts/plex-arabic-latin-600.woff2',
];

async function recache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, res);
    } catch { /* offline: keep what we have */ }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil(recache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      // no-cache: GitHub Pages sends max-age=600; always revalidate so app.js
      // and app.css never come from different deploys.
      const res = await fetch(request, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    } catch {
      return (await caches.match(request, { ignoreSearch: true }))
        ?? (request.mode === 'navigate' ? await caches.match('./index.html') : undefined)
        ?? Response.error();
    }
  })());
});
