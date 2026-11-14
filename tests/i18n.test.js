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

  it('resolves nested i18n param keys at render time (locale-switch safe)', () => {
    const params = {
      topics: 2,
      applied: 3,
      merged: { key: 'organize.merged' },
      stacked: { key: 'organize.stacked', params: { n: 1 } },
      classified: 4,
    };
    const en = t('en', 'organize.done', params);
    const zh = t('zh', 'organize.done', params);
    assert.match(en, /merged to one window/);
    assert.match(en, /1 stacked/);
    assert.match(zh, /已合并到一个窗口/);
    assert.match(zh, /堆栈 1 个/);

    const cancelEn = t('en', 'organize.cancelWithLlm', {
      attempted: 1,
      callWord: { key: 'organize.call' },
      classifiedNote: { key: 'organize.classifiedNote', params: { n: 2 } },
    });
    const cancelZh = t('zh', 'organize.cancelWithLlm', {
      attempted: 1,
      callWord: { key: 'organize.call' },
      classifiedNote: { key: 'organize.classifiedNote', params: { n: 2 } },
    });
    assert.match(cancelEn, /1 LLM call/);
    assert.match(cancelEn, /2 classified/);
    assert.match(cancelZh, /1 次 LLM 调用/);
    assert.match(cancelZh, /已分类 2/);
  });
});

describe('config defaults for uiLocale + REORGANIZE_TABS', () => {
  it('exposes uiLocale default and REORGANIZE_TABS message', () => {
    assert.equal(DEFAULT_CONFIG.uiLocale, 'en');
    assert.equal(MSG.REORGANIZE_TABS, 'REORGANIZE_TABS');
  });
});
