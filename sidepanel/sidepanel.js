/**
 * Side Panel — primary Organize UI (one-click apply), Search, Stacks.
 * Toolbar icon toggles this panel; Options is settings-only.
 * No LLM side-effects here; messages go to the service worker.
 */

import { MSG, STORAGE_KEYS } from '../shared/constants.js';
import { sendToBackground, onBackgroundBroadcast } from '../shared/messages.js';
import { requestOrganizePermissions } from '../shared/permissions.js';
import {
  isIdleOrganizeCancel,
  shouldApplyOrganizeCompletion,
  shouldApplySettingsRetryCompletion,
  shouldMarkOrganizeConfigReady,
} from '../shared/organize-cancel.js';
import { mountVirtualList } from './virtual-list.js';
import { applyDomI18n, normalizeUiLocale, t } from './i18n.js';

/** @type {import('./i18n.js').UiLocale} */
let uiLocale = 'en';

/** @param {string} key @param {Record<string, string | number> | null} [params] */
function tt(key, params = null) {
  return t(uiLocale, key, params);
}

/**
 * Live status is NOT driven by data-i18n — store key/params (or raw) and re-render
 * on locale change so hydrate/locale switch cannot clobber in-flight copy.
 * @type {{ key: string | null, params: Record<string, string | number> | null, raw: string | null }}
 */
let organizeStatusState = { key: 'organize.ready', params: null, raw: null };

function renderOrganizeStatus() {
  if (!organizeStatus) return;
  if (organizeStatusState.raw != null) {
    organizeStatus.textContent = organizeStatusState.raw;
    return;
  }
  if (organizeStatusState.key) {
    organizeStatus.textContent = tt(
      organizeStatusState.key,
      organizeStatusState.params,
    );
  }
}

/**
 * @param {string | { key?: string, params?: Record<string, string | number> | null, raw?: string | null }} keyOrState
 * @param {Record<string, string | number> | null} [params]
 */
function setOrganizeStatus(keyOrState, params = null) {
  if (typeof keyOrState === 'string') {
    organizeStatusState = { key: keyOrState, params, raw: null };
  } else if (keyOrState && typeof keyOrState === 'object') {
    if (typeof keyOrState.raw === 'string') {
      organizeStatusState = { key: null, params: null, raw: keyOrState.raw };
    } else {
      organizeStatusState = {
        key: typeof keyOrState.key === 'string' ? keyOrState.key : null,
        params: keyOrState.params ?? null,
        raw: null,
      };
    }
  }
  renderOrganizeStatus();
}

function localizeCancelMessage({ llmCallsAttempted = 0, classified = 0 } = {}) {
  const attempted = Math.max(0, Number(llmCallsAttempted) || 0);
  const classifiedN = Math.max(0, Number(classified) || 0);
  if (attempted <= 0) {
    return { key: 'organize.cancelNoLlm', params: null };
  }
  return {
    key: 'organize.cancelWithLlm',
    params: {
      attempted,
      callWord: attempted === 1 ? tt('organize.call') : tt('organize.calls'),
      classifiedNote:
        classifiedN > 0 ? tt('organize.classifiedNote', { n: classifiedN }) : '',
    },
  };
}

/**
 * Prefer SW messageKey when present; else map known phases; else raw message.
 * @param {Record<string, unknown>} message
 * @returns {{ key: string, params: Record<string, string | number> | null } | { raw: string } | null}
 */
function formatProgressMessage(message) {
  if (typeof message.messageKey === 'string' && message.messageKey) {
    const params =
      message.messageParams && typeof message.messageParams === 'object'
        ? /** @type {Record<string, string | number>} */ (message.messageParams)
        : {
            current: Number(message.current || message.refineIndex) || 0,
            total: Number(message.refineTotal || message.total) || 0,
          };
    return { key: message.messageKey, params };
  }
  const phase = typeof message.phase === 'string' ? message.phase : '';
  if (phase === 'clear-cache') return { key: 'progress.clearedCache', params: null };
  if (phase === 'quick-pass') return { key: 'progress.quickPass', params: null };
  if (phase === 'refine') {
    return {
      key: 'progress.refine',
      params: {
        current: Number(message.refineIndex) || 0,
        total: Number(message.refineTotal || message.total) || 0,
      },
    };
  }
  if (phase === 'stacks') {
    return {
      key: 'progress.stacks',
      params: {
        current: Number(message.current || message.done) || 0,
        total: Number(message.total) || 0,
      },
    };
  }
  if (phase === 'merge') return { key: 'progress.merge', params: null };
  if (phase === 'done') return { key: 'progress.done', params: null };
  if (phase === 'cancelled') return { key: 'progress.cancelled', params: null };
  if (phase === 'error') return { key: 'progress.error', params: null };
  if (typeof message.message === 'string' && message.message) {
    return { raw: message.message };
  }
  return null;
}

