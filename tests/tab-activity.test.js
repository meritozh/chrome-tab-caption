import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTabActivityStore } from '../shared/tab-activity.js';
import { selectReclaimTargets } from '../shared/reclaim-policy.js';
import { partitionKeepAndReclaim } from '../shared/window-merge.js';
import { planAutoCloseOlder } from '../shared/dedupe-match.js';
import { maybeReclaim } from '../background/stacks.js';
import { StackRecordStore } from '../shared/stack-records.js';

describe('tab activity touches', () => {
  it('raises lastAccessed for touched tabs without mutating input', () => {
    const store = createTabActivityStore();
    const tabs = [
      { id: 1, lastAccessed: 10 },
      { id: 2, lastAccessed: 100 },
    ];
    store.touch(1, 500);
    const next = store.applyToTabs(tabs);
    assert.equal(tabs[0].lastAccessed, 10);
    assert.equal(next[0].lastAccessed, 500);
    assert.equal(next[1].lastAccessed, 100);
  });

  it('keeps a just-activated old tab out of reclaim targets', () => {
    const activity = createTabActivityStore();
    // User switched to tab 10 (grouped, stale chrome lastAccessed).
    activity.touch(10, 10_000);
    const raw = [
      { id: 10, url: 'https://grouped.test/old', lastAccessed: 5, active: true },
      { id: 11, url: 'https://a.test/1', lastAccessed: 9_000 },
      { id: 12, url: 'https://a.test/2', lastAccessed: 8_000 },
      { id: 13, url: 'https://a.test/3', lastAccessed: 7_000 },
    ];
    const tabs = activity.applyToTabs(raw);
    const picked = selectReclaimTargets(tabs, {
      maxOpenTabs: 2,
      protectActiveTabId: 10,
    });
    assert.equal(
      picked.some((t) => t.id === 10),
      false,
    );
    // Excess=2 → reclaim oldest non-protected: 13 then 12
    assert.deepEqual(
      picked.map((t) => t.id),
      [13, 12],
    );
  });

  it('partitionKeepAndReclaim forces protectActiveTabId into the keep-set', () => {
    const tabs = [
      { id: 1, url: 'https://a.test/1', lastAccessed: 100 },
      { id: 2, url: 'https://a.test/2', lastAccessed: 90 },
      { id: 3, url: 'https://grouped.test', lastAccessed: 1, active: true },
    ];
    const { kept, reclaimTargets } = partitionKeepAndReclaim(tabs, {
      maxOpenTabs: 2,
      protectActiveTabId: 3,
    });
    assert.ok(kept.some((t) => t.id === 3));
    assert.equal(
      reclaimTargets.some((t) => t.id === 3),
      false,
    );
  });
});

describe('dedupe protectActiveTabId', () => {
  it('never closes the focused active tab even when another copy scores higher', () => {
    const plans = planAutoCloseOlder(
      [
        {
          id: 1,
          url: 'https://dup.test/page',
          lastAccessed: 10,
          active: true,
          windowId: 1,
        },
        {
          id: 2,
          url: 'https://dup.test/page',
          lastAccessed: 9999,
          active: true,
          windowId: 2,
        },
      ],
      { protectActiveTabId: 1 },
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].keep.id, 1);
    assert.deepEqual(
      plans[0].close.map((t) => t.id),
      [2],
    );
  });

  it('does not close pinned or audible peers when protect overrides keep', () => {
    const plans = planAutoCloseOlder(
      [
        {
          id: 1,
          url: 'https://dup.test/media',
          lastAccessed: 10,
          active: true,
          windowId: 1,
        },
        {
          id: 2,
          url: 'https://dup.test/media',
          lastAccessed: 9999,
          active: true,
          audible: true,
          windowId: 2,
        },
        {
          id: 3,
          url: 'https://dup.test/media',
          lastAccessed: 50,
          pinned: true,
          windowId: 3,
        },
        {
          id: 4,
          url: 'https://dup.test/media',
          lastAccessed: 20,
          windowId: 3,
        },
      ],
      { protectActiveTabId: 1 },
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].keep.id, 1);
    // Ordinary duplicate closes; audible + pinned stay open.
    assert.deepEqual(
      plans[0].close.map((t) => t.id).sort(),
      [4],
    );
  });
});

describe('maybeReclaim + tabActivity (switch-to-grouped regression)', () => {
  function makeTabsApi(initialTabs) {
    /** @type {Map<number, object>} */
    const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
    return {
      async query(queryInfo = {}) {
        let list = [...tabs.values()];
        if (queryInfo.active === true && typeof queryInfo.windowId === 'number') {
          list = list.filter((t) => t.active && t.windowId === queryInfo.windowId);
        }
        return list;
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`missing tab ${id}`);
        return t;
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error(`missing tab ${id}`);
        tabs.delete(id);
      },
      _tabs: tabs,
    };
  }

  it('does not reclaim a just-activated grouped tab with stale lastAccessed', async () => {
    const tabsApi = makeTabsApi([
      // Just switched to this grouped tab — chrome lastAccessed still stale.
      {
        id: 10,
        url: 'https://grouped.test/topic',
        lastAccessed: 1,
        active: true,
        windowId: 1,
        groupId: 42,
      },
      { id: 11, url: 'https://a.test/1', lastAccessed: 100, windowId: 1 },
      { id: 12, url: 'https://a.test/2', lastAccessed: 90, windowId: 1 },
      { id: 13, url: 'https://a.test/3', lastAccessed: 80, windowId: 1 },
    ]);
    const windowsApi = {
      async getLastFocused() {
        return { id: 1, focused: true };
      },
    };
    const activity = createTabActivityStore();
    activity.touch(10, Date.now());

    const store = new StackRecordStore(500);
    const result = await maybeReclaim({
      config: { maxOpenTabs: 2, stackSize: 500, autoStackEnabled: true },
      stackStore: store,
      closingTabIds: new Set(),
      tabsApi,
      windowsApi,
      tabActivity: activity,
      probeUnload: false,
      setOverflowPending: async () => {},
    });

    assert.equal(tabsApi._tabs.has(10), true);
    assert.equal(
      store.list().some((r) => r.url === 'https://grouped.test/topic'),
      false,
    );
    assert.ok((result.reclaimed ?? 0) >= 1);
  });
});
