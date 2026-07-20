/**
 * sw.js — Service Worker for Sudan PWA scaffold
 *
 * Strategy:
 * - Workbox is loaded via importScripts from a CDN (unpkg). During the
 *   'install' event we precache the app shell + the Workbox library itself.
 *   This means ALL external dependencies are cached offline after the first
 *   install. No runtime CDN calls are made.
 * - Precache: app shell files (index.html, styles.css, db.js, verify-hash.js,
 *   manifest.json, and the Dexie CDN copy).
 * - Runtime cache: content navigations use NetworkFirst (fresh when online,
 *   cached when offline); static assets use StaleWhileRevalidate.
 *
 * Compatibility: Android Chrome 7+ supports Service Workers but not ES modules
 * in SW scope. Therefore this file uses importScripts (classic) syntax only.
 * Workbox 6.x is the last major version that supports importScripts from CDN.
 */

const WORKBOX_CDN = "https://unpkg.com/workbox-sw@6.5.4/build/workbox-sw.min.js";
const DEXIE_CDN = "https://unpkg.com/dexie@3.2.7/dist/dexie.min.js";

// ---------------------------------------------------------------------------
// Self-contained SW boot — if Workbox fails to load, fall back to a minimal
// hand-rolled cache strategy so the app still works offline (graceful
// degradation for very old WebView implementations).
// ---------------------------------------------------------------------------

importScripts(WORKBOX_CDN);

if (typeof workbox !== "undefined") {
  // --- Workbox available path ---

  // Tell Workbox to use our precache list at install time
  const precacheFiles = [
    { url: "./index.html", revision: "v1" },
    { url: "./styles.css", revision: "v1" },
    { url: "./db.js", revision: "v1" },
    { url: "./verify-hash.js", revision: "v1" },
    { url: "./manifest.json", revision: "v1" },
    { url: DEXIE_CDN, revision: null }, // cache Dexie for offline DB
    { url: WORKBOX_CDN, revision: null }, // cache Workbox itself
  ];

  workbox.precaching.precacheAndRoute(precacheFiles);

  // Registered + precached, so Dexie is served from cache
  self.addEventListener("install", (event) => {
    // Pre-cache Dexie by fetching it during SW install
    event.waitUntil(
      caches.open("sudan-app-external").then(async (cache) => {
        try {
          await cache.add(DEXIE_CDN);
          await cache.add(WORKBOX_CDN);
        } catch (e) {
          console.warn("SW install: could not precache external CDNs now (will retry on first use)", e);
        }
      })
    );
    self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });

  // --- Runtime caching strategies ---
  // Navigations (HTML page loads): NetworkFirst with offline fallback
  workbox.routing.registerRoute(
    ({ request }) => request.mode === "navigate",
    new workbox.strategies.NetworkFirst({
      cacheName: "sudan-app-pages",
      networkTimeoutSeconds: 5,
      plugins: [
        new workbox.cacheable_response.CacheableResponsePlugin({ statuses: [200] }),
      ],
    })
  );

  // Static assets (CSS, JS, JSON): StaleWhileRevalidate
  workbox.routing.registerRoute(
    ({ request }) =>
      request.destination === "style" ||
      request.destination === "script" ||
      request.destination === "manifest",
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: "sudan-app-static",
    })
  );

  // External CDN libs (Dexie): CacheFirst, long-lived
  workbox.routing.registerRoute(
    ({ url }) => url.origin === "https://unpkg.com",
    new workbox.strategies.CacheFirst({
      cacheName: "sudan-app-external",
      plugins: [
        new workbox.cacheable_response.CacheableResponsePlugin({ statuses: [200] }),
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 10,
          maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
        }),
      ],
    })
  );

  // Images: CacheFirst with expiration
  workbox.routing.registerRoute(
    ({ request }) => request.destination === "image",
    new workbox.strategies.CacheFirst({
      cacheName: "sudan-app-images",
      plugins: [
        new workbox.cacheable_response.CacheableResponsePlugin({ statuses: [200] }),
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 50,
          maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
        }),
      ],
    })
  );

  // --- Message handler: skipWaiting on UPDATE message ---
  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") {
      self.skipWaiting();
    }
  });

} else {
  // --- Minimal fallback SW (Workbox failed to load) ---

  const FALLBACK_CACHE = "sudan-app-fallback";

  self.addEventListener("install", (event) => {
    event.waitUntil(
      caches.open(FALLBACK_CACHE).then((cache) =>
        cache.addAll([
          "./index.html",
          "./styles.css",
          "./db.js",
          "./verify-hash.js",
          "./manifest.json",
        ]).catch(() => undefined)
      )
    );
    self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            // Cache successful GET responses
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(FALLBACK_CACHE).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match("./index.html"));
      })
    );
  });

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") {
      self.skipWaiting();
    }
  });
}
