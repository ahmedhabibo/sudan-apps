/**
 * db.js — IndexedDB wrapper using Dexie.js
 * Stores: content, updates_queue, progress
 *
 * Dexie is loaded from CDN and precached by the Service Worker at install time.
 * Each app extends this DB by defining additional stores in its own db-init.
 */

// Dexie is loaded via the precached CDN script; if offline-first fallback is
// needed, Dexie is precached in sw.js so this always resolves.
const DEXIE_CDN = "https://unpkg.com/dexie@3.2.7/dist/dexie.min.js";

function loadDexie() {
  return new Promise((resolve, reject) => {
    if (typeof Dexie !== "undefined") {
      resolve(Dexie);
      return;
    }
    const script = document.createElement("script");
    script.src = DEXIE_CDN;
    script.onload = () => resolve(Dexie);
    script.onerror = () => reject(new Error("Failed to load Dexie from CDN"));
    document.head.appendChild(script);
  });
}

// ---------------------------------------------------------------------------
// SudanAppDB — the shared database schema
// ---------------------------------------------------------------------------
let _db = null;

async function initDB() {
  const DexieLib = await loadDexie();

  _db = new DexieLib("SudanAppDB");

  _db.version(1).stores({
    // content: app-definable structured content (articles, lessons, items, etc.)
    // keyPath = id (string), indexes on type + updatedAt for efficient queries
    content: "&id, type, updatedAt, [type+updatedAt]",

    // updates_queue: pending content downloads to process when online
    // keyPath = id (auto-increment), index on status (pending/done/failed)
    updates_queue: "++id, status, createdAt",

    // progress: user progress tracking (read items, completed lessons, etc.)
    // keyPath = contentId, index on userId + type
    progress: "&contentId, userId, type, updatedAt"
  });

  await _db.open();
  return _db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const DB = {
  /** Must be called once before any other method. */
  async ready() {
    if (!_db) await initDB();
    return _db;
  },

  // --- content store ---
  async putContent(item) {
    const db = await this.ready();
    item.updatedAt = item.updatedAt || Date.now();
    return db.content.put(item);
  },

  async getContent(id) {
    const db = await this.ready();
    return db.content.get(id);
  },

  async getContentByType(type, limit) {
    const db = await this.ready();
    let coll = db.content.where("type").equals(type).reverse();
    if (limit) coll = coll.limit(limit);
    return coll.toArray();
  },

  async getAllContent() {
    const db = await this.ready();
    return db.content.toArray();
  },

  async deleteContent(id) {
    const db = await this.ready();
    return db.content.delete(id);
  },

  // --- updates_queue store ---
  async enqueueUpdate(updatePayload) {
    const db = await this.ready();
    return db.updates_queue.add({
      payload: updatePayload,
      status: "pending",
      createdAt: Date.now()
    });
  },

  async getPendingUpdates() {
    const db = await this.ready();
    return db.updates_queue.where("status").equals("pending").toArray();
  },

  async markUpdateDone(id) {
    const db = await this.ready();
    return db.updates_queue.update(id, { status: "done" });
  },

  async markUpdateFailed(id, error) {
    const db = await this.ready();
    return db.updates_queue.update(id, { status: "failed", error: String(error) });
  },

  // --- progress store ---
  async putProgress(contentId, progressData) {
    const db = await this.ready();
    return db.progress.put({
      contentId,
      ...progressData,
      updatedAt: Date.now()
    });
  },

  async getProgress(contentId) {
    const db = await this.ready();
    return db.progress.get(contentId);
  },

  async getAllProgress() {
    const db = await this.ready();
    return db.progress.toArray();
  },

  // --- maintenance ---
  async clearAll() {
    const db = await this.ready();
    await Promise.all([
      db.content.clear(),
      db.updates_queue.clear(),
      db.progress.clear()
    ]);
  }
};

// Export as ES module
export default DB;