function applyLocale(nextLocale, { persist = false } = {}) {
  uiLocale = normalizeUiLocale(nextLocale);
  applyDomI18n(document, uiLocale);
  const select = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('ui-locale')
  );
  if (select) select.value = uiLocale;
  // Re-render stored status (never force Ready over in-flight copy).
  renderOrganizeStatus();
  if (persist) {
    sendToBackground(MSG.SET_CONFIG, { patch: { uiLocale } }).catch(() => {});
  }
}

/** Long-lived port so the service worker can toggle-close this panel. */
const sidePanelPort = chrome.runtime.connect({ name: 'side-panel' });
void (async () => {
  try {
    const win = await chrome.windows.getCurrent();
    if (typeof win?.id === 'number') {
      sidePanelPort.postMessage({ type: 'SIDE_PANEL_HELLO', windowId: win.id });
    }
  } catch {
    // window id optional — SW still tracks the port
  }
})();

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
const reorganizeBtn = document.getElementById('btn-reorganize');
const cancelBtn = document.getElementById('btn-cancel-organize');
const organizeStatus = document.getElementById('organize-status');
const progressTrack = document.getElementById('organize-progress-track');
const scopeSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('group-scope'));
const localeSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('ui-locale'));

function setOrganizeProgressVisible(visible) {
  if (progressTrack) progressTrack.hidden = !visible;
  organizeStatus?.classList.toggle('is-running', Boolean(visible));
}

let organizeBusy = false;
/** @type {'organize' | 'reorganize'} */
let activeOrganizeMode = 'organize';

/** @returns {number} unique across side-panel windows */
function nextOrganizeRunId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * Generation token — Cancel bumps this so in-flight Organize / progress cannot update UI.
 * Must be unique across side-panel instances (windows) so CANCEL_GROUP preemptive
 * marks do not collide. Never a simple 0-based counter alone.
 * @type {number}
 */
let organizeRunId = nextOrganizeRunId();
/** @type {'idle' | 'permissions' | 'running' | 'cancelling'} */
let organizePhase = 'idle';
/** @type {string | null} */
let activeJobId = null;
/** Side Panel adopted this job via alarm resume (not a local Organize click). */
let adoptedAlarmResume = false;
/**
 * Alarm-resume jobId seen via GET_JOB_STATE / JOB_STATE even when UI adopt was
 * blocked (busy). Used so Cancel can target that job without aborting
 * unrelated Organize runs in other windows.
 * @type {string | null}
 */
let knownAlarmJobId = null;
/** Job ids the user cancelled — do not re-adopt from JOB_STATE / progress. */
/** @type {Set<string>} */
const suppressedJobIds = new Set();
/** Last known LLM calls started for this run (from progress / job result). */
let lastLlmCallsAttempted = 0;
let lastClassified = 0;

/** True after a successful storage/SW config hydrate (may still be unconfigured LLM). */
let organizeConfigReady = false;
/** True when the last hydrate failed — Organize stays clickable to retry. */
let organizeConfigLoadFailed = false;

function syncOrganizeEnabled() {
  const blocked =
    organizeBusy || (!organizeConfigReady && !organizeConfigLoadFailed);
  // Disable until hydrated; if hydrate failed, keep Organize clickable to retry.
  if (organizeBtn) organizeBtn.disabled = blocked;
  // Reorganize requires a successful hydrate (needs LLM path).
  if (reorganizeBtn) {
    reorganizeBtn.disabled =
      organizeBusy || !organizeConfigReady;
  }
}

function setBusy(busy) {
  organizeBusy = busy;
  syncOrganizeEnabled();
  // Cancel stays enabled so the user can abort permission / running jobs.
  if (cancelBtn) cancelBtn.disabled = false;
  if (scopeSelect) scopeSelect.disabled = busy;
  if (localeSelect) localeSelect.disabled = busy;
  if (!busy) setOrganizeProgressVisible(false);
}

function setOrganizeIdle() {
  organizePhase = 'idle';
  activeJobId = null;
  adoptedAlarmResume = false;
  setBusy(false);
}

/**
 * Remember a cancelled job so alarm JOB_STATE cannot revive it.
 * @param {string | null | undefined} jobId
 */
function suppressJob(jobId) {
  if (!jobId || typeof jobId !== 'string') return;
  suppressedJobIds.add(jobId);
  if (suppressedJobIds.size > 32) {
    const first = suppressedJobIds.values().next().value;
    suppressedJobIds.delete(first);
  }
}

/**
 * Adopt an alarm-resumed Organize into the Side Panel UI (idle only).
 * @param {Record<string, unknown>} state
 * @returns {boolean}
 */
