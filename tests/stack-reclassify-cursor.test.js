import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingStacksForReclassify,
  stackReclassifyProgressCounts,
} from '../background/grouping.js';

describe('remainingStacksForReclassify', () => {
  it('skips already-processed ids and keeps remaining after list mutations', () => {
    const stacks = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    assert.deepEqual(
      remainingStacksForReclassify(stacks, ['a']).map((s) => s.id),
      ['b', 'c'],
    );

    // Newest-first mutation: drop a, prepend d — do not treat as complete.
    const mutated = [{ id: 'd' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(
      remainingStacksForReclassify(mutated, ['a', 'b']).map((s) => s.id),
      ['d', 'c'],
    );
  });

  it('is complete only when every current id was processed', () => {
    const stacks = [{ id: 'x' }, { id: 'y' }];
    assert.equal(remainingStacksForReclassify(stacks, ['x', 'y']).length, 0);
    // Positional “index past length” must NOT imply complete when ids remain.
    assert.equal(remainingStacksForReclassify(stacks, ['x']).length, 1);
    assert.equal(remainingStacksForReclassify([], ['x', 'y']).length, 0);
  });
});

describe('stackReclassifyProgressCounts', () => {
  it('counts only processed ids that still exist on the live list', () => {
    // processed has stale discarded ids — must not report 81/50 style drift.
    const live = Array.from({ length: 50 }, (_, i) => ({ id: `live-${i}` }));
    const processed = [
      ...live.slice(0, 10).map((s) => s.id),
      ...Array.from({ length: 70 }, (_, i) => `gone-${i}`),
    ];
    const counts = stackReclassifyProgressCounts(live, processed);
    assert.equal(counts.total, 50);
    assert.equal(counts.done, 10);
    assert.equal(counts.current, 11);
    assert.ok(counts.current <= counts.total);
  });

  it('reports current === total when all live ids are done', () => {
    const live = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(stackReclassifyProgressCounts(live, ['a', 'b', 'stale']), {
      done: 2,
      total: 2,
      current: 2,
    });
  });
});
