/**
 * Page-world extract runner (classic script).
 * Injected via chrome.scripting.executeScript({ files }) after vendor/Readability.js.
 * No ESM imports — must stay serializable as a classic content script.
 * Exposes globalThis.__tabCaptionExtractPage(opts).
 */
(function initTabCaptionExtractPage(global) {
  /** @param {number} [bufferCap] */
  function readMeta(bufferCap) {
    const selectors = [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]',
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      const content = el && el.getAttribute ? (el.getAttribute('content') || '').trim() : '';
      if (content) {
        return content.length > bufferCap ? content.slice(0, bufferCap) : content;
      }
    }
    return '';
  }

  /** @param {number} [bufferCap] */
  function readLandmarks(bufferCap) {
    const root =
      document.querySelector('article, main, [role="main"]') || document.body;
    if (!root) return '';
    const raw = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.length > bufferCap ? raw.slice(0, bufferCap) : raw;
  }

  /**
   * @param {{ bufferCap?: number }} [opts]
   * @returns {{ title: string, meta: string, text: string, source: string }}
   */
  function extractPageMain(opts) {
    const bufferCap =
      opts && typeof opts.bufferCap === 'number' && opts.bufferCap > 0
        ? opts.bufferCap
        : 4000;
    const title = typeof document !== 'undefined' ? document.title || '' : '';
    const meta = typeof document !== 'undefined' ? readMeta(bufferCap) : '';

    let text = '';
    let source = 'empty';

    if (typeof document !== 'undefined' && typeof global.Readability === 'function') {
      try {
        const clone = document.cloneNode(true);
        const article = new global.Readability(clone).parse();
        const body = article && article.textContent ? String(article.textContent) : '';
        const trimmed = body.replace(/\s+/g, ' ').trim();
        if (trimmed) {
          text = trimmed.length > bufferCap ? trimmed.slice(0, bufferCap) : trimmed;
          source = 'readability';
        }
      } catch (_err) {
        // fail-soft → landmarks / meta
      }
    }

    if (!text && typeof document !== 'undefined') {
      text = readLandmarks(bufferCap);
      if (text) source = 'landmarks';
    }

    if (!text && meta) {
      text = meta;
      source = 'meta';
    }

    return { title, meta, text, source };
  }

  global.__tabCaptionExtractPage = extractPageMain;
})(typeof globalThis !== 'undefined' ? globalThis : self);
