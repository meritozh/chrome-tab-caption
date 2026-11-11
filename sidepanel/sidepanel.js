/**
 * Side Panel shell — Organize CTA (stub), search stub, Stacks stub, Settings link.
 * No LLM side-effects here; messages go to the service worker.
 */

import { MSG } from '../shared/constants.js';
import { sendToBackground } from '../shared/messages.js';

const views = {
  main: document.getElementById('view-main'),
  settings: document.getElementById('view-settings'),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    const active = key === name;
    el.classList.toggle('is-active', active);
    el.hidden = !active;
  }
  document.querySelectorAll('.sp-nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
}

document.getElementById('btn-view-main')?.addEventListener('click', () => showView('main'));
document.getElementById('btn-view-settings')?.addEventListener('click', () => showView('settings'));

document.getElementById('link-options')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options/options.html'), '_blank');
  }
});

const organizeBtn = document.getElementById('btn-organize');
const organizeStatus = document.getElementById('organize-status');
organizeBtn?.addEventListener('click', async () => {
  // Remains disabled in Phase 0/1; handler ready for Phase 2 wiring.
  organizeStatus.textContent = 'Organize stub — Phase 2 will send GROUP_TABS after privacy preview.';
  const res = await sendToBackground(MSG.GROUP_TABS, { scope: 'all' }).catch((err) => ({
    ok: false,
    error: String(err),
  }));
  organizeStatus.textContent = res?.error || JSON.stringify(res);
});

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let searchTimer = 0;
searchInput?.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.innerHTML = '<p class="sp-muted">Open / Stacked results appear here (Phase 3).</p>';
      return;
    }
    const res = await sendToBackground(MSG.SEARCH_QUERY, { query }).catch(() => null);
    searchResults.innerHTML = `<p class="sp-muted">Stub search for “${escapeHtml(query)}” — ${
      res?.note || 'Phase 3'
    }</p>`;
  }, 180);
});

document.getElementById('btn-preview')?.addEventListener('click', async () => {
  const out = document.getElementById('preview-out');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await sendToBackground(MSG.PREVIEW_CLASSIFY_PAYLOAD, {
    url: tab?.url ?? '',
    title: tab?.title ?? '',
    snippet: '',
    extractedText: '',
  });
  out.hidden = false;
  out.textContent = JSON.stringify(res?.preview ?? res, null, 2);
});

async function refreshStacks() {
  const list = document.getElementById('stacks-list');
  const res = await sendToBackground(MSG.GET_STACKS).catch(() => null);
  const stacks = res?.stacks ?? [];
  if (!stacks.length) {
    list.innerHTML = '<li class="sp-muted">No stacked tabs yet (reclaim lands in Phase 4).</li>';
    return;
  }
  list.innerHTML = stacks
    .map((s) => `<li><strong>${escapeHtml(s.title || s.url)}</strong><br /><span class="sp-muted">${escapeHtml(s.url)}</span></li>`)
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

refreshStacks();
