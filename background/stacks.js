/**
 * Stacks reclaim / recall (ADR Phase 4 / §5.6).
 * StackRecords only — not chrome.sessions.
 * Overflow: warn → export or discard (no silent LRU).
 * Reclaim closes mark closingTabIds (suppressClosed — don't pollute user recall lists).
 */

import { MSG, TAB_GROUP_ID_NONE } from '../shared/constants.js';
import {
  createStackRecord,
  persistStackRecords,
} from '../shared/stack-records.js';
import {
  selectReclaimTargets,
  evaluateStackCapacity,
  slotsToFreeForOverflow,
  buildOverflowPending,
  isReclaimCandidate,
} from '../shared/reclaim-policy.js';
import { normalizeUrlKey, computeContentHash } from '../shared/url-normalize.js';
import { colorForTopicKey } from '../shared/physical-groups.js';
import { runAutoDedupe } from './dedupe.js';

/**
 * @typedef {import('../shared/stack-records.js').StackRecordStore} StackRecordStore
 * @typedef {import('../shared/topic-cache.js').TopicCacheLru} TopicCacheLru
 */

/**
 * Best-effort beforeunload / dirty-form probe (ADR: imperfect, exclude when detected).
 * @param {number} tabId
 * @param {typeof chrome.scripting | undefined} scriptingApi
 */
export async function probeBeforeUnloadRisk(tabId, scriptingApi = globalThis.chrome?.scripting) {
  if (typeof tabId !== 'number' || !scriptingApi?.executeScript) return false;
  try {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func: () => {
        if (typeof window.onbeforeunload === 'function') return true;
        try {
          const els = document.querySelectorAll(
            'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
          );
          for (const el of els) {
            if (el instanceof HTMLElement && el.isContentEditable) {
              if ((el.textContent || '').trim().length > 0) return true;
              continue;
            }
            if (
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLSelectElement
            ) {
              if (el.value !== el.defaultValue) return true;
            }
          }
        } catch {
          // page DOM restricted
        }
        return false;
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    // CSP / host permission — fail-soft: do not treat as risk (can't confirm).
    return false;
  }
}

/**
 * Resolve topic + live group metadata for a tab about to be reclaimed.
 * @param {chrome.tabs.Tab} tab
 * @param {TopicCacheLru | null | undefined} topicCache
 */
export async function resolveStackMetadata(tab, topicCache) {
  /** @type {{ topicKey?: string, topicLabel?: string, groupTitle?: string, groupColor?: string }} */
  const meta = {};

  const groupId = typeof tab.groupId === 'number' ? tab.groupId : TAB_GROUP_ID_NONE;
  if (groupId !== TAB_GROUP_ID_NONE && globalThis.chrome?.tabGroups?.get) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group?.title) meta.groupTitle = group.title;
      if (group?.color) meta.groupColor = String(group.color);
    } catch {
      // group gone
    }
  }

  if (topicCache) {
    const urlKey = normalizeUrlKey(tab.url || '');
    if (urlKey) {
      const contentHash = await computeContentHash({
        title: tab.title || '',
        excerpt: '',
        url: urlKey,
      });
      const exact = topicCache.peek?.(urlKey, contentHash);
      if (exact?.topicKey) {
        meta.topicKey = exact.topicKey;
        meta.topicLabel = exact.topicLabel || exact.topicKey;
      } else {
        let best = null;
        for (const entry of topicCache.entries()) {
          if (entry.urlKey !== urlKey) continue;
          if (!best || (entry.lastHitAt ?? 0) > (best.lastHitAt ?? 0)) best = entry;
        }
        if (best?.topicKey) {
          meta.topicKey = best.topicKey;
          meta.topicLabel = best.topicLabel || best.topicKey;
        }
      }
    }
  }

  // Prefer group title as topic label fallback for recall restore.
  if (!meta.topicLabel && meta.groupTitle) {
    meta.topicLabel = meta.groupTitle;
  }
  if (!meta.topicKey && meta.topicLabel) {
    meta.topicKey = meta.topicLabel.toLowerCase().replace(/\s+/g, '-');
  }
  if (!meta.groupTitle && meta.topicLabel) {
    meta.groupTitle = meta.topicLabel;
  }
  if (!meta.groupColor && meta.topicKey) {
    meta.groupColor = colorForTopicKey(meta.topicKey);
  }

  return meta;
}

