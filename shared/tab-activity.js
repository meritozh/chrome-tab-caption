/**
 * In-memory lastAccessed bumps for tabs the user just selected.
 * Chrome's tab.lastAccessed can lag briefly after activate; reclaim must not
 * treat a freshly switched-to tab as least-recently-accessed.
 *
 * Lives in the service worker — cleared on tab remove; lost on SW sleep (OK:
 * Chrome's lastAccessed catches up before the next maintain reclaim).
 */

/**
 * @returns {{
 *   touch: (tabId: number, at?: number) => void,
 *   clear: (tabId: number) => void,
 *   clearAll: () => void,
 *   getOverride: (tabId: number) => number | undefined,
 *   applyToTabs: <T extends { id?: number, lastAccessed?: number }>(tabs: T[]) => T[],
 *   size: () => number,
 * }}
 */
export function createTabActivityStore() {
  /** @type {Map<number, number>} */
  const byId = new Map();

  return {
    /**
     * @param {number} tabId
     * @param {number} [at]
     */
    touch(tabId, at = Date.now()) {
      if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return;
      const ts = Number(at);
      if (!Number.isFinite(ts) || ts <= 0) return;
      const prev = byId.get(tabId) || 0;
      if (ts > prev) byId.set(tabId, ts);
    },

    /** @param {number} tabId */
    clear(tabId) {
      byId.delete(tabId);
    },

    clearAll() {
      byId.clear();
    },

    /** @param {number} tabId */
    getOverride(tabId) {
      return byId.get(tabId);
    },

    /**
     * Return tabs with lastAccessed raised to any newer touch timestamp.
     * Does not mutate the input array or objects.
     * @template {{ id?: number, lastAccessed?: number }} T
     * @param {T[]} tabs
     * @returns {T[]}
     */
    applyToTabs(tabs) {
      const list = Array.isArray(tabs) ? tabs : [];
      if (!byId.size) return list;
      return list.map((tab) => {
        if (typeof tab?.id !== 'number') return tab;
        const touched = byId.get(tab.id);
        if (touched == null) return tab;
        const chromeLa = Number(tab.lastAccessed);
        const baseline = Number.isFinite(chromeLa) && chromeLa > 0 ? chromeLa : 0;
        if (touched <= baseline) return tab;
        return { ...tab, lastAccessed: touched };
      });
    },

    size() {
      return byId.size;
    },
  };
}
