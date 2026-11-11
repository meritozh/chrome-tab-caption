import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlKey } from '../shared/url-normalize.js';

describe('normalizeUrlKey', () => {
  it('strips hash and tracking params but keeps other query', () => {
    const key = normalizeUrlKey(
      'https://example.com/path?id=42&utm_source=x&gclid=1#section',
    );
    assert.equal(key, 'https://example.com/path?id=42');
  });

  it('returns empty string for invalid URLs', () => {
    assert.equal(normalizeUrlKey('not a url'), '');
  });
});