/**
 * Remember alarm-resume job ids even when UI adopt is deferred.
 * @param {Record<string, unknown>} state
 */
function noteAlarmJob(state) {
  const jobId = typeof state?.jobId === 'string' ? state.jobId : null;
  if (
    state?.alarmResume === true &&
    jobId &&
    Number(state?.remaining) > 0 &&
    !suppressedJobIds.has(jobId)
  ) {
    knownAlarmJobId = jobId;
  }
  if (state?.alarmResume !== true && !state?.active && !state?.resumable) {
    if (knownAlarmJobId && (state?.jobId == null || state.jobId === knownAlarmJobId)) {
      knownAlarmJobId = null;
    }
  }
}

function adoptAlarmResumeState(state) {
  noteAlarmJob(state);
  const jobId = typeof state?.jobId === 'string' ? state.jobId : null;
  const isAlarmResume =
    state?.alarmResume === true &&
    Number(state?.remaining) > 0 &&
    jobId &&
    !suppressedJobIds.has(jobId);
  // Never hijack a busy / in-flight Organize started from this panel.
  if (!isAlarmResume || organizePhase !== 'idle' || organizeBusy) {
    return false;
  }

  adoptedAlarmResume = true;
  organizePhase = 'running';
  activeJobId = jobId;
  if (typeof state.clientRunId === 'number') {
    organizeRunId = state.clientRunId;
  }
  lastLlmCallsAttempted = Number(state.llmCallsAttempted) || lastLlmCallsAttempted;
  lastClassified = Number(state.classified) || lastClassified;
  setBusy(true);
  setOrganizeStatus({
    raw: `Alarm resume — ${state.remaining} tabs queued…`,
  });
  setOrganizeProgressVisible(true);
  return true;
}

/**
 * End an adopted alarm-resume UI without inventing a success string.
 * Keeps GROUP_PROGRESS copy when present; only replaces placeholder resume text.
 */
function endAdoptedAlarmResumeUi() {
  const status = organizeStatus?.textContent || '';
  const key = organizeStatusState.key;
  if (
    status.startsWith('Alarm resume') ||
    status.startsWith('Resuming Organize') ||
    key === 'organize.busy' ||
    key === 'organize.reorganizing' ||
    key === 'organize.cancelling' ||
    organizeStatusState.raw
  ) {
    setOrganizeStatus('organize.ended');
  }
  setOrganizeIdle();
  sendToBackground(MSG.GET_LOGICAL_TOPICS)
    .then((res) => {
      if (Array.isArray(res?.logical)) renderLogicalTopics(res.logical);
    })
    .catch(() => {});
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

/**
 * Cached Options config for Organize click — sync read so permissions.request
 * can be the first await (Chrome user-gesture requirement; matches Options Test LLM).
 * Organize stays disabled until hydrate finishes (avoids false "LLM not configured").
 * @type {{
 *   llmProvider: string,
 *   endpointBaseUrl: string,
 *   hasApiKey: boolean,
 *   contentExtractionEnabled: boolean,
 * }}
 */
let cachedOrganizeConfig = {
  llmProvider: '',
  endpointBaseUrl: '',
  hasApiKey: false,
  contentExtractionEnabled: true,
};

/**
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {boolean} true when a config object was applied
 */
function rememberOrganizeConfig(config) {
  if (!shouldMarkOrganizeConfigReady(config)) return false;
  const apiKey = /** @type {Record<string, unknown>} */ (config).apiKey;
  cachedOrganizeConfig = {
    llmProvider:
      typeof config.llmProvider === 'string' ? config.llmProvider : '',
    endpointBaseUrl:
      typeof config.endpointBaseUrl === 'string' ? config.endpointBaseUrl : '',
    hasApiKey: Boolean(
      config.hasApiKey || (typeof apiKey === 'string' && apiKey.length > 0),
    ),
    contentExtractionEnabled: config.contentExtractionEnabled !== false,
  };
  if (typeof config.uiLocale === 'string') {
    uiLocale = normalizeUiLocale(config.uiLocale);
  }
  return true;
}

/**
 * @param {{ hasApiKey?: boolean, llmProvider?: string } | null | undefined} [cfg]
 */
function isCachedLlmReady(cfg = cachedOrganizeConfig) {
  const provider = cfg?.llmProvider || '';
  return (
    Boolean(cfg?.hasApiKey) &&
    (provider === 'anthropic' || provider === 'openai-responses')
  );
}

/**
 * Hydrate from chrome.storage.local (no SW round-trip). Marks ready / load-failed.
 * @returns {Promise<boolean>}
 */
async function hydrateOrganizeConfigFromStorage() {
  try {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) {
      organizeConfigReady = false;
      organizeConfigLoadFailed = true;
      syncOrganizeEnabled();
      return false;
    }
    const result = await storage.get(STORAGE_KEYS.CONFIG);
    rememberOrganizeConfig(result?.[STORAGE_KEYS.CONFIG] || {});
    organizeConfigReady = true;
    organizeConfigLoadFailed = false;
    syncOrganizeEnabled();
    return true;
  } catch {
    organizeConfigReady = false;
    organizeConfigLoadFailed = true;
    syncOrganizeEnabled();
    return false;
  }
}

