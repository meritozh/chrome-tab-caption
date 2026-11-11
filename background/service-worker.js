/**
 * Service worker orchestrator stub (ADR Phase 0/1).
 * Unique orchestration center: events, debounce, jobs, LLM, Chrome side-effects.
 * UI only sends MSG.* — keys & tab mutations stay here.
 */

import { MSG, DEFAULT_CONFIG, SESSION_KEYS } from '../shared/constants.js';
import { loadConfig, saveConfig, redactConfigForUi, mergeConfig } from '../shared/config.js';
import { buildClassifyPayloadPreview, createLlmClient } from '../shared/llm-client.js';
import { TopicCacheLru } from '../shared/topic-cache.js';
import { StackRecordStore } from '../shared/stack-records.js';

/** @type {TopicCacheLru} */
let topicCache = new TopicCacheLru(DEFAULT_CONFIG.cacheSize);
/** @type {StackRecordStore} */
let stackStore = new StackRecordStore(DEFAULT_CONFIG.stackSize);

/** Runtime stub: tabs we are closing (dedupe/reclaim) — suppress recall pollution later. */
/** @type {Set<number>} */
const closingTabIds = new Set();

async function initPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[tab-caption] setPanelBehavior failed', err);
  }
}

async function hydrateFromStorage() {
  const config = await loadConfig();
  topicCache = new TopicCacheLru(config.cacheSize);
  stackStore = new StackRecordStore(config.stackSize);
  // Persistence hydrate for cache/stacks lands in later phases.
}

/**
 * Message router — keep surface stable; implementations fill in by phase.
 * @param {any} message
 * @param {chrome.runtime.MessageSender} _sender
 * @param {(response?: unknown) => void} sendResponse
 */
function onMessage(message, _sender, sendResponse) {
  const type = message?.type;
  if (!type) {
    sendResponse({ ok: false, error: 'missing type' });
    return false;
  }

  (async () => {
    switch (type) {
      case MSG.GET_CONFIG: {
        const config = await loadConfig();
        sendResponse({ ok: true, config: redactConfigForUi(config) });
        break;
      }
      case MSG.SET_CONFIG: {
        const next = await saveConfig(message.patch ?? {});
        topicCache.maxSize = next.cacheSize;
        stackStore.maxSize = next.stackSize;
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
      case MSG.GROUP_TABS: {
        // Phase 2: preview confirm → quick pass → refine → physical groups.
        sendResponse({
          ok: false,
          stub: true,
          error: 'GROUP_TABS not implemented yet (Phase 2). On-demand only — no auto-group.',
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
        const config = mergeConfig(await loadConfig());
        const client = createLlmClient({
          provider: /** @type {any} */ (config.llmProvider || undefined),
          endpointBaseUrl: config.endpointBaseUrl,
          apiKey: config.apiKey,
          model: config.model,
          useMock: true,
        });
        const result = await client.classifyTopic({
          url: message.url ?? 'https://example.com/stub',
          title: message.title ?? 'Connection test',
          snippet: 'stub',
        });
        sendResponse({
          ok: true,
          stub: true,
          result,
          note: 'Real Anthropic / Responses calls land in Phase 2. Mock used for scaffold.',
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
  hydrateFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  initPanelBehavior();
  hydrateFromStorage();
});

chrome.runtime.onMessage.addListener(onMessage);

// Eager init for SW cold start
initPanelBehavior();
hydrateFromStorage();

// Export for tests / future modules (not used by Chrome loader)
export { closingTabIds, topicCache, stackStore, MSG, SESSION_KEYS };
