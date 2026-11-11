import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEligibleTab, isSkippableUrl, filterEligibleTabs } from '../shared/tab-eligibility.js';

describe('tab eligibility', () => {
  it('skips chrome and extension URLs', () => {
    assert.equal(isSkippableUrl('chrome://settings'), true);
    assert.equal(isSkippableUrl('chrome-extension://abc/x'), true);
    assert.equal(isSkippableUrl('devtools://devtools'), true);
    assert.equal(isSkippableUrl('https://example.com'), false);
  });

  it('skips pinned and missing ids', () => {
    assert.equal(isEligibleTab({ id: 1, url: 'https://a.test', pinned: true }), false);
    assert.equal(isEligibleTab({ url: 'https://a.test', pinned: false }), false);
    assert.equal(isEligibleTab({ id: 2, url: 'https://a.test', pinned: false }), true);
  });

  it('filters lists', () => {
    const out = filterEligibleTabs([
      { id: 1, url: 'chrome://newtab', pinned: false },
      { id: 2, url: 'https://ok.test', pinned: false },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 2);
  });
});