/**
 * Prefer local storage; fall back to SW GET_CONFIG if storage hydrate fails.
 * Only marks ready when a real config object was remembered (ok:false → retry).
 * @returns {Promise<typeof cachedOrganizeConfig>}
 */
function refreshCachedOrganizeConfig() {
  return hydrateOrganizeConfigFromStorage().then(async (ok) => {
    if (ok) return cachedOrganizeConfig;
    try {
      const res = await sendToBackground(MSG.GET_CONFIG);
      if (rememberOrganizeConfig(res?.config)) {
        organizeConfigReady = true;
        organizeConfigLoadFailed = false;
      } else {
        organizeConfigReady = false;
        organizeConfigLoadFailed = true;
      }
      syncOrganizeEnabled();
    } catch {
      organizeConfigReady = false;
      organizeConfigLoadFailed = true;
      syncOrganizeEnabled();
    }
    return cachedOrganizeConfig;
  });
}

/**
 * Shared Organize / Reorganize click path.
 * @param {'organize' | 'reorganize'} mode
 */
async function startOrganizeJob(mode = 'organize') {
  if (organizeBusy) return;
  const reorganize = mode === 'reorganize';

  // Recoverable path when boot hydrate failed: refetch, then ask for a second click
  // so permissions.request can still be the first await of a fresh user gesture.
  if (!organizeConfigReady) {
    if (reorganize) return;
    const runId = (organizeRunId = nextOrganizeRunId());
    // Non-idle phase so Cancel does not take the idle/alarm path mid-retry.
    organizePhase = 'permissions';
    setBusy(true);
    setOrganizeStatus('organize.loadingSettings');
    await refreshCachedOrganizeConfig();
    // Matching runId must idle even while busy (this retry set busy).
    // Superseded runId must not setOrganizeIdle (would clobber a newer Organize).
    if (
      !shouldApplySettingsRetryCompletion({
        runId,
        activeRunId: organizeRunId,
      })
    ) {
      return;
    }
    setOrganizeIdle();
    if (!organizeConfigReady) {
      setOrganizeStatus('organize.settingsRetry');
      return;
    }
    setOrganizeStatus(
      isCachedLlmReady() ? 'organize.settingsLoaded' : 'organize.llmMissing',
    );
    applyLocale(uiLocale);
    return;
  }

  const runId = (organizeRunId = nextOrganizeRunId());
  lastLlmCallsAttempted = 0;
  lastClassified = 0;
  activeJobId = null;
  adoptedAlarmResume = false;
  activeOrganizeMode = mode;
  organizePhase = 'permissions';
  setBusy(true);
  setOrganizeStatus(reorganize ? 'organize.reorganizing' : 'organize.busy');
  setOrganizeProgressVisible(true);

  const scope = scopeSelect?.value === 'current' ? 'current' : 'all';
  // Sync cache read only — FIRST await must be permissions.request (user gesture).
  const cached = cachedOrganizeConfig;
  const provider = cached.llmProvider || '';
  if (!isCachedLlmReady(cached)) {
    setOrganizeIdle();
    setOrganizeStatus('organize.llmMissing');
    return;
  }

  const allowed = await requestOrganizePermissions({
    endpointBaseUrl: cached.endpointBaseUrl || '',
    provider,
    includeExtractHosts: cached.contentExtractionEnabled !== false,
    includeAllProviderDefaults: true,
  });

  if (runId !== organizeRunId) {
    // Cancelled during permission prompt — do not start GROUP_TABS / REORGANIZE.
    return;
  }

  if (!allowed) {
    setOrganizeIdle();
    setOrganizeStatus('organize.permissionDenied');
    return;
  }

  const windowId = await getPanelWindowId();
  if (runId !== organizeRunId) return;

  // Optional refresh after grant. Failed GET_CONFIG keeps the cache that already
  // passed llmReady — SW loads config itself for GROUP_TABS.
  const cfg = await sendToBackground(MSG.GET_CONFIG).catch(() => null);
  if (runId !== organizeRunId) return;
  if (cfg?.config) rememberOrganizeConfig(cfg.config);
  if (!isCachedLlmReady()) {
    setOrganizeIdle();
    setOrganizeStatus('organize.llmMissing');
    return;
  }

  organizePhase = 'running';
  if (runId !== organizeRunId) {
    // Cancelled after permission grant, before dispatch.
    return;
  }
  const res = await sendToBackground(
    reorganize ? MSG.REORGANIZE_TABS : MSG.GROUP_TABS,
    {
      scope,
      windowId,
      clientRunId: runId,
      ...(reorganize
        ? { reorganize: true, clearCache: true, bypassCache: true, reclassifyStacks: true }
        : {}),
    },
  ).catch((err) => ({ ok: false, error: String(err) }));

  const stillActive = shouldApplyOrganizeCompletion({
    runId,
    activeRunId: organizeRunId,
    cancelRequested: false,
  });

  if (!stillActive) {
    // Newer Organize owns the UI — never clear busy/progress for that run.
    if (organizeBusy || organizePhase !== 'idle') return;
    // Cancel already idled this panel; refine cancel copy only while still idle.
    if (res?.cancelled) {
      lastLlmCallsAttempted = Number(res.llmCallsAttempted) || lastLlmCallsAttempted;
      lastClassified = Number(res.classified) || lastClassified;
      setOrganizeStatus(
        localizeCancelMessage({
          llmCallsAttempted: lastLlmCallsAttempted,
          classified: lastClassified,
        }),
      );
      if (Array.isArray(res.logical) && res.logical.length) {
        renderLogicalTopics(res.logical);
      }
    }
    return;
  }

  if (res?.cancelled) {
    lastLlmCallsAttempted = Number(res.llmCallsAttempted) || 0;
    lastClassified = Number(res.classified) || 0;
    setOrganizeStatus(
      localizeCancelMessage({
        llmCallsAttempted: lastLlmCallsAttempted,
        classified: lastClassified,
      }),
    );
    if (Array.isArray(res.logical) && res.logical.length) {
      renderLogicalTopics(res.logical);
    }
    setOrganizeIdle();
    return;
  }

  if (!res?.ok) {
    setOrganizeIdle();
    if (res?.needsLlmConfig) {
      setOrganizeStatus(
        res.error
          ? { raw: String(res.error) }
          : { key: 'organize.llmMissing', params: null },
      );
    } else if (res?.needsPermission) {
      setOrganizeStatus(
        res.error
          ? {
              raw: `${res.error} ${tt('organize.permissionRetry')}`,
            }
          : { key: 'organize.permissionRetry', params: null },
      );
    } else {
      setOrganizeStatus(
        res?.error
          ? { raw: String(res.error) }
          : { key: 'organize.failed', params: null },
      );
    }
    return;
  }

  setOrganizeIdle();
  const topics = res.logical?.length ?? 0;
  const applied = res.physical?.applied ?? 0;
  const reclaimed = Number(res.merge?.reclaimed) || 0;
  const merged =
    res.merge?.targetWindowId != null ? tt('organize.merged') : '';
  const stacked =
    reclaimed > 0 ? tt('organize.stacked', { n: reclaimed }) : '';
  setOrganizeStatus('organize.done', {
    topics,
    applied,
    merged,
    stacked,
    classified: res.classified ?? 0,
  });
  renderLogicalTopics(res.logical || []);
  // Always refresh stacks after reorganize (topics may have changed).
  if (reorganize || reclaimed > 0) refreshStacks();
}

