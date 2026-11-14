import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortByLastAccessedDesc,
  partitionKeepAndReclaim,
  selectTargetWindowId,
  planSingleWindowGroups,
  stackMetaFromAssignment,
  isSingleWindowMergeScope,
} from '../shared/window-merge.js';
import {
  moveTabsToWindow,
  reorderTabsInWindow,
  closeEmptyWindows,
  finalizeSingleWindowOrganize,
} from '../background/window-merge.js';
import { StackRecordStore } from '../shared/stack-records.js';

describe('window-merge pure helpers', () => {
  it('sorts by lastAccessed descending (unknown age stays recent)', () => {
    const sorted = sortByLastAccessedDesc([
      { id: 1, lastAccessed: 10 },
      { id: 2, lastAccessed: 50 },
      { id: 3 },
    ]);
    assert.deepEqual(
      sorted.map((t) => t.id),
      [3, 2, 1],
    );
  });

  it('keeps top maxOpenTabs and reclaim targets from excess only', () => {
    const tabs = [
      { id: 1, url: 'https://a.test/1', lastAccessed: 100, windowId: 1 },
      { id: 2, url: 'https://a.test/2', lastAccessed: 80, windowId: 1 },
      { id: 3, url: 'https://a.test/3', lastAccessed: 60, windowId: 2 },
      { id: 4, url: 'https://a.test/4', lastAccessed: 40, windowId: 2 },
      { id: 5, url: 'https://a.test/5', lastAccessed: 20, pinned: true, windowId: 2 },
    ];
    const { kept, reclaimTargets } = partitionKeepAndReclaim(tabs, { maxOpenTabs: 2 });
    assert.deepEqual(
      kept.map((t) => t.id),
      [1, 2],
    );
    // 3,4 excess reclaimable; 5 excess but pinned → not reclaimed
    assert.deepEqual(
      reclaimTargets.map((t) => t.id).sort(),
      [3, 4],
    );
  });

  it('forces protectActiveTabId into keep-set even with stale lastAccessed', () => {
    const tabs = [
      { id: 1, url: 'https://a.test/1', lastAccessed: 100, windowId: 1 },
      { id: 2, url: 'https://a.test/2', lastAccessed: 80, windowId: 1 },
      { id: 9, url: 'https://grouped.test', lastAccessed: 1, windowId: 1, active: true },
    ];
    const { kept, reclaimTargets } = partitionKeepAndReclaim(tabs, {
      maxOpenTabs: 2,
      protectActiveTabId: 9,
    });
    assert.ok(kept.some((t) => t.id === 9));
    assert.equal(reclaimTargets.some((t) => t.id === 9), false);
  });

  it('selects focused window, else preferred, else most tabs', () => {
    const windows = [
      { id: 10 },
      { id: 20, focused: true },
      { id: 30 },
    ];
    const tabs = [
      { windowId: 10 },
      { windowId: 10 },
      { windowId: 10 },
      { windowId: 30 },
    ];
    assert.equal(selectTargetWindowId(windows, tabs), 20);
    assert.equal(
      selectTargetWindowId(
        [
          { id: 10 },
          { id: 30 },
        ],
        tabs,
        { preferredWindowId: 30 },
      ),
      30,
    );
    assert.equal(
      selectTargetWindowId(
        [
          { id: 10 },
          { id: 30 },
        ],
        tabs,
      ),
      10,
    );
  });

  it('plans at most one physical group per topic in the target window', () => {
    const plans = planSingleWindowGroups(
      [
        { tabId: 1, windowId: 10, topicKey: 'news', topicLabel: 'News' },
        { tabId: 2, windowId: 11, topicKey: 'news', topicLabel: 'News' },
        { tabId: 3, windowId: 10, topicKey: 'docs', topicLabel: 'Docs' },
      ],
      99,
    );
    assert.equal(plans.length, 2);
    const news = plans.find((p) => p.topicKey === 'news');
    assert.equal(news.windowId, 99);
    assert.deepEqual(news.tabIds, [1, 2]);
  });

  it('builds stack metadata from assignment + fallback', () => {
    const meta = stackMetaFromAssignment(
      { topicKey: 'news', topicLabel: 'News' },
      { groupTitle: 'Old', groupColor: 'blue' },
    );
    assert.equal(meta.topicKey, 'news');
    assert.equal(meta.groupTitle, 'Old');
    assert.equal(meta.groupColor, 'blue');
  });

  it('treats single-window-merge and superseded cross-window-logical as merge', () => {
    assert.equal(isSingleWindowMergeScope({}), true);
    assert.equal(isSingleWindowMergeScope({ groupScope: 'single-window-merge' }), true);
    assert.equal(isSingleWindowMergeScope({ groupScope: 'cross-window-logical' }), true);
    assert.equal(isSingleWindowMergeScope({ groupScope: 'per-window' }), false);
  });
});

