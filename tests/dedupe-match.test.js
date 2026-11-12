import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  survivorScore,
  isDedupeCandidate,
  groupTabsByNormalizedUrl,
  planAutoCloseOlder,
} from '../shared/dedupe-match.js';

describe('survivorScore', () => {
  it('ranks active > audible > pinned > lastAccessed', () => {
    const base = { lastAccessed: 100 };
    assert.ok(survivorScore({ ...base, active: true }) > survivorScore({ ...base, audible: true }));
    assert.ok(survivorScore({ ...base, audible: true }) > survivorScore({ ...base, pinned: true }));
    assert.ok(survivorScore({ ...base, pinned: true }) > survivorScore({ ...base, lastAccessed: 999 }));
    assert.ok(survivorScore({ lastAccessed: 200 }) > survivorScore({ lastAccessed: 100 }));
  });
});

describe('isDedupeCandidate', () => {
  it('rejects skippable URLs, missing ids, closingTabIds, and unsaved tabs', () => {
    assert.equal(isDedupeCandidate({ id: 1, url: 'chrome://newtab' }, null), false);
    assert.equal(isDedupeCandidate({ url: 'https://a.test' }, null), false);
    assert.equal(isDedupeCandidate({ id: 1, url: 'https://a.test' }, new Set([1])), false);
    assert.equal(isDedupeCandidate({ id: 1, url: 'https://a.test' }, new Set()), true);
    assert.equal(
      isDedupeCandidate({ id: 2, url: 'https://a.test', title: '* Draft' }, null),
      false,
    );
    assert.equal(
      isDedupeCandidate({ id: 3, url: 'about:blank' }, null),
      false,
    );
  });
});

describe('groupTabsByNormalizedUrl / planAutoCloseOlder', () => {
  it('treats cross-window same normalized URL as duplicates', () => {
    const tabs = [
      {
        id: 1,
        windowId: 10,
        url: 'https://example.com/x?id=1&utm_source=a#h',
        lastAccessed: 10,
      },
      {
        id: 2,
        windowId: 20,
        url: 'https://example.com/x?id=1&gclid=zzz',
        lastAccessed: 50,
        active: true,
      },
      { id: 3, windowId: 10, url: 'https://other.test/', lastAccessed: 99 },
    ];
    const groups = groupTabsByNormalizedUrl(tabs);
    assert.equal(groups.get('https://example.com/x?id=1')?.length, 2);
    assert.equal(groups.size, 2);

    const plans = planAutoCloseOlder(tabs);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].keep.id, 2); // active wins
    assert.deepEqual(
      plans[0].close.map((t) => t.id),
      [1],
    );
  });

  it('prefers pinned over older lastAccessed when neither is active', () => {
    const plans = planAutoCloseOlder([
      { id: 1, url: 'https://a.test/p', pinned: true, lastAccessed: 1 },
      { id: 2, url: 'https://a.test/p', pinned: false, lastAccessed: 999 },
    ]);
    assert.equal(plans[0].keep.id, 1);
    assert.equal(plans[0].close[0].id, 2);
  });

  it('skips tabs already in closingTabIds', () => {
    const plans = planAutoCloseOlder(
      [
        { id: 1, url: 'https://a.test', lastAccessed: 1 },
        { id: 2, url: 'https://a.test', lastAccessed: 2 },
      ],
      { closingTabIds: new Set([1]) },
    );
    assert.equal(plans.length, 0);
  });

  it('collapses same-window exact URL copies (ADR inclusive of cross-window)', () => {
    // ADR §5.4: "跨 window 算重复" means cross-window counts — same-window still dedupes.
    const plans = planAutoCloseOlder([
      { id: 1, windowId: 1, url: 'https://a.test/x', lastAccessed: 1 },
      { id: 2, windowId: 1, url: 'https://a.test/x', lastAccessed: 9, active: true },
    ]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].keep.id, 2);
    assert.equal(plans[0].close[0].id, 1);
  });

  it('does not plan closes when the only peer looks unsaved', () => {
    const plans = planAutoCloseOlder([
      { id: 1, windowId: 1, url: 'https://a.test/x', title: '* Edit', lastAccessed: 1 },
      { id: 2, windowId: 2, url: 'https://a.test/x', lastAccessed: 9, active: true },
    ]);
    assert.equal(plans.length, 0);
  });
});
