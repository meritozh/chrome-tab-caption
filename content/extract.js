/**
 * On-demand content extract stub (ADR §3.1 / §5.2).
 * NOT registered as always-on content_scripts — injected via chrome.scripting.executeScript
 * after a successful page load. Mature open-source extractor selection is Phase 6 follow-up.
 */

import { EXCERPT_HARD_CAP_CHARS } from '../shared/constants.js';

/**
 * Best-effort main-text sketch for executeScript injection.
 * Keep pure-ish so it can run in page world as a function body later.
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
 * SW-facing stub: will use scripting.executeScript in Phase 1/6.
 * Fail-soft: returns title+url only when injection is unavailable.
 * @param {number} _tabId
 * @param {{ title?: string, url?: string }} fallback
 */
export async function extractTabContent(_tabId, fallback = {}) {
  return {
    title: fallback.title ?? '',
    url: fallback.url ?? '',
    excerpt: '',
    source: 'fallback-title-url',
    error: 'executeScript extract not wired yet (Phase 1/6 stub)',
  };
}
