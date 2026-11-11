/**
 * Service worker orchestrator (ADR Phase 0–2).
 * Unique orchestration center: events, debounce, jobs, LLM, Chrome side-effects.
 * UI only sends MSG.* — keys & tab mutations stay here.
 * Grouping is on-demand only — never auto-group on tab complete.
 */

import { MSG, DEFAULT_CONFIG, SESSION_KEYS, TIMEOUTS, STORAGE_KEYS } from '../shared/constants.js';
import { loadConfig, saveConfig, redactConfigForUi, mergeConfig } from '../shared/config.js';
import { buildClassifyPayloadPreview, createLlmClient } from '../shared/llm-client.js';
import { TopicCacheLru, loadTopicCache, persistTopicCache } from '../shared/topic-cache.js';
import { StackRecordStore } from '../shared/stack-records.js';
import { normalizeUrlKey, computeContentHash } from '../shared/url-normalize.js';
import { isEligibleTab } from '../shared/tab-eligibility.js';
import {
  buildGroupPayloadPreview,
  groupTabsOnDemand,
} from './grouping.js';

/** @type {TopicCacheLru} */
let topicCache = new TopicCacheLru(DEFAULT_CONFIG.cacheSize);
/** @type {StackRecordStore} */
let stackStore = new StackRecordStore(DEFAULT_CONFIG.stackSize);

/** @type {{ logical: import('../shared/physical-groups.js').PhysicalGroupPlan[] | unknown[], latestWinsAt: number, source: string } | null} */
let lastOrganizeState = null;

/** Runtime: tabs we are closing (dedupe/reclaim) — suppress recall pollution later. */
/** @type {Set<number>} */
const closingTabIds = new Set();

/** @type {ReturnType<typeof setTimeout> | number | null} */
let cacheSyncTimer = null;
/** @type {Map<number, { url?: string, title?: string }>} */
const pendingTabSync = new Map();

/** @type {Promise<void> | null} */
let hydratePromise = null;

async function initPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[tab-caption] setPanelBehavior failed', err);
  }
}

async function hydrateFromStorage() {
  const config = await loadConfig();
  topicCache = await loadTopicCache(config.cacheSize);
  stackStore = new StackRecordStore(config.stackSize);
  // Restore logical topics across SW restarts (session-scoped).
  try {
    const stored = await chrome.storage.session.get(SESSION_KEYS.LAST_ORGANIZE);
    const last = stored?.[SESSION_KEYS.LAST_ORGANIZE];
    if (last && Array.isArray(last.logical)) {
      lastOrganizeState = {
        logical: last.logical,
        latestWinsAt: last.latestWinsAt ?? null,
        latestWinsSource: last.latestWinsSource ?? last.source ?? null,
      };
    }
  } catch {
    // session storage may be unavailable
  }
  // stackRecords hydrate lands in Phase 4
}

function ensureHydrated() {
  if (!hydratePromise) {
    hydratePromise = hydrateFromStorage().catch((err) => {
      console.warn('[tab-caption] hydrate failed', err);
      hydratePromise = null;
    });
  }
  return hydratePromise;
}

/**
 * Persist latest-wins organize result (full logical views) in session.
 * @param {Record<string, unknown>} state
 */
async function rememberOrganizeState(state) {
  lastOrganizeState = {
    logical: Array.isArray(state.logical) ? state.logical : [],
    latestWinsAt: state.latestWinsAt ?? Date.now(),
    latestWinsSource: state.latestWinsSource ?? 'extension-organize',
  };
  try {
    await chrome.storage.session.set({
      [SESSION_KEYS.LAST_ORGANIZE]: {
        logical: lastOrganizeState.logical,
        latestWinsAt: lastOrganizeState.latestWinsAt,
        latestWinsSource: lastOrganizeState.latestWinsSource,
      },
    });
  } catch {
    // session storage may be unavailable in tests
  }
}

/**
 * Prefer explicit windowId from Side Panel; fall back to sender.tab / getCurrent.
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<number | undefined>}
 */
