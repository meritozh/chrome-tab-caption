/**
 * On-demand content extract (ADR §3.1 / §5.2 / Phase 6).
 * NOT registered as always-on content_scripts — injected via chrome.scripting.executeScript
 * after a successful page load / during Organize refine.
 *
 * Pipeline: cheap landmarks/meta first → bounded Mozilla Readability → title+URL fail-soft.
 * Hard excerpt cap (~280); intermediate buffer cap (4000); maxElemsToParse bound.
 */

import {
  EXCERPT_HARD_CAP_CHARS,
  TIMEOUTS,
} from '../shared/constants.js';
import { withTimeout } from '../shared/async-timeout.js';
import {
  EXTRACT_BUFFER_CAP_CHARS,
  EXTRACT_MAX_ELEMS_TO_PARSE,
  assembleExtractResult,
} from '../shared/extract-text.js';

/**
 * Page-world call site — must be import-free (serialized into the tab).
 * Relies on prior injection of vendor/mozilla-readability/Readability.js + content/extract-page.js.
 * @param {{ bufferCap?: number, maxElemsToParse?: number, skipReadability?: boolean }} opts
 */
export function callInjectedExtract(opts) {
  const runner =
    typeof globalThis !== 'undefined' ? globalThis.__tabCaptionExtractPage : null;
  if (typeof runner !== 'function') {
    return { title: '', meta: '', text: '', source: 'empty' };
  }
  return runner(opts && typeof opts === 'object' ? opts : {});
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
 * @param {unknown} first
 * @param {{ title: string, url: string }} base
 * @param {{ excerptCap: number, bufferCap: number }} caps
 * @param {string} [error]
 */
function assembleFromInjection(first, base, caps, error) {
  if (first && typeof first === 'object') {
    return assembleExtractResult(
      {
        title: /** @type {{ title?: string }} */ (first).title || base.title,
        url: base.url,
        text: /** @type {{ text?: string }} */ (first).text || '',
        meta: /** @type {{ meta?: string }} */ (first).meta || '',
        source: /** @type {{ source?: string }} */ (first).source || 'empty',
        error,
      },
      caps,
    );
  }
  return assembleExtractResult(
    {
      ...base,
      text: '',
      meta: '',
      source: 'empty',
      error: error || 'empty extract result',
    },
    caps,
  );
}

/**
 * SW-facing extract: on-demand executeScript with fail-soft fallback to title+URL+meta.
 * Two-phase: cheap landmarks/meta, then bounded Readability with remaining budget so a
 * heavy parse timeout still keeps meta/landmarks instead of title-only.
 * @param {number} tabId
 * @param {{ title?: string, url?: string, timeoutMs?: number, bufferCap?: number, excerptCap?: number, maxElemsToParse?: number }} [fallback]
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
  const maxElemsToParse = fallback.maxElemsToParse ?? EXTRACT_MAX_ELEMS_TO_PARSE;
  const caps = { excerptCap, bufferCap };
  const started = Date.now();
  /** Wall-clock remaining for the overall extract budget (never inflate). */
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - started));
  /** Skip Readability when less than this many ms remain. */
  const READABILITY_MIN_MS = 200;

  try {
    // Inject classic scripts once (shared by cheap + Readability passes).
    await withTimeout(
      scripting.executeScript({
        target: { tabId },
        files: [
          'vendor/mozilla-readability/Readability.js',
          'content/extract-page.js',
        ],
      }),
      Math.max(1, remaining()),
      'extract-inject',
    );

    // Phase 1: landmarks + meta only (no clone / Readability).
    const cheapResults = await withTimeout(
      scripting.executeScript({
        target: { tabId },
        func: callInjectedExtract,
        args: [{ bufferCap, skipReadability: true }],
      }),
      Math.max(1, remaining()),
      'extract-cheap',
    );
    const cheapAssembled = assembleFromInjection(
      cheapResults?.[0]?.result,
      base,
      caps,
    );

    // Phase 2: bounded Readability with whatever budget remains.
    if (remaining() < READABILITY_MIN_MS) {
      return cheapAssembled;
    }

    try {
      const richResults = await withTimeout(
        scripting.executeScript({
          target: { tabId },
          func: callInjectedExtract,
          args: [{ bufferCap, maxElemsToParse, skipReadability: false }],
        }),
        remaining(),
        'extract-readability',
      );
      const rich = richResults?.[0]?.result;
      if (rich && typeof rich === 'object' && rich.source === 'readability') {
        return assembleFromInjection(rich, base, caps);
      }
      // Readability skipped/failed — keep cheap landmarks/meta.
      return cheapAssembled;
    } catch (richErr) {
      return assembleExtractResult(
        {
          title: cheapAssembled.title || base.title,
          url: base.url,
          text: cheapAssembled.excerpt || '',
          meta: cheapAssembled.meta || '',
          source:
            cheapAssembled.source === 'fallback-title-url'
              ? 'empty'
              : cheapAssembled.source,
          error: String(richErr?.message || richErr),
        },
        caps,
      );
    }
  } catch (err) {
    return assembleExtractResult(
      {
        ...base,
        text: '',
        meta: '',
        source: 'empty',
        error: String(err?.message || err),
      },
      caps,
    );
  }
}
