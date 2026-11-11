import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TopicCacheLru,
  loadTopicCache,
  persistTopicCache,
  mergeTopicCacheEntries,
} from '../shared/topic-cache.js';
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

describe('topic cache hydrate / merge', () => {
  it('persists and loads urlKey+contentHash LRU', async () => {
    const storage = mockStorage();
    const cache = new TopicCacheLru(3);
    cache.upsert({
      urlKey: 'https://a.test/x',
      contentHash: 'h1',
      topicKey: 'alpha',
      topicLabel: 'Alpha',
      excerpt: 'hello',
    });
    await persistTopicCache(cache, storage);
    const loaded = await loadTopicCache(3, storage);
    assert.equal(loaded.size, 1);
    const hit = loaded.lookup('https://a.test/x', 'h1');
    assert.ok(hit);
    assert.equal(hit.topicKey, 'alpha');
    assert.ok(storage.local._data[STORAGE_KEYS.TOPIC_CACHE]);
  });

  it('merges entries and peeks without bumping hits', () => {
    const target = new TopicCacheLru(10);
    const source = new TopicCacheLru(10);
    source.upsert({
      urlKey: 'https://b.test',
      contentHash: 'c',
      topicKey: 'beta',
      topicLabel: 'Beta',
    });
    mergeTopicCacheEntries(target, source);
    assert.equal(target.size, 1);
    const peeked = target.peek('https://b.test', 'c');
    assert.equal(peeked?.hitCount, 1);
    const looked = target.lookup('https://b.test', 'c');
    assert.equal(looked?.hitCount, 2);
  });

  it('fromJSON round-trips and evicts to maxSize', () => {
    const raw = {
      maxSize: 1,
      entries: [
        {
          urlKey: 'u1',
          contentHash: 'h',
          topicKey: 't1',
          topicLabel: 'T1',
          createdAt: 1,
          lastHitAt: 1,
          hitCount: 1,
        },
        {
          urlKey: 'u2',
          contentHash: 'h',
          topicKey: 't2',
          topicLabel: 'T2',
          createdAt: 2,
          lastHitAt: 2,
          hitCount: 1,
        },
      ],
    };
    const cache = TopicCacheLru.fromJSON(raw);
    assert.equal(cache.size, 1);
  });
});