async function resolveCurrentWindowId(message, sender) {
  if (typeof message?.windowId === 'number') return message.windowId;
  if (typeof sender?.tab?.windowId === 'number') return sender.tab.windowId;
  try {
    const win = await chrome.windows.getCurrent();
    return win?.id;
  } catch {
    return undefined;
  }
}

/**
 * Debounced cache metadata sync on tab URL/title updates (no LLM).
 * @param {number} tabId
 * @param {chrome.tabs.TabChangeInfo} changeInfo
 * @param {chrome.tabs.Tab} tab
 */
function scheduleCacheSync(tabId, changeInfo, tab) {
  if (!isEligibleTab(tab)) return;
  // Sync only when URL or title actually changes (contentHash inputs) — never LLM.
  if (changeInfo.url == null && changeInfo.title == null) return;
  pendingTabSync.set(tabId, {
    url: tab.url,
    title: tab.title,
    urlChanged: changeInfo.url != null,
  });
  if (cacheSyncTimer) clearTimeout(cacheSyncTimer);
  cacheSyncTimer = setTimeout(() => {
    cacheSyncTimer = null;
    flushCacheSync().catch(() => {});
  }, TIMEOUTS.CACHE_SYNC_DEBOUNCE_MS);
}

async function flushCacheSync() {
  await ensureHydrated();
  const batch = [...pendingTabSync.entries()];
  pendingTabSync.clear();
  let mutated = false;

  for (const [, info] of batch) {
    const urlKey = normalizeUrlKey(info.url || '');
    if (!urlKey) continue;
    // URL navigation: drop all hashes for this urlKey. Title-only: leave entries;
    // next Organize recomputes contentHash and treats mismatch as miss/stale.
    if (info.urlChanged) {
      topicCache.invalidateUrl(urlKey);
      mutated = true;
    }
    void computeContentHash({
      title: info.title || '',
      excerpt: '',
      url: urlKey,
    });
  }

  if (mutated) {
    await persistTopicCache(topicCache);
  }
}

/**
 * Message router — keep surface stable.
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response?: unknown) => void} sendResponse
 */
