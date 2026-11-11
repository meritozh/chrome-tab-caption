/**
 * Fuzzy search orchestration (ADR Phase 3 / §5.5).
 * Builds in-memory docs from open tabs + stackRecords; ranks via shared fuzzy+pinyin.
 */

import { normalizeUrlKey, computeContentHash } from '../shared/url-normalize.js';
import {
  searchDocuments,
  documentFromTab,
  documentFromStack,
} from '../shared/fuzzy-search.js';
import { SKIP_URL_PREFIXES } from '../shared/constants.js';

/**
 * @param {string | undefined} url
 */
function isSkippableUrl(url) {
  if (!url) return true;
  return SKIP_URL_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * Resolve cached topicLabel for a url without mutating LRU order.
 * Prefers exact contentHash peek; falls back to newest entry for urlKey.
 * @param {import('../shared/topic-cache.js').TopicCacheLru} topicCache
 * @param {string} url
 * @param {string} title
 */
async function resolveTopicMeta(topicCache, url, title) {
  const urlKey = normalizeUrlKey(url || '');
  if (!urlKey || !topicCache) return {};

  const contentHash = await computeContentHash({
    title: title || '',
    excerpt: '',
    url: urlKey,
  });
  const exact = topicCache.peek?.(urlKey, contentHash);
  if (exact?.topicLabel) {
    return { topicLabel: exact.topicLabel, topicKey: exact.topicKey };
  }

  /** @type {import('../shared/topic-cache.js').CacheEntry | null} */
  let best = null;
  for (const entry of topicCache.entries()) {
    if (entry.urlKey !== urlKey) continue;
    if (!best || (entry.lastHitAt ?? 0) > (best.lastHitAt ?? 0)) best = entry;
  }
  if (best?.topicLabel) {
    return { topicLabel: best.topicLabel, topicKey: best.topicKey };
  }
  return {};
}

/**
 * Query open tabs + stacks.
 * @param {object} opts
 * @param {string} opts.query
 * @param {import('../shared/stack-records.js').StackRecordStore} opts.stackStore
 * @param {import('../shared/topic-cache.js').TopicCacheLru} opts.topicCache
 * @param {boolean} [opts.pinyinEnabled]
 * @param {number} [opts.limit]
 * @param {typeof chrome.tabs} [opts.tabsApi]
 * @returns {Promise<{ ok: true, query: string, open: object[], stacked: object[], stub: false }>}
 */
export async function runSearchQuery(opts) {
  const query = String(opts.query ?? '').trim();
  const tabsApi = opts.tabsApi ?? globalThis.chrome?.tabs;
  /** @type {import('../shared/fuzzy-search.js').SearchDocument[]} */
  const docs = [];

  if (query && tabsApi?.query) {
    /** @type {chrome.tabs.Tab[]} */
    const tabs = await tabsApi.query({});
    for (const tab of tabs) {
      if (isSkippableUrl(tab.url)) continue;
      const meta = await resolveTopicMeta(opts.topicCache, tab.url || '', tab.title || '');
      const doc = documentFromTab(tab, meta);
      if (doc) docs.push(doc);
    }
  }

  const stacks = opts.stackStore?.list?.() ?? [];
  for (const record of stacks) {
    const doc = documentFromStack(record);
    if (doc) docs.push(doc);
  }

  const { open, stacked } = searchDocuments(docs, query, {
    pinyinEnabled: opts.pinyinEnabled !== false,
    limit: opts.limit ?? 40,
  });

  return {
    ok: true,
    stub: false,
    query,
    open: open.map(serializeHit),
    stacked: stacked.map(serializeHit),
  };
}

/**
 * @param {import('../shared/fuzzy-search.js').ScoredHit} hit
 */
function serializeHit(hit) {
  const d = hit.doc;
  return {
    id: d.id,
    partition: d.partition,
    title: d.title,
    url: d.url,
    topicLabel: d.topicLabel ?? null,
    groupTitle: d.groupTitle ?? null,
    favIconUrl: d.favIconUrl ?? null,
    tabId: d.tabId ?? null,
    windowId: d.windowId ?? null,
    stackId: d.stackId ?? null,
    lastAccessed: hit.lastAccessed,
    matchScore: hit.matchScore,
  };
}
