import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_KEY_REDACTED,
  isApiKeyUnchanged,
  sanitizeConfigPatch,
  saveConfig,
  redactConfigForUi,
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

  it('redactConfigForUi uses the sentinel constant', () => {
    const redacted = redactConfigForUi({ apiKey: 'sk-secret', model: 'x' });
    assert.equal(redacted.apiKey, API_KEY_REDACTED);
    assert.equal(redacted.model, 'x');
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