organizeBtn?.addEventListener('click', () => startOrganizeJob('organize'));
reorganizeBtn?.addEventListener('click', () => startOrganizeJob('reorganize'));

cancelBtn?.addEventListener('click', async () => {
  const phase = organizePhase;
  const cancelledRunId = organizeRunId;
  // Invalidate any in-flight Organize handler (permission await or GROUP_TABS).
  organizeRunId = nextOrganizeRunId();

  if (isIdleOrganizeCancel(phase)) {
    // Only cancel a job this panel knows about — never bare cancelActive (other windows).
    const jobToCancel = activeJobId || knownAlarmJobId;
    if (jobToCancel) {
      suppressJob(jobToCancel);
      sendToBackground(MSG.CANCEL_GROUP, { jobId: jobToCancel }).catch(() => {});
      knownAlarmJobId = null;
    }
    setOrganizeIdle();
    lastLlmCallsAttempted = 0;
    lastClassified = 0;
    setOrganizeStatus(localizeCancelMessage({ llmCallsAttempted: 0 }));
    return;
  }

  if (phase === 'permissions') {
    // Permission step — preemptive clientRunId cancel only (no cross-window abort).
    setOrganizeIdle();
    lastLlmCallsAttempted = 0;
    lastClassified = 0;
    setOrganizeStatus(localizeCancelMessage({ llmCallsAttempted: 0 }));
    sendToBackground(MSG.CANCEL_GROUP, { clientRunId: cancelledRunId }).catch(() => {});
    return;
  }

  if (phase === 'running' || phase === 'cancelling') {
    organizePhase = 'cancelling';
    setOrganizeStatus('organize.cancelling');
    const jobIdToCancel = activeJobId || knownAlarmJobId;
    const cancelRes = await sendToBackground(MSG.CANCEL_GROUP, {
      clientRunId: cancelledRunId,
      jobId: jobIdToCancel || undefined,
    }).catch(() => ({ ok: false }));
    // Suppress only when SW confirmed cancel / cleared pending — otherwise a
    // not-yet-started INTERRUPTED job could stay suppressed while still queued.
    if (cancelRes?.cancelled || cancelRes?.hadActiveJob || cancelRes?.clearedPending) {
      suppressJob(jobIdToCancel);
      knownAlarmJobId = null;
    }
    // Organize click handler will refine copy from the cancelled job result when it returns;
    // show best-known progress counts immediately (never invent "no LLM" if we saw calls).
    setOrganizeStatus(
      localizeCancelMessage({
        llmCallsAttempted: lastLlmCallsAttempted,
        classified: lastClassified,
      }),
    );
    setOrganizeIdle();
    return;
  }

  setOrganizeIdle();
  setOrganizeStatus(localizeCancelMessage({ llmCallsAttempted: 0 }));
});

