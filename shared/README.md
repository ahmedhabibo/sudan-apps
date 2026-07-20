# Shared PWA Scaffold — Sudan Apps

## Overview

This directory contains the shared PWA (Progressive Web App) scaffold that the 3 Sudan apps inherit. Each app builds on this skeleton by adding its own `app.js`, content definitions, and branding — without modifying the shared files.

The scaffold provides:

| File | Purpose |
|------|---------|
| `index.html` | Minimal app shell with RTL sidebar, content area, and script imports |
| `sw.js` | Workbox-based Service Worker: precaches app shell + runtime caching |
| `manifest.json` | PWA manifest with Arabic name, icons, standalone display |
| `db.js` | IndexedDB wrapper (Dexie.js) with stores: content, updates_queue, progress |
| `verify-hash.js` | SHA-256 content integrity checker (SubtleCrypto + JS fallback) |
| `styles.css` | RTL Arabic-first layout, Flexbox-only (no CSS Grid), system fonts |

## Design Constraints Met

- **Bundle < 200KB**: All app-shell files total under 200KB. No Preact/React — vanilla JS ES modules. Dexie (~50KB minified) is loaded from CDN and precached by the Service Worker at install time, so it's available offline without increasing the app shell bundle.
- **Android Chrome 7+ (2016-era phones)**: Service Worker uses `importScripts` (classic, not ES modules). CSS uses Flexbox only (no CSS Grid). Touch targets are min 44x44px. No `let`/`const` in the Service Worker body (only `var`-compatible patterns are used in the fallback path; the Workbox path uses modern syntax since Workbox itself targets Chrome 49+).
- **No runtime API calls**: All CDN dependencies (Workbox SW, Dexie) are precached during the SW `install` event. After first launch, the app works entirely offline.
- **Arabic system fonts**: The CSS `--font-stack` uses only system fonts available on Android (`Droid Arabic Kufi`, `Noto Naskh Arabic`, `Geeza Pro`, etc.). No web fonts are downloaded.
- **Content integrity**: `verify-hash.js` provides SHA-256 hashing using the Web Crypto API with a pure-JS fallback for browsers without `crypto.subtle`.

## How Each App Extends This Scaffold

Each of the 3 Sudan apps (education, news, utilities) follows this pattern:

### 1. Directory structure

```
sudan-apps/
  shared/          ← this scaffold (do NOT modify per-app)
    index.html
    sw.js
    manifest.json
    db.js
    verify-hash.js
    styles.css
  app-education/
    index.html      ← copies and extends shared/index.html
    app.js          ← app-specific logic
    content/        ← pre-packaged content bundles
    icons/          ← app-specific icons
  app-news/
    ...
  app-utilities/
    ...
```

### 2. Extending the Service Worker

Copy `shared/sw.js` into the app directory and add app-specific precache entries:

```javascript
// At the top of app-version/sw.js:
importScripts("../shared/sw.js");  // or inline the shared logic

// Then add app-specific precache:
const appFiles = [
  { url: "./app.js", revision: "v1" },
  { url: "./content/lesson-01.json", revision: "v1" },
  // ...
  { url: "../shared/sw.js", revision: "v1" }, // include parent files
];
workbox.precaching.precacheAndRoute(appFiles);
```

### 3. Using the DB (Dexie stores)

The shared `db.js` creates 3 stores. Apps use them as follows:

| Store | Usage |
|-------|-------|
| `content` | App-specific content items (lessons, articles, guides). Each item has `id`, `type`, `title`, `data`, `hash`, `updatedAt`. |
| `updates_queue` | Pending content downloads. When the app detects new content (via Bluetooth/SD card), it enqueues updates here. The SW processes them when the connection is available. |
| `progress` | User progress (lessons completed, articles read). Keyed by `contentId`, includes `userId`, `type`, `value`, `updatedAt`. |

```javascript
import DB from "../shared/db.js";

// Store content
await DB.putContent({
  id: "lesson-wudu-01",
  type: "lesson",
  title: "صفة الوضوء",
  data: { ... },
  hash: "abc123..."  // SHA-256 from verify-hash.js
});

// Track progress
await DB.putProgress("lesson-wudu-01", {
  userId: "user-default",
  type: "completed",
  value: 100
});
```

### 4. Content integrity verification

Before storing any downloaded content, verify its hash:

```javascript
import VerifyHash from "../shared/verify-hash.js";

const content = await response.text();
const isVerified = await VerifyHash.verify(content, expectedHash);
if (isVerified) {
  await DB.putContent({ id: "...", data: content, hash: expectedHash });
} else {
  console.error("Content corrupted or tampered!");
}
```

### 5. Customizing the manifest

Each app copies `manifest.json` and overrides:
- `name` and `short_name` with app-specific Arabic titles
- `icons` with app-specific icon files
- `theme_color` and `background_color` with app branding colors
- `categories` array with relevant categories

### 6. Registering the Service Worker

In the app's `app.js`:

```javascript
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then((reg) => console.log("SW registered:", reg.scope))
    .catch((err) => console.error("SW registration failed:", err));
}
```

## Browser Compatibility Matrix

| Feature | Required | Supported Since | Fallback |
|---------|----------|-----------------|----------|
| Service Workers | Android Chrome 7+ | Android Chrome 4.1 (2013) | Fallback SW (basic cache) |
| IndexedDB | Android Chrome 7+ | Android Chrome 4.1 | — (no fallback; required) |
| Fetch API | Android Chrome 7+ | Android Chrome 4.2 | XHR in fallback SW |
| Add to Home Screen | Android Chrome 7+ | Android Chrome 4.1 | — (PWA install prompt) |
| Web Crypto (SHA-256) | Preferred | Android Chrome 11+ | Pure JS SHA-256 in verify-hash.js |

## Size Audit

App shell file sizes (without content, without CDN):

| File | Size (approx) |
|------|------|
| index.html | 1.3 KB |
| sw.js | 5.9 KB |
| manifest.json | 0.7 KB |
| db.js | 4.2 KB |
| verify-hash.js | 5.9 KB |
| styles.css | 7.2 KB |
| **Total** | **~25 KB** |

Well under 200KB. Dexie.js (~50KB minified) and Workbox SW (~15KB minified) are precached from CDN on first install and count as external cached resources, not app shell.
