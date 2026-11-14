/**
 * Resolve the focused window's active tab id for reclaim/dedupe protection.
 */

/**
 * Prefer the focused window's active tab (not an arbitrary window's .active).
 * @param {chrome.tabs.Tab[]} tabs
 * @param {typeof chrome.tabs} [tabsApi]
 * @param {typeof chrome.windows} [windowsApi]
 * @returns {Promise<number | undefined>}
 */
export async function resolveFocusedActiveTabId(tabs, tabsApi, windowsApi) {
  try {
    if (windowsApi?.getLastFocused) {
      const focused = await windowsApi.getLastFocused();
      if (typeof focused?.id === 'number' && tabsApi?.query) {
        const [active] = await tabsApi.query({ active: true, windowId: focused.id });
        if (typeof active?.id === 'number') return active.id;
      }
      if (typeof focused?.id === 'number') {
        const inFocused = (tabs || []).find((t) => t.windowId === focused.id && t.active);
        if (typeof inFocused?.id === 'number') return inFocused.id;
      }
    }
  } catch {
    // fall through
  }
  const active = (tabs || []).find((t) => t.active);
  return typeof active?.id === 'number' ? active.id : undefined;
}
