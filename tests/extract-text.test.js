import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_BUFFER_CAP_CHARS,
  cleanStructuredText,
  readMetaDescription,
  readLandmarkText,
  assembleExtractResult,
} from '../shared/extract-text.js';
import { EXCERPT_HARD_CAP_CHARS } from '../shared/constants.js';
import { extractTabContent, callInjectedExtract } from '../content/extract.js';

describe('cleanStructuredText', () => {
  it('collapses whitespace and drops control chars', () => {
    const cleaned = cleanStructuredText('Hello\u0000\n\n  world\t\tthere\n\n\nend');
    assert.equal(cleaned, 'Hello\nworld there\nend');
  });

  it('respects intermediate buffer cap', () => {
    const cleaned = cleanStructuredText('x'.repeat(50), 10);
    assert.equal(cleaned.length, 10);
  });

  it('defaults buffer cap to EXTRACT_BUFFER_CAP_CHARS', () => {
    assert.equal(EXTRACT_BUFFER_CAP_CHARS, 4000);
    const cleaned = cleanStructuredText('a'.repeat(5000));
    assert.equal(cleaned.length, 4000);
  });
});

describe('readMetaDescription / readLandmarkText', () => {
  it('prefers og:description then twitter then description', () => {
    const nodes = {
      'meta[property="og:description"]': {
        getAttribute: () => '  og desc  ',
      },
      'meta[name="description"]': {
        getAttribute: () => 'plain',
      },
    };
    const doc = {
      querySelector(sel) {
        return nodes[sel] || null;
      },
    };
    assert.equal(readMetaDescription(doc), 'og desc');
  });

  it('reads landmark innerText', () => {
    const doc = {
      querySelector(sel) {
        if (sel.includes('article')) {
          return { innerText: '  Article   body  text  ' };
        }
        return null;
      },
      body: { textContent: 'body fallback' },
    };
    assert.equal(readLandmarkText(doc), 'Article body text');
  });
});

describe('assembleExtractResult', () => {
  it('caps readability text at hard excerpt cap', () => {
    const result = assembleExtractResult({
      title: 'T',
      url: 'https://example.test/',
      text: 'y'.repeat(400),
      meta: 'meta unused',
      source: 'readability',
    });
    assert.equal(result.source, 'readability');
    assert.ok(result.excerpt.length <= EXCERPT_HARD_CAP_CHARS);
    assert.equal(result.excerpt.endsWith('…'), true);
  });

  it('falls back to meta then title+URL', () => {
    const withMeta = assembleExtractResult({
      title: 'T',
      url: 'https://example.test/',
      text: '',
      meta: 'From meta description that is useful',
      source: 'empty',
    });
    assert.equal(withMeta.source, 'meta');
    assert.match(withMeta.excerpt, /From meta/);

    const empty = assembleExtractResult({
      title: 'Only title',
      url: 'https://example.test/',
      text: '',
      meta: '',
      source: 'empty',
    });
    assert.equal(empty.source, 'fallback-title-url');
    assert.equal(empty.excerpt, '');
    assert.equal(empty.title, 'Only title');
  });
});

describe('extractTabContent', () => {
  it('fail-soft when scripting unavailable', async () => {
    const prev = globalThis.chrome;
    globalThis.chrome = undefined;
    try {
      const result = await extractTabContent(1, {
        title: 'Hi',
        url: 'https://example.test/',
      });
      assert.equal(result.source, 'fallback-title-url');
      assert.equal(result.title, 'Hi');
      assert.match(result.error || '', /scripting/);
    } finally {
      globalThis.chrome = prev;
    }
  });

  it('injects Readability + extract-page then assembles capped excerpt', async () => {
    const prev = globalThis.chrome;
    /** @type {string[][]} */
    const fileBatches = [];
    globalThis.chrome = {
      scripting: {
        async executeScript(details) {
          if (details.files) {
            fileBatches.push(details.files);
            return [];
          }
          if (details.func) {
            return [
              {
                result: details.func(details.args?.[0]),
              },
            ];
          }
          return [];
        },
      },
    };
    globalThis.__tabCaptionExtractPage = () => ({
      title: 'Page Title',
      meta: 'meta',
      text: 'z'.repeat(500),
      source: 'readability',
    });
    try {
      const result = await extractTabContent(42, {
        title: 'fallback',
        url: 'https://news.test/a',
      });
      assert.deepEqual(fileBatches[0], [
        'vendor/mozilla-readability/Readability.js',
        'content/extract-page.js',
      ]);
      assert.equal(result.source, 'readability');
      assert.equal(result.title, 'Page Title');
      assert.ok(result.excerpt.length <= EXCERPT_HARD_CAP_CHARS);
      assert.equal(result.url, 'https://news.test/a');
    } finally {
      delete globalThis.__tabCaptionExtractPage;
      globalThis.chrome = prev;
    }
  });

  it('times out / errors fall back to title+URL', async () => {
    const prev = globalThis.chrome;
    globalThis.chrome = {
      scripting: {
        async executeScript() {
          throw new Error('CSP blocked');
        },
      },
    };
    try {
      const result = await extractTabContent(7, {
        title: 'Blocked',
        url: 'https://locked.test/',
        timeoutMs: 50,
      });
      assert.equal(result.source, 'fallback-title-url');
      assert.equal(result.title, 'Blocked');
      assert.match(result.error || '', /CSP|extract/i);
    } finally {
      globalThis.chrome = prev;
    }
  });
});

describe('callInjectedExtract', () => {
  it('returns empty when runner missing', () => {
    const prev = globalThis.__tabCaptionExtractPage;
    delete globalThis.__tabCaptionExtractPage;
    try {
      assert.deepEqual(callInjectedExtract(100), {
        title: '',
        meta: '',
        text: '',
        source: 'empty',
      });
    } finally {
      if (prev) globalThis.__tabCaptionExtractPage = prev;
    }
  });
});
