import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_KEY_REDACTED,
  isApiKeyUnchanged,
  sanitizeConfigPatch,
  saveConfig,
  redactConfigForUi,
  resolveTestLlmConfig,
} from '../shared/config.js';
import { STORAGE_KEYS } from '../shared/constants.js';

/** Minimal in-memory chrome.storage.local stand-in. */
function mockStorage(initial = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...initial };
  return {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: data[key] };
        return { ...data };
      },
      async set(obj) {
        Object.assign(data, obj);
      },
      _data: data,
    },
  };
}

describe('apiKey wipe guards', () => {
  it('treats empty and redacted sentinel as unchanged', () => {
    assert.equal(isApiKeyUnchanged(''), true);
    assert.equal(isApiKeyUnchanged('   '), true);
    assert.equal(isApiKeyUnchanged(API_KEY_REDACTED), true);
    assert.equal(isApiKeyUnchanged(null), true);
    assert.equal(isApiKeyUnchanged('sk-real'), false);
  });

  it('sanitizeConfigPatch drops empty and bullet sentinel', () => {
    assert.deepEqual(sanitizeConfigPatch({ model: 'm', apiKey: '' }), { model: 'm' });
    assert.deepEqual(sanitizeConfigPatch({ apiKey: API_KEY_REDACTED, maxOpenTabs: 40 }), {
      maxOpenTabs: 40,
    });
    assert.deepEqual(sanitizeConfigPatch({ apiKey: 'sk-new' }), { apiKey: 'sk-new' });
  });

  it('redactConfigForUi uses the sentinel constant and flags hasApiKey', () => {
    const redacted = redactConfigForUi({ apiKey: 'sk-secret', model: 'x' });
    assert.equal(redacted.apiKey, API_KEY_REDACTED);
    assert.equal(redacted.hasApiKey, true);
    assert.equal(redacted.model, 'x');
    assert.equal(redactConfigForUi({ model: 'x' }).hasApiKey, false);
  });

  it('saveConfig preserves stored apiKey when patch is empty/sentinel', async () => {
    const storage = mockStorage({
      [STORAGE_KEYS.CONFIG]: { apiKey: 'sk-keep-me', model: 'old', maxOpenTabs: 50 },
    });

    await saveConfig({ apiKey: API_KEY_REDACTED, model: 'new' }, storage);
    const afterRedacted = storage.local._data[STORAGE_KEYS.CONFIG];
    assert.equal(afterRedacted.apiKey, 'sk-keep-me');
    assert.equal(afterRedacted.model, 'new');

    await saveConfig({ apiKey: '', maxOpenTabs: 60 }, storage);
    const afterEmpty = storage.local._data[STORAGE_KEYS.CONFIG];
    assert.equal(afterEmpty.apiKey, 'sk-keep-me');
    assert.equal(afterEmpty.maxOpenTabs, 60);

    await saveConfig({ apiKey: 'sk-updated' }, storage);
    const afterReal = storage.local._data[STORAGE_KEYS.CONFIG];
    assert.equal(afterReal.apiKey, 'sk-updated');
  });
});

describe('groupScope migration', () => {
  it('coerces legacy cross-window-logical to single-window-merge', async () => {
    const { mergeConfig } = await import('../shared/config.js');
    const cfg = mergeConfig({ groupScope: 'cross-window-logical', maxOpenTabs: 40 });
    assert.equal(cfg.groupScope, 'single-window-merge');
    assert.equal(cfg.maxOpenTabs, 40);
  });
});

describe('resolveTestLlmConfig (Options Test ↔ TEST_LLM)', () => {
  it('uses stored config when form override is missing', () => {
    const resolved = resolveTestLlmConfig(
      {
        llmProvider: 'anthropic',
        endpointBaseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-stored',
        model: 'claude-stored',
      },
      null,
    );
    assert.equal(resolved.llmProvider, 'anthropic');
    assert.equal(resolved.endpointBaseUrl, 'https://api.anthropic.com');
    assert.equal(resolved.apiKey, 'sk-stored');
    assert.equal(resolved.model, 'claude-stored');
  });

  it('overlays unsaved form provider/endpoint/model onto stored key', () => {
    const resolved = resolveTestLlmConfig(
      {
        llmProvider: 'anthropic',
        endpointBaseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-stored',
        model: 'old-model',
      },
      {
        llmProvider: 'openai-responses',
        endpointBaseUrl: 'https://api.openai.com',
        apiKey: '',
        model: 'gpt-unsaved',
      },
    );
    assert.equal(resolved.llmProvider, 'openai-responses');
    assert.equal(resolved.endpointBaseUrl, 'https://api.openai.com');
    assert.equal(resolved.apiKey, 'sk-stored');
    assert.equal(resolved.model, 'gpt-unsaved');
  });

  it('uses unsaved form apiKey when present (not redacted)', () => {
    const resolved = resolveTestLlmConfig(
      { llmProvider: 'anthropic', apiKey: 'sk-old', model: 'm' },
      {
        llmProvider: 'anthropic',
        endpointBaseUrl: 'https://gateway.example/v1',
        apiKey: 'sk-unsaved-new',
        model: 'm2',
      },
    );
    assert.equal(resolved.apiKey, 'sk-unsaved-new');
    assert.equal(resolved.endpointBaseUrl, 'https://gateway.example/v1');
    assert.equal(resolved.model, 'm2');
  });

  it('keeps stored apiKey when form sends redacted sentinel', () => {
    const resolved = resolveTestLlmConfig(
      { llmProvider: 'anthropic', apiKey: 'sk-keep', endpointBaseUrl: 'https://a.test' },
      {
        llmProvider: 'anthropic',
        apiKey: API_KEY_REDACTED,
        endpointBaseUrl: 'https://b.test',
      },
    );
    assert.equal(resolved.apiKey, 'sk-keep');
    assert.equal(resolved.endpointBaseUrl, 'https://b.test');
  });
});
