import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTopicKey,
  formatTopicLabel,
  mergeTopicResult,
  findSynonymMergeTarget,
  heuristicTopicsAreSynonyms,
  collectSynonymKeys,
} from '../shared/topic-normalize.js';

describe('topic normalize + synonym merge', () => {
  it('normalizes labels to stable keys', () => {
    assert.equal(normalizeTopicKey('  Machine-Learning!! '), 'machine learning');
    assert.equal(normalizeTopicKey("OpenAI's API"), 'openais api');
  });

  it('keeps English seed labels distinct in keys', () => {
    assert.equal(
      normalizeTopicKey('Open Source · AI / Agents'),
      'open source ai agents',
    );
    assert.equal(
      normalizeTopicKey('Reading · AI / Agents'),
      'reading ai agents',
    );
    assert.notEqual(
      normalizeTopicKey('Open Source · AI / Agents'),
      normalizeTopicKey('Reading · AI / Agents'),
    );
  });

  it('formats English display labels', () => {
    assert.equal(formatTopicLabel('machine learning'), 'Machine Learning');
    assert.equal(formatTopicLabel('guides for react'), 'Guides for React');
  });

  it('preserves acronyms in English seed-style labels', () => {
    assert.equal(
      formatTopicLabel('Open Source · AI / Agents'),
      'Open Source · AI / Agents',
    );
    assert.equal(formatTopicLabel('AI Agents'), 'AI Agents');
  });

  it('merges synonyms into the same normalizedKey', () => {
    const registry = new Map();
    const a = mergeTopicResult({ topic: 'Machine Learning', synonyms: ['ML'] }, registry);
    const b = mergeTopicResult({ topic: 'ML', synonyms: ['machine learning'] }, registry);
    assert.equal(a.normalizedKey, b.normalizedKey);
    assert.equal(registry.size, 1);
    assert.ok(collectSynonymKeys('ML', ['machine learning']).includes('machine learning'));
  });

  it('finds synonym merge targets bidirectionally', () => {
    const existing = [
      { normalizedKey: 'react docs', label: 'React Docs', synonymKeys: ['react documentation'] },
    ];
    const hit = findSynonymMergeTarget('React Documentation', [], existing);
    assert.ok(hit);
    assert.equal(hit.normalizedKey, 'react docs');
  });

  it('heuristic synonym detect for plurals', () => {
    assert.equal(heuristicTopicsAreSynonyms('Blog Post', 'Blog Posts'), true);
    assert.equal(heuristicTopicsAreSynonyms('Cats', 'Dogs'), false);
  });
});
