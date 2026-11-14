/**
 * StackRecords — tabs reclaimed by this extension (ADR §5.6).
 * Not chrome.sessions / recently-closed.
 * Overflow: never silent LRU — caller warns → user export or discard.
 */

import { STORAGE_KEYS } from './constants.js';
import { evaluateStackCapacity } from './reclaim-policy.js';

/**
 * @typedef {object} StackRecord
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string} [favIconUrl]
 * @property {string} [topicKey]
 * @property {string} [topicLabel]
 * @property {string} [groupTitle]
 * @property {string} [groupColor]
 * @property {number} [windowIdHint]
 * @property {number} reclaimedAt
 * @property {number} lastAccessedAt
 */

/**
 * @param {Omit<StackRecord, 'id' | 'reclaimedAt'> & { id?: string, reclaimedAt?: number }} partial
 * @returns {StackRecord}
 */
export function createStackRecord(partial) {
  const now = Date.now();
  return {
    id: partial.id ?? `stack_${now}_${Math.random().toString(36).slice(2, 10)}`,
    url: partial.url,
    title: partial.title ?? '',
    favIconUrl: partial.favIconUrl,
    topicKey: partial.topicKey,
    topicLabel: partial.topicLabel,
    groupTitle: partial.groupTitle,
    groupColor: partial.groupColor,
    windowIdHint: partial.windowIdHint,
    reclaimedAt: partial.reclaimedAt ?? now,
    lastAccessedAt: partial.lastAccessedAt ?? now,
  };
}

/**
 * In-memory stack store with hard capacity (no silent eviction on push).
 */
export class StackRecordStore {
  /** @param {number} [maxSize] */
  constructor(maxSize = 500) {
    this.maxSize = Math.max(1, maxSize);
    /** @type {StackRecord[]} newest-first */
    this._records = [];
  }

  get size() {
    return this._records.length;
  }

  /** @returns {StackRecord[]} */
  list() {
    return [...this._records];
  }

  /** @param {string} id */
  getById(id) {
    return this._records.find((r) => r.id === id) ?? null;
  }

  /**
   * Capacity check without mutating.
   * @param {number} [incoming]
   */
  capacityFor(incoming = 1) {
    return evaluateStackCapacity({
      size: this._records.length,
      maxSize: this.maxSize,
      incoming,
    });
  }

  /**
   * Push only when under capacity. Refuses when at maxSize (overflow warn path).
   * @param {StackRecord} record
   * @returns {{ record: StackRecord | null, accepted: boolean, wouldOverflow: boolean }}
   */
  tryPush(record) {
    if (this._records.length >= this.maxSize) {
      return { record: null, accepted: false, wouldOverflow: true };
    }
    this._records.unshift(record);
    return { record, accepted: true, wouldOverflow: false };
  }

  /**
   * Unconditional push (tests / import). Prefer tryPush for reclaim.
   * @param {StackRecord} record
   * @returns {{ record: StackRecord, wouldOverflow: boolean }}
   */
  push(record) {
    const wouldOverflow = this._records.length >= this.maxSize;
    this._records.unshift(record);
    return { record, wouldOverflow };
  }

  /** Discard oldest N records (after user confirms overflow discard / export). */
  discardOldest(count = 1) {
    const n = Math.max(0, Math.min(this._records.length, Math.floor(Number(count) || 0)));
    if (n <= 0) return [];
    return this._records.splice(-n, n);
  }

  /** @param {string} id */
  remove(id) {
    const i = this._records.findIndex((r) => r.id === id);
    if (i < 0) return null;
    return this._records.splice(i, 1)[0];
  }

  /**
   * Patch fields on an existing stack record (e.g. reclassify topic).
   * @param {string} id
   * @param {Partial<StackRecord>} patch
   * @returns {StackRecord | null}
   */
  update(id, patch) {
    const rec = this.getById(id);
    if (!rec || !patch || typeof patch !== 'object') return null;
    Object.assign(rec, patch);
    return rec;
  }

  /**
   * Export payload (JSON). Used by overflow export CTA.
   * @param {{ oldestOnly?: number } | null} [opts]
   * @returns {string}
   */
  exportJson(opts = null) {
    let stacks = this._records;
    const oldestOnly = opts?.oldestOnly;
    if (typeof oldestOnly === 'number' && oldestOnly > 0) {
      stacks = this._records.slice(-oldestOnly);
    }
    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        stacks,
      },
      null,
      2,
    );
  }

  toJSON() {
    return { maxSize: this.maxSize, records: this._records };
  }

  /**
   * @param {{ maxSize?: number, records?: StackRecord[] } | null | undefined} raw
   */
  static fromJSON(raw) {
    const store = new StackRecordStore(raw?.maxSize ?? 500);
    store._records = Array.isArray(raw?.records) ? [...raw.records] : [];
    return store;
  }
}

/**
 * @param {number} [maxSize]
 * @param {typeof chrome.storage | undefined} storage
 * @returns {Promise<StackRecordStore>}
 */
export async function loadStackRecords(maxSize = 500, storage = globalThis.chrome?.storage) {
  const store = new StackRecordStore(maxSize);
  if (!storage?.local) return store;
  const result = await storage.local.get(STORAGE_KEYS.STACK_RECORDS);
  const raw = result[STORAGE_KEYS.STACK_RECORDS];
  if (raw && typeof raw === 'object') {
    const loaded = StackRecordStore.fromJSON({
      maxSize: raw.maxSize ?? maxSize,
      records: Array.isArray(raw.records) ? raw.records : [],
    });
    loaded.maxSize = Math.max(1, maxSize);
    // Keep over-capacity records in memory — warn → export/discard (never silent trim).
    return loaded;
  }
  return store;
}

/**
 * @param {StackRecordStore} store
 * @param {typeof chrome.storage | undefined} storage
 */
export async function persistStackRecords(store, storage = globalThis.chrome?.storage) {
  if (!storage?.local || !store) return;
  await storage.local.set({
    [STORAGE_KEYS.STACK_RECORDS]: store.toJSON(),
  });
}
