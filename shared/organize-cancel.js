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
 * Whether an in-flight Organize / GROUP_TABS completion should update the UI.
 * @param {object} opts
 * @param {number} opts.runId — id captured when Organize started
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
 * Whether a failed-boot settings-retry hydrate should idle/update this panel.
 * Matching runId always applies — even while busy (this retry set busy=true).
 * Superseded runId must not call setOrganizeIdle (avoids clobbering a newer Organize).
 * @param {object} opts
 * @param {number} opts.runId — id captured when the retry started
 * @param {number} opts.activeRunId — current side-panel generation
 * @returns {boolean}
 */
export function shouldApplySettingsRetryCompletion(opts) {
  return opts.runId === opts.activeRunId;
}

/**
 * Whether GET_CONFIG / storage payload should mark organizeConfigReady.
 * ok:false or missing config must leave not-ready so Organize can retry.
 * @param {unknown} config
 * @returns {boolean}
 */
export function shouldMarkOrganizeConfigReady(config) {
  return Boolean(config && typeof config === 'object');
}

/**
 * Whether Cancel is idle (no local Organize job from this panel).
 * May still target a known alarm-resume jobId.
 * @param {'idle' | 'permissions' | 'running' | 'cancelling' | string} phase
 * @returns {boolean}
 */
export function isIdleOrganizeCancel(phase) {
  return phase === 'idle';
}

/**
 * @deprecated Use isIdleOrganizeCancel — privacy preview Confirm was removed.
 * @param {string} phase
 * @returns {boolean}
 */
export function isPreviewOnlyCancel(phase) {
  return isIdleOrganizeCancel(phase) || phase === 'preview';
}

/**
 * Cooperative checkpoint for groupTabsOnDemand.
 * Pass a factory for `state` so expensive fields (e.g. logical views) are built only on abort.
 * @param {AbortSignal | null | undefined} signal
 * @param {(OrganizeCancelStats & Record<string, unknown>) | (() => OrganizeCancelStats & Record<string, unknown>)} [stateOrFactory]
 * @returns {{ continue: true } | { continue: false, result: Record<string, unknown> }}
 */
export function organizeCancelCheckpoint(signal, stateOrFactory = {}) {
  if (!signal?.aborted) return { continue: true };
  const state = typeof stateOrFactory === 'function' ? stateOrFactory() : stateOrFactory;
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
