/**
 * Pure duplicate grouping + survivor selection (ADR §5.4 Phase 5).
 * Same normalized URL across windows = duplicate.
 * Keep: active / audible / pinned / most recent lastAccessed; close older.
 */

import { normalizeUrlKey } from './url-normalize.js';
import { isSkippableUrl } from './tab-eligibility.js';

/**
 * Survivor score — higher means keep. Priority: active > audible > pinned > lastAccessed.
 * @param {{ active?: boolean, audible?: boolean, pinned?: boolean, lastAccessed?: number }} tab
 */
export function survivorScore(tab) {
  if (!tab) return 0;
  let score = 0;
  if (tab.active) score += 1e15;
  if (tab.audible) score += 1e14;
  if (tab.pinned) score += 1e13;
  const accessed = Number(tab.lastAccessed);
  // Missing lastAccessed → treat as recent (don't prefer closing unknown-age tabs).
  score += Number.isFinite(accessed) ? accessed : Date.now();
  return score;
}

/**
 * Whether a tab can participate in auto-dedupe.
 * @param {{ id?: number, url?: string }} tab
 * @param {Set<number> | Iterable<number> | null | undefined} closingTabIds
 */
export function isDedupeCandidate(tab, closingTabIds) {
  if (!tab || typeof tab.id !== 'number') return false;
  if (closingTabIds) {
    const closing =
      closingTabIds instanceof Set ? closingTabIds : new Set(closingTabIds);
    if (closing.has(tab.id)) return false;
  }
  if (!tab.url || isSkippableUrl(tab.url)) return false;
  if (!normalizeUrlKey(tab.url)) return false;
  return true;
}

/**
 * Group eligible tabs by normalized URL key.
 * @param {Array<{ id?: number, url?: string, active?: boolean, audible?: boolean, pinned?: boolean, lastAccessed?: number, windowId?: number }>} tabs
 * @param {{ closingTabIds?: Set<number> | Iterable<number> | null, stripHash?: boolean, stripTracking?: boolean }} [opts]
 * @returns {Map<string, typeof tabs>}
 */
export function groupTabsByNormalizedUrl(tabs, opts = {}) {
  /** @type {Map<string, typeof tabs>} */
  const groups = new Map();
  const normalizeOpts = {
    stripHash: opts.stripHash !== false,
    stripTracking: opts.stripTracking !== false,
  };

  for (const tab of tabs || []) {
    if (!isDedupeCandidate(tab, opts.closingTabIds)) continue;
    const key = normalizeUrlKey(tab.url || '', normalizeOpts);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(tab);
    else groups.set(key, [tab]);
  }
  return groups;
}

/**
 * @typedef {{ urlKey: string, keep: object, close: object[] }} DedupePlan
 */

/**
 * Build auto-close-older plans for duplicate groups (cross-window).
 * @param {Array<{ id?: number, url?: string, active?: boolean, audible?: boolean, pinned?: boolean, lastAccessed?: number, windowId?: number }>} tabs
 * @param {{ closingTabIds?: Set<number> | Iterable<number> | null, stripHash?: boolean, stripTracking?: boolean }} [opts]
 * @returns {DedupePlan[]}
 */
export function planAutoCloseOlder(tabs, opts = {}) {
  const groups = groupTabsByNormalizedUrl(tabs, opts);
  /** @type {DedupePlan[]} */
  const plans = [];

  for (const [urlKey, members] of groups) {
    if (members.length < 2) continue;
    const ranked = [...members].sort((a, b) => {
      const diff = survivorScore(b) - survivorScore(a);
      if (diff !== 0) return diff;
      // Stable tie-break: higher id = slightly newer open.
      return (b.id || 0) - (a.id || 0);
    });
    const keep = ranked[0];
    const close = ranked.slice(1);
    if (keep && close.length) {
      plans.push({ urlKey, keep, close });
    }
  }
  return plans;
}
