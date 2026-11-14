import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { remainingStacksForReclassify } from '../background/grouping.js';

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
