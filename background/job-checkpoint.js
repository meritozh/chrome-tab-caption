/**
 * Persist Organize checkpoints in chrome.storage.session (ADR Phase 7).
 */

import { SESSION_KEYS } from '../shared/constants.js';
import {
  isOrganizeCheckpoint,
  isResumablePhase,
  markInterrupted,
  remainingRefineItems,
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

/**
 * Whether a stored checkpoint should be resumed by alarm / SW start.
 * @param {import('../shared/task-state.js').OrganizeCheckpoint | null | undefined} checkpoint
 */
export function shouldResumeCheckpoint(checkpoint) {
  if (!isOrganizeCheckpoint(checkpoint)) return false;
  if (!isResumablePhase(checkpoint.phase) && checkpoint.phase !== 'interrupted') {
    return false;
  }
  if (!checkpoint.confirmed) return false;
  if (remainingRefineItems(checkpoint).length <= 0) return false;
  // Stale deadline — still resume once so partial apply can finish, unless ancient.
  const ageMs = Date.now() - (checkpoint.startedAt || 0);
  if (ageMs > 30 * 60_000) return false;
  return true;
}

export { summarizeJobState, remainingRefineItems };