/**
 * Restore saved group metadata onto a newly created tab (ADR recall).
 * Same-window same title → join; else create group with saved color/title.
 * @param {number} tabId
 * @param {number} windowId
 * @param {{ groupTitle?: string, groupColor?: string, topicKey?: string, topicLabel?: string }} meta
 */
export async function restoreGroupMetadata(tabId, windowId, meta) {
  const title = (meta.groupTitle || meta.topicLabel || '').trim();
  if (!title || !globalThis.chrome?.tabs?.group) {
    return { restored: false, reason: 'no-metadata' };
  }

  try {
    /** @type {number | undefined} */
    let groupId;
    if (chrome.tabGroups?.query) {
      const existing = await chrome.tabGroups.query({ windowId });
      const match = existing.find(
        (g) => (g.title || '').toLowerCase() === title.toLowerCase(),
      );
      if (match) groupId = match.id;
    }

    if (typeof groupId === 'number') {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId },
      });
    }

    const color =
      meta.groupColor ||
      (meta.topicKey ? colorForTopicKey(meta.topicKey) : undefined);
    if (chrome.tabGroups?.update) {
      /** @type {chrome.tabGroups.UpdateProperties} */
      const update = { title: title.slice(0, 50) };
      if (color) update.color = /** @type {any} */ (color);
      await chrome.tabGroups.update(groupId, update);
    }
    return { restored: true, groupId, title };
  } catch (err) {
    return { restored: false, error: String(err?.message || err) };
  }
}

/**
 * Close a tab while marking suppressClosed via closingTabIds.
 * @param {number} tabId
 * @param {Set<number>} closingTabIds
 * @param {typeof chrome.tabs} [tabsApi]
 */
export async function suppressClosedRemove(tabId, closingTabIds, tabsApi = globalThis.chrome?.tabs) {
  if (!tabsApi?.remove) throw new Error('tabs.remove unavailable');
  closingTabIds.add(tabId);
  try {
    await tabsApi.remove(tabId);
    return { ok: true, tabId, suppressClosed: true };
  } catch (err) {
    closingTabIds.delete(tabId);
    return { ok: false, tabId, suppressClosed: false, error: String(err?.message || err) };
  }
}

/**
 * Broadcast overflow warning to Side Panel (fail-soft).
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
 * @param {object} opts
 * @param {Record<string, unknown>} opts.config
 * @param {StackRecordStore} opts.stackStore
 * @param {TopicCacheLru} [opts.topicCache]
 * @param {Set<number>} opts.closingTabIds
 * @param {(pending: object | null) => Promise<void> | void} [opts.setOverflowPending]
 * @param {object | null} [opts.overflowPending]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.scripting} [opts.scriptingApi]
 * @param {boolean} [opts.probeUnload]
 */
