/**
 * Product: maxOpenTabs excess→Stacks reclaim runs **only** during user Organize /
 * Reorganize. Browse-time create / activate / remove / maintain-alarm must never
 * call maybeReclaim.
 *
 * Follow-up schedule after an Organize result: only when the job succeeded and
 * single-window merge did **not** already apply the keep-set (e.g. per-window
 * scope). Skip failed jobs, interrupted stack reclassify, and successful merges.
 *
 * @param {{
 *   ok?: boolean,
 *   merge?: unknown,
 *   stacksPending?: boolean,
 *   timeout?: boolean,
 * } | null | undefined} result
 */
export function shouldScheduleReclaimAfterOrganize(result) {
  if (!result?.ok) return false;
  if (result.merge) return false;
  if (result.stacksPending || result.timeout) return false;
  return true;
}

/**
 * Browse-time / alarm / config / overflow-export must not enforce maxOpenTabs.
 * Kept as an explicit gate for callers and regression tests.
 */
export function shouldRunBrowseTimeReclaim() {
  return false;
}
