/**
 * Tab eligibility for on-demand grouping (ADR §5.3).
 * Skip pinned and chrome:// / extension / devtools pages.
 */

import { SKIP_URL_PREFIXES } from './constants.js';

/**
 * @param {string | undefined | null} url
 * @returns {boolean}
 */
export function isSkippableUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const lower = url.toLowerCase();
  return SKIP_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * @param {{ id?: number, url?: string, title?: string, pinned?: boolean, windowId?: number, groupId?: number, lastAccessed?: number, favIconUrl?: string, status?: string }} tab
 * @returns {boolean}
 */
export function isEligibleTab(tab) {
  if (!tab || typeof tab.id !== 'number') return false;
  if (tab.pinned) return false;
  if (isSkippableUrl(tab.url)) return false;
  return true;
}

/**
 * @template {{ id?: number, url?: string, pinned?: boolean }} T
 * @param {T[]} tabs
 * @returns {T[]}
 */
export function filterEligibleTabs(tabs) {
  return (tabs || []).filter((t) => isEligibleTab(t));
}
