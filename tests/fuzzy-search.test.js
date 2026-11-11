import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuzzyScore,
  scoreDocument,
  searchDocuments,
  documentFromTab,
  documentFromStack,
  normalizeQuery,
} from '../shared/fuzzy-search.js';
import { textMatchesPinyin } from '../shared/pinyin.js';

describe('normalizeQuery / fuzzyScore', () => {
  it('scores exact and prefix higher than mid-string', () => {
    assert.ok(fuzzyScore('GitHub Issues', 'github issues') > fuzzyScore('GitHub Issues', 'issues'));
    assert.ok(fuzzyScore('abc', 'ab') > fuzzyScore('xabc', 'ab'));
    assert.equal(fuzzyScore('hello', 'zzz'), 0);
  });

  it('trims and lowercases queries', () => {
    assert.equal(normalizeQuery('  Foo '), 'foo');
  });
});

describe('pinyin', () => {
  it('matches full pinyin and initials', () => {
    assert.equal(textMatchesPinyin('北京大学', 'beijing'), true);
    assert.equal(textMatchesPinyin('北京大学', 'bjdx'), true);
    assert.equal(textMatchesPinyin('中国新闻', 'zg'), true);
    assert.equal(textMatchesPinyin('hello', 'zzzz'), false);
  });
});

describe('searchDocuments ranking', () => {
  it('partitions Open vs Stacked and ranks recency within match tier', () => {
    const docs = [
      documentFromTab(
        { id: 1, title: 'React docs', url: 'https://react.dev', lastAccessed: 100 },
        { topicLabel: 'Frontend' },
      ),
      documentFromTab(
        { id: 2, title: 'React blog', url: 'https://react.dev/blog', lastAccessed: 500 },
        { topicLabel: 'Frontend' },
      ),
      documentFromStack({
        id: 's1',
        title: 'React RFC',
        url: 'https://example.com/rfc',
        reclaimedAt: 400,
        topicLabel: 'Frontend',
      }),
      documentFromTab(
        { id: 3, title: 'Unrelated', url: 'https://example.com', lastAccessed: 999 },
      ),
    ].filter(Boolean);

    const { open, stacked } = searchDocuments(docs, 'react', { pinyinEnabled: true });
    assert.equal(open.length, 2);
    assert.equal(open[0].doc.tabId, 2); // newer lastAccessed first within tier
    assert.equal(open[1].doc.tabId, 1);
    assert.equal(stacked.length, 1);
    assert.equal(stacked[0].doc.stackId, 's1');
  });

  it('matches Chinese titles via pinyin when enabled', () => {
    const docs = [
      documentFromTab({
        id: 10,
        title: '今日头条科技频道',
        url: 'https://www.toutiao.com',
        lastAccessed: 1,
      }),
    ].filter(Boolean);

    const on = searchDocuments(docs, 'jrtt', { pinyinEnabled: true });
    assert.equal(on.open.length, 1);

    const off = searchDocuments(docs, 'jrtt', { pinyinEnabled: false });
    assert.equal(off.open.length, 0);
  });

  it('matches topicLabel field', () => {
    const docs = [
      documentFromTab(
        { id: 1, title: 'Page', url: 'https://a.test', lastAccessed: 1 },
        { topicLabel: 'Machine Learning' },
      ),
    ].filter(Boolean);
    const { open } = searchDocuments(docs, 'machine');
    assert.equal(open.length, 1);
    assert.ok(scoreDocument(docs[0], 'machine') > 0);
  });
});
