/**
 * Stacks reclaim / recall stub (Phase 4).
 * StackRecords only — not chrome.sessions. Overflow: warn → export or discard.
 */

/**
 * @param {{ maxOpenTabs: number }} _config
 * @returns {Promise<{ reclaimed: number, stub: true }>}
 */
export async function maybeReclaim(_config) {
  return { reclaimed: 0, stub: true };
}

/**
 * @param {string} _stackId
 * @returns {Promise<{ ok: false, stub: true, error: string }>}
 */
export async function recallStack(_stackId) {
  return { ok: false, stub: true, error: 'recall not implemented (Phase 4)' };
}
