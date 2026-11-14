import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import {
  CONFIG_FORM_FIELDS,
  formatMetricsListHtml,
  readConfigForm,
  fillConfigForm,
  API_KEY_REDACTED,
  isApiKeyUnchanged,
} from '../shared/options-form.js';

/** Minimal form root for Node (no full DOM). */
function makeRoot(values = {}) {
  /** @type {Map<string, any>} */
  const els = new Map();
  for (const name of CONFIG_FORM_FIELDS) {
    const type =
      name === 'autoDedupeEnabled' || name === 'contentExtractionEnabled'
        ? 'checkbox'
        : name === 'llmProvider' || name === 'dedupeMode'
          ? 'select'
          : name === 'apiKey'
            ? 'password'
            : ['maxOpenTabs', 'cacheSize', 'stackSize', 'dailyLlmQuota'].includes(name)
              ? 'number'
              : 'text';
    const def = values[name] ?? DEFAULT_CONFIG[name] ?? '';
    if (type === 'checkbox') {
      els.set(name, { type, checked: Boolean(def), value: '' });
    } else {
      els.set(name, { type, value: def === undefined || def === null ? '' : String(def) });
    }
  }
  els.set('privacyShowFieldsPreview', { type: 'checkbox', checked: false, value: '' });
  return {
    querySelector(sel) {
      const id = String(sel).replace(/^#/, '');
      return els.get(id) || null;
    },
  };
}

describe('options-form helpers', () => {
  it('lists expected config fields', () => {
    assert.ok(CONFIG_FORM_FIELDS.includes('llmProvider'));
    assert.ok(CONFIG_FORM_FIELDS.includes('maxOpenTabs'));
    assert.ok(CONFIG_FORM_FIELDS.includes('dailyLlmQuota'));
  });

  it('readConfigForm omits empty apiKey and coerces blank thresholds', () => {
    const root = makeRoot({
      apiKey: '',
      maxOpenTabs: '',
      dailyLlmQuota: '0',
      llmProvider: 'anthropic',
    });
    const patch = readConfigForm(root);
    assert.equal('apiKey' in patch, false);
    assert.equal(patch.maxOpenTabs, DEFAULT_CONFIG.maxOpenTabs);
    assert.equal(patch.dailyLlmQuota, 0);
    assert.equal(patch.llmProvider, 'anthropic');
    assert.equal(patch.privacyShowFieldsPreview, true);
  });

  it('fillConfigForm clears redacted apiKey sentinel', () => {
    const root = makeRoot({ apiKey: 'keep-me' });
    fillConfigForm(root, { ...DEFAULT_CONFIG, apiKey: API_KEY_REDACTED });
    assert.equal(root.querySelector('#apiKey').value, '');
    assert.equal(root.querySelector('#privacyShowFieldsPreview').checked, true);
  });

  it('isApiKeyUnchanged treats redacted sentinel as unchanged', () => {
    assert.equal(isApiKeyUnchanged(API_KEY_REDACTED), true);
    assert.equal(isApiKeyUnchanged('sk-real'), false);
  });

  it('formatMetricsListHtml includes quota label', () => {
    const html = formatMetricsListHtml({ organizeRuns: 2, llmCalls: 3 }, 10);
    assert.match(html, /Organize runs/);
    assert.match(html, /: 2</);
    assert.match(html, /dailyLlmQuota/);
    assert.match(html, /10/);
  });
});
