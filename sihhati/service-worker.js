/**
 * service-worker.js — Offline content caching for Sihhati (صحتي)
 * Adapted from kiwix-js Service Worker pattern (GPL v3, Kiwix/kiwix-js contributors)
 *
 * Caching strategy:
 *   APP_CACHE  — caches the application shell (HTML, CSS, JS) for offline PWA use
 *   CONTENT_CACHE — caches all JSON content + gzip bundle for offline reading
 */

'use strict';

const appVersion = '1.0.0';

const APP_CACHE = 'sihati-app-' + appVersion;
const CONTENT_CACHE = 'sihati-content-' + appVersion;

const regexpCachedContentTypes = /text\/css|\/javascript|application\/javascript|application\/json|image\/png|image\/svg\+xml|application\/gzip/i;

const regexpExcludedSchema = /^(?:file|chrome-extension|moz-extension):/i;

// Files that make up the app shell — pre-cached on install
const APP_SHELL = [
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/marked.min.js',
  './js/fuse.min.js',
  './js/verify-hash.js',
  './content-config.json',
  './data/medical.json',
  './data/medical-content.json.gz',
  './manifest.webmanifest'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(APP_CACHE).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(name) {
          return name !== APP_CACHE && name !== CONTENT_CACHE;
        }).map(function(name) {
          return caches.delete(name);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  const request = event.request;

  if (request.method !== 'GET' || regexpExcludedSchema.test(request.url)) {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  // App shell files: cache-first
  if (isAppShell(url.pathname)) {
    event.respondWith(
      caches.match(request).then(function(cached) {
        return cached || fetch(request).then(function(response) {
          if (response.ok) {
            const clone = response.clone();
            caches.open(APP_CACHE).then(function(cache) {
              cache.put(request, clone);
            });
          }
          return response;
        }).catch(function() {
          return caches.match('./index.html');
        });
      })
    );
    return;
  }

  // JSON and gzip content files: network-first, fallback to cache
  if (url.pathname.endsWith('.json') || url.pathname.endsWith('.gz')) {
    event.respondWith(
      fetch(request).then(function(response) {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CONTENT_CACHE).then(function(cache) {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(request);
      })
    );
    return;
  }

  // Other same-origin GET: try cache first, then network
  event.respondWith(
    caches.match(request).then(function(cached) {
      if (cached) return cached;
      return fetch(request).then(function(response) {
        if (response.ok) {
          const contentType = response.headers.get('Content-Type') || '';
          if (regexpCachedContentTypes.test(contentType)) {
            const clone = response.clone();
            caches.open(APP_CACHE).then(function(cache) {
              cache.put(request, clone);
            });
          }
        }
        return response;
      });
    })
  );
});

function isAppShell(pathname) {
  return pathname.endsWith('.html') ||
         pathname.endsWith('.css') ||
         pathname.endsWith('.js') ||
         pathname.endsWith('.webmanifest') ||
         pathname.endsWith('.png') ||
         pathname.endsWith('.gz');
}

self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
