/**
 * Organize cancel semantics — pure helpers (generation token + honest status copy).
 * Cooperative cancel: checked between classify steps / before final group apply.
 */

/**
 * @typedef {object} OrganizeCancelStats
 * @property {number} [llmCallsAttempted] — requests already started (cannot be recalled)
 * @property {number} [classified] — successful classifications before cancel
 */

/**
 * Status text after Cancel. Never claim "no LLM calls" if any request was started.
 * @param {OrganizeCancelStats} [stats]
 * @returns {string}
 */
export function formatOrganizeCancelMessage(stats = {}) {
  const attempted = Math.max(0, Number(stats.llmCallsAttempted) || 0);
  const classified = Math.max(0, Number(stats.classified) || 0);
  if (attempted <= 0) {
    return 'Organize cancelled — no LLM calls.';
  }
  const callWord = attempted === 1 ? 'call' : 'calls';
  const classifiedNote =
    classified > 0 ? ` (${classified} classified before cancel)` : '';
  return `Organize cancelled — ${attempted} LLM ${callWord} already sent${classifiedNote}. Already-sent requests cannot be recalled.`;
}

/**
 * Whether an in-flight Confirm / GROUP_TABS completion should update the UI.
 * @param {object} opts
 * @param {number} opts.runId — id captured when Confirm started
 * @param {number} opts.activeRunId — current side-panel generation
 * @param {boolean} [opts.cancelRequested]
 * @returns {boolean}
 */
export function shouldApplyOrganizeCompletion(opts) {
  if (opts.cancelRequested) return false;
  if (opts.runId !== opts.activeRunId) return false;
  return true;
}

/**
 * Whether Cancel was only dismissing the privacy preview (no job started).
 * @param {'idle' | 'preview' | 'confirming' | 'running' | 'cancelling'} phase
 * @returns {boolean}
 */
export function isPreviewOnlyCancel(phase) {
  return phase === 'preview' || phase === 'idle';
}

/**
 * Cooperative checkpoint for groupTabsOnDemand.
 * @param {AbortSignal | null | undefined} signal
 * @param {OrganizeCancelStats & Record<string, unknown>} state
 * @returns {{ continue: true } | { continue: false, result: Record<string, unknown> }}
 */
export function organizeCancelCheckpoint(signal, state = {}) {
  if (!signal?.aborted) return { continue: true };
  const llmCallsAttempted = Math.max(0, Number(state.llmCallsAttempted) || 0);
  const classified = Math.max(0, Number(state.classified) || 0);
  const classifyErrors = Math.max(0, Number(state.classifyErrors) || 0);
  return {
    continue: false,
    result: {
      ok: false,
      cancelled: true,
      llmCallsAttempted,
      classified,
      classifyErrors,
      message: formatOrganizeCancelMessage({ llmCallsAttempted, classified }),
      logical: state.logical ?? [],
      assignments: state.assignments ?? [],
      physical: state.physical ?? { applied: 0, errors: [] },
      jobId: state.jobId,
      scope: state.scope,
      stub: false,
    },
  };
}
