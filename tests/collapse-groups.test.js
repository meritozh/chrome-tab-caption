import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCollapseGroup,
  keepGroupIdFromTab,
  collapseTabGroupsExceptActive,
} from '../background/collapse-groups.js';
import { TAB_GROUP_ID_NONE } from '../shared/constants.js';

describe('shouldCollapseGroup / keepGroupIdFromTab', () => {
  it('keeps only the focused tab group expanded', () => {
    assert.equal(shouldCollapseGroup(10, 10), false);
    assert.equal(shouldCollapseGroup(11, 10), true);
  });

  it('collapses every group when keepGroupId is null/ungrouped', () => {
    assert.equal(shouldCollapseGroup(10, null), true);
    assert.equal(shouldCollapseGroup(10, undefined), true);
    assert.equal(shouldCollapseGroup(10, TAB_GROUP_ID_NONE), true);
  });

  it('maps tab.groupId to keep id or null', () => {
    assert.equal(keepGroupIdFromTab({ groupId: 7 }), 7);
    assert.equal(keepGroupIdFromTab({ groupId: TAB_GROUP_ID_NONE }), null);
    assert.equal(keepGroupIdFromTab({ groupId: -1 }), null);
    assert.equal(keepGroupIdFromTab({}), null);
    assert.equal(keepGroupIdFromTab(null), null);
  });
});

function makeApis({ tabs, groups, focusedWindowId = 1 }) {
  /** @type {Map<number, object>} */
  const tabMap = new Map(tabs.map((t) => [t.id, { ...t }]));
  /** @type {Map<number, object>} */
  const groupMap = new Map(groups.map((g) => [g.id, { ...g }]));
  /** @type {Array<{ id: number, collapsed: boolean }>} */
  const updates = [];

  const tabsApi = {
    async query(query = {}) {
      let list = [...tabMap.values()];
      if (typeof query.windowId === 'number') {
        list = list.filter((t) => t.windowId === query.windowId);
      }
      if (query.active === true) {
        list = list.filter((t) => t.active);
      }
      return list;
    },
    async get(id) {
      const t = tabMap.get(id);
      if (!t) throw new Error(`missing tab ${id}`);
      return { ...t };
    },
    async update(id, props) {
      const t = tabMap.get(id);
      if (!t) throw new Error(`missing tab ${id}`);
      Object.assign(t, props);
      if (props.active) {
        for (const other of tabMap.values()) {
          if (other.windowId === t.windowId && other.id !== id) other.active = false;
        }
      }
      return { ...t };
    },
    _map: tabMap,
  };

  const windowsApi = {
    async getLastFocused() {
      return { id: focusedWindowId, focused: true };
    },
  };

  const tabGroupsApi = {
    async query(query = {}) {
      let list = [...groupMap.values()];
      if (typeof query.windowId === 'number') {
        list = list.filter((g) => g.windowId === query.windowId);
      }
      return list.map((g) => ({ ...g }));
    },
    async update(id, props) {
      const g = groupMap.get(id);
      if (!g) throw new Error(`missing group ${id}`);
      Object.assign(g, props);
      updates.push({ id, collapsed: props.collapsed });
      return { ...g };
    },
    _map: groupMap,
    _updates: updates,
  };

  return { tabsApi, windowsApi, tabGroupsApi };
}

