import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StackRecordStore } from '../shared/stack-records.js';
import { maybeReclaim, exportOrDiscardStacks, recallStack } from '../background/stacks.js';

function makeTabsApi(initialTabs) {
  /** @type {Map<number, object>} */
  const tabs = new Map(initialTabs.map((t) => [t.id, { ...t }]));
  let nextId = Math.max(0, ...tabs.keys()) + 1;
  return {
    async query() {
      return [...tabs.values()];
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error(`missing tab ${id}`);
      tabs.delete(id);
    },
    async create(props) {
      const id = nextId++;
      const tab = {
        id,
        url: props.url,
        windowId: props.windowId ?? 1,
        active: props.active !== false,
        title: props.url,
      };
      tabs.set(id, tab);
      return tab;
    },
    _tabs: tabs,
  };
}

describe('maybeReclaim integration (mocked tabs)', () => {
  it('reclaims excess tabs into StackRecords and marks suppressClosed', async () => {
    const tabsApi = makeTabsApi([
      { id: 1, url: 'https://a.test/1', lastAccessed: 100, window: false, windowId: 1 },
      { id: 2, url: 'https://a.test/2', lastAccessed: 50, pinned: false, windowId: 1 },
      { id: 3, url: 'https://a.test/3', lastAccessed: 10, pinned: false, windowId: 1, active: true },
      { id: 4, url: 'https://a.test/4', lastAccessed: 5, pinned: false, windowId: 1 },
    ]);
    const store = new StackRecordStore(500);
    /** @type {Set<number>} */
    const closingTabIds = new Set();
    const result = await maybeReclaim({
      config: { maxOpenTabs: 2, stackSize: 500, autoStackEnabled: true },
      stackStore: store,
      closingTabIds,
      tabsApi,
      probeUnload: false,
      setOverflowPending: async () => {},
    });

    assert.equal(result.stub, false);
    assert.equal(result.reclaimed, 2);
    assert.equal(store.size, 2);
    // Least-recent: 4 then 2 (3 is active protected; 1 is newer)
    assert.deepEqual(
      store.list().map((r) => r.url).sort(),
      ['https://a.test/2', 'https://a.test/4'].sort(),
    );
    assert.equal(tabsApi._tabs.size, 2);
    // suppressClosed: ids were registered during close (cleared by SW onRemoved in prod)
    assert.ok(closingTabIds.has(4) || closingTabIds.has(2));
  });

  it('pauses reclaim and reports overflow when stack is full', async () => {
    const tabsApi = makeTabsApi([
      { id: 1, url: 'https://a.test/1', lastAccessed: 1, windowId: 1 },
      { id: 2, url: 'https://a.test/2', lastAccessed: 2, windowId: 1 },
      { id: 3, url: 'https://a.test/3', lastAccessed: 3, windowId: 1 },
    ]);
    const store = new StackRecordStore(1);
    store.tryPush({
      id: 'existing',
      url: 'https://old.test',
      title: 'Old',
      reclaimedAt: 1,
      lastAccessedAt: 1,
    });
    /** @type {object | null} */
    let pending = null;
    const result = await maybeReclaim({
      config: { maxOpenTabs: 1, stackSize: 1, autoStackEnabled: true },
      stackStore: store,
      closingTabIds: new Set(),
      tabsApi,
      probeUnload: false,
      overflowPending: null,
      setOverflowPending: async (p) => {
        pending = p;
      },
    });
    assert.equal(result.reclaimed, 0);
    assert.equal(result.overflow, true);
    assert.equal(pending?.needsUserAction, true);
    assert.equal(store.size, 1);
    assert.equal(tabsApi._tabs.size, 3);
  });

  it('export frees oldest records and clears overflow pending', async () => {
    const store = new StackRecordStore(2);
    store.tryPush({
      id: 'a',
      url: 'https://a.test',
      title: 'A',
      reclaimedAt: 1,
      lastAccessedAt: 1,
    });
    store.tryPush({
      id: 'b',
      url: 'https://b.test',
      title: 'B',
      reclaimedAt: 2,
      lastAccessedAt: 2,
    });
    let pending = {
      needsUserAction: true,
      excess: 0,
      blocked: 1,
      reason: 'at_capacity',
    };
    const result = await exportOrDiscardStacks({
      action: 'export',
      stackStore: store,
      overflowPending: pending,
      setOverflowPending: async (p) => {
        pending = p;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.discarded, 1);
    assert.ok(typeof result.exportJson === 'string');
    assert.match(result.exportJson, /https:\/\/a\.test/);
    assert.equal(pending, null);
    assert.equal(store.size, 1);
  });

  it('refuses export/discard when overflow gate is already cleared', async () => {
    const store = new StackRecordStore(2);
    store.tryPush({
      id: 'a',
      url: 'https://a.test',
      title: 'A',
      reclaimedAt: 1,
      lastAccessedAt: 1,
    });
    store.tryPush({
      id: 'b',
      url: 'https://b.test',
      title: 'B',
      reclaimedAt: 2,
      lastAccessedAt: 2,
    });
    const result = await exportOrDiscardStacks({
      action: 'discard',
      stackStore: store,
      overflowPending: null,
    });
    assert.equal(result.ok, false);
    assert.equal(store.size, 2);
  });

  it('shrink overflow discards only the excess (not 2x)', async () => {
    const store = new StackRecordStore(2);
    // Force over capacity the way SET_CONFIG shrink does (push then lower maxSize).
    store.push({
      id: 'a',
      url: 'https://a.test',
      title: 'A',
      reclaimedAt: 1,
      lastAccessedAt: 1,
    });
    store.push({
      id: 'b',
      url: 'https://b.test',
      title: 'B',
      reclaimedAt: 2,
      lastAccessedAt: 2,
    });
    store.push({
      id: 'c',
      url: 'https://c.test',
      title: 'C',
      reclaimedAt: 3,
      lastAccessedAt: 3,
    });
    store.maxSize = 2;
    assert.equal(store.size, 3);
    let pending = {
      needsUserAction: true,
      reason: 'over_capacity',
      excess: 1,
      blocked: 0,
    };
    const result = await exportOrDiscardStacks({
      action: 'discard',
      stackStore: store,
      overflowPending: pending,
      setOverflowPending: async (p) => {
        pending = p;
      },
    });
    assert.equal(result.discarded, 1);
    assert.equal(store.size, 2);
    assert.equal(pending, null);
  });

  it('recallStack creates a tab and removes the record', async () => {
    const store = new StackRecordStore(10);
    store.tryPush({
      id: 'stack_1',
      url: 'https://recall.test/page',
      title: 'Recall me',
      groupTitle: 'Research',
      groupColor: 'blue',
      topicKey: 'research',
      topicLabel: 'Research',
      reclaimedAt: 10,
      lastAccessedAt: 10,
      windowIdHint: 1,
    });
    const tabsApi = makeTabsApi([]);
    // tabGroups unavailable in node — restoreGroupMetadata fails soft
    const result = await recallStack('stack_1', { stackStore: store, tabsApi, windowId: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.tabId != null, true);
    assert.equal(store.getById('stack_1'), null);
    assert.equal(tabsApi._tabs.get(result.tabId)?.url, 'https://recall.test/page');
  });
});
