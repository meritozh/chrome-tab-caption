import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnsavedUrl,
  tabLooksUnsaved,
  isReclaimCandidate,
  excessOpenCount,
  selectReclaimTargets,
  evaluateStackCapacity,
  slotsToFreeForOverflow,
  buildOverflowPending,
} from '../shared/reclaim-policy.js';

describe('reclaim exclusions', () => {
  it('flags unsaved / ephemeral URLs', () => {
    assert.equal(isUnsavedUrl(null), true);
    assert.equal(isUnsavedUrl('about:blank'), true);
    assert.equal(isUnsavedUrl('data:text/html,hi'), true);
    assert.equal(isUnsavedUrl('blob:https://x/1'), true);
    assert.equal(isUnsavedUrl('https://example.com'), false);
  });

  it('treats dirty-title markers as unsaved', () => {
    assert.equal(tabLooksUnsaved({ url: 'https://ok.test', title: '* Draft' }), true);
    assert.equal(tabLooksUnsaved({ url: 'https://ok.test', title: '• Notes' }), true);
    assert.equal(tabLooksUnsaved({ url: 'https://ok.test', title: 'Clean' }), false);
  });

  it('excludes pinned, audible, chrome URLs, and beforeunload-risk ids', () => {
    assert.equal(
      isReclaimCandidate({ id: 1, url: 'https://a.test', pinned: true }),
      false,
    );
    assert.equal(
      isReclaimCandidate({ id: 2, url: 'https://a.test', audible: true }),
      false,
    );
    assert.equal(
      isReclaimCandidate({ id: 3, url: 'chrome://settings' }),
      false,
    );
    assert.equal(
      isReclaimCandidate(
        { id: 4, url: 'https://a.test' },
        { beforeUnloadRiskIds: new Set([4]) },
      ),
      false,
    );
    assert.equal(isReclaimCandidate({ id: 5, url: 'https://a.test' }), true);
  });
});

describe('reclaim selection (least-recently-accessed)', () => {
  const tabs = [
    { id: 1, url: 'https://a.test/1', lastAccessed: 100, window: false },
    { id: 2, url: 'https://a.test/2', lastAccessed: 50, pinned: true },
    { id: 3, url: 'https://a.test/3', lastAccessed: 30, audible: true },
    { id: 4, url: 'https://a.test/4', lastAccessed: 10 },
    { id: 5, url: 'https://a.test/5', lastAccessed: 20, active: true },
    { id: 6, url: 'chrome://extensions', lastAccessed: 1 },
    { id: 7, url: 'about:blank', lastAccessed: 2 },
  ];

  it('computes excess against maxOpenTabs', () => {
    assert.equal(excessOpenCount(7, 50), 0);
    assert.equal(excessOpenCount(55, 50), 5);
    assert.equal(excessOpenCount(3, 3), 0);
  });

  it('picks oldest eligible tabs and allows current-window / active-window tabs', () => {
    // All tabs share one window implicitly — current window is reclaimable.
    const picked = selectReclaimTargets(tabs, { maxOpenTabs: 4 });
    // open=7, excess=3; eligible among non-excluded: 1(100), 4(10), 5(20)
    // pinned 2, audible 3, chrome 6, about:blank 7 excluded
    assert.deepEqual(
      picked.map((t) => t.id),
      [4, 5, 1],
    );
  });

  it('prefers keeping protectActiveTabId when alternatives exist', () => {
    const picked = selectReclaimTargets(tabs, {
      maxOpenTabs: 5,
      protectActiveTabId: 5,
    });
    // excess=2; without protect would be [4,5]; with protect → [4,1]
    assert.deepEqual(
      picked.map((t) => t.id),
      [4, 1],
    );
  });

  it('never reclaims the last remaining tab', () => {
    const one = [{ id: 9, url: 'https://only.test', lastAccessed: 1 }];
    assert.deepEqual(selectReclaimTargets(one, { maxOpenTabs: 1 }), []);
    const three = [
      { id: 1, url: 'https://a.test', lastAccessed: 1 },
      { id: 2, url: 'https://b.test', lastAccessed: 2 },
      { id: 3, url: 'https://c.test', lastAccessed: 3 },
    ];
    // excess=2 with maxOpenTabs=1 — still leaves one open tab
    const picked = selectReclaimTargets(three, { maxOpenTabs: 1 });
    assert.equal(picked.length, 2);
    assert.deepEqual(
      picked.map((t) => t.id),
      [1, 2],
    );
  });

  it('treats missing lastAccessed as recent (Chrome <121), not oldest', () => {
    const tabs = [
      { id: 1, url: 'https://a.test', lastAccessed: 10 },
      { id: 2, url: 'https://b.test' }, // missing — must not sort as 0
      { id: 3, url: 'https://c.test', lastAccessed: 20, active: true },
    ];
    const picked = selectReclaimTargets(tabs, {
      maxOpenTabs: 2,
      protectActiveTabId: 3,
    });
    assert.deepEqual(
      picked.map((t) => t.id),
      [1],
    );
  });
});

describe('stack overflow policy', () => {
  it('accepts when under capacity', () => {
    const r = evaluateStackCapacity({ size: 10, maxSize: 500, incoming: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.accept, 3);
    assert.equal(r.blocked, 0);
    assert.equal(r.needsUserAction, false);
  });

  it('blocks entirely at capacity (warn → export/discard)', () => {
    const r = evaluateStackCapacity({ size: 500, maxSize: 500, incoming: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.accept, 0);
    assert.equal(r.blocked, 2);
    assert.equal(r.needsUserAction, true);
    assert.equal(r.reason, 'at_capacity');
  });

  it('accepts partial fill then requires user action for the rest', () => {
    const r = evaluateStackCapacity({ size: 498, maxSize: 500, incoming: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.accept, 2);
    assert.equal(r.blocked, 3);
    assert.equal(r.needsUserAction, true);
    assert.equal(r.reason, 'partial');
  });

  it('computes discard/export slot count without double-counting shrink excess', () => {
    // Shrink: size 600, max 500 → free exactly 100 when incomingSlots=0
    assert.equal(slotsToFreeForOverflow({ size: 600, maxSize: 500, incomingSlots: 0 }), 100);
    // At capacity wanting 3 new reclaim slots
    assert.equal(slotsToFreeForOverflow({ size: 500, maxSize: 500, incomingSlots: 3 }), 3);
    assert.equal(slotsToFreeForOverflow({ size: 499, maxSize: 500, incomingSlots: 1 }), 0);
    assert.equal(slotsToFreeForOverflow({ size: 490, maxSize: 500, incomingSlots: 5 }), 0);
    // Shrink excess + 2 blocked reclaim → free 102 (not 200)
    assert.equal(slotsToFreeForOverflow({ size: 600, maxSize: 500, incomingSlots: 2 }), 102);
  });

  it('buildOverflowPending separates excess from blocked incoming', () => {
    const shrink = buildOverflowPending({
      size: 600,
      maxSize: 500,
      blockedIncoming: 0,
      reason: 'over_capacity',
    });
    assert.equal(shrink.excess, 100);
    assert.equal(shrink.blocked, 0);
    const reclaim = buildOverflowPending({
      size: 500,
      maxSize: 500,
      blockedIncoming: 3,
      reason: 'at_capacity',
    });
    assert.equal(reclaim.excess, 0);
    assert.equal(reclaim.blocked, 3);
  });
});
