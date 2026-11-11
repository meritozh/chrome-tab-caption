/**
 * Pinyin match wrapper (ADR §5.5).
 * Vendored `pinyin-match` — full pinyin, initials, incomplete syllables.
 * Pure module; no Chrome APIs.
 */

import PinyinMatch from '../vendor/pinyin-match.js';

/**
 * @param {string | null | undefined} text
 * @param {string | null | undefined} query
 * @returns {[number, number] | false}
 */
export function matchPinyin(text, query) {
  if (!text || !query) return false;
  try {
    const hit = PinyinMatch.match(String(text), String(query));
    return Array.isArray(hit) ? /** @type {[number, number]} */ (hit) : false;
  } catch {
    return false;
  }
}

/**
 * True when query matches text via Chinese / pinyin / initials.
 * @param {string | null | undefined} text
 * @param {string | null | undefined} query
 */
export function textMatchesPinyin(text, query) {
  return matchPinyin(text, query) !== false;
}
