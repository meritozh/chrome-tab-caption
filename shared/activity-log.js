/**
 * Minimal in-memory activity log for dedupe / reclaim (ADR §5.4).
 * Not persisted — SW lifetime only. Cap keeps memory bounded.
 */

export const ACTIVITY_LOG_MAX = 40;

/**
 * @typedef {{
 *   id: string,
 *   at: number,
 *   kind: string,
 *   message: string,
 *   detail?: Record<string, unknown>,
 * }} ActivityEntry
 */

/**
 * @param {number} [max]
 */
export function createActivityLog(max = ACTIVITY_LOG_MAX) {
  /** @type {ActivityEntry[]} */
  const entries = [];
  const cap = Math.max(1, max);

  /**
   * @param {{ kind: string, message: string, detail?: Record<string, unknown>, at?: number }} partial
   */
  function push(partial) {
    const entry = {
      id: `act-${Date.now()}-${entries.length}`,
      at: partial.at ?? Date.now(),
      kind: String(partial.kind || 'info'),
      message: String(partial.message || ''),
      detail: partial.detail && typeof partial.detail === 'object' ? partial.detail : undefined,
    };
    entries.unshift(entry);
    while (entries.length > cap) entries.pop();
    return entry;
  }

  function list() {
    return entries.slice();
  }

  function clear() {
    entries.length = 0;
  }

  return { push, list, clear, get size() { return entries.length; } };
}
