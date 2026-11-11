/**
 * Pure reclaim selection + stack overflow policy (ADR §5.6 Phase 4).
 * No Chrome APIs — unit-testable.
 *
 * Exclusions: pinned, audible, unsaved / beforeunload-risk, skippable URLs.
 * Current window is reclaimable. Policy: least-recently-accessed.
 */

import { isSkippableUrl } from './tab-eligibility.js';

/**
 * URLs that behave like unsaved / ephemeral documents.
 * @param {string | undefined | null} url
 */
export function isUnsavedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const lower = url.toLowerCase();
  if (lower === 'about:blank' || lower === 'about:newtab') return true;
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return true;
  return false;
}

/**
 * Best-effort unsaved heuristics without scripting (title dirty markers, empty URL).
 * @param {{ url?: string, title?: string }} tab
 */
export function tabLooksUnsaved(tab) {
  if (!tab) return true;
  if (isUnsavedUrl(tab.url)) return true;
  const title = String(tab.title || '');
  // Common dirty-document markers in editors / IDEs opened as tabs.
  if (title.startsWith('*') || title.startsWith('•')) return true;
  return false;
}

/**
 * Whether a tab may be selected for reclaim (sync checks only).
 * @param {{ id?: number, url?: string, title?: string, pinned?: boolean, audible?: boolean }} tab
 * @param {{ beforeUnloadRiskIds?: Set<number> | number[] | null }} [opts]
 */
export function isReclaimCandidate(tab, opts = {}) {
  if (!tab || typeof tab.id !== 'number') return false;
  if (tab.pinned) return false;
  if (tab.audible) return false;
  if (isSkippableUrl(tab.url)) return false;
  if (tabLooksUnsaved(tab)) return false;
  const risk = opts.beforeUnloadRiskIds;
  if (risk) {
    if (risk instanceof Set) {
      if (risk.has(tab.id)) return false;
    } else if (Array.isArray(risk) && risk.includes(tab.id)) {
      return false;
    }
  }
  return true;
}

/**
 * How many open tabs exceed maxOpenTabs.
 * @param {number} openCount
 * @param {number} maxOpenTabs
 */
export function excessOpenCount(openCount, maxOpenTabs) {
  const max = Math.max(1, Number(maxOpenTabs) || 1);
  const open = Math.max(0, Number(openCount) || 0);
  return Math.max(0, open - max);
}

/**
 * Pick reclaim targets: least-recently-accessed first.
 * Current window tabs are eligible. Never empties the browser of all tabs.
 * Prefers keeping `protectActiveTabId` when other candidates exist.
 *
 * @param {Array<{ id?: number, url?: string, title?: string, pinned?: boolean, audible?: boolean, lastAccessed?: number, active?: boolean, windowId?: number }>} tabs
 * @param {object} opts
 * @param {number} opts.maxOpenTabs
 * @param {Set<number> | number[] | null} [opts.beforeUnloadRiskIds]
 * @param {number} [opts.protectActiveTabId]  avoid reclaiming this tab while alternatives exist
 * @param {number} [opts.limit]  max targets (defaults to excess)
 * @returns {typeof tabs}
 */
export function selectReclaimTargets(tabs, opts) {
  const list = Array.isArray(tabs) ? tabs : [];
  const open = list.filter((t) => typeof t?.id === 'number');
  const excess = excessOpenCount(open.length, opts?.maxOpenTabs ?? 50);
  const limit = Math.min(excess, opts?.limit ?? excess);
  if (limit <= 0) return [];

  const candidates = open
    .filter((t) => isReclaimCandidate(t, { beforeUnloadRiskIds: opts?.beforeUnloadRiskIds }))
    .slice()
    .sort((a, b) => {
      const la = Number(a.lastAccessed) || 0;
      const lb = Number(b.lastAccessed) || 0;
      if (la !== lb) return la - lb; // least-recently-accessed first
      return (a.id ?? 0) - (b.id ?? 0);
    });

  const protectId =
    typeof opts?.protectActiveTabId === 'number' ? opts.protectActiveTabId : null;

  /** @type {typeof tabs} */
  const targets = [];
  const remaining = new Set(open.map((t) => t.id));

  const tryTake = (tab) => {
    if (targets.length >= limit) return false;
    if (!remaining.has(tab.id)) return false;
    // Implementation guard: leave at least one open tab somewhere.
    if (remaining.size <= 1) return false;
    targets.push(tab);
    remaining.delete(tab.id);
    return true;
  };

  for (const tab of candidates) {
    if (protectId != null && tab.id === protectId) continue;
    tryTake(tab);
    if (targets.length >= limit) break;
  }

  // Second pass: only if still short and the protected active tab is a candidate.
  if (targets.length < limit && protectId != null) {
    const active = candidates.find((t) => t.id === protectId);
    if (active) tryTake(active);
  }

  return targets;
}

/**
 * Evaluate whether the stack store can accept `incoming` new records.
 * At capacity → needs user export or discard (no silent LRU).
 *
 * @param {object} args
 * @param {number} args.size  current stack size
 * @param {number} args.maxSize  stackSize config
 * @param {number} [args.incoming]
 * @returns {{ ok: boolean, accept: number, blocked: number, free: number, needsUserAction: boolean, reason: 'ok' | 'at_capacity' | 'partial' }}
 */
export function evaluateStackCapacity({ size, maxSize, incoming = 1 }) {
  const max = Math.max(1, Number(maxSize) || 1);
  const current = Math.max(0, Number(size) || 0);
  const want = Math.max(0, Number(incoming) || 0);
  const free = Math.max(0, max - current);

  if (want === 0) {
    return { ok: true, accept: 0, blocked: 0, free, needsUserAction: false, reason: 'ok' };
  }
  if (free <= 0) {
    return {
      ok: false,
      accept: 0,
      blocked: want,
      free: 0,
      needsUserAction: true,
      reason: 'at_capacity',
    };
  }
  if (want <= free) {
    return { ok: true, accept: want, blocked: 0, free, needsUserAction: false, reason: 'ok' };
  }
  return {
    ok: false,
    accept: free,
    blocked: want - free,
    free,
    needsUserAction: true,
    reason: 'partial',
  };
}

/**
 * How many oldest records to free so `neededSlots` can be accepted (and size ≤ max).
 * @param {object} args
 * @param {number} args.size
 * @param {number} args.maxSize
 * @param {number} [args.neededSlots]
 */
export function slotsToFreeForOverflow({ size, maxSize, neededSlots = 1 }) {
  const max = Math.max(1, Number(maxSize) || 1);
  const current = Math.max(0, Number(size) || 0);
  const need = Math.max(1, Number(neededSlots) || 1);
  const over = Math.max(0, current + need - max);
  return Math.max(need, over);
}
