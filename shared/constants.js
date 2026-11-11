/**
 * Shared constants — message types, storage keys, defaults.
 * ADR §3.1 message table · §6 Config defaults · §10 Borrowed MSG pattern from Pilot.
 */

/** @typedef {'anthropic' | 'openai-responses'} LlmProvider */

export const EXTENSION_ID = 'chrome-tab-caption';

/** chrome.storage.local partition keys */
export const STORAGE_KEYS = Object.freeze({
  CONFIG: 'config',
  TOPIC_CACHE: 'topicCache',
  STACK_RECORDS: 'stackRecords',
  SEARCH_INDEX: 'searchIndex',
});

/** chrome.storage.session runtime keys (optional) */
export const SESSION_KEYS = Object.freeze({
  RUNTIME: 'runtime',
  CLOSING_TAB_IDS: 'closingTabIds',
  LAST_ORGANIZE: 'lastOrganize',
});

/**
 * UI ↔ Service Worker message type table (ADR §3.1).
 * Side Panel / Options send typed messages; SW owns Chrome side-effects & API keys.
 */
export const MSG = Object.freeze({
  // UI → SW
  GROUP_TABS: 'GROUP_TABS',
  PREVIEW_CLASSIFY_PAYLOAD: 'PREVIEW_CLASSIFY_PAYLOAD',
  PREVIEW_GROUP_PAYLOAD: 'PREVIEW_GROUP_PAYLOAD',
  SEARCH_QUERY: 'SEARCH_QUERY',
  RECALL_STACK: 'RECALL_STACK',
  EXPORT_OR_DISCARD_STACKS: 'EXPORT_OR_DISCARD_STACKS',
  GET_CONFIG: 'GET_CONFIG',
  SET_CONFIG: 'SET_CONFIG',
  TEST_LLM: 'TEST_LLM',
  GET_STACKS: 'GET_STACKS',
  GET_ACTIVITY_LOG: 'GET_ACTIVITY_LOG',
  GET_LOGICAL_TOPICS: 'GET_LOGICAL_TOPICS',

  // SW → UI
  GROUP_PROGRESS: 'GROUP_PROGRESS',
  JOB_STATE: 'JOB_STATE',
  STACKS_OVERFLOW_WARN: 'STACKS_OVERFLOW_WARN',
  ACTIVITY_LOG: 'ACTIVITY_LOG',
  CONFIG_UPDATED: 'CONFIG_UPDATED',
});

/** Timeouts for on-demand organize (ms). */
export const TIMEOUTS = Object.freeze({
  EXTRACT_MS: 2000,
  CLASSIFY_MS: 8000,
  GROUP_JOB_MS: 60000,
  CACHE_SYNC_DEBOUNCE_MS: 500,
});

/** Chrome tabGroups.TAB_GROUP_ID_NONE stand-in when chrome is unavailable. */
export const TAB_GROUP_ID_NONE = -1;

/** Default config — ADR §6. Secrets stay empty; never commit keys. */
export const DEFAULT_CONFIG = Object.freeze({
  llmProvider: /** @type {LlmProvider | ''} */ (''),
  endpointBaseUrl: '',
  apiKey: '',
  model: '',
  maxOpenTabs: 50,
  cacheSize: 500,
  stackSize: 500,
  groupOnDemandOnly: true,
  autoDedupeEnabled: true,
  autoStackEnabled: true,
  dedupeMode: 'auto-close-older',
  reclaimPolicy: 'least-recently-accessed',
  groupScope: 'cross-window-logical',
  contentExtractionEnabled: true,
  topicLabelLocale: 'en',
  topicGranularity: 'fine',
  searchPinyinEnabled: true,
  searchRank: 'recency-first',
  privacyShowFieldsPreview: true,
  urlNormalizeStripHash: true,
  urlNormalizeStripTrackingParams: true,
  classifyDebounceMs: 500,
});

/** Hard cap for excerpts persisted / sent to LLM (ADR §5.2). */
export const EXCERPT_HARD_CAP_CHARS = 280;

/** Tracking query params stripped during URL normalize (keep other query). */
export const TRACKING_QUERY_PARAMS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  '_ga',
  'ref',
  'ref_src',
]);

/** Schemes / hosts skipped for grouping / reclaim / extract. */
export const SKIP_URL_PREFIXES = Object.freeze([
  'chrome://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'chrome-search://',
]);
