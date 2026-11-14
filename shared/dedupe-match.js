/**
 * Pure duplicate grouping + survivor selection (ADR §5.4 Phase 5).
 *
 * ADR Decision B: same normalized URL is a duplicate **including across windows**
 * ("含跨 window" / "跨 window 算重复") — same-window exact URL copies are also
 * collapsed. That is intentional, not a windowId filter miss.
 *
 * Keep: active / audible / pinned / most recent lastAccessed; close older.
 * Never treat unsaved / dirty-title tabs as closeable candidates.
 */

import { normalizeUrlKey } from './url-normalize.js';
import { isSkippableUrl } from './tab-eligibility.js';
import { tabLooksUnsaved } from './reclaim-policy.js';

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
 * Whether a tab can participate in auto-dedupe (as keep or close).
 * Unsaved / dirty-title tabs are excluded so we never auto-close them.
 * @param {{ id?: number, url?: string, title?: string }} tab
 * @param {Set<number> | Iterable<number> | null | undefined} closingTabIds
 * @param {{ beforeUnloadRiskIds?: Set<number> | Iterable<number> | null }} [opts]
 */
export function isDedupeCandidate(tab, closingTabIds, opts = {}) {
  if (!tab || typeof tab.id !== 'number') return false;
  if (closingTabIds) {
    const closing =
      closingTabIds instanceof Set ? closingTabIds : new Set(closingTabIds);
    if (closing.has(tab.id)) return false;
  }
  if (!tab.url || isSkippableUrl(tab.url)) return false;
  if (!normalizeUrlKey(tab.url)) return false;
  if (tabLooksUnsaved(tab)) return false;
  const risk = opts.beforeUnloadRiskIds;
  if (risk) {
    const set = risk instanceof Set ? risk : new Set(risk);
    if (set.has(tab.id)) return false;
  }
  return true;
}

/**
 * Group eligible tabs by normalized URL key.
 * @param {Array<{ id?: number, url?: string, title?: string, active?: boolean, audible?: boolean, pinned?: boolean, lastAccessed?: number, windowId?: number }>} tabs
 * @param {{ closingTabIds?: Set<number> | Iterable<number> | null, stripHash?: boolean, stripTracking?: boolean, beforeUnloadRiskIds?: Set<number> | Iterable<number> | null }} [opts]
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
    if (!isDedupeCandidate(tab, opts.closingTabIds, opts)) continue;
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
 * Pinned / audible tabs must never be auto-closed (ADR keep priorities).
 * @param {{ pinned?: boolean, audible?: boolean } | null | undefined} tab
 */
export function isDedupeCloseExempt(tab) {
  return Boolean(tab?.pinned || tab?.audible);
}

/**
 * Build auto-close-older plans for duplicate groups.
 * Same-window and cross-window exact normalized URLs both qualify (ADR §5.4).
 * Never closes `protectActiveTabId` (focused window's active tab) — switching
 * into a duplicate must not vanish the tab the user just selected.
 * Never closes pinned or audible copies (even when protect overrides the keep).
 * @param {Array<{ id?: number, url?: string, title?: string, active?: boolean, audible?: boolean, pinned?: boolean, lastAccessed?: number, windowId?: number }>} tabs
 * @param {{ closingTabIds?: Set<number> | Iterable<number> | null, stripHash?: boolean, stripTracking?: boolean, beforeUnloadRiskIds?: Set<number> | Iterable<number> | null, protectActiveTabId?: number }} [opts]
 * @returns {DedupePlan[]}
 */
export function planAutoCloseOlder(tabs, opts = {}) {
  const groups = groupTabsByNormalizedUrl(tabs, opts);
  const protectId =
    typeof opts.protectActiveTabId === 'number' ? opts.protectActiveTabId : null;
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

    let keep = ranked[0];
    if (protectId != null) {
      const protectedTab = members.find((t) => t.id === protectId);
      if (protectedTab) keep = protectedTab;
    }

    // Close older / lower-ranked peers, but never the keep, protect id, pinned, or audible.
    const close = members.filter(
      (t) =>
        t.id !== keep?.id &&
        t.id !== protectId &&
        !isDedupeCloseExempt(t),
    );

    if (keep && close.length) {
      plans.push({ urlKey, keep, close });
    }
  }
  return plans;
}
