import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_METRICS,
  mergeMetrics,
  utcDayKey,
  rollDailyWindow,
  canSpendLlmCall,
  remainingDailyLlmCalls,
  applyMetricsDelta,
  loadMetrics,
  persistMetrics,
  bumpMetrics,
} from '../shared/metrics.js';
import { STORAGE_KEYS } from '../shared/constants.js';

describe('local metrics + daily LLM quota', () => {
  it('merges defaults safely', () => {
    const m = mergeMetrics({ organizeRuns: 2, llmCalls: -3, dailyLlmDate: 12 });
    assert.equal(m.organizeRuns, 2);
    assert.equal(m.llmCalls, 0);
    assert.equal(m.dailyLlmDate, '');
    assert.equal(m.dedupeCloses, DEFAULT_METRICS.dedupeCloses);
  });

  it('rolls the UTC day window', () => {
    const yesterday = utcDayKey(Date.now() - 48 * 3600_000);
    const rolled = rollDailyWindow(
      mergeMetrics({ dailyLlmDate: yesterday, dailyLlmCalls: 9, llmCalls: 40 }),
    );
    assert.equal(rolled.dailyLlmDate, utcDayKey());
    assert.equal(rolled.dailyLlmCalls, 0);
    assert.equal(rolled.llmCalls, 40);
  });

  it('enforces optional daily quota (0 = unlimited)', () => {
    const m = mergeMetrics({ dailyLlmDate: utcDayKey(), dailyLlmCalls: 2 });
    assert.equal(canSpendLlmCall(m, 0), true);
    assert.equal(canSpendLlmCall(m, 2), false);
    assert.equal(canSpendLlmCall(m, 3), true);
    assert.equal(remainingDailyLlmCalls(m, 5), 3);
    assert.equal(remainingDailyLlmCalls(m, 0), Number.POSITIVE_INFINITY);
  });

  it('applies deltas and daily spend', () => {
    const next = applyMetricsDelta(mergeMetrics(null), {
      organizeRuns: 1,
      dedupeCloses: 2,
      spendDailyLlm: 3,
    });
    assert.equal(next.organizeRuns, 1);
    assert.equal(next.dedupeCloses, 2);
    assert.equal(next.llmCalls, 3);
    assert.equal(next.dailyLlmCalls, 3);
    assert.equal(next.dailyLlmDate, utcDayKey());
  });

  it('loads and persists via storage.local mock', async () => {
    /** @type {Record<string, unknown>} */
    const bag = {};
    const storage = {
      local: {
        async get(key) {
          const k = typeof key === 'string' ? key : key[0];
          return { [k]: bag[k] };
        },
        async set(obj) {
          Object.assign(bag, obj);
        },
      },
    };
    const loaded = await loadMetrics(storage);
    assert.equal(loaded.organizeRuns, 0);
    assert.equal(loaded.dailyLlmDate, utcDayKey()); // load rolls empty → today
    await persistMetrics(mergeMetrics({ reclaimCount: 4 }), storage);
    assert.equal(bag[STORAGE_KEYS.METRICS].reclaimCount, 4);
    const bumped = await bumpMetrics({ alarmResumes: 1 }, storage);
    assert.equal(bumped.alarmResumes, 1);
    assert.equal(bumped.reclaimCount, 4);
  });
});
