/**
 * Options page — LLM endpoint + thresholds + privacy fields preview (always shown).
 */

import { DEFAULT_CONFIG, MSG } from '../shared/constants.js';
import { API_KEY_REDACTED, isApiKeyUnchanged } from '../shared/config.js';
import { sendToBackground } from '../shared/messages.js';

const fields = [
  'llmProvider',
  'endpointBaseUrl',
  'apiKey',
  'model',
  'maxOpenTabs',
  'cacheSize',
  'stackSize',
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
    if (el.type === 'number') {
      const n = Number(el.value);
      patch[name] = Number.isFinite(n) ? n : DEFAULT_CONFIG[name];
    } else {
      patch[name] = el.value;
    }
  }
  return patch;
}

async function load() {
  const res = await sendToBackground(MSG.GET_CONFIG);
  fillForm(res?.config ?? DEFAULT_CONFIG);
}

document.getElementById('options-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('save-status');
  const patch = readForm();
  const res = await sendToBackground(MSG.SET_CONFIG, { patch });
  status.textContent = res?.ok ? 'Saved.' : `Save failed: ${res?.error || 'unknown'}`;
  if (res?.config) fillForm(res.config);
});

document.getElementById('btn-test-llm')?.addEventListener('click', async () => {
  const status = document.getElementById('test-status');
  status.textContent = 'Testing (mock)…';
  const res = await sendToBackground(MSG.TEST_LLM, {
    url: 'https://example.com/connection-test',
    title: 'Connection test',
  });
  status.textContent = res?.ok
    ? `Mock OK — topic “${res.result?.topic ?? '?'}” (${res.note || 'stub'})`
    : `Failed: ${res?.error || 'unknown'}`;
});

// Exported for tests (browser ignores unused bindings on module side effects)
export { fillForm, readForm, API_KEY_REDACTED };

load();
