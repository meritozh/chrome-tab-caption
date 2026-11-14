import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUiLocale, t, MESSAGES } from '../sidepanel/i18n.js';
import { DEFAULT_CONFIG, MSG } from '../shared/constants.js';

describe('normalizeUiLocale', () => {
  it('maps zh variants to zh and everything else to en', () => {
    assert.equal(normalizeUiLocale('zh'), 'zh');
    assert.equal(normalizeUiLocale('zh-CN'), 'zh');
    assert.equal(normalizeUiLocale('en'), 'en');
    assert.equal(normalizeUiLocale('fr'), 'en');
  });
});

describe('t', () => {
  it('returns en and zh side-panel strings with params', () => {
    assert.equal(t('en', 'organize.reorganize'), 'Reorganize');
    assert.equal(t('zh', 'organize.reorganize'), '重新整理');
    assert.equal(t('en', 'progress.stacks', { current: 2, total: 5 }), 'Reclassifying stacks 2/5…');
    assert.ok(MESSAGES.en['organize.ready']);
    assert.ok(MESSAGES.zh['organize.ready']);
  });
});

describe('config defaults for uiLocale + REORGANIZE_TABS', () => {
  it('exposes uiLocale default and REORGANIZE_TABS message', () => {
    assert.equal(DEFAULT_CONFIG.uiLocale, 'en');
    assert.equal(MSG.REORGANIZE_TABS, 'REORGANIZE_TABS');
  });
});
