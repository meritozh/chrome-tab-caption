/**
 * On-demand content extract stub (ADR §3.1 / §5.2).
 * NOT registered as always-on content_scripts — injected via chrome.scripting.executeScript
 * after a successful page load. Mature open-source extractor selection is Phase 6 follow-up.
 * Phase 2: title + URL + short excerpt is enough; fail-soft on timeout / CSP.
 */

import { EXCERPT_HARD_CAP_CHARS, TIMEOUTS } from '../shared/constants.js';
import { withTimeout } from '../shared/async-timeout.js';

/**
 * Best-effort main-text sketch for executeScript injection (page world).
 * Keep free of imports — serialized as a function into the tab.
 * @param {number} [cap]
 * @returns {{ title: string, excerpt: string, source: 'stub' }}
 */
export function extractPageExcerpt(cap = EXCERPT_HARD_CAP_CHARS) {
  const title = typeof document !== 'undefined' ? document.title || '' : '';
  let text = '';
  if (typeof document !== 'undefined') {
    const root =
      document.querySelector('article, main, [role="main"]') || document.body;
    text = (root?.innerText || root?.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const excerpt =
    text.length <= cap ? text : text.slice(0, Math.max(0, cap - 1)).trimEnd() + '…';
  return { title, excerpt, source: 'stub' };
}

/**
 * SW-facing extract: on-demand executeScript with fail-soft fallback to title+URL.
 * @param {number} tabId
 * @param {{ title?: string, url?: string, timeoutMs?: number }} [fallback]
 */
export async function extractTabContent(tabId, fallback = {}) {
  const base = {
    title: fallback.title ?? '',
    url: fallback.url ?? '',
    excerpt: '',
    source: 'fallback-title-url',
  };

  if (typeof tabId !== 'number' || !globalThis.chrome?.scripting?.executeScript) {
    return { ...base, error: 'scripting unavailable' };
  }

  const timeoutMs = fallback.timeoutMs ?? TIMEOUTS.EXTRACT_MS;

  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageExcerpt,
        args: [EXCERPT_HARD_CAP_CHARS],
      }),
      timeoutMs,
      'extract',
    );
    const first = results?.[0]?.result;
    if (first && typeof first === 'object') {
      return {
        title: first.title || base.title,
        url: base.url,
        excerpt: first.excerpt || '',
        source: first.source || 'stub',
      };
    }
    return { ...base, error: 'empty extract result' };
  } catch (err) {
    return {
      ...base,
      error: String(err?.message || err),
    };
  }
}
