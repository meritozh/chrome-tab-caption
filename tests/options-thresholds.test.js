import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../shared/constants.js';

/**
 * Mirrors options/options.js number parsing for thresholds (blank must not become 0).
 * @param {string} raw
 * @param {number} fallback
 */
function parseThreshold(raw, fallback) {
  const trimmed = String(raw ?? '').trim();
  const n = Number(trimmed);
  return trimmed !== '' && Number.isFinite(n) && n >= 1 ? n : fallback;
}

describe('threshold parsing', () => {
  it('falls back on blank, zero, and negative', () => {
    assert.equal(parseThreshold('', DEFAULT_CONFIG.maxOpenTabs), 50);
    assert.equal(parseThreshold('0', DEFAULT_CONFIG.topicCacheSize), 500);
    assert.equal(parseThreshold('-3', DEFAULT_CONFIG.topicCacheSize), 500);
  });

  it('accepts positive integers', () => {
    assert.equal(parseThreshold('40', DEFAULT_CONFIG.maxOpenTabs), 40);
  });
});
