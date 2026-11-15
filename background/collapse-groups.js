/**
 * After Organize / Reorganize: collapse every tab group except the one that
 * contains the focused/active tab. Ungrouped focused tab → collapse all.
 */

import { TAB_GROUP_ID_NONE } from '../shared/constants.js';
import { resolveFocusedActiveTabId } from './focused-tab.js';

/**
 * Whether a group should be collapsed given the keep-open group id.
 * @param {number} groupId
 * @param {number | null | undefined} keepGroupId — null/undefined → collapse all
 * @returns {boolean}
 */
export function shouldCollapseGroup(groupId, keepGroupId) {
  if (typeof keepGroupId !== 'number' || keepGroupId === TAB_GROUP_ID_NONE) {
    return true;
  }
  return groupId !== keepGroupId;
}

/**
 * Resolve a usable groupId from a tab (Chrome uses -1 for none).
 * @param {{ groupId?: number } | null | undefined} tab
 * @returns {number | null}
 */
export function keepGroupIdFromTab(tab) {
  const gid = tab?.groupId;
  if (typeof gid !== 'number' || gid === TAB_GROUP_ID_NONE || gid < 0) {
    return null;
  }
  return gid;
}

/**
 * Load a live tab by id, or null if it is gone.
 * @param {number} tabId
 * @param {typeof chrome.tabs} tabsApi
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function getLiveTab(tabId, tabsApi) {
  if (!tabsApi?.get || typeof tabId !== 'number') return null;
  try {
    return await tabsApi.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Resolve the focused window's active tab id (fresh query).
 * @param {typeof chrome.tabs} [tabsApi]
 * @param {typeof chrome.windows} [windowsApi]
 * @returns {Promise<number | undefined>}
 */
async function resolveLiveFocusedTabId(tabsApi, windowsApi) {
  const tabs = tabsApi?.query ? await tabsApi.query({}) : [];
  return resolveFocusedActiveTabId(tabs, tabsApi, windowsApi);
}

/**
 * Ensure `activeTabId` stays the focused window's active tab, then collapse
 * all tabGroups in its window except its group (or all in that window if
 * ungrouped). If the captured tab is gone, re-resolve the focused active tab.
 *
 * @param {object} [opts]
 * @param {number} [opts.activeTabId] — captured before merge/group so focus can be restored
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.windows} [opts.windowsApi]
 * @param {typeof chrome.tabGroups} [opts.tabGroupsApi]
 * @returns {Promise<{
 *   activeTabId: number | undefined,
 *   keepGroupId: number | null,
 *   windowId: number | undefined,
 *   collapsed: number,
 *   expanded: number,
 *   errors: string[],
 * }>}
 */
export async function collapseTabGroupsExceptActive(opts = {}) {
  const tabsApi = opts.tabsApi ?? globalThis.chrome?.tabs;
  const windowsApi = opts.windowsApi ?? globalThis.chrome?.windows;
  const tabGroupsApi = opts.tabGroupsApi ?? globalThis.chrome?.tabGroups;

  /** @type {string[]} */
  const errors = [];
  let collapsed = 0;
  let expanded = 0;
  /** @type {number | undefined} */
  let activeTabId =
    typeof opts.activeTabId === 'number' ? opts.activeTabId : undefined;

  /** @type {chrome.tabs.Tab | null} */
  let activeTab = null;

  if (typeof activeTabId === 'number') {
    activeTab = await getLiveTab(activeTabId, tabsApi);
    if (!activeTab) {
      // Captured tab closed during merge/reclaim — fall back to current focus.
      errors.push(`captured tab ${activeTabId} missing — re-resolving focus`);
      activeTabId = undefined;
    }
  }

  if (!activeTab) {
    try {
      activeTabId = await resolveLiveFocusedTabId(tabsApi, windowsApi);
    } catch (err) {
      errors.push(`resolve active: ${err?.message || err}`);
      activeTabId = undefined;
    }
    if (typeof activeTabId === 'number') {
      activeTab = await getLiveTab(activeTabId, tabsApi);
    }
  }

  if (activeTab && typeof activeTabId === 'number') {
    // Restore focus if merge / group APIs left another tab active.
    if (activeTab.active !== true && tabsApi?.update) {
      try {
        activeTab = await tabsApi.update(activeTabId, { active: true });
      } catch (err) {
        errors.push(`restore active: ${err?.message || err}`);
      }
    }
    // Refresh groupId after restore (group apply may have just assigned it).
    const refreshed = await getLiveTab(activeTabId, tabsApi);
    if (refreshed) activeTab = refreshed;
  }

  const keepGroupId = keepGroupIdFromTab(activeTab);
  const windowId =
    typeof activeTab?.windowId === 'number' ? activeTab.windowId : undefined;

  if (!tabGroupsApi?.query || !tabGroupsApi?.update) {
    return {
      activeTabId,
      keepGroupId,
      windowId,
      collapsed,
      expanded,
      errors: [...errors, 'tabGroups API unavailable'],
    };
  }

  // Never query all windows without a resolved focused window — that would
  // collapse every group across the browser when the captured tab is gone.
  if (typeof windowId !== 'number') {
    return {
      activeTabId,
      keepGroupId,
      windowId,
      collapsed,
      expanded,
      errors: [...errors, 'no focused window to collapse'],
    };
  }

  /** @type {chrome.tabGroups.TabGroup[]} */
  let groups = [];
  try {
    groups = await tabGroupsApi.query({ windowId });
  } catch (err) {
    errors.push(`tabGroups.query: ${err?.message || err}`);
    return { activeTabId, keepGroupId, windowId, collapsed, expanded, errors };
  }

  for (const group of groups) {
    if (typeof group?.id !== 'number') continue;
    const collapse = shouldCollapseGroup(group.id, keepGroupId);
    // Skip no-op updates when already in the desired state.
    if (group.collapsed === collapse) {
      if (collapse) collapsed += 1;
      else expanded += 1;
      continue;
    }
    try {
      await tabGroupsApi.update(group.id, { collapsed: collapse });
      if (collapse) collapsed += 1;
      else expanded += 1;
    } catch (err) {
      errors.push(`tabGroups.update ${group.id}: ${err?.message || err}`);
    }
  }

  return { activeTabId, keepGroupId, windowId, collapsed, expanded, errors };
}
