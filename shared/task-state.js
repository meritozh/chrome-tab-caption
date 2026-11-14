/**
 * Organize job state machine (ADR Phase 7 / §8).
 * Persist checkpoints so MV3 SW sleep can resume via chrome.alarms.
 * Pure helpers — storage I/O stays in the service worker.
 */

/** Terminal / non-resumable phases. */
export const JOB_PHASES = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  QUICK_PASS: 'quick-pass',
  QUICK_PASS_APPLIED: 'quick-pass-applied',
  REFINE: 'refine',
  APPLYING: 'applying',
  DONE: 'done',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
});

const RESUMABLE = new Set([
  JOB_PHASES.QUEUED,
  JOB_PHASES.QUICK_PASS,
  JOB_PHASES.QUICK_PASS_APPLIED,
  JOB_PHASES.REFINE,
  JOB_PHASES.APPLYING,
  JOB_PHASES.INTERRUPTED,
]);

const TERMINAL = new Set([
  JOB_PHASES.DONE,
  JOB_PHASES.CANCELLED,
  JOB_PHASES.TIMEOUT,
  JOB_PHASES.ERROR,
  JOB_PHASES.IDLE,
]);

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   url: string,
 *   title: string,
 *   urlKey: string,
 *   contentHash: string,
 * }} RefineQueueItem
 *
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   topicKey: string,
 *   topicLabel: string,
 * }} CheckpointAssignment
 *
 * @typedef {{
 *   jobId: string,
 *   phase: string,
 *   scope: 'all' | 'current',
 *   confirmed: boolean,
 *   clientRunId: number | null,
 *   currentWindowId: number | null,
 *   startedAt: number,
 *   updatedAt: number,
 *   deadlineAt: number,
 *   total: number,
 *   refineIndex: number,
 *   refineQueue: RefineQueueItem[],
 *   assignments: CheckpointAssignment[],
 *   llmCallsAttempted: number,
 *   classified: number,
 *   classifyErrors: number,
 *   resumeCount: number,
 *   reorganize: boolean,
 *   clearCache: boolean,
 *   bypassCache: boolean,
 *   reclassifyStacks: boolean,
 *   stacksDone: boolean,
 *   stackIndex: number,
 * }} OrganizeCheckpoint
 */

/**
 * @param {Partial<OrganizeCheckpoint> & { jobId: string }} partial
 * @returns {OrganizeCheckpoint}
 */
export function createOrganizeCheckpoint(partial) {
  const now = Date.now();
  const reorganize = partial.reorganize === true;
  return {
    jobId: String(partial.jobId),
    phase: partial.phase || JOB_PHASES.QUEUED,
    scope: partial.scope === 'current' ? 'current' : 'all',
    confirmed: partial.confirmed !== false,
    clientRunId: typeof partial.clientRunId === 'number' ? partial.clientRunId : null,
    currentWindowId:
      typeof partial.currentWindowId === 'number' ? partial.currentWindowId : null,
    startedAt: partial.startedAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    deadlineAt: partial.deadlineAt ?? now + 60_000,
    total: Math.max(0, Number(partial.total) || 0),
    refineIndex: Math.max(0, Number(partial.refineIndex) || 0),
    refineQueue: Array.isArray(partial.refineQueue) ? partial.refineQueue.slice() : [],
    assignments: Array.isArray(partial.assignments) ? partial.assignments.slice() : [],
    llmCallsAttempted: Math.max(0, Number(partial.llmCallsAttempted) || 0),
    classified: Math.max(0, Number(partial.classified) || 0),
    classifyErrors: Math.max(0, Number(partial.classifyErrors) || 0),
    resumeCount: Math.max(0, Number(partial.resumeCount) || 0),
    reorganize,
    clearCache: partial.clearCache === true || reorganize,
    bypassCache: partial.bypassCache === true || reorganize,
    reclassifyStacks: partial.reclassifyStacks === true || reorganize,
    stacksDone: partial.stacksDone === true,
    /** Next stack index to process (resume cursor for reclassifyAllStacks). */
    stackIndex: Math.max(0, Number(partial.stackIndex) || 0),
  };
}

/**
 * @param {unknown} value
 * @returns {value is OrganizeCheckpoint}
 */
export function isOrganizeCheckpoint(value) {
  if (!value || typeof value !== 'object') return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  return typeof c.jobId === 'string' && typeof c.phase === 'string';
}

/**
 * @param {string | undefined | null} phase
 */
export function isResumablePhase(phase) {
  return RESUMABLE.has(String(phase || ''));
}

/**
 * @param {string | undefined | null} phase
 */
export function isTerminalPhase(phase) {
  return TERMINAL.has(String(phase || ''));
}

/**
 * Remaining refine items (not yet processed).
 * @param {OrganizeCheckpoint} checkpoint
 */