describe('collapseTabGroupsExceptActive', () => {
  it('collapses all groups except the active tab group and restores focus', async () => {
    const api = makeApis({
      tabs: [
        { id: 1, windowId: 1, active: false, groupId: 100 },
        { id: 2, windowId: 1, active: true, groupId: 200 },
        { id: 3, windowId: 1, active: false, groupId: 200 },
      ],
      groups: [
        { id: 100, windowId: 1, title: 'News', collapsed: false },
        { id: 200, windowId: 1, title: 'Docs', collapsed: false },
        { id: 300, windowId: 1, title: 'Video', collapsed: false },
      ],
    });

    // Pre-captured focused tab was 1; merge left tab 2 active — restore 1.
    const result = await collapseTabGroupsExceptActive({
      activeTabId: 1,
      tabsApi: api.tabsApi,
      windowsApi: api.windowsApi,
      tabGroupsApi: api.tabGroupsApi,
    });

    assert.equal(result.activeTabId, 1);
    assert.equal(result.keepGroupId, 100);
    assert.equal(api.tabsApi._map.get(1).active, true);
    assert.equal(api.tabsApi._map.get(2).active, false);
    assert.equal(api.tabGroupsApi._map.get(100).collapsed, false);
    assert.equal(api.tabGroupsApi._map.get(200).collapsed, true);
    assert.equal(api.tabGroupsApi._map.get(300).collapsed, true);
    assert.equal(result.expanded, 1);
    assert.equal(result.collapsed, 2);
    assert.deepEqual(result.errors, []);
  });

  it('collapses every group when the focused tab is ungrouped', async () => {
    const api = makeApis({
      tabs: [
        { id: 1, windowId: 1, active: true, groupId: TAB_GROUP_ID_NONE },
        { id: 2, windowId: 1, active: false, groupId: 100 },
      ],
      groups: [
        { id: 100, windowId: 1, title: 'News', collapsed: false },
        { id: 200, windowId: 1, title: 'Docs', collapsed: false },
      ],
    });

    const result = await collapseTabGroupsExceptActive({
      activeTabId: 1,
      tabsApi: api.tabsApi,
      windowsApi: api.windowsApi,
      tabGroupsApi: api.tabGroupsApi,
    });

    assert.equal(result.keepGroupId, null);
    assert.equal(api.tabGroupsApi._map.get(100).collapsed, true);
    assert.equal(api.tabGroupsApi._map.get(200).collapsed, true);
    assert.equal(result.collapsed, 2);
    assert.equal(result.expanded, 0);
  });

  it('resolves focused active tab when activeTabId is omitted', async () => {
    const api = makeApis({
      focusedWindowId: 1,
      tabs: [
        { id: 1, windowId: 1, active: true, groupId: 50 },
        { id: 2, windowId: 1, active: false, groupId: 60 },
      ],
      groups: [
        { id: 50, windowId: 1, title: 'A', collapsed: true },
        { id: 60, windowId: 1, title: 'B', collapsed: false },
      ],
    });

    const result = await collapseTabGroupsExceptActive({
      tabsApi: api.tabsApi,
      windowsApi: api.windowsApi,
      tabGroupsApi: api.tabGroupsApi,
    });

    assert.equal(result.activeTabId, 1);
    assert.equal(result.keepGroupId, 50);
    assert.equal(api.tabGroupsApi._map.get(50).collapsed, false);
    assert.equal(api.tabGroupsApi._map.get(60).collapsed, true);
  });

  it('is fail-soft when a group update throws', async () => {
    const api = makeApis({
      tabs: [{ id: 1, windowId: 1, active: true, groupId: 10 }],
      groups: [
        { id: 10, windowId: 1, title: 'Keep', collapsed: false },
        { id: 20, windowId: 1, title: 'Fail', collapsed: false },
      ],
    });
    const origUpdate = api.tabGroupsApi.update.bind(api.tabGroupsApi);
    api.tabGroupsApi.update = async (id, props) => {
      if (id === 20) throw new Error('gone');
      return origUpdate(id, props);
    };

    const result = await collapseTabGroupsExceptActive({
      activeTabId: 1,
      tabsApi: api.tabsApi,
      windowsApi: api.windowsApi,
      tabGroupsApi: api.tabGroupsApi,
    });

    assert.equal(api.tabGroupsApi._map.get(10).collapsed, false);
    assert.ok(result.errors.some((e) => e.includes('20') && e.includes('gone')));
  });
});
