/**
 * Structured-text cleaning + excerpt assembly for content extraction (ADR §5.2 / Phase 6).
 * Pure helpers — no Chrome APIs. Page-world DOM extract lives in content/extract-page.js.
 */

import { EXCERPT_HARD_CAP_CHARS } from './constants.js';
import { capExcerpt } from './topic-cache.js';

/** Intermediate buffer before hard excerpt cap (Pilot-style; ADR §5.2). */
export const EXTRACT_BUFFER_CAP_CHARS = 4000;

/**
 * Collapse whitespace / strip control chars for LLM-friendly structured text.
 * @param {string | null | undefined} text
 * @param {number} [bufferCap]
 */
export function cleanStructuredText(text, bufferCap = EXTRACT_BUFFER_CAP_CHARS) {
  if (!text) return '';
  let t = String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
  // Keep paragraph breaks as single newlines, flatten other runs of whitespace.
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  if (bufferCap > 0 && t.length > bufferCap) {
    t = t.slice(0, bufferCap).trimEnd();
  }
  return t;
}

/**
 * Prefer Open Graph / Twitter / standard meta description.
 * @param {{ getAttribute?: (name: string) => string | null } | null | undefined} el
 */
function attrContent(el) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  return (el.getAttribute('content') || '').trim();
}

/**
 * Read meta description from a document-like object.
 * @param {{ querySelector?: (sel: string) => any }} doc
 */
export function readMetaDescription(doc) {
  if (!doc?.querySelector) return '';
  const selectors = [
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ];
  for (const sel of selectors) {
    const content = attrContent(doc.querySelector(sel));
    if (content) return content;
  }
  return '';
}

/**
 * Landmark / body text when Readability finds nothing (document-like).
 * @param {{ querySelector?: (sel: string) => any, body?: { innerText?: string, textContent?: string } }} doc
 * @param {number} [bufferCap]
 */
export function readLandmarkText(doc, bufferCap = EXTRACT_BUFFER_CAP_CHARS) {
  if (!doc?.querySelector && !doc?.body) return '';
  const root =
    (doc.querySelector && doc.querySelector('article, main, [role="main"]')) || doc.body;
  if (!root) return '';
  const raw = root.innerText || root.textContent || '';
  return cleanStructuredText(raw, bufferCap);
}

/**
 * Assemble final extract fields: hard-cap excerpt, fail-soft source labels.
 * @param {{
 *   title?: string,
 *   url?: string,
 *   text?: string,
 *   meta?: string,
 *   source?: string,
 *   error?: string,
 * }} raw
 * @param {{ excerptCap?: number, bufferCap?: number }} [opts]
 */
export function assembleExtractResult(raw = {}, opts = {}) {
  const excerptCap = opts.excerptCap ?? EXCERPT_HARD_CAP_CHARS;
  const bufferCap = opts.bufferCap ?? EXTRACT_BUFFER_CAP_CHARS;
  const title = raw.title || '';
  const url = raw.url || '';
  const meta = cleanStructuredText(raw.meta || '', bufferCap);
  const cleaned = cleanStructuredText(raw.text || '', bufferCap);

  let excerpt = capExcerpt(cleaned, excerptCap);
  let source = raw.source || 'empty';

  if (!excerpt && meta) {
    excerpt = capExcerpt(meta, excerptCap);
    source = source === 'empty' || source === 'landmarks' ? 'meta' : source;
  }

  if (!excerpt) {
    return {
      title,
      url,
      excerpt: '',
      meta,
      source: 'fallback-title-url',
      error: raw.error,
    };
  }

  return {
    title,
    url,
    excerpt,
    meta,
    source,
    error: raw.error,
  };
}
