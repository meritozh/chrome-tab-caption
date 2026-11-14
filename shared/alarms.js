/**
 * chrome.alarms names + helpers (ADR Phase 7 — MV3 SW resume).
 * Minimum period is ~0.5 minutes in Chrome.
 */

export const ALARM_NAMES = Object.freeze({
  /**
   * Legacy periodic reclaim alarm (pre organize-only reclaim).
   * No longer created; cleared on SW start so old installs stop waking for reclaim.
   */
  MAINTAIN: 'tab-caption-maintain',
  /** Wake SW to continue an interrupted Organize refine queue. */
  ORGANIZE_RESUME: 'tab-caption-organize-resume',
});

/** ~30s — Chrome's practical minimum for periodInMinutes. */
export const ORGANIZE_RESUME_PERIOD_MINUTES = 0.5;

/**
 * Schedule (or refresh) the organize-resume alarm while a job is active.
 * @param {typeof chrome.alarms | undefined} alarms
 */
export async function ensureOrganizeResumeAlarm(alarms = globalThis.chrome?.alarms) {
  if (!alarms?.create) return false;
  try {
    await alarms.create(ALARM_NAMES.ORGANIZE_RESUME, {
      periodInMinutes: ORGANIZE_RESUME_PERIOD_MINUTES,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear resume alarm when the job reaches a terminal phase.
 * @param {typeof chrome.alarms | undefined} alarms
 */
export async function clearOrganizeResumeAlarm(alarms = globalThis.chrome?.alarms) {
  if (!alarms?.clear) return false;
  try {
    return Boolean(await alarms.clear(ALARM_NAMES.ORGANIZE_RESUME));
  } catch {
    return false;
  }
}

/**
 * @deprecated maxOpenTabs reclaim is Organize-only — do not create this alarm.
 * Kept for tests that assert the legacy name / create path.
 * @param {typeof chrome.alarms | undefined} alarms
 */
export async function ensureMaintainAlarm(alarms = globalThis.chrome?.alarms) {
  if (!alarms?.create) return false;
  try {
    await alarms.create(ALARM_NAMES.MAINTAIN, { periodInMinutes: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the legacy maintain/reclaim alarm (idempotent).
 * @param {typeof chrome.alarms | undefined} alarms
 */
export async function clearMaintainAlarm(alarms = globalThis.chrome?.alarms) {
  if (!alarms?.clear) return false;
  try {
    return Boolean(await alarms.clear(ALARM_NAMES.MAINTAIN));
  } catch {
    return false;
  }
}
