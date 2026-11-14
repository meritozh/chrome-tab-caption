/**
 * Cross-window auto-dedupe (ADR Phase 5 / §5.4).
 * Mode: auto-close-older for same normalized URL (hash + tracking stripped).
 * Same-window exact URL copies are also collapsed (ADR "含跨 window" is inclusive).
 * Safety: activate keep + focus window → suppressClosed remove;
 * closingTabIds prevents re-entry; any step failure → keep both.
 * Serialized via dedupeGate so scheduleDedupe + reclaim cannot race closes.
 */

import { MSG } from '../shared/constants.js';
import { planAutoCloseOlder } from '../shared/dedupe-match.js';
import { suppressClosedRemove } from '../shared/suppress-closed.js';
import { probeBeforeUnloadRisk } from '../shared/beforeunload-probe.js';
import { tabLooksUnsaved } from '../shared/reclaim-policy.js';
import { normalizeUrlKey } from '../shared/url-normalize.js';
import { resolveFocusedActiveTabId } from './focused-tab.js';

/** @type {Promise<unknown>} */
let dedupeGate = Promise.resolve();

/**
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.config]
 * @param {Set<number>} [opts.closingTabIds]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.windows} [opts.windowsApi]
 * @param {typeof chrome.scripting} [opts.scriptingApi]
 * @param {{ push: (e: object) => object }} [opts.activityLog]
 * @param {boolean} [opts.broadcast]
 * @param {boolean} [opts.probeUnload]
 * @returns {Promise<{ closed: number, kept: number, groups: number, stub: false, skipped?: string, errors?: string[] }>}
 */
export async function runAutoDedupe(opts = {}) {
  // Serialize all callers (standalone scheduleDedupe + maybeReclaim).
  let release = () => {};
  const myTurn = new Promise((resolve) => {
    release = resolve;
  });
  const previous = dedupeGate;
  dedupeGate = previous.then(() => myTurn, () => myTurn);
  await previous.catch(() => {});
  try {
    return await runAutoDedupeUnlocked(opts);
  } finally {
    release();
  }
}

/**
 * @param {object} [opts]
 */
