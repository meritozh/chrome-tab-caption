/**
 * Config load/merge helpers. API keys only in chrome.storage.local (never sync).
 */

import { DEFAULT_CONFIG, STORAGE_KEYS } from './constants.js';

/** UI-only placeholder — must never be written to chrome.storage.local. */
export const API_KEY_REDACTED = '••••••••';

/**
 * True when apiKey should be left unchanged (empty, missing, or redacted sentinel).
 * @param {unknown} value
 */
export function isApiKeyUnchanged(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === API_KEY_REDACTED;
}

/**
 * Drop empty/redacted apiKey from a config patch so Save cannot wipe or round-trip bullets.
 * Also drops legacy size keys — capacity is only `topicCacheSize`.
 * @param {Partial<typeof DEFAULT_CONFIG> | Record<string, unknown> | null | undefined} patch
 * @returns {Partial<typeof DEFAULT_CONFIG> & Record<string, unknown>}
 */
export function sanitizeConfigPatch(patch) {
  const next = { ...(patch && typeof patch === 'object' ? patch : {}) };
  if ('apiKey' in next && isApiKeyUnchanged(next.apiKey)) {
    delete next.apiKey;
  }
  // Legacy dual knobs — never persist separately after unify.
  delete next.cacheSize;
  delete next.stackSize;
  return next;
}

/**
 * Resolve the unified topic-cache / Stacks capacity.
 * Prefers `topicCacheSize`; migrates legacy `cacheSize` / `stackSize` via max when both differ.
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {number}
 */
export function resolveTopicCacheSize(config) {
  const unified = Number(config?.topicCacheSize);
  if (Number.isFinite(unified) && unified >= 1) return Math.floor(unified);

  const candidates = [];
  const cache = Number(config?.cacheSize);
  const stack = Number(config?.stackSize);
  if (Number.isFinite(cache) && cache >= 1) candidates.push(Math.floor(cache));
  if (Number.isFinite(stack) && stack >= 1) candidates.push(Math.floor(stack));
  if (candidates.length) return Math.max(...candidates);
  return DEFAULT_CONFIG.topicCacheSize;
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG> | null | undefined} partial
 * @returns {typeof DEFAULT_CONFIG & Record<string, unknown>}
 */
export function mergeConfig(partial) {
  const src = partial && typeof partial === 'object' ? { ...partial } : {};
  const topicCacheSize = resolveTopicCacheSize(src);
  // Drop legacy knobs so callers cannot observe divergent cache vs stack sizes.
  delete src.cacheSize;
  delete src.stackSize;
  const next = {
    ...DEFAULT_CONFIG,
    ...src,
    topicCacheSize,
  };
  // ADR 2026-11-13: coerce superseded stored value so Organize always merges.
  if (next.groupScope === 'cross-window-logical') {
    next.groupScope = 'single-window-merge';
  }
  return next;
}

/**
 * Read config from chrome.storage.local (stub-friendly).
 * @param {typeof chrome.storage | undefined} storage
 */
export async function loadConfig(storage = globalThis.chrome?.storage) {
  if (!storage?.local) {
    return mergeConfig(null);
  }
  const result = await storage.local.get(STORAGE_KEYS.CONFIG);
  return mergeConfig(result[STORAGE_KEYS.CONFIG]);
}

/**
 * Persist config. Does not log apiKey. Omits empty/redacted apiKey from the patch.
 * Always writes unified `topicCacheSize` (legacy cacheSize/stackSize stripped).
 * @param {Partial<typeof DEFAULT_CONFIG>} patch
 * @param {typeof chrome.storage | undefined} storage
 */
export async function saveConfig(patch, storage = globalThis.chrome?.storage) {
  const current = await loadConfig(storage);
  const safePatch = sanitizeConfigPatch(patch);
  const next = mergeConfig({ ...current, ...safePatch });
  // Ensure stored blob has no legacy size keys after migration.
  delete next.cacheSize;
  delete next.stackSize;
  if (!storage?.local) return next;
  await storage.local.set({ [STORAGE_KEYS.CONFIG]: next });
  return next;
}

/**
 * Redact secrets for UI preview / activity logs.
 * @param {Record<string, unknown>} config
 */
export function redactConfigForUi(config) {
  const copy = { ...config };
  const hasApiKey = typeof copy.apiKey === 'string' && copy.apiKey.length > 0;
  copy.hasApiKey = hasApiKey;
  if (hasApiKey) {
    copy.apiKey = API_KEY_REDACTED;
  }
  return copy;
}

/**
 * Resolve LLM fields for Options → TEST_LLM.
 * Overlays an unsaved form patch on stored config so permission grant and ping
 * target the same provider/endpoint/key/model. Empty/redacted apiKey in the
 * form keeps the stored secret (same as Save).
 *
 * @param {Partial<typeof DEFAULT_CONFIG> | Record<string, unknown> | null | undefined} stored
 * @param {Partial<typeof DEFAULT_CONFIG> | Record<string, unknown> | null | undefined} formOverride
 * @returns {typeof DEFAULT_CONFIG & Record<string, unknown>}
 */
export function resolveTestLlmConfig(stored, formOverride) {
  const base = mergeConfig(stored);
  if (!formOverride || typeof formOverride !== 'object') {
    return base;
  }
  /** @type {Record<string, unknown>} */
  const llmPatch = {};
  for (const key of ['llmProvider', 'endpointBaseUrl', 'apiKey', 'model']) {
    if (key in formOverride) {
      llmPatch[key] = formOverride[key];
    }
  }
  return mergeConfig({ ...base, ...sanitizeConfigPatch(llmPatch) });
}
