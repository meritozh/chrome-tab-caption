/**
 * Persist Organize checkpoints in chrome.storage.session (ADR Phase 7).
 */

import { SESSION_KEYS } from '../shared/constants.js';
import {
  isOrganizeCheckpoint,
  isResumablePhase,
  markInterrupted,
  remainingRefineItems,
  hasPendingStackReclassify,
  summarizeJobState,
} from '../shared/task-state.js';

/**
 * @param {typeof chrome.storage | undefined} storage
 * @returns {Promise<import('../shared/task-state.js').OrganizeCheckpoint | null>}
 */
export async function loadOrganizeCheckpoint(storage = globalThis.chrome?.storage) {
  if (!storage?.session) return null;
  try {
    const stored = await storage.session.get(SESSION_KEYS.ORGANIZE_CHECKPOINT);
    const raw = stored?.[SESSION_KEYS.ORGANIZE_CHECKPOINT];
    return isOrganizeCheckpoint(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('../shared/task-state.js').OrganizeCheckpoint | null} checkpoint
 * @param {typeof chrome.storage | undefined} storage
 */
export async function saveOrganizeCheckpoint(
  checkpoint,
  storage = globalThis.chrome?.storage,
) {
  if (!storage?.session) return checkpoint;
  try {
    if (!checkpoint) {
      await storage.session.remove(SESSION_KEYS.ORGANIZE_CHECKPOINT);
      return null;
    }
    await storage.session.set({ [SESSION_KEYS.ORGANIZE_CHECKPOINT]: checkpoint });
    return checkpoint;
  } catch {
    return checkpoint;
  }
}

/**
 * Mark active checkpoint interrupted so the next alarm can resume.
 * @param {typeof chrome.storage | undefined} storage
 */
export async function interruptOrganizeCheckpoint(storage = globalThis.chrome?.storage) {
  const current = await loadOrganizeCheckpoint(storage);
  if (!current || !isResumablePhase(current.phase)) return current;
  const next = markInterrupted(current);
  await saveOrganizeCheckpoint(next, storage);
  return next;
}

/** Max idle time since last checkpoint progress before abandoning resume. */
export const ORGANIZE_RESUME_MAX_AGE_MS = 30 * 60_000;

/**
 * Whether a stored checkpoint should be resumed by alarm / SW start.
 * Resume when refine tabs remain **or** Reorganize still needs stack reclassify
 * (`reclassifyStacks && !stacksDone`) — even if the refine queue is empty.
 *
 * Age uses `updatedAt` while stacks are still pending (merge not applied) so a
 * long Reorganize with alarm gaps does not drop unapplied grouping. Idle
 * checkpoints with no progress for 30 minutes are still abandoned.
 * @param {import('../shared/task-state.js').OrganizeCheckpoint | null | undefined} checkpoint
 * @param {number} [nowMs]
 */
export function shouldResumeCheckpoint(checkpoint, nowMs = Date.now()) {
  if (!isOrganizeCheckpoint(checkpoint)) return false;
  if (!isResumablePhase(checkpoint.phase) && checkpoint.phase !== 'interrupted') {
    return false;
  }
  if (!checkpoint.confirmed) return false;
  const refineLeft = remainingRefineItems(checkpoint).length > 0;
  const stacksLeft = hasPendingStackReclassify(checkpoint);
  if (!refineLeft && !stacksLeft) return false;
  // Prefer updatedAt while stacks pending — progress checkpoints keep the window alive.
  // Otherwise fall back to startedAt (original job age for refine-only resumes).
  const ageRef = stacksLeft
    ? Number(checkpoint.updatedAt) || Number(checkpoint.startedAt) || 0
    : Number(checkpoint.startedAt) || 0;
  if (nowMs - ageRef > ORGANIZE_RESUME_MAX_AGE_MS) return false;
  return true;
}

export { summarizeJobState, remainingRefineItems, hasPendingStackReclassify };
