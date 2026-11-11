import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopicCacheLru } from '../shared/topic-cache.js';
import { StackRecordStore, createStackRecord } from '../shared/stack-records.js';
import { runSearchQuery } from '../background/search.js';

describe('runSearchQuery', () => {
  it('searches open tabs via tabsApi stub and stacked records', async () => {
    const topicCache = new TopicCacheLru(10);
    topicCache.upsert({
      urlKey: 'https://news.example/cn',
      contentHash: 'abc',
      topicKey: 'cn-news',
      topicLabel: 'Chinese News',
    });

    const stackStore = new StackRecordStore(10);
    stackStore.push(
      createStackRecord({
        url: 'https://archive.example/old',
        title: '旧闻归档',
        topicLabel: 'Archives',
        lastAccessedAt: 50,
        reclaimedAt: 50,
      }),
    );

    const tabsApi = {
      async query() {
        return [
          {
            id: 7,
            windowId: 1,
            title: '今日头条',
            url: 'https://www.toutiao.com/a',
            lastAccessed: 200,
            favIconUrl: '',
          },
          {
            id: 8,
            windowId: 1,
            title: 'chrome internals',
            url: 'chrome://extensions',
            lastAccessed: 999,
          },
        ];
      },
    };

    const res = await runSearchQuery({
      query: 'jrtt',
      topicCache,
      stackStore,
      tabsApi,
      pinyinEnabled: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.stub, false);
    assert.equal(res.open.length, 1);
    assert.equal(res.open[0].tabId, 7);
    // chrome:// skipped
    assert.ok(!res.open.some((h) => h.url?.startsWith('chrome://')));

    const stacked = await runSearchQuery({
      query: '旧闻',
      topicCache,
      stackStore,
      tabsApi: { async query() { return []; } },
      pinyinEnabled: true,
    });
    assert.equal(stacked.stacked.length, 1);
    assert.ok(stacked.stacked[0].stackId);
  });

  it('returns empty partitions for blank query', async () => {
    const res = await runSearchQuery({
      query: '   ',
      topicCache: new TopicCacheLru(1),
      stackStore: new StackRecordStore(1),
      tabsApi: { async query() { return [{ id: 1, title: 'x', url: 'https://x.test' }]; } },
    });
    assert.deepEqual(res.open, []);
    assert.deepEqual(res.stacked, []);
  });
});
