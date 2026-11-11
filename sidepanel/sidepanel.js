/**
 * Side Panel — Organize CTA with privacy preview confirm, search stub, Stacks stub.
 * No LLM side-effects here; messages go to the service worker.
 */

import { MSG } from '../shared/constants.js';
import { sendToBackground, onBackgroundBroadcast } from '../shared/messages.js';
import { requestOrganizePermissions } from '../shared/permissions.js';
import {
  formatOrganizeCancelMessage,
  isPreviewOnlyCancel,
  shouldApplyOrganizeCompletion,
} from '../shared/organize-cancel.js';

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

/**
 * @typedef {object} PendingOrganize
 * @property {string} scope
 * @property {number | undefined} windowId
 * @property {number} eligibleCount
 * @property {number} cacheHits
 * @property {number} cacheMisses
 * @property {string[]} fieldsTemplate
 * @property {unknown[]} samples
 * @property {string} endpointBaseUrl
 * @property {string} llmProvider
 * @property {boolean} hasApiKey
 */

/** @type {PendingOrganize | null} */
let pendingPreview = null;
let organizeBusy = false;

/**
 * Generation token — Cancel bumps this so in-flight Confirm / progress cannot update UI.
 * @type {number}
 */
let organizeRunId = 0;
/** @type {'idle' | 'preview' | 'confirming' | 'running' | 'cancelling'} */
let organizePhase = 'idle';
/** @type {string | null} */
let activeJobId = null;
/** Last known LLM calls started for this run (from progress / job result). */
let lastLlmCallsAttempted = 0;
let lastClassified = 0;

function setBusy(busy) {
  organizeBusy = busy;
  if (organizeBtn) organizeBtn.disabled = busy;
  if (confirmBtn) confirmBtn.disabled = busy;
  // Cancel stays enabled so the user can abort confirming / running jobs.
  if (cancelBtn) cancelBtn.disabled = false;
  // Keep scope locked while a preview is pending so Confirm matches what was reviewed.
  if (scopeSelect) scopeSelect.disabled = busy || Boolean(pendingPreview);
}

function hidePreview() {
  pendingPreview = null;
  if (previewPanel) previewPanel.hidden = true;
  if (scopeSelect && !organizeBusy) scopeSelect.disabled = false;
}

function setOrganizeIdle() {
  organizePhase = 'idle';
  activeJobId = null;
  setBusy(false);
}

/**
 * Window hosting the side panel (not sender.tab — panels have no tab).
 * @returns {Promise<number | undefined>}
 */
async function getPanelWindowId() {
  try {
    const win = await chrome.windows.getCurrent();
    return win?.id;
  } catch {
    return undefined;
  }
}

function renderOrganizePreview(preview, meta) {
  pendingPreview = {
    scope: meta.scope,
    windowId: meta.windowId,
    eligibleCount: preview.eligibleCount,
    cacheHits: preview.cacheHits,
    cacheMisses: preview.cacheMisses,
    fieldsTemplate: preview.fieldsTemplate || [],
    samples: preview.samples || [],
    endpointBaseUrl: meta.endpointBaseUrl || '',
    llmProvider: meta.llmProvider || '',
    hasApiKey: Boolean(meta.hasApiKey),
  };
  organizePhase = 'preview';
  if (!previewPanel) return;
  previewPanel.hidden = false;
  if (scopeSelect) {
    scopeSelect.value = pendingPreview.scope;
    scopeSelect.disabled = true;
  }
  const summary = document.getElementById('organize-preview-summary');
  const fieldsEl = document.getElementById('organize-preview-fields');
  const samplesEl = document.getElementById('organize-preview-samples');
  if (summary) {
    summary.textContent = `${preview.eligibleCount} eligible tabs · ${preview.cacheHits} cache hits · ${preview.cacheMisses} to classify (scope: ${pendingPreview.scope}). Fields below are what real classify would send (API key never shown).`;
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
  organizePhase = 'idle';
  organizeStatus.textContent = 'Building privacy preview…';
  const scope = scopeSelect?.value === 'current' ? 'current' : 'all';
  const windowId = await getPanelWindowId();
  const [res, cfg] = await Promise.all([
    sendToBackground(MSG.PREVIEW_GROUP_PAYLOAD, { scope, windowId }).catch((err) => ({
      ok: false,
      error: String(err),
    })),
    sendToBackground(MSG.GET_CONFIG).catch(() => null),
  ]);
  setBusy(false);
  if (!res?.ok) {
    organizeStatus.textContent = res?.error || 'Preview failed';
    hidePreview();
    organizePhase = 'idle';
    return;
  }
  renderOrganizePreview(res.preview, {
    scope: res.preview?.scope === 'current' ? 'current' : scope,
    windowId,
    endpointBaseUrl: cfg?.config?.endpointBaseUrl || '',
    llmProvider: cfg?.config?.llmProvider || '',
    hasApiKey: Boolean(cfg?.config?.hasApiKey),
  });
  organizeStatus.textContent = 'Review fields, then confirm to classify cache misses.';
});

