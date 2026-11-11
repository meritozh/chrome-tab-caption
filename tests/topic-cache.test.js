import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopicCacheLru, capExcerpt } from '../shared/topic-cache.js';

describe('TopicCacheLru', () => {
  it('evicts oldest when over capacity', () => {
    const cache = new TopicCacheLru(2);
    cache.upsert({ urlKey: 'a', contentHash: '1', topicKey: 't1', topicLabel: 'T1' });
    cache.upsert({ urlKey: 'b', contentHash: '1', topicKey: 't2', topicLabel: 'T2' });
    cache.upsert({ urlKey: 'c', contentHash: '1', topicKey: 't3', topicLabel: 'T3' });
    assert.equal(cache.size, 2);
    assert.equal(cache.lookup('a', '1'), null);
    assert.ok(cache.lookup('b', '1'));
    assert.ok(cache.lookup('c', '1'));
  });

  it('caps excerpts', () => {
    assert.ok(capExcerpt('x'.repeat(400), 280).length <= 280);
  });
});
