/**
 * Cross-window auto-dedupe (ADR Phase 5 / §5.4).
 * Mode: auto-close-older for same normalized URL (hash + tracking stripped).
 * Safety: activate keep + focus window → suppressClosed remove;
 * closingTabIds prevents re-entry; any step failure → keep both.
 */

import { MSG } from '../shared/constants.js';
import { planAutoCloseOlder } from '../shared/dedupe-match.js';
import { suppressClosedRemove } from '../shared/suppress-closed.js';

/**
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.config]
 * @param {Set<number>} [opts.closingTabIds]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.windows} [opts.windowsApi]
 * @param {{ push: (e: object) => object }} [opts.activityLog]
 * @param {boolean} [opts.broadcast]
 * @returns {Promise<{ closed: number, kept: number, groups: number, stub: false, skipped?: string, errors?: string[] }>}
 */
export async function runAutoDedupe(opts = {}) {
  // Back-compat: maybeReclaim historically passed a Set as the sole arg.
  const closingTabIds =
    opts instanceof Set ? opts : opts.closingTabIds instanceof Set ? opts.closingTabIds : null;
  const config = opts instanceof Set ? {} : opts.config || {};
  const tabsApi = (opts instanceof Set ? undefined : opts.tabsApi) ?? globalThis.chrome?.tabs;
  const windowsApi =
    (opts instanceof Set ? undefined : opts.windowsApi) ?? globalThis.chrome?.windows;
  const activityLog = opts instanceof Set ? undefined : opts.activityLog;
  const broadcast = opts instanceof Set ? true : opts.broadcast !== false; // default on

  if (!closingTabIds) {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: 'noClosingSet' };
  }
  if (config.autoDedupeEnabled === false) {
    return { closed: 0, kept: 0, groups: 0, stub: false, skipped: 'autoDedupeDisabled' };
  }
  // Only supported mode today (ADR Decision B). Unknown modes → no-op.
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

  const plans = planAutoCloseOlder(tabs, {
    closingTabIds,
    stripHash: config.urlNormalizeStripHash !== false,
    stripTracking: config.urlNormalizeStripTrackingParams !== false,
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
      if (closingTabIds.has(dupId) || closingTabIds.has(keepId)) {
        // Re-entry / concurrent close — leave both.
        continue;
      }

      const activated = await activateSurvivor(keepId, plan.keep.windowId, tabsApi, windowsApi);
      if (!activated.ok) {
        errors.push(activated.error || `activate failed for keep ${keepId}`);
        // Fail → keep both (do not remove dup).
        continue;
      }

      const removed = await suppressClosedRemove(dupId, closingTabIds, tabsApi);
      if (!removed.ok) {
        errors.push(removed.error || `remove failed for ${dupId}`);
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
 * Activate survivor tab and focus its window before removing a duplicate.
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