function onMessage(message, sender, sendResponse) {
  const type = message?.type;
  if (!type) {
    sendResponse({ ok: false, error: 'missing type' });
    return false;
  }

  (async () => {
    await ensureHydrated();

    switch (type) {
      case MSG.GET_CONFIG: {
        const config = await loadConfig();
        sendResponse({ ok: true, config: redactConfigForUi(config) });
        break;
      }
      case MSG.SET_CONFIG: {
        const next = await saveConfig(message.patch ?? {});
        topicCache.maxSize = Math.max(1, Number(next.cacheSize) || DEFAULT_CONFIG.cacheSize);
        topicCache._evict();
        await persistTopicCache(topicCache);
        stackStore.maxSize = Math.max(1, Number(next.stackSize) || DEFAULT_CONFIG.stackSize);
        chrome.runtime.sendMessage({ type: MSG.CONFIG_UPDATED }).catch(() => {});
        sendResponse({ ok: true, config: redactConfigForUi(next) });
        break;
      }
      case MSG.PREVIEW_CLASSIFY_PAYLOAD: {
        const config = await loadConfig();
        const preview = buildClassifyPayloadPreview(
          {
            url: message.url ?? '',
            title: message.title ?? '',
            snippet: message.snippet,
            extractedText: message.extractedText,
          },
          {
            provider: /** @type {any} */ (config.llmProvider || ''),
            model: config.model,
            endpointBaseUrl: config.endpointBaseUrl,
          },
        );
        sendResponse({ ok: true, preview });
        break;
      }
      case MSG.PREVIEW_GROUP_PAYLOAD: {
        const config = await loadConfig();
        const currentWindowId = await resolveCurrentWindowId(message, sender);
        const preview = await buildGroupPayloadPreview({
          scope: message.scope === 'current' ? 'current' : 'all',
          currentWindowId,
          topicCache,
          config,
        });
        sendResponse({ ok: true, preview });
        break;
      }
      case MSG.GROUP_TABS: {
        const config = await loadConfig();
        if (!message.confirmed) {
          sendResponse({
            ok: false,
            needsConfirm: true,
            error: 'Confirm privacy preview before Organize (ADR #12).',
          });
          break;
        }
        if (config.groupOnDemandOnly === false) {
          // Still never auto-group; flag is informational for Phase 2.
        }
        const currentWindowId = await resolveCurrentWindowId(message, sender);
        const result = await groupTabsOnDemand({
          scope: message.scope === 'current' ? 'current' : 'all',
          currentWindowId,
          confirmed: true,
          topicCache,
          config,
          llmOpts: { useMock: message.useMock === true },
        });
        if (result.ok) {
          await rememberOrganizeState(result);
        }
        sendResponse(result);
        break;
      }
      case MSG.GET_LOGICAL_TOPICS: {
        sendResponse({
          ok: true,
          logical: lastOrganizeState?.logical ?? [],
          latestWinsAt: lastOrganizeState?.latestWinsAt ?? null,
          source: lastOrganizeState?.latestWinsSource ?? null,
        });
        break;
      }
      case MSG.SEARCH_QUERY: {
        sendResponse({
          ok: true,
          stub: true,
          query: message.query ?? '',
          open: [],
          stacked: [],
          note: 'Fuzzy + pinyin + recency-first lands in Phase 3.',
        });
        break;
      }
      case MSG.GET_STACKS: {
        sendResponse({ ok: true, stacks: stackStore.list(), stub: true });
        break;
      }
      case MSG.RECALL_STACK: {
        sendResponse({
          ok: false,
          stub: true,
          error: 'RECALL_STACK not implemented yet (Phase 4).',
        });
        break;
      }
      case MSG.EXPORT_OR_DISCARD_STACKS: {
        sendResponse({
          ok: false,
          stub: true,
          error: 'EXPORT_OR_DISCARD_STACKS not implemented yet (Phase 4).',
        });
        break;
      }
      case MSG.TEST_LLM: {
        // Keep mock for TEST_LLM — never send real secrets in connection-test path.
        const config = mergeConfig(await loadConfig());
        const client = createLlmClient({
          provider: /** @type {any} */ (config.llmProvider || undefined),
          endpointBaseUrl: config.endpointBaseUrl,
          apiKey: config.apiKey,
          model: config.model,
          useMock: true,
        });
        const preview = buildClassifyPayloadPreview(
          {
            url: message.url ?? 'https://example.com/stub',
            title: message.title ?? 'Connection test',
            snippet: 'stub',
          },
          {
            provider: /** @type {any} */ (config.llmProvider || ''),
            model: config.model,
            endpointBaseUrl: config.endpointBaseUrl,
          },
        );
        const result = await client.classifyTopic({
          url: message.url ?? 'https://example.com/stub',
          title: message.title ?? 'Connection test',
          snippet: 'stub',
        });
        sendResponse({
          ok: true,
          stub: true,
          preview,
          result,
          note: 'TEST_LLM always uses MockLlmClient. Real Anthropic/Responses calls run on confirmed Organize.',
        });
        break;
      }
      case MSG.GET_ACTIVITY_LOG: {
        sendResponse({ ok: true, entries: [], stub: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: `unknown type: ${type}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // async sendResponse
}

chrome.runtime.onInstalled.addListener(() => {
  initPanelBehavior();
  ensureHydrated();
});

chrome.runtime.onStartup.addListener(() => {
  initPanelBehavior();
  ensureHydrated();
});

chrome.runtime.onMessage.addListener(onMessage);

// Cache sync on URL/title updates — metadata only, never LLM / never auto-group
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleCacheSync(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabSync.delete(tabId);
  closingTabIds.delete(tabId);
});

// Eager init for SW cold start
initPanelBehavior();
ensureHydrated();

// Export for tests / future modules (not used by Chrome loader)
export {
  closingTabIds,
  topicCache,
  stackStore,
  MSG,
  SESSION_KEYS,
  STORAGE_KEYS,
  ensureHydrated,
};
