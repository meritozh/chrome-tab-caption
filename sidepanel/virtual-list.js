/**
 * Lightweight windowed list for MV3 Side Panel (no framework).
 * Pure range math is exported for unit tests; mountVirtualList binds a scroller.
 */

/**
 * @param {{
 *   scrollTop: number,
 *   viewportHeight: number,
 *   itemHeight: number,
 *   itemCount: number,
 *   overscan?: number,
 * }} opts
 * @returns {{ start: number, end: number }}
 */
export function visibleRange({
  scrollTop,
  viewportHeight,
  itemHeight,
  itemCount,
  overscan = 4,
}) {
  if (itemCount <= 0 || itemHeight <= 0 || viewportHeight < 0) {
    return { start: 0, end: 0 };
  }
  const top = Math.max(0, scrollTop);
  const start = Math.max(0, Math.floor(top / itemHeight) - overscan);
  const end = Math.min(
    itemCount,
    Math.ceil((top + Math.max(viewportHeight, 0)) / itemHeight) + overscan,
  );
  return { start, end: Math.max(start, end) };
}

/**
 * @param {number} itemCount
 * @param {number} itemHeight
 */
export function totalHeight(itemCount, itemHeight) {
  const n = Math.max(0, itemCount | 0);
  const h = Math.max(0, itemHeight);
  return n * h;
}

/**
 * Mount a virtual list into a scroll container.
 * Renders only the visible window (+ overscan) as absolutely positioned children
 * of an inner spacer sized to the full list height.
 *
 * @param {{
 *   container: HTMLElement,
 *   itemHeight: number,
 *   overscan?: number,
 *   getKey: (item: unknown, index: number) => string,
 *   renderItem: (item: unknown, index: number) => HTMLElement,
 * }} options
 */
export function mountVirtualList({
  container,
  itemHeight,
  overscan = 6,
  getKey,
  renderItem,
}) {
  /** @type {unknown[]} */
  let items = [];
  let scrollTop = container.scrollTop || 0;
  let raf = 0;

  const spacer = document.createElement('div');
  spacer.className = 'sp-virtual-spacer';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';
  container.replaceChildren(spacer);

  /** @type {Map<string, HTMLElement>} */
  const pool = new Map();

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }

  function paint() {
    const count = items.length;
    spacer.style.height = `${totalHeight(count, itemHeight)}px`;

    if (count === 0) {
      spacer.replaceChildren();
      pool.clear();
      return;
    }

    const { start, end } = visibleRange({
      scrollTop,
      viewportHeight: container.clientHeight,
      itemHeight,
      itemCount: count,
      overscan,
    });

    /** @type {Set<string>} */
    const keep = new Set();
    const frag = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
      const item = items[i];
      const key = getKey(item, i);
      keep.add(key);
      let el = pool.get(key);
      if (!el) {
        el = renderItem(item, i);
        el.dataset.virtualKey = key;
        pool.set(key, el);
      }
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.top = `${i * itemHeight}px`;
      el.style.height = `${itemHeight}px`;
      el.style.boxSizing = 'border-box';
      frag.appendChild(el);
    }

    for (const [key, el] of pool) {
      if (!keep.has(key)) {
        el.remove();
        pool.delete(key);
      }
    }
    spacer.replaceChildren(frag);
  }

  function onScroll() {
    scrollTop = container.scrollTop;
    schedule();
  }

  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => schedule())
      : null;
  ro?.observe(container);
  container.addEventListener('scroll', onScroll, { passive: true });

  return {
    /**
     * @param {unknown[]} next
     * @param {{ resetScroll?: boolean }} [opts]
     */
    setItems(next, opts = {}) {
      items = Array.isArray(next) ? next : [];
      // Drop cached nodes so title/topic/favicon refresh with new data.
      pool.clear();
      if (opts.resetScroll) {
        container.scrollTop = 0;
        scrollTop = 0;
      }
      paint();
    },
    refresh() {
      paint();
    },
    getItems() {
      return items;
    },
    destroy() {
      container.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      pool.clear();
      container.replaceChildren();
    },
  };
}
