/**
 * Topic cache LRU — urlKey + contentHash → CacheEntry (ADR §3.2 / §5.2).
 * Persist/load via chrome.storage.local (STORAGE_KEYS.TOPIC_CACHE).
 */

import { EXCERPT_HARD_CAP_CHARS, STORAGE_KEYS } from './constants.js';

/**
 * @typedef {object} CacheEntry
 * @property {string} urlKey
 * @property {string} contentHash
 * @property {string} topicKey
 * @property {string} topicLabel
 * @property {string} [excerpt]
 * @property {number} createdAt
 * @property {number} lastHitAt
 * @property {number} hitCount
 */

/**
 * Cap excerpt length for cache / LLM payload.
 * @param {string | undefined | null} text
 * @param {number} [cap]
 */
export function capExcerpt(text, cap = EXCERPT_HARD_CAP_CHARS) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= cap) return t;
  return t.slice(0, Math.max(0, cap - 1)).trimEnd() + '…';
}

/**
 * In-memory LRU topic cache. Keys are `${urlKey}\0${contentHash}`.
 */
export class TopicCacheLru {
  /** @param {number} [maxSize] */
  constructor(maxSize = 500) {
    this.maxSize = Math.max(1, maxSize);
    /** @type {Map<string, CacheEntry>} */
    this._map = new Map();
  }

  /** @param {string} urlKey @param {string} contentHash */
  static makeKey(urlKey, contentHash) {
    return `${urlKey}\0${contentHash}`;
  }

  get size() {
    return this._map.size;
  }

  /**
   * Read without mutating LRU order / hit counts (privacy preview).
   * @param {string} urlKey
   * @param {string} contentHash
   * @returns {CacheEntry | null}
   */
  peek(urlKey, contentHash) {
    const key = TopicCacheLru.makeKey(urlKey, contentHash);
    return this._map.get(key) ?? null;
  }

  /**
   * @param {string} urlKey
   * @param {string} contentHash
   * @returns {CacheEntry | null}
   */
  lookup(urlKey, contentHash) {
    const key = TopicCacheLru.makeKey(urlKey, contentHash);
    const entry = this._map.get(key);
    if (!entry) return null;
    // Refresh LRU order
    this._map.delete(key);
    entry.lastHitAt = Date.now();
    entry.hitCount = (entry.hitCount || 0) + 1;
    this._map.set(key, entry);
    return entry;
  }

  /**
   * @param {Omit<CacheEntry, 'createdAt' | 'lastHitAt' | 'hitCount'> & Partial<CacheEntry>} entry
   */
  upsert(entry) {
    const now = Date.now();
    const key = TopicCacheLru.makeKey(entry.urlKey, entry.contentHash);
    const prev = this._map.get(key);
    if (prev) this._map.delete(key);

    /** @type {CacheEntry} */
    const next = {
      urlKey: entry.urlKey,
      contentHash: entry.contentHash,
      topicKey: entry.topicKey,
      topicLabel: entry.topicLabel,
      excerpt: capExcerpt(entry.excerpt),
      createdAt: entry.createdAt ?? prev?.createdAt ?? now,
      lastHitAt: now,
      hitCount: (prev?.hitCount ?? 0) + 1,
    };
    this._map.set(key, next);
    this._evict();
    return next;
  }

  /** Mark entries for a urlKey stale by removing them (contentHash change). */
  invalidateUrl(urlKey) {
    for (const key of [...this._map.keys()]) {
      if (key.startsWith(`${urlKey}\0`)) this._map.delete(key);
    }
  }

  /** @returns {CacheEntry[]} oldest → newest (insertion / LRU order) */
  entries() {
    return [...this._map.values()];
  }

  clear() {
    this._map.clear();
  }

  /** Serialize for chrome.storage.local */
  toJSON() {
    return {
      maxSize: this.maxSize,
      entries: this.entries(),
    };
  }

  /**
   * @param {{ maxSize?: number, entries?: CacheEntry[] } | null | undefined} raw
   */
  static fromJSON(raw) {
    const cache = new TopicCacheLru(raw?.maxSize ?? 500);
    for (const e of raw?.entries ?? []) {
      if (e?.urlKey && e?.contentHash && e?.topicKey) {
        cache._map.set(TopicCacheLru.makeKey(e.urlKey, e.contentHash), {
          ...e,
          excerpt: capExcerpt(e.excerpt),
        });
      }
    }
    cache._evict();
    return cache;
  }

  _evict() {
    while (this._map.size > this.maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
}

/**
 * Load topic cache from chrome.storage.local.
 * @param {number} [maxSize]
 * @param {typeof chrome.storage | undefined} storage
 * @returns {Promise<TopicCacheLru>}
 */
export async function loadTopicCache(maxSize = 500, storage = globalThis.chrome?.storage) {
  if (!storage?.local) return new TopicCacheLru(maxSize);
  const result = await storage.local.get(STORAGE_KEYS.TOPIC_CACHE);
  const raw = result[STORAGE_KEYS.TOPIC_CACHE];
  const cache = TopicCacheLru.fromJSON(
    raw && typeof raw === 'object'
      ? { maxSize: raw.maxSize ?? maxSize, entries: raw.entries }
      : { maxSize, entries: [] },
  );
  cache.maxSize = Math.max(1, maxSize);
  cache._evict();
  return cache;
}

/**
 * Persist topic cache snapshot. Does not log entry contents.
 * @param {TopicCacheLru} cache
 * @param {typeof chrome.storage | undefined} storage
 */
export async function persistTopicCache(cache, storage = globalThis.chrome?.storage) {
  if (!storage?.local || !cache) return;
  await storage.local.set({
    [STORAGE_KEYS.TOPIC_CACHE]: cache.toJSON(),
  });
}

/**
 * Merge another cache's entries into `target` (LRU order preserved for incoming).
 * Useful after hydrate + in-memory upserts.
 * @param {TopicCacheLru} target
 * @param {TopicCacheLru | { entries?: import('./topic-cache.js').CacheEntry[] } | null | undefined} source
 */
export function mergeTopicCacheEntries(target, source) {
  if (!target || !source) return target;
  const entries =
    typeof source.entries === 'function'
      ? source.entries()
      : Array.isArray(source.entries)
        ? source.entries
        : [];
  for (const e of entries) {
    if (!e?.urlKey || !e?.contentHash || !e?.topicKey) continue;
    target.upsert({
      urlKey: e.urlKey,
      contentHash: e.contentHash,
      topicKey: e.topicKey,
      topicLabel: e.topicLabel || e.topicKey,
      excerpt: e.excerpt,
      createdAt: e.createdAt,
      hitCount: e.hitCount,
    });
  }
  return target;
}