export async function maybeReclaim(opts) {
  const config = opts.config || {};
  if (config.autoStackEnabled === false) {
    return { reclaimed: 0, skipped: 'autoStackDisabled', stub: false };
  }

  const stackStore = opts.stackStore;
  const closingTabIds = opts.closingTabIds;
  const tabsApi = opts.tabsApi ?? globalThis.chrome?.tabs;
  if (!tabsApi?.query || !stackStore || !closingTabIds) {
    return { reclaimed: 0, skipped: 'unavailable', stub: false };
  }

  // Phase 5 will close dups; stub coexists and runs first per ADR order.
  await runAutoDedupe(closingTabIds);

  if (opts.overflowPending?.needsUserAction) {
    return {
      reclaimed: 0,
      skipped: 'overflowPending',
      overflowPending: opts.overflowPending,
      stub: false,
    };
  }

  /** @type {chrome.tabs.Tab[]} */
  const tabs = await tabsApi.query({});
  const maxOpenTabs = Math.max(1, Number(config.maxOpenTabs) || 50);
  const stackSize = Math.max(1, Number(config.stackSize) || 500);
  stackStore.maxSize = stackSize;

  // Prefer the focused window's active tab (not an arbitrary window's .active).
  const protectActiveTabId = await resolveFocusedActiveTabId(
    tabs,
    tabsApi,
    opts.windowsApi ?? globalThis.chrome?.windows,
  );

  // Probe unload risk only for sync-eligible candidates we might take (cap work).
  /** @type {Set<number>} */
  const beforeUnloadRiskIds = new Set();
  if (opts.probeUnload !== false) {
    const prelim = selectReclaimTargets(tabs, {
      maxOpenTabs,
      protectActiveTabId,
      limit: Math.max(8, excessCap(tabs.length, maxOpenTabs) + 4),
    });
    for (const tab of prelim) {
      if (await probeBeforeUnloadRisk(tab.id, opts.scriptingApi)) {
        beforeUnloadRiskIds.add(tab.id);
      }
    }
  }

  const targets = selectReclaimTargets(tabs, {
    maxOpenTabs,
    protectActiveTabId,
    beforeUnloadRiskIds,
  });

  if (!targets.length) {
    return { reclaimed: 0, candidates: 0, stub: false };
  }

  const capacity = evaluateStackCapacity({
    size: stackStore.size,
    maxSize: stackSize,
    incoming: targets.length,
  });

  if (capacity.accept <= 0) {
    const pending = buildOverflowPending({
      size: stackStore.size,
      maxSize: stackSize,
      blockedIncoming: capacity.blocked || targets.length,
      reason: capacity.reason === 'partial' ? 'partial' : 'at_capacity',
    });
    await opts.setOverflowPending?.(pending);
    broadcastOverflow(pending);
    return { reclaimed: 0, overflow: true, overflowPending: pending, stub: false };
  }

  const toReclaim = targets.slice(0, capacity.accept);
  let reclaimed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const tab of toReclaim) {
    if (!isReclaimCandidate(tab, { beforeUnloadRiskIds })) continue;
    if (!tab.url) continue;

    const meta = await resolveStackMetadata(tab, opts.topicCache);
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
        blockedIncoming: toReclaim.length - reclaimed,
        reason: 'at_capacity',
      });
      await opts.setOverflowPending?.(pending);
      broadcastOverflow(pending);
      break;
    }

    const closed = await suppressClosedRemove(tab.id, closingTabIds, tabsApi);
    if (!closed.ok) {
      // Roll back stack entry — tab still open.
      stackStore.remove(record.id);
      errors.push(closed.error || `failed to close ${tab.id}`);
      continue;
    }
    reclaimed += 1;
  }

  if (reclaimed > 0) {
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
    return {
      reclaimed,
      overflow: true,
      overflowPending: pending,
      errors,
      stub: false,
    };
  }

  return { reclaimed, errors, stub: false };
}

function excessCap(openCount, maxOpenTabs) {
  return Math.max(0, openCount - maxOpenTabs);
}

/**
 * Protect the focused window's active tab when alternatives exist.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {typeof chrome.tabs} [tabsApi]
 * @param {typeof chrome.windows} [windowsApi]
 * @returns {Promise<number | undefined>}
 */
export async function resolveFocusedActiveTabId(tabs, tabsApi, windowsApi) {
  try {
    if (windowsApi?.getLastFocused) {
      const focused = await windowsApi.getLastFocused();
      if (typeof focused?.id === 'number' && tabsApi?.query) {
        const [active] = await tabsApi.query({ active: true, windowId: focused.id });
        if (typeof active?.id === 'number') return active.id;
      }
      if (typeof focused?.id === 'number') {
        const inFocused = tabs.find((t) => t.windowId === focused.id && t.active);
        if (typeof inFocused?.id === 'number') return inFocused.id;
      }
    }
  } catch {
    // fall through
  }
  const active = tabs.find((t) => t.active);
  return typeof active?.id === 'number' ? active.id : undefined;
}

