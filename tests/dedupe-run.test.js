import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoDedupe } from '../background/dedupe.js';
import { createActivityLog } from '../shared/activity-log.js';
import { maybeReclaim } from '../background/stacks.js';
import { StackRecordStore } from '../shared/stack-records.js';

function makeChromeApis(initialTabs) {
  /** @type {Map<number, object>} */
  const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
  /** @type {number[]} */
  const activated = [];
  /** @type {number[]} */
  const focusedWindows = [];

  const tabsApi = {
    async query() {
      return [...tabs.values()];
    },
    async get(id) {
      const t = tabs.get(id);
      if (!t) throw new Error(`missing ${id}`);
      return t;
    },
    async update(id, props) {
      const t = tabs.get(id);
      if (!t) throw new Error(`missing ${id}`);
      Object.assign(t, props);
      if (props.active) {
        activated.push(id);
        for (const other of tabs.values()) {
          if (other.windowId === t.windowId && other.id !== id) other.active = false;
        }
      }
      return t;
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error(`missing tab ${id}`);
      tabs.delete(id);
    },
    _tabs: tabs,
    _activated: activated,
  };

  const windowsApi = {
    async update(windowId, props) {
      if (props.focused) focusedWindows.push(windowId);
      return { id: windowId, focused: Boolean(props.focused) };
    },
    _focused: focusedWindows,
  };

  return { tabsApi, windowsApi };
}

describe('runAutoDedupe', () => {
  it('activates survivor then suppressClosed-removes older cross-window dups', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      {
        id: 1,
        windowId: 10,
        url: 'https://news.test/story?id=9&utm_source=x',
        lastAccessed: 10,
        active: false,
      },
      {
        id: 2,
        windowId: 20,
        url: 'https://news.test/story?id=9#comments',
        lastAccessed: 5,
        active: true,
      },
      { id: 3, windowId: 10, url: 'https://unique.test/', lastAccessed: 100 },
    ]);
    /** @type {Set<number>} */
    const closingTabIds = new Set();
    const activityLog = createActivityLog();

    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds,
      tabsApi,
      windowsApi,
      activityLog,
      broadcast: false,
    });

    assert.equal(result.stub, false);
    assert.equal(result.closed, 1);
    assert.equal(tabsApi._tabs.has(2), true);
    assert.equal(tabsApi._tabs.has(1), false);
    assert.equal(tabsApi._tabs.has(3), true);
    // activate-then-remove order: survivor activated before close
    assert.ok(tabsApi._activated.includes(2));
    assert.ok(windowsApi._focused.includes(20));
    assert.ok(closingTabIds.has(1));
    assert.equal(activityLog.size, 1);
    assert.equal(activityLog.list()[0].kind, 'dedupe');
  });

  it('keeps both tabs when activate fails', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://a.test/', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://a.test/', lastAccessed: 2, active: true },
    ]);
    tabsApi.update = async () => {
      throw new Error('activate denied');
    };
    const closingTabIds = new Set();
    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds,
      tabsApi,
      windowsApi,
      broadcast: false,
    });
    assert.equal(result.closed, 0);
    assert.equal(tabsApi._tabs.size, 2);
    assert.equal(closingTabIds.size, 0);
  });

  it('no-ops when autoDedupeEnabled is false', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://a.test/', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://a.test/', lastAccessed: 2 },
    ]);
    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: false, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      broadcast: false,
    });
    assert.equal(result.skipped, 'autoDedupeDisabled');
    assert.equal(tabsApi._tabs.size, 2);
  });
});

describe('dedupe before reclaim', () => {
  it('closes duplicates before counting open tabs for reclaim', async () => {
    // 4 tabs, 2 are URL dups → after dedupe 3 open; maxOpenTabs=3 → no reclaim.
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://dup.test/x', lastAccessed: 40, active: true },
      { id: 2, windowId: 2, url: 'https://dup.test/x?utm_medium=cpc', lastAccessed: 10 },
      { id: 3, windowId: 1, url: 'https://a.test/1', lastAccessed: 30 },
      { id: 4, windowId: 1, url: 'https://a.test/2', lastAccessed: 20 },
    ]);
    const store = new StackRecordStore(500);
    const closingTabIds = new Set();
    const result = await maybeReclaim({
      config: {
        maxOpenTabs: 3,
        stackSize: 500,
        autoStackEnabled: true,
        autoDedupeEnabled: true,
        dedupeMode: 'auto-close-older',
      },
      stackStore: store,
      closingTabIds,
      tabsApi,
      windowsApi,
      probeUnload: false,
      setOverflowPending: async () => {},
    });

    assert.equal(result.dedupe?.closed, 1);
    assert.equal(result.reclaimed, 0);
    assert.equal(store.size, 0);
    assert.equal(tabsApi._tabs.size, 3);
    assert.equal(tabsApi._tabs.has(1), true);
    assert.equal(tabsApi._tabs.has(2), false);
  });

  it('still dedupes when autoStackEnabled is false', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://z.test/', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://z.test/', lastAccessed: 9, active: true },
    ]);
    const result = await maybeReclaim({
      config: {
        autoStackEnabled: false,
        autoDedupeEnabled: true,
        dedupeMode: 'auto-close-older',
        maxOpenTabs: 1,
      },
      stackStore: new StackRecordStore(10),
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      probeUnload: false,
    });
    assert.equal(result.skipped, 'autoStackDisabled');
    assert.equal(result.dedupe?.closed, 1);
    assert.equal(tabsApi._tabs.size, 1);
  });
});
