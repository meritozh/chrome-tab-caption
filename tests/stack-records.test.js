import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StackRecordStore,
  createStackRecord,
  loadStackRecords,
  persistStackRecords,
} from '../shared/stack-records.js';
import { STORAGE_KEYS } from '../shared/constants.js';

function mockStorage(initial = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...initial };
  return {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: data[key] };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) out[k] = data[k];
          return out;
        }
        return { ...data };
      },
      async set(obj) {
        Object.assign(data, obj);
      },
      _data: data,
    },
  };
}

describe('StackRecordStore capacity', () => {
  it('tryPush refuses at maxSize without silent LRU', () => {
    const store = new StackRecordStore(2);
    assert.equal(store.tryPush(createStackRecord({ url: 'https://a.test', title: 'A' })).accepted, true);
    assert.equal(store.tryPush(createStackRecord({ url: 'https://b.test', title: 'B' })).accepted, true);
    const blocked = store.tryPush(createStackRecord({ url: 'https://c.test', title: 'C' }));
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.wouldOverflow, true);
    assert.equal(store.size, 2);
    assert.equal(store.list()[0].title, 'B');
  });

  it('discardOldest frees room for later tryPush', () => {
    const store = new StackRecordStore(2);
    store.tryPush(createStackRecord({ url: 'https://a.test', title: 'A', reclaimedAt: 1 }));
    store.tryPush(createStackRecord({ url: 'https://b.test', title: 'B', reclaimedAt: 2 }));
    const dropped = store.discardOldest(1);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].title, 'A');
    assert.equal(store.tryPush(createStackRecord({ url: 'https://c.test', title: 'C' })).accepted, true);
    assert.equal(store.size, 2);
  });

  it('exportJson can limit to oldest N', () => {
    const store = new StackRecordStore(10);
    store.tryPush(createStackRecord({ id: 'old', url: 'https://old.test', title: 'Old', reclaimedAt: 1 }));
    store.tryPush(createStackRecord({ id: 'new', url: 'https://new.test', title: 'New', reclaimedAt: 2 }));
    const payload = JSON.parse(store.exportJson({ oldestOnly: 1 }));
    assert.equal(payload.stacks.length, 1);
    assert.equal(payload.stacks[0].id, 'old');
  });

  it('persists and hydrates via chrome.storage.local', async () => {
    const storage = mockStorage();
    const store = new StackRecordStore(5);
    store.tryPush(
      createStackRecord({
        url: 'https://persist.test',
        title: 'Persist',
        groupTitle: 'Docs',
        groupColor: 'blue',
        topicKey: 'docs',
        topicLabel: 'Docs',
      }),
    );
    await persistStackRecords(store, storage);
    const loaded = await loadStackRecords(5, storage);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.list()[0].groupTitle, 'Docs');
    assert.ok(storage.local._data[STORAGE_KEYS.STACK_RECORDS]);
  });

  it('hydrate keeps over-capacity records (no silent discard)', async () => {
    const storage = mockStorage({
      [STORAGE_KEYS.STACK_RECORDS]: {
        maxSize: 10,
        records: [
          createStackRecord({ id: 'a', url: 'https://a.test', title: 'A' }),
          createStackRecord({ id: 'b', url: 'https://b.test', title: 'B' }),
          createStackRecord({ id: 'c', url: 'https://c.test', title: 'C' }),
        ],
      },
    });
    const loaded = await loadStackRecords(1, storage);
    assert.equal(loaded.maxSize, 1);
    assert.equal(loaded.size, 3);
  });
});
