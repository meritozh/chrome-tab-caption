/**
 * Shared Settings / Options form helpers (Side Panel Settings table + thin Options redirect).
 * API key: empty/redacted omits from patch so SET_CONFIG preserves the stored secret.
 */

import { DEFAULT_CONFIG } from './constants.js';
import { API_KEY_REDACTED, isApiKeyUnchanged } from './config.js';
import { normalizeSeedTopics, seedTopicsToText } from './seed-topics.js';

/** Editable config field ids (same as Side Panel Settings table). */
export const CONFIG_FORM_FIELDS = Object.freeze([
  'llmProvider',
  'endpointBaseUrl',
  'apiKey',
  'model',
  'maxOpenTabs',
  'topicCacheSize',
  'seedTopics',
  'autoDedupeEnabled',
  'dedupeMode',
  'contentExtractionEnabled',
  'dailyLlmQuota',
]);

/**
 * @param {ParentNode} root
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function byId(root, id) {
  // Field ids are alphanumeric; avoid CSS.escape for Node test portability.
  return /** @type {HTMLElement | null} */ (root.querySelector(`#${id}`));
}

/**
 * @param {ParentNode} root
 * @param {Record<string, unknown>} config
 */
export function fillConfigForm(root, config) {
  for (const name of CONFIG_FORM_FIELDS) {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */ (
      byId(root, name)
    );
    if (!el) continue;
    let value = config[name] ?? DEFAULT_CONFIG[name] ?? '';
    // Never put the redacted sentinel into the password field (would wipe on Save).
    if (name === 'apiKey' && isApiKeyUnchanged(value)) {
      value = '';
    }
    if (name === 'seedTopics') {
      el.value = seedTopicsToText(value);
      continue;
    }
    if ('type' in el && el.type === 'checkbox') {
      /** @type {HTMLInputElement} */ (el).checked = Boolean(value);
    } else {
      el.value = value === undefined || value === null ? '' : String(value);
    }
  }
  const privacy = /** @type {HTMLInputElement | null} */ (
    byId(root, 'privacyShowFieldsPreview')
  );
  if (privacy) privacy.checked = true; // ADR #12 — fields listed in Settings
}

/**
 * @param {ParentNode} root
 * @returns {Record<string, unknown>}
 */
export function readConfigForm(root) {
  /** @type {Record<string, unknown>} */
  const patch = {
    privacyShowFieldsPreview: true,
    groupOnDemandOnly: true,
  };
  for (const name of CONFIG_FORM_FIELDS) {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null} */ (
      byId(root, name)
    );
    if (!el) continue;
    if (name === 'apiKey') {
      // Omit empty / redacted so SET_CONFIG preserves the stored secret.
      if (isApiKeyUnchanged(el.value)) continue;
      patch.apiKey = el.value;
      continue;
    }
    if (name === 'seedTopics') {
      // Allow empty list (user cleared seeds); do not fall back to defaults here.
      patch.seedTopics = normalizeSeedTopics(String(el.value ?? '').split(/\r?\n/));
      continue;
    }
    if ('type' in el && el.type === 'checkbox') {
      patch[name] = /** @type {HTMLInputElement} */ (el).checked;
      continue;
    }
    if ('type' in el && el.type === 'number') {
      const raw = String(el.value ?? '').trim();
      const n = Number(raw);
      if (name === 'dailyLlmQuota') {
        // 0 = unlimited; blank falls back to default.
        patch[name] =
          raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CONFIG[name];
        continue;
      }
      // Blank → Number('') === 0, which isFinite — treat empty/non-positive as default.
      patch[name] =
        raw !== '' && Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONFIG[name];
    } else {
      patch[name] = el.value;
    }
  }
  return patch;
}

/**
 * @param {Record<string, unknown>} metrics
 * @param {number} [dailyLlmQuota]
 * @returns {string} HTML for a metrics list
 */
export function formatMetricsListHtml(metrics, dailyLlmQuota = 0) {
  const rows = [
    ['organizeRuns', 'Organize runs'],
    ['llmCalls', 'LLM calls (lifetime)'],
    ['dailyLlmCalls', 'LLM calls (UTC today)'],
    ['classifyErrors', 'Classify errors'],
    ['dedupeCloses', 'Dedupe closes'],
    ['reclaimCount', 'Reclaim count'],
    ['alarmResumes', 'Alarm resumes'],
  ];
  const quotaLabel =
    Number(dailyLlmQuota) > 0 ? String(dailyLlmQuota) : 'unlimited';
  return (
    rows
      .map(
        ([key, label]) =>
          `<li><strong>${label}</strong>: ${Number(metrics?.[key]) || 0}</li>`,
      )
      .join('') + `<li><strong>dailyLlmQuota</strong>: ${quotaLabel}</li>`
  );
}

export { API_KEY_REDACTED, isApiKeyUnchanged };