async function runAutoDedupeUnlocked(opts = {}) {
  // Back-compat: maybeReclaim historically passed a Set as the sole arg.
  const closingTabIds =
    opts instanceof Set ? opts : opts.closingTabIds instanceof Set ? opts.closingTabIds : null;
  const config = opts instanceof Set ? {} : opts.config || {};
  const tabsApi = (opts instanceof Set ? undefined : opts.tabsApi) ?? globalThis.chrome?.tabs;
  const windowsApi =
    (opts instanceof Set ? undefined : opts.windowsApi) ?? globalThis.chrome?.windows;
  const scriptingApi =
    (opts instanceof Set ? undefined : opts.scriptingApi) ?? globalThis.chrome?.scripting;
  const activityLog = opts instanceof Set ? undefined : opts.activityLog;
  const broadcast = opts instanceof Set ? true : opts.broadcast !== false;
  const probeUnload = opts instanceof Set ? true : opts.probeUnload !== false;

  if (!closingTabIds) {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: 'noClosingSet' };
  }
  if (config.autoDedupeEnabled === false) {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: 'autoDedupeDisabled' };
  }
  const mode = config.dedupeMode || 'auto-close-older';
  if (mode !== 'auto-close-older') {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: `unsupportedMode:${mode}` };
  }
  if (!tabsApi?.query) {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: 'unavailable' };
  }

  const tabActivity = opts instanceof Set ? undefined : opts.tabActivity;

  /** @type {chrome.tabs.Tab[]} */
  let tabs;
  try {
    const raw = await tabsApi.query({});
    tabs =
      typeof tabActivity?.applyToTabs === 'function' ? tabActivity.applyToTabs(raw) : raw;
  } catch (err) {
    return {
      closed: 0,
      kept: 0,
      groups: 0,
      stub: false,
      skipped: 'queryFailed',
      errors: [String(err?.message || err)],
    };
  }

  const protectActiveTabId = await resolveFocusedActiveTabId(tabs, tabsApi, windowsApi);

  // Probe possible close targets for beforeunload / dirty forms before planning.
  /** @type {Set<number>} */
  const beforeUnloadRiskIds = new Set();
  /** Tabs whose DOM risk probe already ran (positive or negative). */
  /** @type {Set<number>} */
  const probedTabIds = new Set();
  if (probeUnload) {
    const prelim = planAutoCloseOlder(tabs, {
      closingTabIds,
      stripHash: config.urlNormalizeStripHash !== false,
      stripTracking: config.urlNormalizeStripTrackingParams !== false,
      protectActiveTabId,
    });
    /** @type {Set<number>} */
    const toProbe = new Set();
    for (const plan of prelim) {
      for (const dup of plan.close) {
        if (typeof dup?.id === 'number' && !tabLooksUnsaved(dup)) toProbe.add(dup.id);
      }
    }
    for (const id of toProbe) {
      probedTabIds.add(id);
      if (await probeBeforeUnloadRisk(id, scriptingApi)) {
        beforeUnloadRiskIds.add(id);
      }
    }
  }

  const normalizeOpts = {
    stripHash: config.urlNormalizeStripHash !== false,
    stripTracking: config.urlNormalizeStripTrackingParams !== false,
  };

  // Re-query after probes — URLs may have changed during await.
  try {
    const raw = await tabsApi.query({});
    tabs =
      typeof tabActivity?.applyToTabs === 'function' ? tabActivity.applyToTabs(raw) : raw;
  } catch (err) {
    return {
      closed: 0,
      kept: 0,
      groups: 0,
      stub: false,
      skipped: 'requeryFailed',
      errors: [String(err?.message || err)],
    };
  }

  const protectAfterProbe = await resolveFocusedActiveTabId(tabs, tabsApi, windowsApi);

  const plans = planAutoCloseOlder(tabs, {
    closingTabIds,
    ...normalizeOpts,
    beforeUnloadRiskIds,
    protectActiveTabId: protectAfterProbe ?? protectActiveTabId,
  });

  if (!plans.length) {
    return { closed: 0, kept: 0, groups: 0, stub: false };
  }

  // Issue #10: post-probe re-plan can introduce close targets that were never
  // probed (former survivor, or a duplicate that appeared during await).
  // Probe those before the close loop; do not auto-close unprobed dirty tabs.
  if (probeUnload) {
    /** @type {Set<number>} */
    const lateProbe = new Set();
    for (const plan of plans) {
      for (const dup of plan.close) {
        if (
          typeof dup?.id === 'number' &&
          !probedTabIds.has(dup.id) &&
          !beforeUnloadRiskIds.has(dup.id) &&
          !tabLooksUnsaved(dup)
        ) {
          lateProbe.add(dup.id);
        }
      }
    }
    for (const id of lateProbe) {
      probedTabIds.add(id);
      if (await probeBeforeUnloadRisk(id, scriptingApi)) {
        beforeUnloadRiskIds.add(id);
      }
    }
  }

  let closed = 0;
  let kept = 0;
  /** @type {string[]} */
  const errors = [];

  for (const plan of plans) {
    const keepId = plan.keep?.id;
    if (typeof keepId !== 'number') continue;
    kept += 1;

    for (const dup of plan.close) {
      const dupId = dup?.id;
      if (typeof dupId !== 'number') continue;
      // Reserve immediately so a nested / late planner skips this id.
      if (closingTabIds.has(dupId) || closingTabIds.has(keepId)) {
        continue;
      }
      if (tabLooksUnsaved(dup) || beforeUnloadRiskIds.has(dupId)) {
        continue;
      }

      // Fresh URL check — skip if either tab navigated away during probe/plan.
      const stillDup = await urlsStillMatch(keepId, dupId, plan.urlKey, tabsApi, normalizeOpts);
      if (!stillDup.ok) {
        continue;
      }

      // Mark before activate so concurrent work sees the suppress set.
      closingTabIds.add(dupId);

      const activated = await activateSurvivor(
        keepId,
        stillDup.keepWindowId ?? plan.keep.windowId,
        tabsApi,
        windowsApi,
      );
      if (!activated.ok) {
        closingTabIds.delete(dupId);
        errors.push(activated.error || `activate failed for keep ${keepId}`);
        continue;
      }

      // Re-check after activate (focus can race with navigation).
      const stillDupAfter = await urlsStillMatch(
        keepId,
        dupId,
        plan.urlKey,
        tabsApi,
        normalizeOpts,
      );
      if (!stillDupAfter.ok) {
        closingTabIds.delete(dupId);
        continue;
      }

      const removed = await suppressClosedRemove(dupId, closingTabIds, tabsApi);
      if (!removed.ok) {
        errors.push(removed.error || `remove failed for ${dupId}`);
        continue;
      }
      if (removed.alreadyClosed) {
        // Peer won the race; don't double-count / double-log.
        continue;
      }

      closed += 1;
      const entry = {
        kind: 'dedupe',
        message: `Closed duplicate tab (kept #${keepId})`,
        detail: {
          keepTabId: keepId,
          closedTabId: dupId,
          urlKey: plan.urlKey,
          keepWindowId: stillDupAfter.keepWindowId ?? plan.keep.windowId,
          closedWindowId: stillDupAfter.dupWindowId ?? dup.windowId,
        },
      };
      const logged = activityLog?.push?.(entry);
      if (broadcast) {
        broadcastActivity(logged || { ...entry, at: Date.now() });
      }
    }
  }

  return {
    closed,
    kept,
    groups: plans.length,
    stub: false,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Confirm keep + dup still share the planned normalized URL (post-probe freshness).
 * @param {number} keepId
 * @param {number} dupId
 * @param {string} urlKey
 * @param {typeof chrome.tabs} tabsApi
 * @param {{ stripHash?: boolean, stripTracking?: boolean }} normalizeOpts
 */
async function urlsStillMatch(keepId, dupId, urlKey, tabsApi, normalizeOpts) {
  if (!tabsApi?.get) {
    return { ok: true };
  }
  try {
    const [keepTab, dupTab] = await Promise.all([tabsApi.get(keepId), tabsApi.get(dupId)]);
    if (tabLooksUnsaved(dupTab)) return { ok: false, reason: 'dupUnsaved' };
    const keepKey = normalizeUrlKey(keepTab?.url || '', normalizeOpts);
    const dupKey = normalizeUrlKey(dupTab?.url || '', normalizeOpts);
    if (!keepKey || !dupKey || keepKey !== urlKey || dupKey !== urlKey) {
      return { ok: false, reason: 'urlChanged' };
    }
    return {
      ok: true,
      keepWindowId: keepTab.windowId,
      dupWindowId: dupTab.windowId,
    };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

/**
 * @param {number} keepId
 * @param {number | undefined} windowId
 * @param {typeof chrome.tabs} tabsApi
 * @param {typeof chrome.windows | undefined} windowsApi
 */
async function activateSurvivor(keepId, windowId, tabsApi, windowsApi) {
  try {
    if (tabsApi?.update) {
      await tabsApi.update(keepId, { active: true });
    }
    const winId =
      typeof windowId === 'number'
        ? windowId
        : (await tabsApi.get?.(keepId))?.windowId;
    if (typeof winId === 'number' && windowsApi?.update) {
      await windowsApi.update(winId, { focused: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * @param {object} entry
 */
function broadcastActivity(entry) {
  try {
    chrome.runtime
      .sendMessage({ type: MSG.ACTIVITY_LOG, entry })
      .catch(() => {});
  } catch {
    // no listeners / chrome unavailable
  }
}
