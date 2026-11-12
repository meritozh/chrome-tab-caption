/**
 * Local-only counters / optional daily LLM quota (ADR Phase 7 / §8 cost risk).
 * Never leaves the device — not analytics telemetry.
 */

import { STORAGE_KEYS } from './constants.js';

/** @typedef {{
 *   organizeRuns: number,
 *   llmCalls: number,
 *   classifyErrors: number,
 *   dedupeCloses: number,
 *   reclaimCount: number,
 *   alarmResumes: number,
 *   dailyLlmDate: string,
 *   dailyLlmCalls: number,
 * }} LocalMetrics
 */

export const DEFAULT_METRICS = Object.freeze({
  organizeRuns: 0,
  llmCalls: 0,
  classifyErrors: 0,
  dedupeCloses: 0,
  reclaimCount: 0,
  alarmResumes: 0,
  dailyLlmDate: '',
  dailyLlmCalls: 0,
});

/**
 * UTC calendar day key for daily quota windows.
 * @param {number} [nowMs]
 * @returns {string} YYYY-MM-DD
 */
export function utcDayKey(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * @param {Partial<LocalMetrics> | null | undefined} partial
 * @returns {LocalMetrics}
 */
export function mergeMetrics(partial) {
  const base = { ...DEFAULT_METRICS, ...(partial && typeof partial === 'object' ? partial : {}) };
  for (const key of Object.keys(DEFAULT_METRICS)) {
    if (key === 'dailyLlmDate') {
      base.dailyLlmDate = typeof base.dailyLlmDate === 'string' ? base.dailyLlmDate : '';
      continue;
    }
    const n = Number(base[key]);
    base[key] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return /** @type {LocalMetrics} */ (base);
}

/**
 * Roll daily window if the UTC day changed.
 * @param {LocalMetrics} metrics
 * @param {number} [nowMs]
 */
export function rollDailyWindow(metrics, nowMs = Date.now()) {
  const today = utcDayKey(nowMs);
  if (metrics.dailyLlmDate === today) return metrics;
  return mergeMetrics({
    ...metrics,
    dailyLlmDate: today,
    dailyLlmCalls: 0,
  });
}

/**
 * Whether another LLM call is allowed under optional daily quota.
 * `dailyLlmQuota <= 0` means unlimited.
 * @param {LocalMetrics} metrics
 * @param {number} dailyLlmQuota
 * @param {number} [nowMs]
 */
export function canSpendLlmCall(metrics, dailyLlmQuota, nowMs = Date.now()) {
  const quota = Number(dailyLlmQuota);
  if (!Number.isFinite(quota) || quota <= 0) return true;
  const rolled = rollDailyWindow(metrics, nowMs);
  return rolled.dailyLlmCalls < Math.floor(quota);
}

/**
 * Remaining calls today (Infinity when unlimited).
 * @param {LocalMetrics} metrics
 * @param {number} dailyLlmQuota
 * @param {number} [nowMs]
 */
export function remainingDailyLlmCalls(metrics, dailyLlmQuota, nowMs = Date.now()) {
  const quota = Number(dailyLlmQuota);
  if (!Number.isFinite(quota) || quota <= 0) return Number.POSITIVE_INFINITY;
  const rolled = rollDailyWindow(metrics, nowMs);
  return Math.max(0, Math.floor(quota) - rolled.dailyLlmCalls);
}

/**
 * Apply a counter delta (+ optional daily LLM spend).
 * @param {LocalMetrics} metrics
 * @param {Partial<Record<keyof LocalMetrics, number>> & { spendDailyLlm?: number }} delta
 * @param {number} [nowMs]
 */
export function applyMetricsDelta(metrics, delta = {}, nowMs = Date.now()) {
  let next = rollDailyWindow(metrics, nowMs);
  const keys = /** @type {(keyof LocalMetrics)[]} */ ([
    'organizeRuns',
    'llmCalls',
    'classifyErrors',
    'dedupeCloses',
    'reclaimCount',
    'alarmResumes',
  ]);
  for (const key of keys) {
    const add = Number(delta[key]);
    if (Number.isFinite(add) && add !== 0) {
      next = { ...next, [key]: Math.max(0, next[key] + Math.floor(add)) };
    }
  }
  const spend = Number(delta.spendDailyLlm);
  if (Number.isFinite(spend) && spend > 0) {
    next = {
      ...next,
      llmCalls: next.llmCalls + Math.floor(spend),
      dailyLlmCalls: next.dailyLlmCalls + Math.floor(spend),
    };
  }
  return mergeMetrics(next);
}

/**
 * @param {typeof chrome.storage | undefined} storage
 * @returns {Promise<LocalMetrics>}
 */
export async function loadMetrics(storage = globalThis.chrome?.storage) {
  if (!storage?.local) return mergeMetrics(null);
  const result = await storage.local.get(STORAGE_KEYS.METRICS);
  return rollDailyWindow(mergeMetrics(result[STORAGE_KEYS.METRICS]));
}

/**
 * @param {LocalMetrics} metrics
 * @param {typeof chrome.storage | undefined} storage
 */
export async function persistMetrics(metrics, storage = globalThis.chrome?.storage) {
  const next = mergeMetrics(metrics);
  if (!storage?.local) return next;
  await storage.local.set({ [STORAGE_KEYS.METRICS]: next });
  return next;
}

/**
 * Load → apply delta → persist.
 * @param {Partial<Record<keyof LocalMetrics, number>> & { spendDailyLlm?: number }} delta
 * @param {typeof chrome.storage | undefined} storage
 */
export async function bumpMetrics(delta, storage = globalThis.chrome?.storage) {
  const current = await loadMetrics(storage);
  const next = applyMetricsDelta(current, delta);
  return persistMetrics(next, storage);
}
