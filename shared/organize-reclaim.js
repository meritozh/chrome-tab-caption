/**
 * Whether to schedule a follow-up maybeReclaim after an Organize / Reorganize result.
 * Skip when single-window merge already applied the keep-set, or when stack
 * reclassify was interrupted (merge not finalized — reclaim would undo keep-set).
 *
 * @param {{
 *   ok?: boolean,
 *   merge?: unknown,
 *   stacksPending?: boolean,
 *   timeout?: boolean,
 * } | null | undefined} result
 */
export function shouldScheduleReclaimAfterOrganize(result) {
  if (result?.ok && result?.merge) return false;
  if (result?.stacksPending || result?.timeout) return false;
  return true;
}