onBackgroundBroadcast((message) => {
  if (message.type === MSG.STACKS_OVERFLOW_WARN) {
    showStacksOverflow(message?.needsUserAction ? message : null);
    refreshStacks();
    return;
  }
  if (message.type === MSG.CONFIG_UPDATED) {
    // Always refresh Stacks so a cleared overflow gate hides Export/Discard.
    refreshStacks();
    void refreshCachedOrganizeConfig();
    return;
  }
  if (message.type === MSG.JOB_STATE) {
    const jobId = typeof message.jobId === 'string' ? message.jobId : null;
    if (adoptAlarmResumeState(message)) return;

    // Terminal state for an alarm-adopted job (checkpoint cleared; jobId may be null).
    if (
      adoptedAlarmResume &&
      organizePhase === 'running' &&
      message.alarmResume !== true &&
      !message.active &&
      !message.resumable &&
      (jobId == null || activeJobId === jobId)
    ) {
      endAdoptedAlarmResumeUi();
    }
    return;
  }
  if (message.type !== MSG.GROUP_PROGRESS) return;

  // Ignore progress for superseded / cancelled runs / suppressed alarm jobs.
  if (typeof message.jobId === 'string' && suppressedJobIds.has(message.jobId)) {
    return;
  }
  if (organizePhase === 'idle' || organizePhase === 'permissions') {
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
    setOrganizeStatus(
      localizeCancelMessage({
        llmCallsAttempted: lastLlmCallsAttempted,
        classified: lastClassified,
      }),
    );
    return;
  }
  // Suppress stale "Done" if user already cancelled.
  if (organizePhase === 'cancelling') return;
  const progressState = formatProgressMessage(message);
  if (progressState) setOrganizeStatus(progressState);
  if (message.phase && message.phase !== 'done' && message.phase !== 'cancelled') {
    setOrganizeProgressVisible(true);
  }
  if (message.phase === 'done' || message.phase === 'cancelled') {
    setOrganizeProgressVisible(false);
  }
});

function renderLogicalTopics(logical) {
  const list = document.getElementById('topics-list');
  if (!list) return;
  if (!logical.length) {
    list.innerHTML = `<li class="sp-muted">${escapeHtml(tt('topics.empty'))}</li>`;
    return;
  }
  list.innerHTML = logical
    .map((topic) => {
      const label = escapeHtml(topic.label || topic.topicKey);
      const tabs = topic.tabIds?.length ?? 0;
      const windows = escapeHtml((topic.windowIds || []).join(', ') || '—');
      return `<li><strong>${label}</strong>${escapeHtml(
        tt('topics.meta', { tabs, windows: '«W»' }),
      ).replace('«W»', windows)}</li>`;
    })
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
    searchResults.innerHTML = `<p class="sp-muted">${escapeHtml(tt('search.emptyPrompt'))}</p>`;
    return;
  }

  const transportError = fail?.transportError;
  const workerError = res && res.ok === false ? res.error || 'Search failed' : null;
  if (transportError || workerError) {
    flatSearchHits = [];
    activeSearchIndex = -1;
    const msg = transportError || workerError;
    searchResults.innerHTML = `<p class="sp-muted">${escapeHtml(
      tt('search.error', { msg: String(msg) }),
    )}</p>`;
    setSearchStatus(String(msg));
    return;
  }

  const open = Array.isArray(res?.open) ? res.open : [];
  const stacked = Array.isArray(res?.stacked) ? res.stacked : [];
  flatSearchHits = [...open, ...stacked];
  activeSearchIndex = flatSearchHits.length ? 0 : -1;

  if (!flatSearchHits.length) {
    searchResults.innerHTML = `<p class="sp-muted">${escapeHtml(
      tt('search.noMatches', { query }),
    )}</p>`;
    return;
  }

  const parts = [];
  parts.push(renderSearchPartition('open', open, 0));
  parts.push(renderSearchPartition('stacked', stacked, open.length));
  searchResults.innerHTML = parts.join('');
  syncSearchActiveClass();
}

