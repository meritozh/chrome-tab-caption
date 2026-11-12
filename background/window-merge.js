/**
 * Single-window Organize finalize (ADR §5.3 D / §5.6).
 * After classify: reclaim excess (with topic metadata) → cross-window move kept tabs
 * into one window → order by lastAccessed → physical tabGroups → close empty windows.
 * Fail-soft on move/close failures.
 */

import { MSG } from '../shared/constants.js';
import { createStackRecord, persistStackRecords } from '../shared/stack-records.js';
import {
  evaluateStackCapacity,
  buildOverflowPending,
  isReclaimCandidate,
} from '../shared/reclaim-policy.js';
import { suppressClosedRemove } from '../shared/suppress-closed.js';
import { probeBeforeUnloadRisk } from '../shared/beforeunload-probe.js';
import { colorForTopicKey } from '../shared/physical-groups.js';
import {
  partitionKeepAndReclaim,
  selectTargetWindowId,
  planSingleWindowGroups,
  stackMetaFromAssignment,
  sortByLastAccessedDesc,
} from '../shared/window-merge.js';
import { resolveStackMetadata } from './stacks.js';
import { runAutoDedupe } from './dedupe.js';

/**
 * Broadcast overflow warning (fail-soft).
 * @param {Record<string, unknown>} payload
 */
function broadcastOverflow(payload) {
  try {
    chrome.runtime.sendMessage({ type: MSG.STACKS_OVERFLOW_WARN, ...payload }).catch(() => {});
  } catch {
    // no listeners
  }
}

/**
 * Move tabs into target window (cross-window allowed). Fail-soft per batch/tab.
 * @param {number[]} tabIds
 * @param {number} targetWindowId
 * @param {typeof chrome.tabs} [tabsApi]
 * @returns {Promise<{ moved: number[], errors: string[] }>}
 */
export async function moveTabsToWindow(tabIds, targetWindowId, tabsApi = globalThis.chrome?.tabs) {
  /** @type {number[]} */
  const moved = [];
  /** @type {string[]} */
  const errors = [];
  if (!tabsApi?.move || typeof targetWindowId !== 'number') {
    return { moved, errors: ['tabs.move unavailable'] };
  }

  for (const tabId of tabIds || []) {
    if (typeof tabId !== 'number') continue;
    try {
      const tab = await tabsApi.get?.(tabId);
      if (!tab) continue;
      if (tab.windowId === targetWindowId) {
        moved.push(tabId);
        continue;
      }
      await tabsApi.move(tabId, { windowId: targetWindowId, index: -1 });
      moved.push(tabId);
    } catch (err) {
      errors.push(`move ${tabId}: ${err?.message || err}`);
    }
  }
  return { moved, errors };
}

/**
 * Reorder tabs in a window by the given id sequence (index 0 = first).
 * @param {number[]} orderedTabIds
 * @param {number} windowId
 * @param {typeof chrome.tabs} [tabsApi]
 */
