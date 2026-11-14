/**
 * Options page — LLM endpoint + thresholds + privacy fields preview (always shown).
 */

import { DEFAULT_CONFIG, MSG } from '../shared/constants.js';
import { API_KEY_REDACTED, isApiKeyUnchanged } from '../shared/config.js';
import { sendToBackground } from '../shared/messages.js';
import { requestOrganizePermissions } from '../shared/permissions.js';

const fields = [
  'llmProvider',
  'endpointBaseUrl',
  'apiKey',
  'model',
  'maxOpenTabs',
  'cacheSize',
  'stackSize',
  'autoDedupeEnabled',
  'dedupeMode',
  'contentExtractionEnabled',
  'dailyLlmQuota',
];

/**
 * @param {Record<string, unknown>} config
 */
function fillForm(config) {
  for (const name of fields) {
    const el = document.getElementById(name);
    if (!el) continue;
    let value = config[name] ?? DEFAULT_CONFIG[name] ?? '';
    // Never put the redacted sentinel into the password field (would wipe on Save).
    if (name === 'apiKey' && isApiKeyUnchanged(value)) {
      value = '';
    }
    if (el.type === 'checkbox') {
      el.checked = Boolean(value);
    } else {
      el.value = value === undefined || value === null ? '' : String(value);
    }
  }
  const privacy = document.getElementById('privacyShowFieldsPreview');
  if (privacy) privacy.checked = true; // ADR #12 — always on
}

function readForm() {
  /** @type {Record<string, unknown>} */
  const patch = {
    privacyShowFieldsPreview: true,
    groupOnDemandOnly: true,
  };
  for (const name of fields) {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | null} */ (
      document.getElementById(name)
    );
    if (!el) continue;
    if (name === 'apiKey') {
      // Omit empty / redacted so SET_CONFIG preserves the stored secret.
      if (isApiKeyUnchanged(el.value)) continue;
      patch.apiKey = el.value;
      continue;
    }
    if (el.type === 'checkbox') {
      patch[name] = /** @type {HTMLInputElement} */ (el).checked;
      continue;
    }
    if (el.type === 'number') {
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
 */
function renderMetrics(metrics, dailyLlmQuota = 0) {
  const list = document.getElementById('metrics-list');
  if (!list) return;
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
  list.innerHTML =
    rows
      .map(
        ([key, label]) =>
          `<li><strong>${label}</strong>: ${Number(metrics?.[key]) || 0}</li>`,
      )
      .join('') + `<li><strong>dailyLlmQuota</strong>: ${quotaLabel}</li>`;
}

async function load() {
  const [res, metricsRes] = await Promise.all([
    sendToBackground(MSG.GET_CONFIG),
    sendToBackground(MSG.GET_METRICS).catch(() => null),
  ]);
  fillForm(res?.config ?? DEFAULT_CONFIG);
  renderMetrics(
    metricsRes?.metrics || {},
    metricsRes?.dailyLlmQuota ?? res?.config?.dailyLlmQuota ?? 0,
  );
}

document.getElementById('options-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('save-status');
  const patch = readForm();
  const res = await sendToBackground(MSG.SET_CONFIG, { patch });
  status.textContent = res?.ok ? 'Saved.' : `Save failed: ${res?.error || 'unknown'}`;
  if (res?.config) fillForm(res.config);
  const metricsRes = await sendToBackground(MSG.GET_METRICS).catch(() => null);
  renderMetrics(
    metricsRes?.metrics || {},
    metricsRes?.dailyLlmQuota ?? res?.config?.dailyLlmQuota ?? 0,
  );
});

document.getElementById('btn-test-llm')?.addEventListener('click', async () => {
  const status = document.getElementById('test-status');
  status.textContent = 'Testing live LLM…';
  // Sync form read only — FIRST await must be permissions.request (user gesture).
  const form = readForm();
  const provider = /** @type {string} */ (form.llmProvider || '');
  const endpointBaseUrl = /** @type {string} */ (form.endpointBaseUrl || '');
  const allowed = await requestOrganizePermissions({
    endpointBaseUrl,
    provider,
    includeExtractHosts: false,
    includeAllProviderDefaults: true,
  });
  if (!allowed) {
    status.textContent =
      'Host permission denied. Grant LLM endpoint access, then Test connection again.';
    return;
  }
  const res = await sendToBackground(MSG.TEST_LLM, {
    url: 'https://example.com/connection-test',
    title: 'Connection test',
  });
  status.textContent = res?.ok
    ? `Live OK — topic “${res.result?.topic ?? '?'}”. Endpoint reachable.`
    : `Failed: ${res?.error || 'unknown'}`;
});

// Exported for tests (browser ignores unused bindings on module side effects)
export { fillForm, readForm, API_KEY_REDACTED };

load();