/**
 * @param {'open' | 'stacked'} partition
 * @param {object[]} hits
 * @param {number} indexOffset
 */
function renderSearchPartition(partition, hits, indexOffset) {
  const label = partition === 'stacked' ? tt('search.stacked') : tt('search.open');
  if (!hits.length) {
    const empty =
      partition === 'stacked' ? tt('search.noStacked') : tt('search.noOpen');
    return `<div class="sp-search-section"><h3 class="sp-search-heading">${escapeHtml(
      label,
    )}</h3><p class="sp-muted">${escapeHtml(empty)}</p></div>`;
  }
  const items = hits
    .map((hit, i) => {
      const flatIndex = indexOffset + i;
      const meta = [hit.topicLabel, hit.url].filter(Boolean).join(' · ');
      return `<button type="button" class="sp-search-item" role="option" data-flat-index="${flatIndex}" id="search-hit-${flatIndex}">
        <span class="sp-search-title">${escapeHtml(hit.title || hit.url || tt('stacks.untitled'))}</span>
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
    setSearchStatus(
      res?.ok
        ? tt('search.focused', { title: hit.title || hit.url || '' })
        : res?.error || tt('search.activateFailed'),
    );
    return;
  }
  if (hit.partition === 'stacked' && hit.stackId) {
    const res = await sendToBackground(MSG.RECALL_STACK, { stackId: hit.stackId }).catch((err) => ({
      ok: false,
      error: String(err),
    }));
    setSearchStatus(
      res?.ok
        ? tt('search.recalled', {
            title: hit.title || hit.url || '',
            group: res.groupRestore?.restored ? tt('search.groupRestored') : '',
          })
        : res?.error || tt('search.recallFailed'),
    );
    if (res?.ok) refreshStacks();
    return;
  }
  setSearchStatus(tt('search.nothing'));
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
    const excess = Number(pending.excess) || 0;
    const blocked = Number(pending.blocked) || 0;
    const freeHint =
      excess > 0 && blocked === 0
        ? tt('stacks.overflowExcess', { excess, count, max })
        : tt('stacks.overflowBlocked', {
            count,
            max,
            blockedNote:
              blocked > 0 ? tt('stacks.blockedNote', { n: blocked }) : '',
          });
    summary.textContent = freeHint;
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
  setStacksStatus(
    action === 'export' ? tt('stacks.exporting') : tt('stacks.discarding'),
  );
  const res = await sendToBackground(MSG.EXPORT_OR_DISCARD_STACKS, { action }).catch((err) => ({
    ok: false,
    error: String(err),
  }));
  if (!res?.ok) {
    setStacksStatus(res?.error || tt('stacks.overflowFail'));
    return;
  }
  if (action === 'export' && typeof res.exportJson === 'string') {
    downloadStacksExport(res.exportJson);
  }
  showStacksOverflow(null);
  setStacksStatus(
    action === 'export'
      ? tt('stacks.exported', { n: res.discarded ?? 0 })
      : tt('stacks.discarded', { n: res.discarded ?? 0 }),
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
      ? tt('stacks.recalled', {
          title: title || stackId,
          group: res.groupRestore?.restored ? tt('search.groupRestored') : '',
        })
      : res?.error || tt('stacks.recallFailed'),
  );
  if (res?.ok) await refreshStacks();
}

/** Fixed row height for virtual Stacks cards (matches --stack-row). */
const STACK_ROW_HEIGHT = 56;

/**
 * Hostname letter for missing favicons.
 * @param {string | undefined} url
 */
function siteGlyph(url) {
  try {
    const host = new URL(url || '').hostname.replace(/^www\./, '');
    return (host[0] || '?').toUpperCase();
  } catch {
    return '?';
  }
}

/**
 * Prefer stored favIconUrl; otherwise leave null and show glyph placeholder.
 * @param {{ favIconUrl?: string, url?: string }} stack
 * @returns {string | null}
 */
function resolveStackIconUrl(stack) {
  const icon = typeof stack?.favIconUrl === 'string' ? stack.favIconUrl.trim() : '';
  if (
    icon &&
    (icon.startsWith('https:') ||
      icon.startsWith('http:') ||
      icon.startsWith('data:') ||
      icon.startsWith('chrome:') ||
      icon.startsWith('chrome-extension:'))
  ) {
    return icon;
  }
  return null;
}

/**
 * @param {object} stack
 * @returns {HTMLButtonElement}
 */
function renderStackCard(stack) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sp-stack-card';
  // Keep native button semantics — do not override with role=listitem.
  btn.dataset.stackId = String(stack.id || '');
  btn.title = tt('stacks.recallTitle');

  const iconUrl = resolveStackIconUrl(stack);
  const img = document.createElement('img');
  img.className = 'sp-stack-icon';
  img.width = 32;
  img.height = 32;
  img.alt = '';
  img.decoding = 'async';

  const fallback = document.createElement('span');
  fallback.className = 'sp-stack-icon sp-stack-icon-fallback';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.textContent = siteGlyph(stack.url);

  if (iconUrl) {
    fallback.hidden = true;
    img.src = iconUrl;
    img.addEventListener('error', () => {
      img.hidden = true;
      fallback.hidden = false;
    });
  } else {
    img.hidden = true;
  }

  const text = document.createElement('span');
  text.className = 'sp-stack-text';
  const title = document.createElement('span');
  title.className = 'sp-stack-title';
  title.textContent = stack.title || stack.url || tt('stacks.untitled');
  const topic = document.createElement('span');
  topic.className = 'sp-stack-topic';
  topic.textContent = stack.topicLabel || stack.groupTitle || tt('stacks.noTopic');
  text.append(title, topic);

  btn.append(img, fallback, text);
  return btn;
}

const stacksViewport = document.getElementById('stacks-viewport');
/** @type {ReturnType<typeof mountVirtualList> | null} */
let stacksVirtual = null;

function ensureStacksVirtual() {
  if (!stacksViewport || stacksVirtual) return stacksVirtual;
  stacksVirtual = mountVirtualList({
    container: stacksViewport,
    itemHeight: STACK_ROW_HEIGHT,
    overscan: 8,
    getKey: (item) => String(/** @type {{ id?: string }} */ (item).id || ''),
    renderItem: (item) => renderStackCard(/** @type {object} */ (item)),
  });
  return stacksVirtual;
}

function showStacksEmpty() {
  if (!stacksViewport) return;
  if (stacksVirtual) {
    stacksVirtual.destroy();
    stacksVirtual = null;
  }
  stacksViewport.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'sp-muted sp-stacks-empty';
  empty.textContent = tt('stacks.empty');
  stacksViewport.append(empty);
}

async function refreshStacks() {
  if (!stacksViewport) return;
  const res = await sendToBackground(MSG.GET_STACKS).catch(() => null);
  const stacks = Array.isArray(res?.stacks) ? res.stacks : [];
  showStacksOverflow(res?.overflowPending);

  if (!stacks.length) {
    showStacksEmpty();
    return;
  }

  const list = ensureStacksVirtual();
  list?.setItems(stacks);
}

stacksViewport?.addEventListener('click', (e) => {
  const card = /** @type {HTMLElement | null} */ (
    e.target instanceof Element ? e.target.closest('.sp-stack-card') : null
  );
  if (!card) return;
  const stackId = card.getAttribute('data-stack-id');
  if (!stackId) return;
  const title =
    card.querySelector('.sp-stack-title')?.textContent || stackId;
  recallStackById(stackId, title);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Keep Organize disabled until config hydrate completes (or fails recoverably).
syncOrganizeEnabled();
applyLocale(uiLocale);
if (organizeStatus && !organizeConfigReady) {
  setOrganizeStatus('organize.loadingSettings');
}

localeSelect?.addEventListener('change', () => {
  applyLocale(localeSelect.value, { persist: true });
  // Re-render dynamic lists so empty/help copy matches the new locale.
  refreshLogicalTopics();
  refreshStacks();
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes?.[STORAGE_KEYS.CONFIG]) return;
  const next = changes[STORAGE_KEYS.CONFIG].newValue || {};
  rememberOrganizeConfig(next);
  organizeConfigReady = true;
  organizeConfigLoadFailed = false;
  syncOrganizeEnabled();
  if (typeof next.uiLocale === 'string') {
    applyLocale(next.uiLocale);
  }
});

refreshStacks();
refreshLogicalTopics();
void refreshCachedOrganizeConfig().then(() => {
  applyLocale(uiLocale);
  if (!organizeBusy && organizePhase === 'idle' && organizeStatus) {
    if (!organizeConfigReady) {
      setOrganizeStatus('organize.settingsRetry');
    } else {
      setOrganizeStatus('organize.ready');
    }
  }
});
// Reopened panel: adopt in-flight alarm resume if SW already has a checkpoint.
sendToBackground(MSG.GET_JOB_STATE)
  .then((state) => {
    if (state?.ok !== false) adoptAlarmResumeState(state || {});
  })
  .catch(() => {});
