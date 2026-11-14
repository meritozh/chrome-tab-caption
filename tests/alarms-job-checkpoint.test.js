import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALARM_NAMES,
  ORGANIZE_RESUME_PERIOD_MINUTES,
  ensureOrganizeResumeAlarm,
  clearOrganizeResumeAlarm,
  ensureMaintainAlarm,
  clearMaintainAlarm,
} from '../shared/alarms.js';
import {
  createOrganizeCheckpoint,
  JOB_PHASES,
} from '../shared/task-state.js';
import {
  loadOrganizeCheckpoint,
  saveOrganizeCheckpoint,
  interruptOrganizeCheckpoint,
  shouldResumeCheckpoint,
  remainingRefineItems,
  ORGANIZE_RESUME_MAX_AGE_MS,
} from '../background/job-checkpoint.js';
import { SESSION_KEYS } from '../shared/constants.js';

describe('alarm helpers', () => {
  it('exposes stable alarm names and period', () => {
    assert.equal(ALARM_NAMES.MAINTAIN, 'tab-caption-maintain');
    assert.equal(ALARM_NAMES.ORGANIZE_RESUME, 'tab-caption-organize-resume');
    assert.ok(ORGANIZE_RESUME_PERIOD_MINUTES >= 0.5);
  });

  it('creates and clears organize resume alarm via mock', async () => {
    /** @type {Record<string, unknown>} */
    const created = {};
    const alarms = {
      async create(name, info) {
        created[name] = info;
      },
      async clear(name) {
        const had = name in created;
        delete created[name];
        return had;
      },
    };
    assert.equal(await ensureOrganizeResumeAlarm(alarms), true);
    assert.deepEqual(created[ALARM_NAMES.ORGANIZE_RESUME], {
      periodInMinutes: ORGANIZE_RESUME_PERIOD_MINUTES,
    });
    assert.equal(await clearOrganizeResumeAlarm(alarms), true);
    assert.equal(ALARM_NAMES.ORGANIZE_RESUME in created, false);
    assert.equal(await ensureMaintainAlarm(alarms), true);
    assert.equal(created[ALARM_NAMES.MAINTAIN].periodInMinutes, 1);
    // Product: organize-only reclaim — SW clears this legacy alarm on start.
    assert.equal(await clearMaintainAlarm(alarms), true);
    assert.equal(ALARM_NAMES.MAINTAIN in created, false);
  });
});

describe('organize checkpoint persistence', () => {
  function mockSession() {
    /** @type {Record<string, unknown>} */
    const bag = {};
    return {
      storage: {
        session: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            /** @type {Record<string, unknown>} */
            const out = {};
            for (const k of list) out[k] = bag[k];
            return out;
          },
          async set(obj) {
            Object.assign(bag, obj);
          },
          async remove(key) {
            delete bag[key];
          },
        },
      },
      bag,
    };
  }

  it('round-trips checkpoint and marks interrupted', async () => {
    const { storage, bag } = mockSession();
    const cp = createOrganizeCheckpoint({
      jobId: 'job-9',
      phase: JOB_PHASES.REFINE,
      confirmed: true,
      refineQueue: [
        { tabId: 3, windowId: 1, url: 'https://x', title: 'X', urlKey: 'https://x', contentHash: 'h' },
      ],
      refineIndex: 0,
    });
    await saveOrganizeCheckpoint(cp, storage);
    assert.equal(bag[SESSION_KEYS.ORGANIZE_CHECKPOINT].jobId, 'job-9');
    const loaded = await loadOrganizeCheckpoint(storage);
    assert.equal(loaded?.jobId, 'job-9');
    assert.equal(shouldResumeCheckpoint(loaded), true);

    const interrupted = await interruptOrganizeCheckpoint(storage);
    assert.equal(interrupted?.phase, JOB_PHASES.INTERRUPTED);
    assert.equal(shouldResumeCheckpoint(interrupted), true);

    await saveOrganizeCheckpoint(null, storage);
    assert.equal(await loadOrganizeCheckpoint(storage), null);
  });

  it('rejects stale or empty checkpoints for resume', () => {
    assert.equal(shouldResumeCheckpoint(null), false);
    assert.equal(
      shouldResumeCheckpoint(
        createOrganizeCheckpoint({
          jobId: 'done',
          phase: JOB_PHASES.DONE,
          refineQueue: [{ tabId: 1, windowId: 1, url: 'u', title: 't', urlKey: 'u', contentHash: 'h' }],
        }),
      ),
      false,
    );
    assert.equal(
      shouldResumeCheckpoint(
        createOrganizeCheckpoint({
          jobId: 'empty',
          phase: JOB_PHASES.REFINE,
          refineQueue: [],
        }),
      ),
      false,
    );
    const ancient = createOrganizeCheckpoint({
      jobId: 'old',
      phase: JOB_PHASES.REFINE,
      startedAt: Date.now() - 31 * 60_000,
      refineQueue: [{ tabId: 1, windowId: 1, url: 'u', title: 't', urlKey: 'u', contentHash: 'h' }],
    });
    assert.equal(shouldResumeCheckpoint(ancient), false);
  });

  it('resumes when refine is empty but stack reclassify is still pending', () => {
    const stacksPending = createOrganizeCheckpoint({
      jobId: 'reorg-stacks',
      phase: JOB_PHASES.REFINE,
      reorganize: true,
      refineQueue: [
        { tabId: 1, windowId: 1, url: 'u', title: 't', urlKey: 'u', contentHash: 'h' },
      ],
      refineIndex: 1, // all tabs classified
      stacksDone: false,
      processedStackIds: ['s1', 's2'],
    });
    assert.equal(remainingRefineItems(stacksPending).length, 0);
    assert.deepEqual(stacksPending.processedStackIds, ['s1', 's2']);
    assert.equal(shouldResumeCheckpoint(stacksPending), true);

    const stacksDone = createOrganizeCheckpoint({
      ...stacksPending,
      stacksDone: true,
    });
    assert.equal(shouldResumeCheckpoint(stacksDone), false);
  });

  it('keeps stacks-pending resume alive via updatedAt despite old startedAt', () => {
    const now = Date.now();
    const staleStart = createOrganizeCheckpoint({
      jobId: 'reorg-long',
      phase: JOB_PHASES.INTERRUPTED,
      reorganize: true,
      refineQueue: [],
      stacksDone: false,
      processedStackIds: ['s1'],
      startedAt: now - ORGANIZE_RESUME_MAX_AGE_MS - 60_000,
      updatedAt: now - 5_000,
    });
    assert.equal(shouldResumeCheckpoint(staleStart, now), true);

    const idleTooLong = createOrganizeCheckpoint({
      ...staleStart,
      updatedAt: now - ORGANIZE_RESUME_MAX_AGE_MS - 1,
    });
    assert.equal(shouldResumeCheckpoint(idleTooLong, now), false);
  });
});
