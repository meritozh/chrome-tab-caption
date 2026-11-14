import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldScheduleReclaimAfterOrganize } from '../shared/organize-reclaim.js';

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

  it('schedules reclaim for plain Organize without merge payload', () => {
    assert.equal(shouldScheduleReclaimAfterOrganize({ ok: true }), true);
    assert.equal(shouldScheduleReclaimAfterOrganize({ ok: false, error: 'x' }), true);
  });
});
