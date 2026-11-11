/**
 * URL normalize: strip hash + tracking params; keep other query (ADR Decisions #3).
 * Pure module — safe for unit tests without Chrome APIs.
 */

import { TRACKING_QUERY_PARAMS } from './constants.js';

/**
 * @param {string} url
 * @param {{ stripHash?: boolean, stripTracking?: boolean, trackingParams?: readonly string[] }} [opts]
 * @returns {string} normalized urlKey (empty string if unparseable)
 */
export function normalizeUrlKey(url, opts = {}) {
  const stripHash = opts.stripHash !== false;
  const stripTracking = opts.stripTracking !== false;
  const tracking = new Set(
    (opts.trackingParams ?? TRACKING_QUERY_PARAMS).map((p) => p.toLowerCase()),
  );

  if (!url || typeof url !== 'string') return '';

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  if (stripHash) {
    parsed.hash = '';
  }

  if (stripTracking && parsed.searchParams) {
    for (const key of [...parsed.searchParams.keys()]) {
      if (tracking.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
  }

  // Normalize trailing `?` with empty search
  let out = parsed.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  if (out.endsWith('/#') || out.endsWith('#')) out = out.replace(/#$/, '');
  return out;
}

/**
 * Lightweight content fingerprint for cache keys (urlKey + contentHash).
 * Stub: SHA-256 of title|excerpt when crypto.subtle available; else djb2-ish hex.
 * @param {{ title?: string, excerpt?: string, url?: string }} parts
 * @returns {Promise<string>}
 */
export async function computeContentHash(parts) {
  const material = [parts.title ?? '', parts.excerpt ?? '', parts.url ?? ''].join('\n|\n');
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(material);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
  }
  // Fallback for Node tests without subtle
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = (h * 33) ^ material.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
