/**
 * Config load/merge helpers. API keys only in chrome.storage.local (never sync).
 */

import { DEFAULT_CONFIG, STORAGE_KEYS } from './constants.js';

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
 * Persist config. Does not log apiKey.
 * @param {Partial<typeof DEFAULT_CONFIG>} patch
 * @param {typeof chrome.storage | undefined} storage
 */
export async function saveConfig(patch, storage = globalThis.chrome?.storage) {
  const current = await loadConfig(storage);
  const next = mergeConfig({ ...current, ...patch });
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
    copy.apiKey = '••••••••';
  }
  return copy;
}
