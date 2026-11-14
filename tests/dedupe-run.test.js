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
      probeUnload: false,
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
      probeUnload: false,
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
      probeUnload: false,
    });
    assert.equal(result.skipped, 'autoDedupeDisabled');
    assert.equal(tabsApi._tabs.size, 2);
  });

  it('skips unsaved duplicates instead of closing them', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://edit.test/', title: '* Draft', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://edit.test/', lastAccessed: 9, active: true },
    ]);
    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      broadcast: false,
      probeUnload: false,
    });
    assert.equal(result.closed, 0);
    assert.equal(tabsApi._tabs.size, 2);
  });

  it('skips close when a tab navigates away before remove', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://nav.test/old', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://nav.test/old', lastAccessed: 9, active: true },
    ]);
    const originalGet = tabsApi.get.bind(tabsApi);
    let getCount = 0;
    tabsApi.get = async (id) => {
      getCount += 1;
      const tab = await originalGet(id);
      // After first pair of freshness reads, tab 1 has navigated away.
      if (id === 1 && getCount > 2) {
        return { ...tab, url: 'https://nav.test/elsewhere' };
      }
      return tab;
    };
    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      broadcast: false,
      probeUnload: false,
    });
    assert.equal(result.closed, 0);
    assert.equal(tabsApi._tabs.size, 2);
  });

  it('serializes overlapping runAutoDedupe calls', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      { id: 1, windowId: 1, url: 'https://race.test/', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://race.test/', lastAccessed: 9, active: true },
    ]);
    const closingTabIds = new Set();
    const opts = {
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds,
      tabsApi,
      windowsApi,
      broadcast: false,
      probeUnload: false,
    };
    const [a, b] = await Promise.all([runAutoDedupe(opts), runAutoDedupe(opts)]);
    assert.equal(a.closed + b.closed, 1);
    assert.equal(tabsApi._tabs.size, 1);
    assert.equal(tabsApi._tabs.has(2), true);
  });

  it('retains unprobed dirty tab when re-plan swaps survivor (issue #10)', async () => {
    // Tab 1 starts active (survivor) with dirty DOM; tab 2 is the prelim close target.
    // During tab 2's probe, the user activates tab 2 → re-plan closes tab 1.
    // Tab 1 must be late-probed and retained, not closed unprobed.
    const { tabsApi, windowsApi } = makeChromeApis([
      {
        id: 1,
        windowId: 1,
        url: 'https://form.test/edit',
        title: 'Form',
        lastAccessed: 10,
        active: true,
      },
      {
        id: 2,
        windowId: 1,
        url: 'https://form.test/edit',
        title: 'Form',
        lastAccessed: 5,
        active: false,
      },
    ]);
    /** @type {number[]} */
    const probed = [];
    const scriptingApi = {
      async executeScript({ target }) {
        const tabId = target.tabId;
        probed.push(tabId);
        if (tabId === 2) {
          for (const t of tabsApi._tabs.values()) {
            t.active = t.id === 2;
          }
        }
        // Tab 1 has unsaved form state; tab 2 is clean.
        return [{ result: tabId === 1 }];
      },
    };

    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      scriptingApi,
      broadcast: false,
      probeUnload: true,
    });

    assert.equal(result.closed, 0);
    assert.equal(tabsApi._tabs.size, 2);
    assert.ok(probed.includes(2), 'prelim close target probed');
    assert.ok(probed.includes(1), 're-planned close target late-probed');
  });

  it('probes and closes a clean duplicate that appears during probe await', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      {
        id: 1,
        windowId: 1,
        url: 'https://newdup.test/',
        title: 'A',
        lastAccessed: 10,
        active: true,
      },
      {
        id: 2,
        windowId: 1,
        url: 'https://newdup.test/',
        title: 'A',
        lastAccessed: 5,
        active: false,
      },
    ]);
    /** @type {number[]} */
    const probed = [];
    const scriptingApi = {
      async executeScript({ target }) {
        const tabId = target.tabId;
        probed.push(tabId);
        if (tabId === 2 && !tabsApi._tabs.has(3)) {
          tabsApi._tabs.set(3, {
            id: 3,
            windowId: 1,
            url: 'https://newdup.test/',
            title: 'A',
            lastAccessed: 1,
            active: false,
          });
        }
        return [{ result: false }];
      },
    };

    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      scriptingApi,
      broadcast: false,
      probeUnload: true,
    });

    assert.ok(probed.includes(2));
    assert.ok(probed.includes(3), 'newly appeared close target late-probed');
    assert.equal(result.closed, 2);
    assert.equal(tabsApi._tabs.has(1), true);
    assert.equal(tabsApi._tabs.has(2), false);
    assert.equal(tabsApi._tabs.has(3), false);
  });

  it('retains a dirty duplicate that appears during probe await', async () => {
    const { tabsApi, windowsApi } = makeChromeApis([
      {
        id: 1,
        windowId: 1,
        url: 'https://dirtynew.test/',
        title: 'A',
        lastAccessed: 10,
        active: true,
      },
      {
        id: 2,
        windowId: 1,
        url: 'https://dirtynew.test/',
        title: 'A',
        lastAccessed: 5,
        active: false,
      },
    ]);
    /** @type {number[]} */
    const probed = [];
    const scriptingApi = {
      async executeScript({ target }) {
        const tabId = target.tabId;
        probed.push(tabId);
        if (tabId === 2 && !tabsApi._tabs.has(3)) {
          tabsApi._tabs.set(3, {
            id: 3,
            windowId: 1,
            url: 'https://dirtynew.test/',
            title: 'A',
            lastAccessed: 1,
            active: false,
          });
        }
        // Only the newly appeared tab is dirty.
        return [{ result: tabId === 3 }];
      },
    };

    const result = await runAutoDedupe({
      config: { autoDedupeEnabled: true, dedupeMode: 'auto-close-older' },
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      scriptingApi,
      broadcast: false,
      probeUnload: true,
    });

    assert.ok(probed.includes(3), 'newly appeared dirty tab late-probed');
    assert.equal(result.closed, 1);
    assert.equal(tabsApi._tabs.has(1), true);
    assert.equal(tabsApi._tabs.has(2), false);
    assert.equal(tabsApi._tabs.has(3), true);
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
        topicCacheSize: 500,
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
