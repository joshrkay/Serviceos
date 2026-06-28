/* eslint-disable no-restricted-globals */
/**
 * Rivet PWA service worker (R4 — native-mobile parity with Jobber).
 *
 * Strategy:
 *   - Navigations: network-first → cached app shell ('/') → offline.html.
 *     Keeps the SPA fresh online and openable offline.
 *   - Static assets (script/style/font/image, same-origin): stale-while-
 *     revalidate so the app shell loads instantly and updates in the
 *     background.
 *   - Everything else (notably /api and cross-origin) passes straight to the
 *     network — we never cache authenticated API responses or runtime config.
 *
 * Bump CACHE_VERSION to invalidate old caches on deploy.
 */
const CACHE_VERSION = 'rivet-v1';
const PRECACHE = `${CACHE_VERSION}-precache`;
const RUNTIME = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = ['/', '/offline.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== PRECACHE && key !== RUNTIME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/env.js';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only; never intercept API or runtime config.
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(PRECACHE);
          return (await cache.match('/')) || (await cache.match('/offline.html'));
        }),
    );
    return;
  }

  const dest = request.destination;
  if (dest === 'script' || dest === 'style' || dest === 'font' || dest === 'image') {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