export async function reorderTabsInWindow(
  orderedTabIds,
  windowId,
  tabsApi = globalThis.chrome?.tabs,
) {
  /** @type {string[]} */
  const errors = [];
  if (!tabsApi?.move) return { ok: false, errors: ['tabs.move unavailable'] };

  let index = 0;
  for (const tabId of orderedTabIds || []) {
    if (typeof tabId !== 'number') continue;
    try {
      const tab = await tabsApi.get?.(tabId);
      if (!tab || tab.windowId !== windowId) continue;
      await tabsApi.move(tabId, { index });
      index += 1;
    } catch (err) {
      errors.push(`reorder ${tabId}: ${err?.message || err}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Close windows that have no tabs left (never remove the last window).
 * @param {number} keepWindowId
 * @param {typeof chrome.windows} [windowsApi]
 * @param {typeof chrome.tabs} [tabsApi]
 */
export async function closeEmptyWindows(
  keepWindowId,
  windowsApi = globalThis.chrome?.windows,
  tabsApi = globalThis.chrome?.tabs,
) {
  /** @type {number[]} */
  const closed = [];
  /** @type {string[]} */
  const errors = [];
  if (!windowsApi?.getAll || !tabsApi?.query) {
    return { closed, errors: ['windows/tabs API unavailable'] };
  }

  let windows;
  try {
    windows = await windowsApi.getAll({ populate: false });
  } catch (err) {
    return { closed, errors: [String(err?.message || err)] };
  }

  for (const win of windows || []) {
    if (typeof win?.id !== 'number') continue;
    if (win.id === keepWindowId) continue;
    try {
      const tabs = await tabsApi.query({ windowId: win.id });
      if ((tabs || []).length > 0) continue;
      await windowsApi.remove(win.id);
      closed.push(win.id);
    } catch (err) {
      errors.push(`close window ${win.id}: ${err?.message || err}`);
    }
  }
  return { closed, errors };
}

/**
 * Finalize Organize: dedupe → reclaim excess with topics → merge → groups → empty windows.
 *
 * @param {object} opts
 * @param {import('../shared/physical-groups.js').TabTopicAssignment[]} opts.assignments
 * @param {Record<string, unknown>} opts.config
 * @param {import('../shared/stack-records.js').StackRecordStore} [opts.stackStore]
 * @param {import('../shared/topic-cache.js').TopicCacheLru} [opts.topicCache]
 * @param {Set<number>} [opts.closingTabIds]
 * @param {(pending: object | null) => Promise<void> | void} [opts.setOverflowPending]
 * @param {object | null} [opts.overflowPending]
 * @param {number | null} [opts.preferredWindowId]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.windows} [opts.windowsApi]
 * @param {typeof chrome.scripting} [opts.scriptingApi]
 * @param {boolean} [opts.probeUnload]
 * @param {{ push: (e: object) => object }} [opts.activityLog]
 * @param {(payload: Record<string, unknown>) => void} [opts.onProgress]
 */
export async function finalizeSingleWindowOrganize(opts) {
  const config = opts.config || {};
  const tabsApi = opts.tabsApi ?? globalThis.chrome?.tabs;
  const windowsApi = opts.windowsApi ?? globalThis.chrome?.windows;
  const assignments = Array.isArray(opts.assignments) ? opts.assignments : [];
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  /** @type {Map<number, (typeof assignments)[0]>} */
  const byTabId = new Map();
  for (const a of assignments) {
    if (typeof a?.tabId === 'number') byTabId.set(a.tabId, a);
  }

  /** @type {{ reclaimed: number, moved: number, emptyWindowsClosed: number, targetWindowId: number | null, remappedAssignments: typeof assignments, plans: import('../shared/physical-groups.js').PhysicalGroupPlan[], errors: string[], overflow?: boolean, overflowPending?: object | null, dedupe?: object, stub: boolean }} */
  const summary = {
    reclaimed: 0,
    moved: 0,
    emptyWindowsClosed: 0,
    targetWindowId: null,
    remappedAssignments: [],
    plans: [],
    errors: [],
    stub: false,
  };

  // 1) Dedupe before counting open tabs (ADR flowchart).
  if (opts.closingTabIds) {
    try {
      summary.dedupe = await runAutoDedupe({
        config,
        closingTabIds: opts.closingTabIds,
        tabsApi,
        windowsApi,
        scriptingApi: opts.scriptingApi,
        activityLog: opts.activityLog,
        probeUnload: opts.probeUnload,
      });
    } catch (err) {
      summary.errors.push(`dedupe: ${err?.message || err}`);
    }
  }

  if (!tabsApi?.query) {
    summary.errors.push('tabs.query unavailable');
    return summary;
  }

  /** @type {chrome.tabs.Tab[]} */
  let tabs = await tabsApi.query({});
  const maxOpenTabs = Math.max(1, Number(config.maxOpenTabs) || 50);

  // 2) Probe beforeunload for likely reclaim candidates.
  /** @type {Set<number>} */
  const beforeUnloadRiskIds = new Set();
  if (opts.probeUnload !== false) {
    const prelim = partitionKeepAndReclaim(tabs, { maxOpenTabs }).reclaimTargets;
    for (const tab of prelim.slice(0, Math.max(8, prelim.length))) {
      if (typeof tab.id !== 'number') continue;
      try {
        if (await probeBeforeUnloadRisk(tab.id, opts.scriptingApi)) {
          beforeUnloadRiskIds.add(tab.id);
        }
      } catch {
        // fail-soft
      }
    }
  }

  const { kept, reclaimTargets } = partitionKeepAndReclaim(tabs, {
    maxOpenTabs,
    beforeUnloadRiskIds,
  });

  onProgress({
    phase: 'reclaim',
    message: `Reclaiming ${reclaimTargets.length} excess tabs into Stacks…`,
    reclaimCandidates: reclaimTargets.length,
    kept: kept.length,
  });

  // 3) Excess → StackRecords (with classify topic) then suppressClosed remove.
  const stackStore = opts.stackStore;
  const closingTabIds = opts.closingTabIds;
  if (
    reclaimTargets.length &&
    stackStore &&
    closingTabIds &&
    config.autoStackEnabled !== false
  ) {
    if (opts.overflowPending?.needsUserAction) {
      summary.overflow = true;
      summary.overflowPending = opts.overflowPending;
    } else {
      const stackSize = Math.max(1, Number(config.stackSize) || 500);
      stackStore.maxSize = stackSize;
      const capacity = evaluateStackCapacity({
        size: stackStore.size,
        maxSize: stackSize,
        incoming: reclaimTargets.length,
      });

      if (capacity.accept <= 0) {
        const pending = buildOverflowPending({
          size: stackStore.size,
          maxSize: stackSize,
          blockedIncoming: capacity.blocked || reclaimTargets.length,
          reason: capacity.reason === 'partial' ? 'partial' : 'at_capacity',
        });
        await opts.setOverflowPending?.(pending);
        broadcastOverflow(pending);
        summary.overflow = true;
        summary.overflowPending = pending;
      } else {
        const toReclaim = reclaimTargets.slice(0, capacity.accept);
        for (const tab of toReclaim) {
          if (!isReclaimCandidate(tab, { beforeUnloadRiskIds })) continue;
          if (!tab.url || typeof tab.id !== 'number') continue;

          const asg = byTabId.get(tab.id);
          let fallback = null;
          try {
            fallback = await resolveStackMetadata(tab, opts.topicCache);
          } catch {
            fallback = null;
          }
          const meta = stackMetaFromAssignment(asg, fallback);
          if (!meta.groupColor && meta.topicKey) {
            meta.groupColor = colorForTopicKey(meta.topicKey);
          }

          const record = createStackRecord({
            url: tab.url,
            title: tab.title || tab.url,
            favIconUrl: tab.favIconUrl,
            topicKey: meta.topicKey,
            topicLabel: meta.topicLabel,
            groupTitle: meta.groupTitle,
            groupColor: meta.groupColor,
            windowIdHint: tab.windowId,
            lastAccessedAt: Number(tab.lastAccessed) || Date.now(),
          });

          const pushed = stackStore.tryPush(record);
          if (!pushed.accepted) {
            const pending = buildOverflowPending({
              size: stackStore.size,
              maxSize: stackSize,
              blockedIncoming: toReclaim.length - summary.reclaimed,
              reason: 'at_capacity',
            });
            await opts.setOverflowPending?.(pending);
            broadcastOverflow(pending);
            summary.overflow = true;
            summary.overflowPending = pending;
            break;
          }

          const closed = await suppressClosedRemove(tab.id, closingTabIds, tabsApi);
          if (!closed.ok || closed.alreadyClosed) {
            stackStore.remove(record.id);
            if (!closed.ok) {
              summary.errors.push(closed.error || `failed to close ${tab.id}`);
            }
            continue;
          }
          summary.reclaimed += 1;
        }

        if (summary.reclaimed > 0) {
          await persistStackRecords(stackStore);
        }

        if (capacity.needsUserAction && capacity.blocked > 0) {
          const pending = buildOverflowPending({
            size: stackStore.size,
            maxSize: stackSize,
            blockedIncoming: capacity.blocked,
            reason: capacity.reason === 'partial' ? 'partial' : 'at_capacity',
          });
          await opts.setOverflowPending?.(pending);
          broadcastOverflow(pending);
          summary.overflow = true;
          summary.overflowPending = pending;
        }
      }
    }
  }

  // Refresh live tabs after reclaim.
  tabs = await tabsApi.query({});
  if (!tabs.length) {
    return summary;
  }

  // 4) Pick target window (focused / preferred / most tabs).
  let windows = [];
  try {
    windows = windowsApi?.getAll ? await windowsApi.getAll({}) : [];
  } catch (err) {
    summary.errors.push(`windows.getAll: ${err?.message || err}`);
  }

  const targetWindowId = selectTargetWindowId(windows, tabs, {
    preferredWindowId: opts.preferredWindowId,
  });
  if (typeof targetWindowId !== 'number') {
    summary.errors.push('no target window');
    return summary;
  }
  summary.targetWindowId = targetWindowId;

  const orderedRemaining = sortByLastAccessedDesc(tabs);
  const moveIds = orderedRemaining
    .map((t) => t.id)
    .filter((id) => typeof id === 'number');

  onProgress({
    phase: 'merge',
    message: `Merging ${moveIds.length} tabs into one window…`,
    targetWindowId,
  });

  // 5) Cross-window move into target (fail-soft).
  const moveResult = await moveTabsToWindow(moveIds, targetWindowId, tabsApi);
  summary.moved = moveResult.moved.length;
  summary.errors.push(...moveResult.errors);

  // 6) Order by lastAccessed desc inside target.
  const reorder = await reorderTabsInWindow(moveResult.moved, targetWindowId, tabsApi);
  summary.errors.push(...(reorder.errors || []));

  // Remap assignment windowIds for kept live tabs.
  /** @type {Set<number>} */
  const liveIds = new Set(moveResult.moved);
  const remapped = assignments
    .filter((a) => liveIds.has(a.tabId))
    .map((a) => ({ ...a, windowId: targetWindowId }));
  summary.remappedAssignments = remapped;
  summary.plans = planSingleWindowGroups(remapped, targetWindowId, {
    tabIds: liveIds,
  });

  // 7) Close empty windows (groups applied by caller with summary.plans).
  const emptied = await closeEmptyWindows(targetWindowId, windowsApi, tabsApi);
  summary.emptyWindowsClosed = emptied.closed.length;
  summary.errors.push(...emptied.errors);

  onProgress({
    phase: 'merged',
    message: `Merged into window ${targetWindowId} — ${summary.plans.length} topic plans, ${summary.reclaimed} stacked.`,
    targetWindowId,
    reclaimed: summary.reclaimed,
    moved: summary.moved,
    planCount: summary.plans.length,
  });

  return summary;
}
