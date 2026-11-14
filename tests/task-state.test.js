import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_PHASES,
  createOrganizeCheckpoint,
  isOrganizeCheckpoint,
  isResumablePhase,
  isTerminalPhase,
  remainingRefineItems,
  hasPendingStackReclassify,
  advancePhase,
  markInterrupted,
  bumpResumeCount,
  recordRefineStep,
  summarizeJobState,
} from '../shared/task-state.js';

describe('organize task state machine', () => {
  it('creates a normalized checkpoint', () => {
    const cp = createOrganizeCheckpoint({
      jobId: 'group-1',
      scope: 'current',
      refineQueue: [{ tabId: 1, windowId: 1, url: 'https://a', title: 'A', urlKey: 'https://a', contentHash: 'h' }],
    });
    assert.equal(cp.jobId, 'group-1');
    assert.equal(cp.scope, 'current');
    assert.equal(cp.phase, JOB_PHASES.QUEUED);
    assert.equal(cp.refineQueue.length, 1);
    assert.equal(cp.confirmed, true);
    assert.equal(cp.reorganize, false);
    assert.equal(cp.reclassifyStacks, false);
    assert.equal(cp.stacksDone, false);
  });

  it('persists Reorganize flags for alarm resume', () => {
    const cp = createOrganizeCheckpoint({
      jobId: 'reorg-1',
      reorganize: true,
      stacksDone: false,
      processedStackIds: [],
    });
    assert.equal(cp.reorganize, true);
    assert.equal(cp.clearCache, true);
    assert.equal(cp.bypassCache, true);
    assert.equal(cp.reclassifyStacks, true);
    assert.deepEqual(cp.processedStackIds, []);
    assert.equal(hasPendingStackReclassify(cp), true);
    const advanced = advancePhase(cp, JOB_PHASES.REFINE, {
      stacksDone: true,
      processedStackIds: ['s1', 's2'],
    });
    assert.equal(advanced.reorganize, true);
    assert.equal(advanced.reclassifyStacks, true);
    assert.equal(advanced.stacksDone, true);
    assert.deepEqual(advanced.processedStackIds, ['s1', 's2']);
    assert.equal(hasPendingStackReclassify(advanced), false);
  });

  it('summarizes stacks-pending resume when refine queue is empty', () => {
    const cp = createOrganizeCheckpoint({
      jobId: 'reorg-2',
      phase: JOB_PHASES.REFINE,
      reorganize: true,
      refineQueue: [],
      refineIndex: 0,
      stacksDone: false,
      processedStackIds: ['a', 'b'],
      resumeCount: 1,
    });
    const summary = summarizeJobState(cp);
    assert.equal(summary.remaining, 0);
    assert.equal(summary.stacksPending, true);
    assert.deepEqual(summary.processedStackIds, ['a', 'b']);
    assert.equal(summary.resumable, true);
    assert.equal(summary.alarmResume, true);
  });

  it('advances processedStackIds without marking stacksDone', () => {
    const cp = createOrganizeCheckpoint({
      jobId: 'reorg-cursor',
      phase: JOB_PHASES.REFINE,
      reorganize: true,
      processedStackIds: [],
      stacksDone: false,
    });
    const mid = advancePhase(cp, JOB_PHASES.INTERRUPTED, {
      processedStackIds: ['s1', 's2'],
      stacksDone: false,
    });
    assert.deepEqual(mid.processedStackIds, ['s1', 's2']);
    assert.equal(mid.stacksDone, false);
    assert.equal(hasPendingStackReclassify(mid), true);
  });

  it('classifies resumable vs terminal phases', () => {
    assert.equal(isResumablePhase(JOB_PHASES.REFINE), true);
    assert.equal(isResumablePhase(JOB_PHASES.INTERRUPTED), true);
    assert.equal(isResumablePhase(JOB_PHASES.DONE), false);
    assert.equal(isTerminalPhase(JOB_PHASES.CANCELLED), true);
    assert.equal(isTerminalPhase(JOB_PHASES.REFINE), false);
  });

  it('tracks remaining refine items and step progress', () => {
    let cp = createOrganizeCheckpoint({
      jobId: 'g',
      phase: JOB_PHASES.REFINE,
      refineQueue: [
        { tabId: 1, windowId: 1, url: 'https://a', title: 'A', urlKey: 'a', contentHash: '1' },
        { tabId: 2, windowId: 1, url: 'https://b', title: 'B', urlKey: 'b', contentHash: '2' },
      ],
      refineIndex: 0,
    });
    assert.equal(remainingRefineItems(cp).length, 2);
    cp = recordRefineStep(cp, {
      assignment: { tabId: 1, windowId: 1, topicKey: 'news', topicLabel: 'News' },
      classified: 1,
      llmCallsAttempted: 1,
    });
    assert.equal(cp.refineIndex, 1);
    assert.equal(remainingRefineItems(cp).length, 1);
    assert.equal(cp.assignments.length, 1);
    assert.equal(cp.classified, 1);
  });

  it('marks interrupted and bumps resume count', () => {
    const base = createOrganizeCheckpoint({
      jobId: 'g',
      phase: JOB_PHASES.REFINE,
      refineQueue: [{ tabId: 1, windowId: 1, url: 'u', title: 't', urlKey: 'u', contentHash: 'h' }],
    });
    const interrupted = markInterrupted(base);
    assert.equal(interrupted.phase, JOB_PHASES.INTERRUPTED);
    const resumed = bumpResumeCount(interrupted);
    assert.equal(resumed.resumeCount, 1);
    assert.equal(resumed.phase, JOB_PHASES.REFINE);
    assert.equal(isOrganizeCheckpoint(resumed), true);
  });

  it('summarizes job state for UI', () => {
    const idle = summarizeJobState(null);
    assert.equal(idle.phase, JOB_PHASES.IDLE);
    assert.equal(idle.resumable, false);
    assert.equal(idle.alarmResume, false);

    const cp = advancePhase(
      createOrganizeCheckpoint({
        jobId: 'g2',
        refineQueue: [{ tabId: 9, windowId: 1, url: 'u', title: 't', urlKey: 'u', contentHash: 'h' }],
        refineIndex: 0,
      }),
      JOB_PHASES.REFINE,
    );
    const summary = summarizeJobState(cp);
    assert.equal(summary.resumable, true);
    assert.equal(summary.active, true);
    assert.equal(summary.alarmResume, false); // normal refine is not alarm resume
    assert.equal(summary.remaining, 1);
    assert.equal(summary.jobId, 'g2');

    const resumed = summarizeJobState(
      createOrganizeCheckpoint({ ...cp, resumeCount: 1, phase: JOB_PHASES.REFINE }),
    );
    assert.equal(resumed.alarmResume, true);
  });
});
