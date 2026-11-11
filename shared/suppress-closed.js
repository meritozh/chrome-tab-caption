/**
 * Mark extension-initiated closes so they don't pollute user recall lists
 * (ADR §5.4 suppressClosed — Pilot adopt).
 */

/**
 * Close a tab while registering it in closingTabIds first.
 * On remove failure: only unmark if the tab still exists (a concurrent closer
 * may have already removed it — don't clear the suppress mark prematurely).
 * @param {number} tabId
 * @param {Set<number>} closingTabIds
 * @param {typeof chrome.tabs} [tabsApi]
 * @returns {Promise<{ ok: boolean, tabId: number, suppressClosed: boolean, error?: string, alreadyClosed?: boolean }>}
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
    const stillOpen = await tabStillOpen(tabId, tabsApi);
    if (stillOpen) {
      closingTabIds.delete(tabId);
      return {
        ok: false,
        tabId,
        suppressClosed: false,
        error: String(err?.message || err),
      };
    }
    // Peer already closed it — keep id marked until onRemoved; treat as done.
    return {
      ok: true,
      tabId,
      suppressClosed: true,
      alreadyClosed: true,
    };
  }
}

/**
 * @param {number} tabId
 * @param {typeof chrome.tabs} tabsApi
 */
async function tabStillOpen(tabId, tabsApi) {
  if (!tabsApi?.get) {
    // Can't verify — assume still open so we unmark and report failure.
    return true;
  }
  try {
    await tabsApi.get(tabId);
    return true;
  } catch {
    return false;
  }
}
