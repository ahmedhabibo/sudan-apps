/**
 * service-worker.js — Derasa offline education PWA
 * Adapted from kiwix-js SW caching pattern (GPL v3)
 *
 * Strategy: cache-first for app shell, network-first for JSON content packs
 * with cache fallback for offline use.
 */

'use strict';

const appVersion = '1.0.0';
const APP_CACHE = 'derasa-app-' + appVersion;
const CONTENT_CACHE = 'derasa-content-' + appVersion;

const APP_SHELL = [
  './www/index.html',
  './www/css/app.css',
  './www/js/app.js',
  './www/js/marked.min.js',
  './www/js/fuse.min.js',
  './www/content-config.json',
  './www/data/education/math-g6-manifest.json',
  './www/data/education/math-g6.json',
  './www/data/education/math-g6.json.gz',
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
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) {
          return n !== APP_CACHE && n !== CONTENT_CACHE;
        }).map(function(n) {
          return caches.delete(n);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App shell: cache-first
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') || url.pathname.endsWith('.webmanifest') ||
      url.pathname.endsWith('.png')) {
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

  // JSON content packs: network-first, fallback to cache
  if (url.pathname.endsWith('.json') || url.pathname.endsWith('.json.gz')) {
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

  // Other: cache-first fallback to network
  event.respondWith(
    caches.match(request).then(function(cached) {
      if (cached) return cached;
      return fetch(request);
    })
  );
});

self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
