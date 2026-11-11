/**
 * Optional host permission helpers (ADR §7).
 * Request endpoint origin before real LLM calls; never assume always-on <all_urls>.
 */

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
 * Ensure optional host permission for the configured LLM endpoint.
 * Fail-soft: returns false when the user denies (caller should surface error).
 * @param {string} endpointBaseUrl
 * @param {typeof chrome.permissions | undefined} permissions
 * @returns {Promise<boolean>}
 */
export async function ensureEndpointPermission(
  endpointBaseUrl,
  permissions = globalThis.chrome?.permissions,
) {
  const pattern = originPatternFromEndpoint(endpointBaseUrl);
  if (!pattern) return true; // nothing to grant / invalid — let fetch fail clearly
  if (!permissions?.contains || !permissions?.request) return true;

  try {
    const has = await permissions.contains({ origins: [pattern] });
    if (has) return true;
    return await permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
