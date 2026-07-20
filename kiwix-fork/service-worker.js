/**
 * service-worker.js - Offline content caching for Sudan Reader
 * Adapted from kiwix-js Service Worker pattern (GPL v3, Kiwix/kiwix-js contributors)
 *
 * Caching strategy:
 *   APP_CACHE  - caches the application shell (HTML, CSS, JS) for offline PWA use
 *   CONTENT_CACHE - caches all JSON article content for offline reading
 */

'use strict';

const appVersion = '1.0.0';

// Cache names follow kiwix-js pattern: prefix + version for clean invalidation
const APP_CACHE = 'sudanreader-app-' + appVersion;
const CONTENT_CACHE = 'sudanreader-content-' + appVersion;

// Content types eligible for caching
const regexpCachedContentTypes = /text\/css|\/javascript|application\/javascript|application\/json|image\/png|image\/svg\+xml/i;

// URLs to skip (non-cacheable schemata)
const regexpExcludedSchema = /^(?:file|chrome-extension|moz-extension):/i;

// Files that make up the app shell — pre-cached on install
const APP_SHELL = [
  './www/index.html',
  './www/css/app.css',
  './www/js/app.js',
  './www/js/marked.min.js',
  './www/js/fuse.min.js',
  './www/content-config.json',
  './www/data/medical.json',
  './www/data/education.json',
  './manifest.webmanifest'
];

// Installation: pre-cache the app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(APP_CACHE).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activation: clean up old caches
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

// Fetch handler: cache-first for app shell, network-first-then-cache for content
self.addEventListener('fetch', function(event) {
  const request = event.request;

  // Skip non-GET and excluded schemas
  if (request.method !== 'GET' || regexpExcludedSchema.test(request.url)) {
    return;
  }

  const url = new URL(request.url);

  // Skip cross-origin requests
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
          return caches.match('./www/index.html');
        });
      })
    );
    return;
  }

  // JSON content files: network-first, fallback to cache
  if (url.pathname.endsWith('.json')) {
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

// Determine if a pathname is part of the static app shell
function isAppShell(pathname) {
  return pathname.endsWith('.html') ||
         pathname.endsWith('.css') ||
         pathname.endsWith('.js') ||
         pathname.endsWith('.webmanifest') ||
         pathname.endsWith('.png');
}

// Allow page to trigger updates
self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
