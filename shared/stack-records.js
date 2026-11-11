/**
 * StackRecords interface — tabs reclaimed by this extension (ADR §5.6).
 * Not chrome.sessions / recently-closed. Pure stub for Phase 0/1.
 */

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
 * In-memory stack store with soft capacity. Overflow warn is UI/SW concern.
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
   * @param {StackRecord} record
   * @returns {{ record: StackRecord, wouldOverflow: boolean }}
   */
  push(record) {
    const wouldOverflow = this._records.length >= this.maxSize;
    this._records.unshift(record);
    return { record, wouldOverflow };
  }

  /** Discard oldest N records (after user confirms overflow discard). */
  discardOldest(count = 1) {
    const n = Math.max(0, count);
    return this._records.splice(-n, n);
  }

  /** @param {string} id */
  remove(id) {
    const i = this._records.findIndex((r) => r.id === id);
    if (i < 0) return null;
    return this._records.splice(i, 1)[0];
  }

  /**
   * Stub export payload (JSON). Real export UX in Phase 4.
   * @returns {string}
   */
  exportJson() {
    return JSON.stringify({ version: 1, stacks: this._records }, null, 2);
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