export function remainingRefineItems(checkpoint) {
  const idx = Math.max(0, Number(checkpoint.refineIndex) || 0);
  const queue = Array.isArray(checkpoint.refineQueue) ? checkpoint.refineQueue : [];
  return queue.slice(idx);
}

/**
 * Reorganize still owes a stack reclassify pass (or a partial pass to finish).
 * @param {OrganizeCheckpoint | null | undefined} checkpoint
 */
export function hasPendingStackReclassify(checkpoint) {
  if (!isOrganizeCheckpoint(checkpoint)) return false;
  return checkpoint.reclassifyStacks === true && checkpoint.stacksDone !== true;
}

/**
 * @param {OrganizeCheckpoint} checkpoint
 * @param {string} phase
 * @param {Partial<OrganizeCheckpoint>} [patch]
 */
export function advancePhase(checkpoint, phase, patch = {}) {
  return createOrganizeCheckpoint({
    ...checkpoint,
    ...patch,
    phase,
    updatedAt: Date.now(),
  });
}

/**
 * Mark a running job interrupted so alarm / SW restart can resume.
 * @param {OrganizeCheckpoint} checkpoint
 */
export function markInterrupted(checkpoint) {
  if (isTerminalPhase(checkpoint.phase)) return checkpoint;
  return advancePhase(checkpoint, JOB_PHASES.INTERRUPTED);
}

/**
 * After a successful alarm-driven resume kickoff.
 * @param {OrganizeCheckpoint} checkpoint
 */
export function bumpResumeCount(checkpoint) {
  return createOrganizeCheckpoint({
    ...checkpoint,
    resumeCount: (checkpoint.resumeCount || 0) + 1,
    phase:
      checkpoint.phase === JOB_PHASES.INTERRUPTED
        ? JOB_PHASES.REFINE
        : checkpoint.phase,
    updatedAt: Date.now(),
  });
}

/**
 * Record one refine-queue step completion.
 * @param {OrganizeCheckpoint} checkpoint
 * @param {{
 *   assignment?: CheckpointAssignment | null,
 *   llmCallsAttempted?: number,
 *   classified?: number,
 *   classifyErrors?: number,
 * }} step
 */
export function recordRefineStep(checkpoint, step = {}) {
  const nextIndex = Math.min(
    (checkpoint.refineIndex || 0) + 1,
    (checkpoint.refineQueue || []).length,
  );
  const assignments = Array.isArray(checkpoint.assignments)
    ? checkpoint.assignments.slice()
    : [];
  if (step.assignment) assignments.push(step.assignment);
  return createOrganizeCheckpoint({
    ...checkpoint,
    phase: JOB_PHASES.REFINE,
    refineIndex: nextIndex,
    assignments,
    llmCallsAttempted:
      step.llmCallsAttempted != null
        ? step.llmCallsAttempted
        : checkpoint.llmCallsAttempted,
    classified: step.classified != null ? step.classified : checkpoint.classified,
    classifyErrors:
      step.classifyErrors != null ? step.classifyErrors : checkpoint.classifyErrors,
    updatedAt: Date.now(),
  });
}

/**
 * UI / JOB_STATE broadcast payload.
 * @param {OrganizeCheckpoint | null | undefined} checkpoint
 */
export function summarizeJobState(checkpoint) {
  if (!isOrganizeCheckpoint(checkpoint)) {
    return {
      phase: JOB_PHASES.IDLE,
      resumable: false,
      alarmResume: false,
      active: false,
      remaining: 0,
      jobId: null,
      clientRunId: null,
    };
  }
  const remaining = remainingRefineItems(checkpoint).length;
  const stacksPending = hasPendingStackReclassify(checkpoint);
  const resumeCount = Math.max(0, Number(checkpoint.resumeCount) || 0);
  return {
    jobId: checkpoint.jobId,
    phase: checkpoint.phase,
    scope: checkpoint.scope,
    clientRunId: checkpoint.clientRunId,
    resumable:
      isResumablePhase(checkpoint.phase) && (remaining > 0 || stacksPending),
    stacksPending,
    stackIndex: Math.max(0, Number(checkpoint.stackIndex) || 0),
    /**
     * True only for alarm/SW-sleep continuation — not a normal in-progress Organize.
     * Side Panel must adopt UI only when this is set (avoid hijacking an in-flight Organize).
     */
    alarmResume:
      resumeCount > 0 || checkpoint.phase === JOB_PHASES.INTERRUPTED,
    /** True when the SW is actively refining (including alarm resume). */
    active: !isTerminalPhase(checkpoint.phase) && checkpoint.phase !== JOB_PHASES.IDLE,
    remaining,
    total: checkpoint.total,
    refineIndex: checkpoint.refineIndex,
    llmCallsAttempted: checkpoint.llmCallsAttempted,
    classified: checkpoint.classified,
    classifyErrors: checkpoint.classifyErrors,
    resumeCount,
    updatedAt: checkpoint.updatedAt,
    deadlineAt: checkpoint.deadlineAt,
  };
}
