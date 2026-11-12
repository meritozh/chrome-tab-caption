/**
 * On-demand content extract (ADR §3.1 / §5.2 / Phase 6).
 * NOT registered as always-on content_scripts — injected via chrome.scripting.executeScript
 * after a successful page load / during Organize refine.
 *
 * Pipeline: vendor Mozilla Readability → landmarks → meta → title+URL fail-soft.
 * Hard excerpt cap (~280); intermediate buffer cap (4000).
 */

import {
  EXCERPT_HARD_CAP_CHARS,
  TIMEOUTS,
} from '../shared/constants.js';
import { withTimeout } from '../shared/async-timeout.js';
import {
  EXTRACT_BUFFER_CAP_CHARS,
  assembleExtractResult,
} from '../shared/extract-text.js';

/**
 * Page-world call site — must be import-free (serialized into the tab).
 * Relies on prior injection of vendor/Readability.js + content/extract-page.js.
 * @param {number} bufferCap
 */
export function callInjectedExtract(bufferCap) {
  const runner =
    typeof globalThis !== 'undefined' ? globalThis.__tabCaptionExtractPage : null;
  if (typeof runner !== 'function') {
    return { title: '', meta: '', text: '', source: 'empty' };
  }
  return runner({ bufferCap });
}

/**
 * Best-effort landmark sketch kept for tests / environments without Readability files.
 * Prefer extractTabContent (full pipeline) in production.
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
 * SW-facing extract: on-demand executeScript with fail-soft fallback to title+URL+meta.
 * @param {number} tabId
 * @param {{ title?: string, url?: string, timeoutMs?: number, bufferCap?: number, excerptCap?: number }} [fallback]
 */
export async function extractTabContent(tabId, fallback = {}) {
  const base = {
    title: fallback.title ?? '',
    url: fallback.url ?? '',
    excerpt: '',
    meta: '',
    source: 'fallback-title-url',
  };

  const scripting = globalThis.chrome?.scripting;
  if (typeof tabId !== 'number' || !scripting?.executeScript) {
    return { ...base, error: 'scripting unavailable' };
  }

  const timeoutMs = fallback.timeoutMs ?? TIMEOUTS.EXTRACT_MS;
  const bufferCap = fallback.bufferCap ?? EXTRACT_BUFFER_CAP_CHARS;
  const excerptCap = fallback.excerptCap ?? EXCERPT_HARD_CAP_CHARS;

  try {
    const results = await withTimeout(
      (async () => {
        // Classic scripts: Readability global, then page runner, then invoke.
        await scripting.executeScript({
          target: { tabId },
          files: [
            'vendor/mozilla-readability/Readability.js',
            'content/extract-page.js',
          ],
        });
        return scripting.executeScript({
          target: { tabId },
          func: callInjectedExtract,
          args: [bufferCap],
        });
      })(),
      timeoutMs,
      'extract',
    );

    const first = results?.[0]?.result;
    if (first && typeof first === 'object') {
      return assembleExtractResult(
        {
          title: first.title || base.title,
          url: base.url,
          text: first.text || '',
          meta: first.meta || '',
          source: first.source || 'empty',
        },
        { excerptCap, bufferCap },
      );
    }
    return assembleExtractResult(
      { ...base, text: '', meta: '', source: 'empty', error: 'empty extract result' },
      { excerptCap, bufferCap },
    );
  } catch (err) {
    return assembleExtractResult(
      {
        ...base,
        text: '',
        meta: '',
        source: 'empty',
        error: String(err?.message || err),
      },
      { excerptCap, bufferCap },
    );
  }
}
