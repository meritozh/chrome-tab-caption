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

  /** @type {chrome.tabs.Tab[]} */
  let tabs;
  try {
    tabs = await tabsApi.query({});
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

  // Probe possible close targets for beforeunload / dirty forms before planning.
  /** @type {Set<number>} */
  const beforeUnloadRiskIds = new Set();
  if (probeUnload) {
    const prelim = planAutoCloseOlder(tabs, {
      closingTabIds,
      stripHash: config.urlNormalizeStripHash !== false,
      stripTracking: config.urlNormalizeStripTrackingParams !== false,
    });
    /** @type {Set<number>} */
    const toProbe = new Set();
    for (const plan of prelim) {
      for (const dup of plan.close) {
        if (typeof dup?.id === 'number' && !tabLooksUnsaved(dup)) toProbe.add(dup.id);
      }
    }
    for (const id of toProbe) {
      if (await probeBeforeUnloadRisk(id, scriptingApi)) {
        beforeUnloadRiskIds.add(id);
      }
    }
  }

  const plans = planAutoCloseOlder(tabs, {
    closingTabIds,
    stripHash: config.urlNormalizeStripHash !== false,
    stripTracking: config.urlNormalizeStripTrackingParams !== false,
    beforeUnloadRiskIds,
  });

  if (!plans.length) {
    return { closed: 0, kept: 0, groups: 0, stub: false };
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

      // Mark before activate so concurrent work sees the suppress set.
      closingTabIds.add(dupId);

      const activated = await activateSurvivor(keepId, plan.keep.windowId, tabsApi, windowsApi);
      if (!activated.ok) {
        closingTabIds.delete(dupId);
        errors.push(activated.error || `activate failed for keep ${keepId}`);
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
          keepWindowId: plan.keep.windowId,
          closedWindowId: dup.windowId,
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
