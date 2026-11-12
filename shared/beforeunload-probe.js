/**
 * Best-effort beforeunload / dirty-form probe (ADR: imperfect, exclude when detected).
 * Shared by reclaim + dedupe so we never circular-import background modules.
 */

/**
 * @param {number} tabId
 * @param {typeof chrome.scripting | undefined} scriptingApi
 * @returns {Promise<boolean>}
 */
export async function probeBeforeUnloadRisk(
  tabId,
  scriptingApi = globalThis.chrome?.scripting,
) {
  if (typeof tabId !== 'number' || !scriptingApi?.executeScript) return false;
  try {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func: () => {
        if (typeof window.onbeforeunload === 'function') return true;
        try {
          const els = document.querySelectorAll(
            'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
          );
          for (const el of els) {
            if (el instanceof HTMLElement && el.isContentEditable) {
              if ((el.textContent || '').trim().length > 0) return true;
              continue;
            }
            if (
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLSelectElement
            ) {
              if (el.value !== el.defaultValue) return true;
            }
          }
        } catch {
          // page DOM restricted
        }
        return false;
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    // CSP / host permission — fail-soft: do not treat as risk (can't confirm).
    return false;
  }
}
