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
 * Ensure `activeTabId` stays the focused window's active tab, then collapse
 * all tabGroups in its window except its group (or all if ungrouped).
 *
 * @param {object} [opts]
 * @param {number} [opts.activeTabId] — captured before merge/group so focus can be restored
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @param {typeof chrome.windows} [opts.windowsApi]
 * @param {typeof chrome.tabGroups} [opts.tabGroupsApi]
 * @returns {Promise<{
 *   activeTabId: number | undefined,
 *   keepGroupId: number | null,
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

  if (typeof activeTabId !== 'number') {
    try {
      const tabs = tabsApi?.query ? await tabsApi.query({}) : [];
      activeTabId = await resolveFocusedActiveTabId(tabs, tabsApi, windowsApi);
    } catch (err) {
      errors.push(`resolve active: ${err?.message || err}`);
    }
  }

  /** @type {chrome.tabs.Tab | null} */
  let activeTab = null;
  if (typeof activeTabId === 'number' && tabsApi?.get) {
    try {
      activeTab = await tabsApi.get(activeTabId);
      // Restore focus if merge / group APIs left another tab active.
      if (activeTab && activeTab.active !== true && tabsApi.update) {
        try {
          activeTab = await tabsApi.update(activeTabId, { active: true });
        } catch (err) {
          errors.push(`restore active: ${err?.message || err}`);
        }
      }
      // Refresh groupId after restore (group apply may have just assigned it).
      if (tabsApi.get) {
        try {
          activeTab = await tabsApi.get(activeTabId);
        } catch {
          // keep prior snapshot
        }
      }
    } catch (err) {
      errors.push(`get active tab: ${err?.message || err}`);
      activeTab = null;
    }
  }

  const keepGroupId = keepGroupIdFromTab(activeTab);
  const windowId =
    typeof activeTab?.windowId === 'number' ? activeTab.windowId : undefined;

  if (!tabGroupsApi?.query || !tabGroupsApi?.update) {
    return {
      activeTabId,
      keepGroupId,
      collapsed,
      expanded,
      errors: [...errors, 'tabGroups API unavailable'],
    };
  }

  /** @type {chrome.tabGroups.TabGroup[]} */
  let groups = [];
  try {
    groups =
      typeof windowId === 'number'
        ? await tabGroupsApi.query({ windowId })
        : await tabGroupsApi.query({});
  } catch (err) {
    errors.push(`tabGroups.query: ${err?.message || err}`);
    return { activeTabId, keepGroupId, collapsed, expanded, errors };
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

  return { activeTabId, keepGroupId, collapsed, expanded, errors };
}