cancelBtn?.addEventListener('click', async () => {
  const phase = organizePhase;
  const cancelledRunId = organizeRunId;
  // Invalidate any in-flight Confirm handler (permission await or GROUP_TABS).
  organizeRunId += 1;

  if (isPreviewOnlyCancel(phase)) {
    hidePreview();
    setOrganizeIdle();
    lastLlmCallsAttempted = 0;
    lastClassified = 0;
    organizeStatus.textContent = formatOrganizeCancelMessage({ llmCallsAttempted: 0 });
    return;
  }

  if (phase === 'confirming') {
    // Permission step — no LLM yet; mark this run cancelled in SW in case GROUP_TABS races.
    hidePreview();
    setOrganizeIdle();
    lastLlmCallsAttempted = 0;
    lastClassified = 0;
    organizeStatus.textContent = formatOrganizeCancelMessage({ llmCallsAttempted: 0 });
    sendToBackground(MSG.CANCEL_GROUP, { clientRunId: cancelledRunId }).catch(() => {});
    return;
  }

  if (phase === 'running' || phase === 'cancelling') {
    organizePhase = 'cancelling';
    organizeStatus.textContent = 'Cancelling…';
    hidePreview();
    await sendToBackground(MSG.CANCEL_GROUP, { clientRunId: cancelledRunId }).catch(() => {});
    // Confirm handler will refine copy from the cancelled job result when it returns;
    // show best-known progress counts immediately (never invent "no LLM" if we saw calls).
    organizeStatus.textContent = formatOrganizeCancelMessage({
      llmCallsAttempted: lastLlmCallsAttempted,
      classified: lastClassified,
    });
    setOrganizeIdle();
    return;
  }

  hidePreview();
  setOrganizeIdle();
  organizeStatus.textContent = formatOrganizeCancelMessage({ llmCallsAttempted: 0 });
});

confirmBtn?.addEventListener('click', async () => {
  if (organizeBusy || !pendingPreview) return;
  const pending = pendingPreview;
  const runId = (organizeRunId += 1);
  lastLlmCallsAttempted = 0;
  lastClassified = 0;
  activeJobId = null;
  organizePhase = 'confirming';
  setBusy(true);
  organizeStatus.textContent = 'Organizing…';

  // FIRST await must be permissions.request to preserve the click user gesture.
  // Always request (not gated on stale hasApiKey): covers key/provider saved after preview.
  // Includes both public provider defaults + preview endpoint + extract hosts.
  const allowed = await requestOrganizePermissions({
    endpointBaseUrl: pending.endpointBaseUrl,
    provider: pending.llmProvider,
    includeExtractHosts: true,
    includeAllProviderDefaults: true,
  });

  if (runId !== organizeRunId) {
    // Cancelled during permission prompt — do not start GROUP_TABS.
    return;
  }

  if (!allowed) {
    setBusy(false);
    organizePhase = 'preview';
    if (scopeSelect) scopeSelect.disabled = true;
    organizeStatus.textContent =
      'Host permission denied. Grant LLM + page access, then Confirm again.';
    return;
  }

  organizePhase = 'running';
  if (runId !== organizeRunId) {
    // Cancelled after permission grant, before GROUP_TABS dispatch.
    return;
  }
  const res = await sendToBackground(MSG.GROUP_TABS, {
    scope: pending.scope,
    windowId: pending.windowId,
    confirmed: true,
    clientRunId: runId,
  }).catch((err) => ({ ok: false, error: String(err) }));

  const stillActive = shouldApplyOrganizeCompletion({
    runId,
    activeRunId: organizeRunId,
    cancelRequested: false,
  });

  if (!stillActive) {
    // Cancel already updated status; absorb stale completion.
    if (res?.cancelled) {
      lastLlmCallsAttempted = Number(res.llmCallsAttempted) || lastLlmCallsAttempted;
      lastClassified = Number(res.classified) || lastClassified;
      organizeStatus.textContent = formatOrganizeCancelMessage({
        llmCallsAttempted: lastLlmCallsAttempted,
        classified: lastClassified,
      });
      if (Array.isArray(res.logical) && res.logical.length) {
        renderLogicalTopics(res.logical);
      }
    }
    setOrganizeIdle();
    return;
  }

  if (res?.cancelled) {
    hidePreview();
    lastLlmCallsAttempted = Number(res.llmCallsAttempted) || 0;
    lastClassified = Number(res.classified) || 0;
    organizeStatus.textContent =
      res.message ||
      formatOrganizeCancelMessage({
        llmCallsAttempted: lastLlmCallsAttempted,
        classified: lastClassified,
      });
    if (Array.isArray(res.logical) && res.logical.length) {
      renderLogicalTopics(res.logical);
    }
    setOrganizeIdle();
    return;
  }

  setBusy(false);
  if (!res?.ok) {
    // Keep preview open so Confirm retains a user-gesture path (e.g. needsPermission).
    organizePhase = 'preview';
    if (scopeSelect) scopeSelect.disabled = true;
    organizeStatus.textContent = res?.needsPermission
      ? `${res.error || 'Host permission missing.'} Confirm again after granting access.`
      : res?.error || 'Organize failed';
    return;
  }
  hidePreview();
  organizePhase = 'idle';
  const topics = res.logical?.length ?? 0;
  const applied = res.physical?.applied ?? 0;
  organizeStatus.textContent = `Done — ${topics} logical topics, ${applied} physical groups, ${res.classified ?? 0} classified.`;
  renderLogicalTopics(res.logical || []);
});

