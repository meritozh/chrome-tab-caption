/**
 * Mark extension-initiated closes so they don't pollute user recall lists
 * (ADR §5.4 suppressClosed — Pilot adopt).
 */

/**
 * Close a tab while registering it in closingTabIds first.
 * @param {number} tabId
 * @param {Set<number>} closingTabIds
 * @param {typeof chrome.tabs} [tabsApi]
 * @returns {Promise<{ ok: boolean, tabId: number, suppressClosed: boolean, error?: string }>}
 */
export async function suppressClosedRemove(
  tabId,
  closingTabIds,
  tabsApi = globalThis.chrome?.tabs,
) {
  if (!tabsApi?.remove) {
    return {
      ok: false,
      tabId,
      suppressClosed: false,
      error: 'tabs.remove unavailable',
    };
  }
  closingTabIds.add(tabId);
  try {
    await tabsApi.remove(tabId);
    return { ok: true, tabId, suppressClosed: true };
  } catch (err) {
    closingTabIds.delete(tabId);
    return {
      ok: false,
      tabId,
      suppressClosed: false,
      error: String(err?.message || err),
    };
  }
}
