import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPhysicalGroups,
  buildLogicalTopicViews,
  groupPlansByWindow,
  colorForTopicKey,
} from '../shared/physical-groups.js';

describe('physical / logical group helpers', () => {
  it('plans at most one physical group per window+topic', () => {
    const plans = planPhysicalGroups([
      { tabId: 1, windowId: 10, topicKey: 'news', topicLabel: 'News' },
      { tabId: 2, windowId: 10, topicKey: 'news', topicLabel: 'News' },
      { tabId: 3, windowId: 11, topicKey: 'news', topicLabel: 'News' },
      { tabId: 4, windowId: 10, topicKey: 'docs', topicLabel: 'Docs' },
    ]);
    assert.equal(plans.length, 3);
    const win10news = plans.find((p) => p.windowId === 10 && p.topicKey === 'news');
    assert.deepEqual(win10news.tabIds, [1, 2]);
  });

  it('builds cross-window logical views without merging windows physically', () => {
    const logical = buildLogicalTopicViews([
      { tabId: 1, windowId: 10, topicKey: 'news', topicLabel: 'News' },
      { tabId: 3, windowId: 11, topicKey: 'news', topicLabel: 'News' },
    ]);
    assert.equal(logical.length, 1);
    assert.deepEqual(logical[0].windowIds, [10, 11]);
    assert.deepEqual(logical[0].tabIds, [1, 3]);
  });

  it('groups plans by window', () => {
    const by = groupPlansByWindow(
      planPhysicalGroups([
        { tabId: 1, windowId: 1, topicKey: 'a', topicLabel: 'A' },
        { tabId: 2, windowId: 2, topicKey: 'a', topicLabel: 'A' },
      ]),
    );
    assert.equal(by.size, 2);
  });

  it('picks a stable chrome group color', () => {
    assert.equal(colorForTopicKey('news'), colorForTopicKey('news'));
    assert.ok(typeof colorForTopicKey('x') === 'string');
  });
});
