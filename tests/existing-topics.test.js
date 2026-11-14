import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existingTopicsForClassify } from '../background/grouping.js';

describe('existingTopicsForClassify', () => {
  it('merges seed labels with registry labels and de-dupes', () => {
    const registry = new Map([
      ['docs', { label: 'Docs' }],
      ['news', { label: 'News' }],
    ]);
    assert.deepEqual(existingTopicsForClassify(registry, ['Docs', 'Sports']), [
      'Docs',
      'Sports',
      'News',
    ]);
  });
});
