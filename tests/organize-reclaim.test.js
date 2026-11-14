import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldScheduleReclaimAfterOrganize,
  shouldRunBrowseTimeReclaim,
} from '../shared/organize-reclaim.js';

describe('shouldScheduleReclaimAfterOrganize', () => {
  it('skips reclaim after successful single-window merge', () => {
    assert.equal(
      shouldScheduleReclaimAfterOrganize({ ok: true, merge: { reclaimed: 2 } }),
      false,
    );
  });

  it('skips reclaim on interrupted stack reclassify (no merge yet)', () => {
    assert.equal(
      shouldScheduleReclaimAfterOrganize({
        ok: false,
        timeout: true,
        stacksPending: true,
        merge: null,
      }),
      false,
    );
    assert.equal(
      shouldScheduleReclaimAfterOrganize({
        ok: false,
        stacksPending: true,
        merge: { reclaimed: 1 },
      }),
      false,
    );
  });

  it('schedules reclaim only for successful Organize without merge payload', () => {
    assert.equal(shouldScheduleReclaimAfterOrganize({ ok: true }), true);
    // Failed Organize must not reclaim — maxOpenTabs is Organize-success-only.
    assert.equal(shouldScheduleReclaimAfterOrganize({ ok: false, error: 'x' }), false);
    assert.equal(shouldScheduleReclaimAfterOrganize(null), false);
  });
});

describe('browse-time reclaim gate', () => {
  it('never allows maxOpenTabs reclaim outside Organize', () => {
    assert.equal(shouldRunBrowseTimeReclaim(), false);
  });
});
