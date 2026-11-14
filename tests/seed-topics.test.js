import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../shared/config.js';
import { DEFAULT_CONFIG, DEFAULT_SEED_TOPICS } from '../shared/constants.js';
import {
  buildSeedCandidateTopics,
  normalizeSeedTopics,
  seedTopicsToText,
} from '../shared/seed-topics.js';
import { heuristicTopicsAreSynonyms } from '../shared/topic-normalize.js';

describe('seed topics', () => {
  it('defaults to English domain taxonomy (no Other)', () => {
    assert.equal(DEFAULT_SEED_TOPICS.length, 9);
    assert.ok(DEFAULT_SEED_TOPICS.includes('Open Source · AI / Agents'));
    assert.ok(DEFAULT_SEED_TOPICS.includes('Shopping & Life'));
    assert.equal(
      DEFAULT_SEED_TOPICS.some((t) => /其他|other/i.test(t)),
      false,
    );
    assert.equal(
      DEFAULT_SEED_TOPICS.some((t) => /[\u3400-\u9fff]/.test(t)),
      false,
    );
    assert.deepEqual(DEFAULT_CONFIG.seedTopics, [...DEFAULT_SEED_TOPICS]);
  });

  it('normalizes arrays and textarea lines; empty stays empty', () => {
    assert.deepEqual(normalizeSeedTopics(null), [...DEFAULT_SEED_TOPICS]);
    assert.deepEqual(normalizeSeedTopics([' Video ', 'Video', 'Shopping & Life']), [
      'Video',
      'Shopping & Life',
    ]);
    assert.deepEqual(normalizeSeedTopics('Video\n\nShopping & Life\n'), [
      'Video',
      'Shopping & Life',
    ]);
    assert.deepEqual(normalizeSeedTopics([]), []);
    assert.deepEqual(normalizeSeedTopics(''), []);
  });

  it('mergeConfig keeps custom seeds and allows clearing', () => {
    const custom = mergeConfig({
      seedTopics: ['Video', 'Reading · AI / Agents'],
    });
    assert.deepEqual(custom.seedTopics, ['Video', 'Reading · AI / Agents']);
    const cleared = mergeConfig({ seedTopics: [] });
    assert.deepEqual(cleared.seedTopics, []);
    const fromDefault = mergeConfig({ maxOpenTabs: 10 });
    assert.deepEqual(fromDefault.seedTopics, [...DEFAULT_SEED_TOPICS]);
  });

  it('buildSeedCandidateTopics: Organize = groups then seeds; Reorganize = seeds only', () => {
    const seeds = ['Open Source · AI / Agents', 'Video'];
    assert.deepEqual(
      buildSeedCandidateTopics({
        seedTopics: seeds,
        existingGroupLabels: ['Docs', 'Video'],
        reorganize: false,
      }),
      ['Docs', 'Video', 'Open Source · AI / Agents'],
    );
    assert.deepEqual(
      buildSeedCandidateTopics({
        seedTopics: seeds,
        existingGroupLabels: ['Docs', 'Video'],
        reorganize: true,
      }),
      ['Open Source · AI / Agents', 'Video'],
    );
  });

  it('seedTopicsToText is one-per-line', () => {
    assert.equal(
      seedTopicsToText(['Video', 'Shopping & Life']),
      'Video\nShopping & Life',
    );
  });

  it('default seeds stay distinct from each other and from parent prefixes', () => {
    const parents = [
      'Open Source',
      'Reading',
      'Shopping',
      'Social',
      'Video',
    ];
    for (let i = 0; i < DEFAULT_SEED_TOPICS.length; i++) {
      for (let j = i + 1; j < DEFAULT_SEED_TOPICS.length; j++) {
        assert.equal(
          heuristicTopicsAreSynonyms(DEFAULT_SEED_TOPICS[i], DEFAULT_SEED_TOPICS[j]),
          false,
          `${DEFAULT_SEED_TOPICS[i]} vs ${DEFAULT_SEED_TOPICS[j]}`,
        );
      }
      for (const parent of parents) {
        if (parent === DEFAULT_SEED_TOPICS[i]) continue;
        assert.equal(
          heuristicTopicsAreSynonyms(parent, DEFAULT_SEED_TOPICS[i]),
          false,
          `${parent} vs ${DEFAULT_SEED_TOPICS[i]}`,
        );
      }
    }
  });
});
