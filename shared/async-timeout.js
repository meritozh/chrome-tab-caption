/**
 * Fail-soft timeouts for extract / classify / whole organize jobs (ADR §5.2–5.3).
 */

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = 'operation') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Deadline helper: remaining ms until absolute deadline.
 * @param {number} deadlineMs
 * @returns {number}
 */
export function remainingMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

/**
 * @param {number} budgetMs
 * @returns {{ deadline: number, remaining: () => number, expired: () => boolean }}
 */
export function createDeadline(budgetMs) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  return {
    deadline,
    remaining: () => remainingMs(deadline),
    expired: () => Date.now() >= deadline,
  };
}