onBackgroundBroadcast((message) => {
  if (message.type === MSG.STACKS_OVERFLOW_WARN) {
    showStacksOverflow(message);
    refreshStacks();
    return;
  }
  if (message.type === MSG.CONFIG_UPDATED && pendingPreview) {
    organizeRunId += 1;
    hidePreview();
    setOrganizeIdle();
    organizeStatus.textContent =
      'Settings changed — run Organize again to refresh the privacy preview.';
    return;
  }
  if (message.type !== MSG.GROUP_PROGRESS) return;

  // Ignore progress for superseded / cancelled runs.
  if (organizePhase === 'idle' || organizePhase === 'preview' || organizePhase === 'confirming') {
    return;
  }
  if (typeof message.jobId === 'string') {
    if (!activeJobId) activeJobId = message.jobId;
    else if (activeJobId !== message.jobId) return;
  }
  if (typeof message.llmCallsAttempted === 'number') {
    lastLlmCallsAttempted = message.llmCallsAttempted;
  }
  if (typeof message.classified === 'number') {
    lastClassified = message.classified;
  }
  if (message.phase === 'cancelled') {
    organizeStatus.textContent =
      typeof message.message === 'string'
        ? message.message
        : formatOrganizeCancelMessage({
            llmCallsAttempted: lastLlmCallsAttempted,
            classified: lastClassified,
          });
    return;
  }
  // Suppress stale "Done" if user already cancelled.
  if (organizePhase === 'cancelling') return;
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
const searchStatus = document.getElementById('search-status');
let searchTimer = 0;
/** @type {number} */
let searchRequestId = 0;
/** @type {Array<{ partition: string, tabId?: number | null, stackId?: string | null, title?: string, url?: string, topicLabel?: string | null }>} */
let flatSearchHits = [];
/** @type {number} */
let activeSearchIndex = -1;

function setSearchStatus(text, { hidden = !text } = {}) {
  if (!searchStatus) return;
  searchStatus.hidden = hidden;
  searchStatus.textContent = text || '';
}

/**
 * @param {{ ok?: boolean, open?: object[], stacked?: object[], error?: string } | null} res
 * @param {string} query
 * @param {{ transportError?: string } | null} [fail]
 */
function renderSearchResults(res, query, fail = null) {
  if (!searchResults) return;

  if (!query) {
    flatSearchHits = [];
    activeSearchIndex = -1;
    searchResults.innerHTML = '<p class="sp-muted">Type to search Open tabs and Stacked records.</p>';
    return;
  }

  const transportError = fail?.transportError;
  const workerError = res && res.ok === false ? res.error || 'Search failed' : null;
  if (transportError || workerError) {
    flatSearchHits = [];
    activeSearchIndex = -1;
    const msg = transportError || workerError;
    searchResults.innerHTML = `<p class="sp-muted">Search error: ${escapeHtml(String(msg))}</p>`;
    setSearchStatus(String(msg));
    return;
  }

  const open = Array.isArray(res?.open) ? res.open : [];
  const stacked = Array.isArray(res?.stacked) ? res.stacked : [];
  flatSearchHits = [...open, ...stacked];
  activeSearchIndex = flatSearchHits.length ? 0 : -1;

  if (!flatSearchHits.length) {
    searchResults.innerHTML = `<p class="sp-muted">No matches for “${escapeHtml(query)}”.</p>`;
    return;
  }

  const parts = [];
  parts.push(renderSearchPartition('Open', open, 0));
  parts.push(renderSearchPartition('Stacked', stacked, open.length));
  searchResults.innerHTML = parts.join('');
  syncSearchActiveClass();
}

/**
 * @param {string} label
 * @param {object[]} hits
 * @param {number} indexOffset
 */
function renderSearchPartition(label, hits, indexOffset) {
  if (!hits.length) {
    const empty =
      label === 'Stacked' ? 'No stacked matches.' : 'No open-tab matches.';
    return `<div class="sp-search-section"><h3 class="sp-search-heading">${escapeHtml(
      label,
    )}</h3><p class="sp-muted">${escapeHtml(empty)}</p></div>`;
  }
  const items = hits
    .map((hit, i) => {
      const flatIndex = indexOffset + i;
      const meta = [hit.topicLabel, hit.url].filter(Boolean).join(' · ');
      return `<button type="button" class="sp-search-item" role="option" data-flat-index="${flatIndex}" id="search-hit-${flatIndex}">
        <span class="sp-search-title">${escapeHtml(hit.title || hit.url || '(untitled)')}</span>
        <span class="sp-search-meta">${escapeHtml(meta)}</span>
      </button>`;
    })
    .join('');
  return `<div class="sp-search-section"><h3 class="sp-search-heading">${escapeHtml(
    label,
  )}</h3><div class="sp-search-list" role="listbox">${items}</div></div>`;
}

function syncSearchActiveClass() {
  searchResults?.querySelectorAll('.sp-search-item').forEach((el) => {
    const idx = Number(el.getAttribute('data-flat-index'));
    el.classList.toggle('is-active', idx === activeSearchIndex);
    if (idx === activeSearchIndex) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

/**
 * @param {number} delta
 */
function moveSearchSelection(delta) {
  if (!flatSearchHits.length) return;
  const n = flatSearchHits.length;
  activeSearchIndex = (activeSearchIndex + delta + n) % n;
  syncSearchActiveClass();
}

async function activateSearchHit(hit) {
  if (!hit) return;
  if (hit.partition === 'open' && hit.tabId != null) {
    const res = await sendToBackground(MSG.ACTIVATE_TAB, { tabId: hit.tabId }).catch((err) => ({
      ok: false,
      error: String(err),
    }));
    setSearchStatus(res?.ok ? `Focused: ${hit.title || hit.url}` : res?.error || 'Activate failed');
    return;
  }
  if (hit.partition === 'stacked' && hit.stackId) {
    const res = await sendToBackground(MSG.RECALL_STACK, { stackId: hit.stackId }).catch((err) => ({
      ok: false,
      error: String(err),
    }));
    setSearchStatus(
      res?.ok
        ? `Recalled: ${hit.title || hit.url}${res.groupRestore?.restored ? ' (group restored)' : ''}`
        : res?.error || 'Recall failed',
    );
    if (res?.ok) refreshStacks();
    return;
  }
  setSearchStatus('Nothing to activate.');
}

searchResults?.addEventListener('click', (e) => {
  const btn = /** @type {HTMLElement | null} */ (
    e.target instanceof Element ? e.target.closest('.sp-search-item') : null
  );
  if (!btn) return;
  const idx = Number(btn.getAttribute('data-flat-index'));
  if (!Number.isFinite(idx)) return;
  activeSearchIndex = idx;
  syncSearchActiveClass();
  activateSearchHit(flatSearchHits[idx]);
});

searchInput?.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const query = searchInput.value.trim();
    const reqId = ++searchRequestId;
    setSearchStatus('');
    if (!query) {
      flatSearchHits = [];
      activeSearchIndex = -1;
      renderSearchResults(null, '');
      return;
    }
    let transportError = '';
    const res = await sendToBackground(MSG.SEARCH_QUERY, { query }).catch((err) => {
      transportError = String(err?.message || err || 'Search request failed');
      return null;
    });
    if (reqId !== searchRequestId) return;
    renderSearchResults(res, query, transportError ? { transportError } : null);
  }, 160);
});

searchInput?.addEventListener('keydown', (e) => {
  // Let IME compose (Chinese pinyin candidates, etc.) own arrows/Enter.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSearchSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSearchSelection(-1);
  } else if (e.key === 'Enter') {
    if (activeSearchIndex >= 0 && flatSearchHits[activeSearchIndex]) {
      e.preventDefault();
      activateSearchHit(flatSearchHits[activeSearchIndex]);
    }
  }
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

/**
 * @param {object | null | undefined} pending
 */
function showStacksOverflow(pending) {
  const panel = document.getElementById('stacks-overflow');
  const summary = document.getElementById('stacks-overflow-summary');
  if (!panel) return;
  if (!pending?.needsUserAction) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  if (summary) {
    const count = pending.stackCount ?? '—';
    const max = pending.stackSize ?? '—';
    const blocked = pending.blocked ?? 1;
    summary.textContent = `Archive at capacity (${count}/${max}). Choose export or discard to free space for ${blocked} more reclaim(s). Reclaim is paused until then.`;
  }
}

function setStacksStatus(text) {
  const el = document.getElementById('stacks-status');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
}

/**
 * Trigger browser download for exported stacks JSON.
 * @param {string} json
 */
function downloadStacksExport(json) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tab-caption-stacks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function resolveStacksOverflow(action) {
  setStacksStatus(action === 'export' ? 'Exporting…' : 'Discarding oldest…');
  const res = await sendToBackground(MSG.EXPORT_OR_DISCARD_STACKS, { action }).catch((err) => ({
    ok: false,
    error: String(err),
  }));
  if (!res?.ok) {
    setStacksStatus(res?.error || 'Overflow action failed');
    return;
  }
  if (action === 'export' && typeof res.exportJson === 'string') {
    downloadStacksExport(res.exportJson);
  }
  showStacksOverflow(null);
  setStacksStatus(
    action === 'export'
      ? `Exported and freed ${res.discarded ?? 0} oldest record(s).`
      : `Discarded ${res.discarded ?? 0} oldest record(s).`,
  );
  await refreshStacks();
}

document.getElementById('btn-stacks-export')?.addEventListener('click', () => {
  resolveStacksOverflow('export');
});
document.getElementById('btn-stacks-discard')?.addEventListener('click', () => {
  resolveStacksOverflow('discard');
});

async function recallStackById(stackId, title) {
  const res = await sendToBackground(MSG.RECALL_STACK, { stackId }).catch((err) => ({
    ok: false,
    error: String(err),
  }));
  setStacksStatus(
    res?.ok
      ? `Recalled: ${title || stackId}${res.groupRestore?.restored ? ' (group restored)' : ''}`
      : res?.error || 'Recall failed',
  );
  if (res?.ok) await refreshStacks();
}

async function refreshStacks() {
  const list = document.getElementById('stacks-list');
  if (!list) return;
  const res = await sendToBackground(MSG.GET_STACKS).catch(() => null);
  const stacks = res?.stacks ?? [];
  showStacksOverflow(res?.overflowPending);

  if (!stacks.length) {
    list.innerHTML =
      '<li class="sp-muted">No stacked tabs yet — reclaim runs when open tabs exceed maxOpenTabs.</li>';
    return;
  }
  list.innerHTML = stacks
    .map((s) => {
      const meta = [s.topicLabel || s.groupTitle, s.url].filter(Boolean).join(' · ');
      return `<li class="sp-stack-item" data-stack-id="${escapeHtml(s.id)}">
        <div>
          <strong>${escapeHtml(s.title || s.url)}</strong><br />
          <span class="sp-muted">${escapeHtml(meta)}</span>
        </div>
        <div class="sp-stack-actions">
          <button type="button" class="sp-secondary sp-stack-recall" data-stack-id="${escapeHtml(s.id)}">Recall</button>
        </div>
      </li>`;
    })
    .join('');
}

document.getElementById('stacks-list')?.addEventListener('click', (e) => {
  const btn = /** @type {HTMLElement | null} */ (
    e.target instanceof Element ? e.target.closest('.sp-stack-recall') : null
  );
  if (!btn) return;
  const stackId = btn.getAttribute('data-stack-id');
  if (!stackId) return;
  const item = btn.closest('.sp-stack-item');
  const title = item?.querySelector('strong')?.textContent || stackId;
  recallStackById(stackId, title);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

refreshStacks();
refreshLogicalTopics();
