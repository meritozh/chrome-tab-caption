/**
 * Single-window Organize merge helpers (ADR §5.3 Decision D / 2026-11-13).
 * Pure functions — no Chrome APIs.
 *
 * After classify: sort by lastAccessed desc → keep top maxOpenTabs → excess → Stacks;
 * kept tabs merge into one target window (cross-window tabs.move allowed).
 */

import { isReclaimCandidate } from './reclaim-policy.js';
import { colorForTopicKey } from './physical-groups.js';

/**
 * Recency for sort — missing lastAccessed treated as newest so unknowns stay kept.
 * @param {{ lastAccessed?: number }} tab
 */
export function tabRecency(tab) {
  const n = Number(tab?.lastAccessed);
  if (Number.isFinite(n) && n > 0) return n;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Sort tabs by lastAccessed descending (most recent first).
 * @template {{ lastAccessed?: number, id?: number }} T
 * @param {T[]} tabs
 * @returns {T[]}
 */
export function sortByLastAccessedDesc(tabs) {
  return (Array.isArray(tabs) ? tabs : []).slice().sort((a, b) => {
    const diff = tabRecency(b) - tabRecency(a);
    if (diff !== 0) return diff;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

/**
 * Partition open tabs into keep (top maxOpenTabs by lastAccessed) vs reclaim candidates.
 * Excess that fail reclaim exclusions (pinned / audible / unsaved / beforeunload) stay open.
 *
 * @param {Array<{ id?: number, url?: string, title?: string, pinned?: boolean, audible?: boolean, lastAccessed?: number, windowId?: number }>} tabs
 * @param {object} opts
 * @param {number} opts.maxOpenTabs
 * @param {Set<number> | number[] | null} [opts.beforeUnloadRiskIds]
 * @returns {{ kept: typeof tabs, reclaimTargets: typeof tabs, ordered: typeof tabs }}
 */
export function partitionKeepAndReclaim(tabs, opts) {
  const list = (Array.isArray(tabs) ? tabs : []).filter((t) => typeof t?.id === 'number');
  const max = Math.max(1, Number(opts?.maxOpenTabs) || 50);
  const ordered = sortByLastAccessedDesc(list);
  const kept = ordered.slice(0, max);
  const excess = ordered.slice(max);
  const reclaimTargets = excess.filter((t) =>
    isReclaimCandidate(t, { beforeUnloadRiskIds: opts?.beforeUnloadRiskIds }),
  );
  return { kept, reclaimTargets, ordered };
}

/**
 * Choose target window: prefer focused/current, else the window with the most tabs.
 * @param {Array<{ id?: number, focused?: boolean }>} windows
 * @param {Array<{ windowId?: number }>} tabs
 * @param {{ preferredWindowId?: number | null }} [opts]
 * @returns {number | null}
 */
export function selectTargetWindowId(windows, tabs, opts = {}) {
  const wins = (Array.isArray(windows) ? windows : []).filter(
    (w) => typeof w?.id === 'number',
  );
  if (!wins.length) return null;

  const preferred =
    typeof opts.preferredWindowId === 'number' ? opts.preferredWindowId : null;
  if (preferred != null && wins.some((w) => w.id === preferred)) {
    return preferred;
  }

  const focused = wins.find((w) => w.focused);
  if (focused && typeof focused.id === 'number') return focused.id;

  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const t of tabs || []) {
    if (typeof t?.windowId !== 'number') continue;
    counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
  }

  let bestId = wins[0].id;
  let bestCount = -1;
  for (const w of wins) {
    const c = counts.get(w.id) || 0;
    if (c > bestCount || (c === bestCount && w.id < bestId)) {
      bestCount = c;
      bestId = w.id;
    }
  }
  return typeof bestId === 'number' ? bestId : null;
}

/**
 * Plan physical groups for a single target window from topic assignments.
 * Same topicKey → at most one group. Optionally restrict to keptTabIds.
 *
 * @param {Array<{ tabId: number, windowId?: number, topicKey: string, topicLabel?: string }>} assignments
 * @param {number} targetWindowId
 * @param {{ tabIds?: number[] | Set<number> | null }} [opts]
 * @returns {import('./physical-groups.js').PhysicalGroupPlan[]}
 */
export function planSingleWindowGroups(assignments, targetWindowId, opts = {}) {
  if (typeof targetWindowId !== 'number') return [];
  /** @type {Set<number> | null} */
  let allow = null;
  if (opts.tabIds instanceof Set) {
    allow = opts.tabIds;
  } else if (Array.isArray(opts.tabIds)) {
    allow = new Set(opts.tabIds);
  }

  /** @type {Map<string, import('./physical-groups.js').PhysicalGroupPlan>} */
  const map = new Map();
  for (const a of assignments || []) {
    if (typeof a.tabId !== 'number' || !a.topicKey) continue;
    if (allow && !allow.has(a.tabId)) continue;
    let plan = map.get(a.topicKey);
    if (!plan) {
      plan = {
        windowId: targetWindowId,
        topicKey: a.topicKey,
        title: a.topicLabel || a.topicKey,
        tabIds: [],
      };
      map.set(a.topicKey, plan);
    }
    if (!plan.tabIds.includes(a.tabId)) plan.tabIds.push(a.tabId);
    if (a.topicLabel && a.topicLabel.length >= plan.title.length) {
      plan.title = a.topicLabel;
    }
  }
  return [...map.values()].filter((p) => p.tabIds.length > 0);
}

/**
 * Build StackRecord topic/group metadata from an organize assignment (or fallbacks).
 * @param {{ topicKey?: string, topicLabel?: string } | null | undefined} assignment
 * @param {{ topicKey?: string, topicLabel?: string, groupTitle?: string, groupColor?: string } | null | undefined} [fallback]
 */
export function stackMetaFromAssignment(assignment, fallback = null) {
  const topicKey = assignment?.topicKey || fallback?.topicKey || undefined;
  const topicLabel =
    assignment?.topicLabel || fallback?.topicLabel || topicKey || undefined;
  const groupTitle = fallback?.groupTitle || topicLabel || undefined;
  const groupColor =
    fallback?.groupColor ||
    (topicKey ? colorForTopicKey(topicKey) : undefined);
  return {
    topicKey,
    topicLabel,
    groupTitle,
    groupColor,
  };
}

/**
 * Whether config requests the single-window Organize merge path.
 * @param {Record<string, unknown> | null | undefined} config
 */
export function isSingleWindowMergeScope(config) {
  const scope = config?.groupScope;
  // Default / accepted value; treat unknown legacy as merge when unset.
  if (scope == null || scope === '') return true;
  if (scope === 'single-window-merge') return true;
  if (scope === 'cross-window-logical') return false;
  return scope !== 'per-window';
}
