/**
 * Page-world extract runner (classic script).
 * Injected via chrome.scripting.executeScript({ files }) after vendor/Readability.js.
 * No ESM imports — must stay serializable as a classic content script.
 * Exposes globalThis.__tabCaptionExtractPage(opts).
 *
 * Always gathers meta + landmarks first (cheap). Readability only runs when
 * skipReadability is false and document element count ≤ maxElemsToParse.
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
   * @param {{
   *   bufferCap?: number,
   *   maxElemsToParse?: number,
   *   skipReadability?: boolean,
   * }} [opts]
   * @returns {{ title: string, meta: string, text: string, source: string }}
   */
  function extractPageMain(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const bufferCap =
      typeof o.bufferCap === 'number' && o.bufferCap > 0 ? o.bufferCap : 4000;
    const maxElems =
      typeof o.maxElemsToParse === 'number' && o.maxElemsToParse > 0
        ? o.maxElemsToParse
        : 3000;
    const skipReadability = Boolean(o.skipReadability);

    const title = typeof document !== 'undefined' ? document.title || '' : '';
    const meta = typeof document !== 'undefined' ? readMeta(bufferCap) : '';
    const landmarks =
      typeof document !== 'undefined' ? readLandmarks(bufferCap) : '';

    let text = landmarks;
    let source = landmarks ? 'landmarks' : meta ? 'meta' : 'empty';
    if (!landmarks && meta) {
      text = meta;
    }

    if (
      !skipReadability &&
      typeof document !== 'undefined' &&
      typeof global.Readability === 'function'
    ) {
      try {
        const numTags = document.getElementsByTagName('*').length;
        // Skip clone+parse entirely on oversized DOMs (also enforced inside Readability).
        if (numTags <= maxElems) {
          const clone = document.cloneNode(true);
          const article = new global.Readability(clone, {
            maxElemsToParse: maxElems,
          }).parse();
          const body = article && article.textContent ? String(article.textContent) : '';
          const trimmed = body.replace(/\s+/g, ' ').trim();
          if (trimmed) {
            text = trimmed.length > bufferCap ? trimmed.slice(0, bufferCap) : trimmed;
            source = 'readability';
          }
        }
      } catch (_err) {
        // Keep landmarks/meta already gathered.
      }
    }

    return { title, meta, text, source };
  }

  global.__tabCaptionExtractPage = extractPageMain;
})(typeof globalThis !== 'undefined' ? globalThis : self);
