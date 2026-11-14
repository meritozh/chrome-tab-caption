/**
 * Optional host permission helpers (ADR §7).
 * Request endpoint origin before real LLM calls; never assume always-on <all_urls>.
 * Call request() as the first await from a user-gesture handler (do not await contains first).
 */

/** Default public API origins when endpointBaseUrl is empty. */
export const DEFAULT_ENDPOINT_BY_PROVIDER = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com',
});

/** Optional patterns needed for on-demand executeScript extract (Phase 6 Readability). */
export const EXTRACT_HOST_PATTERNS = Object.freeze(['http://*/*', 'https://*/*']);

/**
 * Resolve the effective endpoint base URL for permission + fetch.
 * @param {string | undefined | null} endpointBaseUrl
 * @param {string | undefined | null} provider
 * @returns {string}
 */
export function resolveEndpointBaseUrl(endpointBaseUrl, provider) {
  const trimmed = typeof endpointBaseUrl === 'string' ? endpointBaseUrl.trim() : '';
  if (trimmed) return trimmed;
  if (provider && DEFAULT_ENDPOINT_BY_PROVIDER[provider]) {
    return DEFAULT_ENDPOINT_BY_PROVIDER[provider];
  }
  return '';
}

/**
 * @param {string} endpointBaseUrl
 * @returns {string | null} origin pattern like https://api.example.com/*
 */
export function originPatternFromEndpoint(endpointBaseUrl) {
  if (!endpointBaseUrl || typeof endpointBaseUrl !== 'string') return null;
  try {
    const u = new URL(endpointBaseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Build origin list for Organize (LLM endpoint + extract hosts).
 * When `includeAllProviderDefaults` is true, also grant both Anthropic and OpenAI
 * public hosts so a stale Options config still matches live fetch.
 * @param {{
 *   endpointBaseUrl?: string,
 *   provider?: string,
 *   includeExtractHosts?: boolean,
 *   includeAllProviderDefaults?: boolean,
 * }} opts
 * @returns {string[]}
 */
export function buildOrganizePermissionOrigins(opts = {}) {
  /** @type {string[]} */
  const origins = [];
  const add = (pattern) => {
    if (pattern && !origins.includes(pattern)) origins.push(pattern);
  };

  add(originPatternFromEndpoint(resolveEndpointBaseUrl(opts.endpointBaseUrl, opts.provider)));
  // Explicit custom base even when provider is missing / changed after preview.
  add(originPatternFromEndpoint(opts.endpointBaseUrl || ''));

  if (opts.includeAllProviderDefaults !== false) {
    for (const base of Object.values(DEFAULT_ENDPOINT_BY_PROVIDER)) {
      add(originPatternFromEndpoint(base));
    }
  }

  if (opts.includeExtractHosts !== false) {
    for (const p of EXTRACT_HOST_PATTERNS) add(p);
  }
  return origins;
}

/**
 * Request Organize permissions as the first await (preserves user gesture).
 * Skips permissions.contains — awaiting contains first drops the gesture in MV3.
 * @param {{ endpointBaseUrl?: string, provider?: string, includeExtractHosts?: boolean }} opts
 * @param {typeof chrome.permissions | undefined} permissions
 * @returns {Promise<boolean>}
 */
export async function requestOrganizePermissions(
  opts = {},
  permissions = globalThis.chrome?.permissions,
) {
  const origins = buildOrganizePermissionOrigins(opts);
  if (!origins.length) return true;
  if (!permissions?.request) return true;
  try {
    return await permissions.request({ origins });
  } catch {
    return false;
  }
}

/**
 * Check (no prompt) whether endpoint host is already granted.
 * Safe to call without a user gesture.
 * @param {string} endpointBaseUrl
 * @param {string | undefined | null} provider
 * @param {typeof chrome.permissions | undefined} permissions
 * @returns {Promise<boolean>}
 */
export async function hasEndpointPermission(
  endpointBaseUrl,
  provider,
  permissions = globalThis.chrome?.permissions,
) {
  const endpoint = resolveEndpointBaseUrl(endpointBaseUrl, provider);
  const pattern = originPatternFromEndpoint(endpoint);
  if (!pattern) return true;
  if (!permissions?.contains) return true;
  try {
    return await permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * @deprecated Prefer requestOrganizePermissions from a click handler.
 * Kept for tests / SW containment checks.
 * @param {string} endpointBaseUrl
 * @param {typeof chrome.permissions | undefined} permissions
 * @param {string | undefined | null} [provider]
 */
export async function ensureEndpointPermission(
  endpointBaseUrl,
  permissions = globalThis.chrome?.permissions,
  provider = undefined,
) {
  const endpoint = resolveEndpointBaseUrl(endpointBaseUrl, provider);
  const pattern = originPatternFromEndpoint(endpoint);
  if (!pattern) return true;
  if (!permissions?.request) return true;
  // Request directly — do not await contains first (gesture safety).
  try {
    return await permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