function makeChromeMock(initial) {
  /** @type {Map<number, object>} */
  const tabs = new Map(initial.tabs.map((t) => [t.id, { ...t }]));
  /** @type {Map<number, object>} */
  const windows = new Map(initial.windows.map((w) => [w.id, { ...w }]));
  return {
    tabs: {
      async query(query = {}) {
        let list = [...tabs.values()];
        if (typeof query.windowId === 'number') {
          list = list.filter((t) => t.windowId === query.windowId);
        }
        return list;
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`missing tab ${id}`);
        return { ...t };
      },
      async move(tabId, props) {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`missing tab ${tabId}`);
        if (typeof props.windowId === 'number') t.windowId = props.windowId;
        return { ...t };
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error(`missing tab ${id}`);
        tabs.delete(id);
      },
      _map: tabs,
    },
    windows: {
      async getAll() {
        return [...windows.values()];
      },
      async remove(id) {
        if (!windows.has(id)) throw new Error(`missing window ${id}`);
        windows.delete(id);
      },
      _map: windows,
    },
  };
}

describe('window-merge chrome helpers (mocked)', () => {
  it('moves tabs across windows fail-soft', async () => {
    const api = makeChromeMock({
      windows: [{ id: 1 }, { id: 2 }],
      tabs: [
        { id: 10, windowId: 1, url: 'https://a.test', lastAccessed: 2 },
        { id: 11, windowId: 2, url: 'https://b.test', lastAccessed: 1 },
      ],
    });
    const result = await moveTabsToWindow([10, 11, 999], 1, api.tabs);
    assert.deepEqual(result.moved, [10, 11]);
    assert.equal(api.tabs._map.get(11).windowId, 1);
    assert.ok(result.errors.some((e) => e.includes('999')));
  });

  it('closes empty windows but keeps target', async () => {
    const api = makeChromeMock({
      windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      tabs: [{ id: 10, windowId: 1, url: 'https://a.test' }],
    });
    const result = await closeEmptyWindows(1, api.windows, api.tabs);
    assert.deepEqual(result.closed.sort(), [2, 3]);
    assert.ok(api.windows._map.has(1));
  });

  it('finalize reclaim excess with topic then merges to one window', async () => {
    const api = makeChromeMock({
      windows: [
        { id: 1, focused: true },
        { id: 2 },
      ],
      tabs: [
        { id: 1, url: 'https://a.test/1', lastAccessed: 100, windowId: 1, title: 'A' },
        { id: 2, url: 'https://a.test/2', lastAccessed: 90, windowId: 1, title: 'B' },
        { id: 3, url: 'https://a.test/3', lastAccessed: 10, windowId: 2, title: 'C' },
        { id: 4, url: 'https://a.test/4', lastAccessed: 5, windowId: 2, title: 'D' },
      ],
    });
    const store = new StackRecordStore(500);
    /** @type {Set<number>} */
    const closingTabIds = new Set();
    const summary = await finalizeSingleWindowOrganize({
      assignments: [
        { tabId: 1, windowId: 1, topicKey: 'news', topicLabel: 'News' },
        { tabId: 2, windowId: 1, topicKey: 'news', topicLabel: 'News' },
        { tabId: 3, windowId: 2, topicKey: 'docs', topicLabel: 'Docs' },
        { tabId: 4, windowId: 2, topicKey: 'docs', topicLabel: 'Docs' },
      ],
      config: {
        maxOpenTabs: 2,
        topicCacheSize: 500,
        autoStackEnabled: true,
        autoDedupeEnabled: false,
        groupScope: 'single-window-merge',
      },
      stackStore: store,
      closingTabIds,
      tabsApi: api.tabs,
      windowsApi: api.windows,
      probeUnload: false,
    });

    assert.equal(summary.reclaimed, 2);
    assert.equal(store.size, 2);
    assert.ok(store.list().every((r) => r.topicKey === 'docs'));
    assert.equal(summary.targetWindowId, 1);
    assert.equal(api.tabs._map.size, 2);
    assert.ok([...api.tabs._map.values()].every((t) => t.windowId === 1));
    assert.equal(api.windows._map.has(2), false);
    assert.equal(summary.plans.length, 1);
    assert.equal(summary.plans[0].topicKey, 'news');
    assert.equal(summary.plans[0].windowId, 1);
  });

  it('reorderTabsInWindow is fail-soft on missing tabs', async () => {
    const api = makeChromeMock({
      windows: [{ id: 1 }],
      tabs: [{ id: 1, windowId: 1, url: 'https://a.test' }],
    });
    const out = await reorderTabsInWindow([1, 99], 1, api.tabs);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => e.includes('99')));
  });
});
