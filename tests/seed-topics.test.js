import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../shared/config.js';
import { DEFAULT_CONFIG, DEFAULT_SEED_TOPICS } from '../shared/constants.js';
import {
  buildSeedCandidateTopics,
  normalizeSeedTopics,
  seedTopicsToText,
} from '../shared/seed-topics.js';

describe('seed topics', () => {
  it('defaults to the confirmed domain taxonomy (no Other)', () => {
    assert.equal(DEFAULT_SEED_TOPICS.length, 9);
    assert.ok(DEFAULT_SEED_TOPICS.includes('开源 · AI / Agents'));
    assert.ok(DEFAULT_SEED_TOPICS.includes('购物与生活'));
    assert.equal(
      DEFAULT_SEED_TOPICS.some((t) => /其他|other/i.test(t)),
      false,
    );
    assert.deepEqual(DEFAULT_CONFIG.seedTopics, [...DEFAULT_SEED_TOPICS]);
  });

  it('normalizes arrays and textarea lines; empty stays empty', () => {
    assert.deepEqual(normalizeSeedTopics(null), [...DEFAULT_SEED_TOPICS]);
    assert.deepEqual(normalizeSeedTopics([' 视频 ', '视频', '购物与生活']), [
      '视频',
      '购物与生活',
    ]);
    assert.deepEqual(normalizeSeedTopics('视频\n\n购物与生活\n'), [
      '视频',
      '购物与生活',
    ]);
    assert.deepEqual(normalizeSeedTopics([]), []);
    assert.deepEqual(normalizeSeedTopics(''), []);
  });

  it('mergeConfig keeps custom seeds and allows clearing', () => {
    const custom = mergeConfig({ seedTopics: ['视频', '阅读 · AI / Agents'] });
    assert.deepEqual(custom.seedTopics, ['视频', '阅读 · AI / Agents']);
    const cleared = mergeConfig({ seedTopics: [] });
    assert.deepEqual(cleared.seedTopics, []);
    const fromDefault = mergeConfig({ maxOpenTabs: 10 });
    assert.deepEqual(fromDefault.seedTopics, [...DEFAULT_SEED_TOPICS]);
  });

  it('buildSeedCandidateTopics: Organize = groups then seeds; Reorganize = seeds only', () => {
    const seeds = ['开源 · AI / Agents', '视频'];
    assert.deepEqual(
      buildSeedCandidateTopics({
        seedTopics: seeds,
        existingGroupLabels: ['Docs', '视频'],
        reorganize: false,
      }),
      ['Docs', '视频', '开源 · AI / Agents'],
    );
    assert.deepEqual(
      buildSeedCandidateTopics({
        seedTopics: seeds,
        existingGroupLabels: ['Docs', '视频'],
        reorganize: true,
      }),
      ['开源 · AI / Agents', '视频'],
    );
  });

  it('seedTopicsToText is one-per-line', () => {
    assert.equal(
      seedTopicsToText(['视频', '购物与生活']),
      '视频\n购物与生活',
    );
  });
});
