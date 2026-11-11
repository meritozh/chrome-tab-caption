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
 * @param {Partial<typeof DEFAULT_CONFIG> | Record<string, unknown> | null | undefined} patch
 * @returns {Partial<typeof DEFAULT_CONFIG> & Record<string, unknown>}
 */
export function sanitizeConfigPatch(patch) {
  const next = { ...(patch && typeof patch === 'object' ? patch : {}) };
  if ('apiKey' in next && isApiKeyUnchanged(next.apiKey)) {
    delete next.apiKey;
  }
  return next;
}

/**
 * @param {Partial<typeof DEFAULT_CONFIG> | null | undefined} partial
 * @returns {typeof DEFAULT_CONFIG & Record<string, unknown>}
 */
export function mergeConfig(partial) {
  return {
    ...DEFAULT_CONFIG,
    ...(partial && typeof partial === 'object' ? partial : {}),
  };
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
 * @param {Partial<typeof DEFAULT_CONFIG>} patch
 * @param {typeof chrome.storage | undefined} storage
 */
export async function saveConfig(patch, storage = globalThis.chrome?.storage) {
  const current = await loadConfig(storage);
  const safePatch = sanitizeConfigPatch(patch);
  const next = mergeConfig({ ...current, ...safePatch });
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
  if (typeof copy.apiKey === 'string' && copy.apiKey.length > 0) {
    copy.apiKey = API_KEY_REDACTED;
  }
  return copy;
}
