/**
 * Thin Options entry — Chrome still lists an Options page, but config lives in
 * Side Panel → Settings. This page opens that view (no duplicate form).
 */

import { SESSION_KEYS } from '../shared/constants.js';
import {
  API_KEY_REDACTED,
  fillConfigForm,
  readConfigForm,
} from '../shared/options-form.js';

const statusEl = document.getElementById('redirect-status');
const openBtn = document.getElementById('btn-open-settings');

/**
 * @param {string} text
 */
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

/**
 * Ask the Side Panel to show Settings, then open the panel for this window.
 * Prefer a click gesture — sidePanel.open is most reliable from user input.
 */
async function openSidePanelSettings() {
  setStatus('Opening Side Panel → Settings…');
  try {
    await chrome.storage.session.set({
      [SESSION_KEYS.OPEN_SIDEPANEL_VIEW]: 'settings',
    });
  } catch (err) {
    setStatus(`Could not signal Side Panel: ${String(err?.message || err)}`);
    return;
  }

  try {
    const win = await chrome.windows.getCurrent();
    if (typeof win?.id === 'number') {
      await chrome.sidePanel.open({ windowId: win.id });
      setStatus('Side Panel opened — use the Settings tab.');
      return;
    }
  } catch (err) {
    setStatus(
      `Could not open Side Panel automatically (${String(err?.message || err)}). ` +
        'Click the extension icon, then open Settings.',
    );
    return;
  }
  setStatus('Click the extension toolbar icon, then open Settings.');
}

openBtn?.addEventListener('click', () => {
  void openSidePanelSettings();
});

// Best-effort auto-open when Chrome navigates here from “Extension options”.
void openSidePanelSettings();

// Re-exports keep older imports/tests stable if they pointed at options.js.
export { fillConfigForm as fillForm, readConfigForm as readForm, API_KEY_REDACTED };