/**
 * Recall a stacked tab: create URL + restore group metadata; remove StackRecord.
 * @param {string} stackId
 * @param {object} opts
 * @param {StackRecordStore} opts.stackStore
 * @param {number} [opts.windowId]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 */
export async function recallStack(stackId, opts = {}) {
  const store = opts.stackStore;
  if (!store) {
    return { ok: false, error: 'stack store unavailable' };
  }
  const id = String(stackId || '');
  const record = store.getById(id);
  if (!record) {
    return { ok: false, error: `unknown stackId: ${id}` };
  }
  if (!record.url) {
    return { ok: false, error: 'stack record missing url' };
  }

  const tabsApi = opts.tabsApi ?? globalThis.chrome?.tabs;
  if (!tabsApi?.create) {
    return { ok: false, error: 'tabs.create unavailable' };
  }

  /** @type {chrome.tabs.CreateProperties} */
  const createProps = { url: record.url, active: true };
  if (typeof opts.windowId === 'number') {
    createProps.windowId = opts.windowId;
  } else if (typeof record.windowIdHint === 'number') {
    createProps.windowId = record.windowIdHint;
  }

  let tab;
  try {
    tab = await tabsApi.create(createProps);
  } catch (err) {
    // windowIdHint may be stale — retry without it.
    if (createProps.windowId != null) {
      try {
        delete createProps.windowId;
        tab = await tabsApi.create(createProps);
      } catch (err2) {
        return { ok: false, error: String(err2?.message || err2) };
      }
    } else {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  const windowId =
    typeof tab.windowId === 'number'
      ? tab.windowId
      : typeof opts.windowId === 'number'
        ? opts.windowId
        : undefined;

  let groupRestore = { restored: false };
  if (typeof tab.id === 'number' && typeof windowId === 'number') {
    groupRestore = await restoreGroupMetadata(tab.id, windowId, {
      groupTitle: record.groupTitle,
      groupColor: record.groupColor,
      topicKey: record.topicKey,
      topicLabel: record.topicLabel,
    });
  }

  store.remove(id);
  await persistStackRecords(store);

  return {
    ok: true,
    stub: false,
    tabId: tab.id,
    windowId,
    stackId: id,
    groupRestore,
  };
}

/**
 * Handle overflow CTA: export (JSON + discard oldest) or discard oldest.
 * @param {object} opts
 * @param {'export' | 'discard'} opts.action
 * @param {StackRecordStore} opts.stackStore
 * @param {object | null} [opts.overflowPending]
 * @param {(pending: object | null) => Promise<void> | void} [opts.setOverflowPending]
 * @param {number} [opts.count]
 */
export async function exportOrDiscardStacks(opts) {
  const action = opts.action === 'export' ? 'export' : 'discard';
  const store = opts.stackStore;
  if (!store) return { ok: false, error: 'stack store unavailable' };

  const pending = opts.overflowPending;
  // Shrink excess and blocked reclaim are separate — do not double-count.
  const excess =
    typeof pending?.excess === 'number'
      ? Math.max(0, pending.excess)
      : Math.max(0, store.size - store.maxSize);
  const blockedIncoming =
    typeof opts.count === 'number'
      ? Math.max(0, opts.count)
      : Math.max(0, Number(pending?.blocked) || 0);
  // Default: free enough for one new reclaim when at exact capacity with no pending shape.
  const incomingSlots =
    excess > 0 || blockedIncoming > 0 ? blockedIncoming : 1;

  const freeCount = slotsToFreeForOverflow({
    size: store.size,
    maxSize: store.maxSize,
    incomingSlots,
  });

  let exportJson = null;
  if (action === 'export') {
    exportJson = store.exportJson({ oldestOnly: freeCount });
  }

  const discarded = store.discardOldest(freeCount);
  await persistStackRecords(store);
  await opts.setOverflowPending?.(null);

  return {
    ok: true,
    stub: false,
    action,
    discarded: discarded.length,
    exportJson,
    stackCount: store.size,
  };
}
