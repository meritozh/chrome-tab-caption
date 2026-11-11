import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suppressClosedRemove } from '../shared/suppress-closed.js';

describe('suppressClosedRemove', () => {
  it('marks closingTabIds before remove and keeps mark on success', async () => {
    const tabs = new Map([[1, { id: 1 }]]);
    const closing = new Set();
    const tabsApi = {
      async remove(id) {
        if (!tabs.has(id)) throw new Error('gone');
        tabs.delete(id);
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error('gone');
        return tabs.get(id);
      },
    };
    const result = await suppressClosedRemove(1, closing, tabsApi);
    assert.equal(result.ok, true);
    assert.equal(result.suppressClosed, true);
    assert.ok(closing.has(1));
    assert.equal(tabs.size, 0);
  });

  it('unmarks only when the tab is still open after failure', async () => {
    const tabs = new Map([[1, { id: 1 }]]);
    const closing = new Set();
    const tabsApi = {
      async remove() {
        throw new Error('denied');
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error('gone');
        return tabs.get(id);
      },
    };
    const result = await suppressClosedRemove(1, closing, tabsApi);
    assert.equal(result.ok, false);
    assert.equal(closing.has(1), false);
  });

  it('treats already-closed peer race as suppressClosed success without unmarking', async () => {
    const closing = new Set();
    const tabsApi = {
      async remove() {
        throw new Error('No tab with id: 7');
      },
      async get() {
        throw new Error('No tab with id: 7');
      },
    };
    const result = await suppressClosedRemove(7, closing, tabsApi);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyClosed, true);
    assert.ok(closing.has(7));
  });
});
