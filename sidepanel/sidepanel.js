/**
 * Side Panel — Organize CTA with privacy preview confirm, search stub, Stacks stub.
 * No LLM side-effects here; messages go to the service worker.
 */

import { MSG } from '../shared/constants.js';
import { sendToBackground, onBackgroundBroadcast } from '../shared/messages.js';
import { ensureEndpointPermission } from '../shared/permissions.js';

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
const confirmBtn = document.getElementById('btn-confirm-organize');
const cancelBtn = document.getElementById('btn-cancel-organize');
const organizeStatus = document.getElementById('organize-status');
const previewPanel = document.getElementById('organize-preview');
const scopeSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('group-scope'));

/** @type {object | null} */
let pendingPreview = null;
let organizeBusy = false;

function setBusy(busy) {
  organizeBusy = busy;
  if (organizeBtn) organizeBtn.disabled = busy;
  if (confirmBtn) confirmBtn.disabled = busy;
  if (scopeSelect) scopeSelect.disabled = busy;
}

function hidePreview() {
  pendingPreview = null;
  if (previewPanel) previewPanel.hidden = true;
}

function renderOrganizePreview(preview) {
  pendingPreview = preview;
  if (!previewPanel) return;
  previewPanel.hidden = false;
  const summary = document.getElementById('organize-preview-summary');
  const fieldsEl = document.getElementById('organize-preview-fields');
  const samplesEl = document.getElementById('organize-preview-samples');
  if (summary) {
    summary.textContent = `${preview.eligibleCount} eligible tabs · ${preview.cacheHits} cache hits · ${preview.cacheMisses} to classify. Fields below are what real classify would send (API key never shown).`;
  }
  if (fieldsEl) {
    fieldsEl.innerHTML = (preview.fieldsTemplate || [])
      .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
      .join('');
  }
  if (samplesEl) {
    samplesEl.hidden = false;
    samplesEl.textContent = JSON.stringify(preview.samples ?? [], null, 2);
  }
}

organizeBtn?.addEventListener('click', async () => {
  if (organizeBusy) return;
  setBusy(true);
  organizeStatus.textContent = 'Building privacy preview…';
  const scope = scopeSelect?.value === 'current' ? 'current' : 'all';
  const res = await sendToBackground(MSG.PREVIEW_GROUP_PAYLOAD, { scope }).catch((err) => ({
    ok: false,
    error: String(err),
  }));
  setBusy(false);
  if (!res?.ok) {
    organizeStatus.textContent = res?.error || 'Preview failed';
    hidePreview();
    return;
  }
  renderOrganizePreview(res.preview);
  organizeStatus.textContent = 'Review fields, then confirm to classify cache misses.';
});

cancelBtn?.addEventListener('click', () => {
  hidePreview();
  organizeStatus.textContent = 'Organize cancelled — no LLM calls.';
});

confirmBtn?.addEventListener('click', async () => {
  if (organizeBusy || !pendingPreview) return;
  setBusy(true);
  organizeStatus.textContent = 'Organizing…';

  // Request endpoint host permission in the user-gesture turn (MV3 requirement).
  const cfg = await sendToBackground(MSG.GET_CONFIG).catch(() => null);
  const endpoint = cfg?.config?.endpointBaseUrl || '';
  if (endpoint && cfg?.config?.hasApiKey && cfg?.config?.llmProvider) {
    const allowed = await ensureEndpointPermission(endpoint);
    if (!allowed) {
      setBusy(false);
      organizeStatus.textContent =
        'Host permission for the LLM endpoint was denied. Grant access, then confirm again.';
      return;
    }
  }

  const scope = scopeSelect?.value === 'current' ? 'current' : 'all';
  const res = await sendToBackground(MSG.GROUP_TABS, {
    scope,
    confirmed: true,
  }).catch((err) => ({ ok: false, error: String(err) }));
  setBusy(false);
  hidePreview();
  if (!res?.ok) {
    organizeStatus.textContent = res?.error || 'Organize failed';
    return;
  }
  const topics = res.logical?.length ?? 0;
  const applied = res.physical?.applied ?? 0;
  organizeStatus.textContent = `Done — ${topics} logical topics, ${applied} physical groups, ${res.classified ?? 0} classified.`;
  renderLogicalTopics(res.logical || []);
});

onBackgroundBroadcast((message) => {
  if (message.type !== MSG.GROUP_PROGRESS) return;
  if (typeof message.message === 'string') {
    organizeStatus.textContent = message.message;
  }
});

function renderLogicalTopics(logical) {
  const list = document.getElementById('topics-list');
  if (!list) return;
  if (!logical.length) {
    list.innerHTML = '<li class="sp-muted">No topics yet — run Organize.</li>';
    return;
  }
  list.innerHTML = logical
    .map(
      (t) =>
        `<li><strong>${escapeHtml(t.label || t.topicKey)}</strong> · ${t.tabIds?.length ?? 0} tabs · windows ${(t.windowIds || []).join(', ') || '—'}</li>`,
    )
    .join('');
}

async function refreshLogicalTopics() {
  const res = await sendToBackground(MSG.GET_LOGICAL_TOPICS).catch(() => null);
  renderLogicalTopics(res?.logical ?? []);
}

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
refreshLogicalTopics();
