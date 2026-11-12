/**
 * Service worker orchestrator (ADR Phase 0–7).
 * Unique orchestration center: events, debounce, jobs, LLM, Chrome side-effects.
 * UI only sends MSG.* — keys & tab mutations stay here.
 * Grouping is on-demand only — never auto-group on tab complete.
 * Phase 3: fuzzy + pinyin search over open tabs and stackRecords.
 * Phase 4: Stacks reclaim / recall; overflow warn → export or discard.
 * Phase 5: Cross-window auto-dedupe (before reclaim).
 * Phase 7: Task state machine + alarm resume + local metrics.
 */

import { MSG, DEFAULT_CONFIG, SESSION_KEYS, TIMEOUTS, STORAGE_KEYS } from '../shared/constants.js';
import { loadConfig, saveConfig, redactConfigForUi, mergeConfig } from '../shared/config.js';
import { buildClassifyPayloadPreview, createLlmClient } from '../shared/llm-client.js';
import { TopicCacheLru, loadTopicCache, persistTopicCache } from '../shared/topic-cache.js';
import { StackRecordStore, loadStackRecords, persistStackRecords } from '../shared/stack-records.js';
import { normalizeUrlKey, computeContentHash } from '../shared/url-normalize.js';
import { isEligibleTab } from '../shared/tab-eligibility.js';
import { createActivityLog } from '../shared/activity-log.js';
import {
  buildGroupPayloadPreview,
  groupTabsOnDemand,
} from './grouping.js';
import { formatOrganizeCancelMessage } from '../shared/organize-cancel.js';
import { runSearchQuery } from './search.js';
import { maybeReclaim, recallStack, exportOrDiscardStacks } from './stacks.js';
import { runAutoDedupe } from './dedupe.js';
import { buildOverflowPending } from '../shared/reclaim-policy.js';
import {
  loadMetrics,
  bumpMetrics,
  mergeMetrics,
} from '../shared/metrics.js';
import {
  ALARM_NAMES,
  ensureMaintainAlarm,
  ensureOrganizeResumeAlarm,
  clearOrganizeResumeAlarm,
} from '../shared/alarms.js';
import {
  loadOrganizeCheckpoint,
  saveOrganizeCheckpoint,
  interruptOrganizeCheckpoint,
  shouldResumeCheckpoint,
  summarizeJobState,
} from './job-checkpoint.js';
import { isTerminalPhase, JOB_PHASES } from '../shared/task-state.js';

/** @type {TopicCacheLru} */
let topicCache = new TopicCacheLru(DEFAULT_CONFIG.cacheSize);
/** @type {StackRecordStore} */
let stackStore = new StackRecordStore(DEFAULT_CONFIG.stackSize);
/** @type {import('../shared/metrics.js').LocalMetrics} */
let localMetrics = mergeMetrics(null);
/** @type {import('../shared/task-state.js').OrganizeCheckpoint | null} */
let organizeCheckpoint = null;
/** Prevent overlapping resume / organize jobs. */
let organizeResumeInFlight = false;

/** @type {{ logical: import('../shared/physical-groups.js').PhysicalGroupPlan[] | unknown[], latestWinsAt: number, source: string } | null} */
let lastOrganizeState = null;

/** Runtime: tabs we are closing (dedupe/reclaim) — suppressClosed recall pollution. */
/** @type {Set<number>} */
const closingTabIds = new Set();

/** Minimal activity log (dedupe closes, etc.). */
const activityLog = createActivityLog();

/** @type {ReturnType<typeof setTimeout> | number | null} */
let cacheSyncTimer = null;
/** @type {Map<number, { url?: string, title?: string }>} */
const pendingTabSync = new Map();

/** Debounced auto-dedupe after tab create / URL update (ADR classifyDebounceMs). */
/** @type {ReturnType<typeof setTimeout> | number | null} */
let dedupeTimer = null;
/** @type {Promise<unknown> | null} */
let dedupeInFlight = null;

/** Debounced reclaim after tab count changes (ADR classifyDebounceMs). */
/** @type {ReturnType<typeof setTimeout> | number | null} */
let reclaimTimer = null;
/** @type {Promise<unknown> | null} */
let reclaimInFlight = null;

/** Persisted overflow gate — reclaim pauses until export/discard. */
/** @type {object | null} */
let overflowPending = null;

/** @type {Promise<void> | null} */
let hydratePromise = null;

/**
 * Active on-demand Organize job — Cancel aborts via AbortController.
 * @type {{ jobId: string, controller: AbortController, clientRunId: number | null } | null}
 */
let activeOrganizeJob = null;

/**
 * Side-panel run ids cancelled before GROUP_TABS registered the job (permission / race).
 * @type {Set<number>}
 */
const cancelledClientRunIds = new Set();

async function initPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[tab-caption] setPanelBehavior failed', err);
  }
}

async function hydrateFromStorage() {
  const config = await loadConfig();
  topicCache = await loadTopicCache(config.cacheSize);
  stackStore = await loadStackRecords(config.stackSize);
  localMetrics = await loadMetrics();
  // Restore logical topics across SW restarts (session-scoped).
  try {
    const stored = await chrome.storage.session.get([
      SESSION_KEYS.LAST_ORGANIZE,
      SESSION_KEYS.STACKS_OVERFLOW_PENDING,
      SESSION_KEYS.ORGANIZE_CHECKPOINT,
    ]);
    const last = stored?.[SESSION_KEYS.LAST_ORGANIZE];
    if (last && Array.isArray(last.logical)) {
      lastOrganizeState = {
        logical: last.logical,
        latestWinsAt: last.latestWinsAt ?? null,
        latestWinsSource: last.latestWinsSource ?? last.source ?? null,
      };
    }
    const pending = stored?.[SESSION_KEYS.STACKS_OVERFLOW_PENDING];
    overflowPending =
      pending && typeof pending === 'object' && pending.needsUserAction ? pending : null;
    const cp = stored?.[SESSION_KEYS.ORGANIZE_CHECKPOINT];
    organizeCheckpoint = cp && typeof cp.jobId === 'string' ? cp : null;
  } catch {
    // session storage may be unavailable
  }
  // Over-capacity after hydrate (e.g. stackSize shrunk) — warn, never silent trim.
  if (stackStore.size > stackStore.maxSize) {
    const pending = buildOverflowPending({
      size: stackStore.size,
      maxSize: stackStore.maxSize,
      blockedIncoming: 0,
      reason: 'over_capacity',
    });
    await setOverflowPending(pending);
  } else if (overflowPending?.needsUserAction && stackStore.size <= stackStore.maxSize) {
    // Capacity raised or records already trimmed — clear stale gate.
    const stillBlocked = Number(overflowPending.blocked) > 0 && stackStore.size >= stackStore.maxSize;
    if (!stillBlocked) {
      await setOverflowPending(null);
    }
  }
}

function ensureHydrated() {
  if (!hydratePromise) {
    hydratePromise = hydrateFromStorage()
      .then(async () => {
        // After cold start: mark any mid-flight job interrupted and try alarm resume.
        if (organizeCheckpoint && !isTerminalPhase(organizeCheckpoint.phase) && !activeOrganizeJob) {
          organizeCheckpoint = await interruptOrganizeCheckpoint();
          broadcastJobState();
        }
      })
      .catch((err) => {
        console.warn('[tab-caption] hydrate failed', err);
        hydratePromise = null;
      });
  }
  return hydratePromise;
}

/**
 * Broadcast JOB_STATE to Side Panel (fail-soft).
 */
function broadcastJobState() {
  try {
    chrome.runtime
      .sendMessage({ type: MSG.JOB_STATE, ...summarizeJobState(organizeCheckpoint) })
      .catch(() => {});
  } catch {
    // no listeners
  }
}

/**
 * Persist checkpoint + keep/clear resume alarm.
 * @param {import('../shared/task-state.js').OrganizeCheckpoint | null} checkpoint
 */
async function persistOrganizeCheckpoint(checkpoint) {
  organizeCheckpoint = checkpoint;
  await saveOrganizeCheckpoint(checkpoint);
  if (checkpoint && !isTerminalPhase(checkpoint.phase)) {
    await ensureOrganizeResumeAlarm();
  } else {
    await clearOrganizeResumeAlarm();
  }
  broadcastJobState();
}

/**
 * Run Organize with checkpoint hooks (fresh or resume).
 * @param {object} opts
 */
async function runOrganizeJob(opts) {
  const jobId = opts.jobId;
  const metricsSnapshot = mergeMetrics(localMetrics);
  const result = await groupTabsOnDemand({
    ...opts,
    topicCache,
    metrics: metricsSnapshot,
    onCheckpoint: async (cp) => {
      await persistOrganizeCheckpoint(cp);
    },
    onLlmSpend: async () => {
      localMetrics = await bumpMetrics({ spendDailyLlm: 1 });
      metricsSnapshot.dailyLlmCalls = localMetrics.dailyLlmCalls;
      metricsSnapshot.llmCalls = localMetrics.llmCalls;
      metricsSnapshot.dailyLlmDate = localMetrics.dailyLlmDate;
    },
  });
  if (result?.ok) {
    localMetrics = await bumpMetrics({
      organizeRuns: 1,
      classifyErrors: Number(result.classifyErrors) || 0,
    });
  }
  // Drop resumable checkpoint only for *this* job — a superseded cancel must not
  // wipe a successor Organize that already wrote its own checkpoint / alarm.
  const finishedJobId = result?.jobId || jobId;
  const ownsCheckpoint =
    !organizeCheckpoint ||
    (finishedJobId && organizeCheckpoint.jobId === finishedJobId);
  const terminal =
    ownsCheckpoint &&
    (result?.ok ||
      result?.cancelled ||
      result?.needsPermission ||
      isTerminalPhase(organizeCheckpoint?.phase));
  if (terminal && ownsCheckpoint) {
    await clearOrganizeResumeAlarm();
    await saveOrganizeCheckpoint(null);
    organizeCheckpoint = null;
    broadcastJobState();
  }
  return result;
}

/**
 * Alarm / cold-start resume of an interrupted Organize refine queue.
 */
async function maybeResumeOrganizeFromCheckpoint() {
  if (organizeResumeInFlight || activeOrganizeJob) return null;
  await ensureHydrated();
  const cp = organizeCheckpoint || (await loadOrganizeCheckpoint());
  organizeCheckpoint = cp;
  if (!shouldResumeCheckpoint(cp)) {
    // Alarms survive browser restart; session checkpoints do not — clear orphans.
    await clearOrganizeResumeAlarm();
    if (cp) {
      await saveOrganizeCheckpoint(null);
      organizeCheckpoint = null;
      broadcastJobState();
    }
    return null;
  }

  organizeResumeInFlight = true;
  const controller = new AbortController();
  const jobId = cp.jobId;
  activeOrganizeJob = {
    jobId,
    controller,
    clientRunId: typeof cp.clientRunId === 'number' ? cp.clientRunId : null,
  };
  broadcastJobState();
  try {
    await bumpMetrics({ alarmResumes: 1 });
    localMetrics = await loadMetrics();
    const config = await loadConfig();
    const result = await runOrganizeJob({
      scope: cp.scope,
      currentWindowId: cp.currentWindowId ?? undefined,
      confirmed: true,
      config,
      llmOpts: { useMock: cp.useMock === true },
      signal: controller.signal,
      jobId,
      clientRunId: cp.clientRunId,
      resumeFrom: cp,
    });
    if (result?.ok) {
      await rememberOrganizeState(result);
    } else if (result?.cancelled && Array.isArray(result.logical) && result.logical.length) {
      await rememberOrganizeState({
        logical: result.logical,
        latestWinsAt: Date.now(),
        latestWinsSource: 'extension-organize-cancelled',
      });
    }
    scheduleReclaim();
    return result;
  } finally {
    if (activeOrganizeJob?.jobId === jobId) activeOrganizeJob = null;
    organizeResumeInFlight = false;
  }
}

/**
 * @param {object | null} pending
 */
async function setOverflowPending(pending) {
  overflowPending = pending;
  try {
    if (pending) {
      await chrome.storage.session.set({
        [SESSION_KEYS.STACKS_OVERFLOW_PENDING]: pending,
      });
    } else {
      await chrome.storage.session.remove(SESSION_KEYS.STACKS_OVERFLOW_PENDING);
    }
  } catch {
    // session storage may be unavailable in tests
  }
}

/**
 * Persist latest-wins organize result (full logical views) in session.
 * @param {Record<string, unknown>} state
 */
async function rememberOrganizeState(state) {
  lastOrganizeState = {
    logical: Array.isArray(state.logical) ? state.logical : [],
    latestWinsAt: state.latestWinsAt ?? Date.now(),
    latestWinsSource: state.latestWinsSource ?? 'extension-organize',
  };
  try {
    await chrome.storage.session.set({
      [SESSION_KEYS.LAST_ORGANIZE]: {
        logical: lastOrganizeState.logical,
        latestWinsAt: lastOrganizeState.latestWinsAt,
        latestWinsSource: lastOrganizeState.latestWinsSource,
      },
    });
  } catch {
    // session storage may be unavailable in tests
  }
}

/**
 * Prefer explicit windowId from Side Panel; fall back to sender.tab / getCurrent.
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<number | undefined>}
 */
async function resolveCurrentWindowId(message, sender) {
  if (typeof message?.windowId === 'number') return message.windowId;
  if (typeof sender?.tab?.windowId === 'number') return sender.tab.windowId;
  try {
    const win = await chrome.windows.getCurrent();
    return win?.id;
  } catch {
    return undefined;
  }
}

/**
 * Debounced cache metadata sync on tab URL/title updates (no LLM).
 * @param {number} tabId
 * @param {chrome.tabs.TabChangeInfo} changeInfo
 * @param {chrome.tabs.Tab} tab
 */
function scheduleCacheSync(tabId, changeInfo, tab) {
  if (!isEligibleTab(tab)) return;
  // Sync only when URL or title actually changes (contentHash inputs) — never LLM.
  if (changeInfo.url == null && changeInfo.title == null) return;
  pendingTabSync.set(tabId, {
    url: tab.url,
    title: tab.title,
    urlChanged: changeInfo.url != null,
  });
  if (cacheSyncTimer) clearTimeout(cacheSyncTimer);
  cacheSyncTimer = setTimeout(() => {
    cacheSyncTimer = null;
    flushCacheSync().catch(() => {});
  }, TIMEOUTS.CACHE_SYNC_DEBOUNCE_MS);
}

async function flushCacheSync() {
  await ensureHydrated();
  const batch = [...pendingTabSync.entries()];
  pendingTabSync.clear();
  let mutated = false;

  for (const [, info] of batch) {
    const urlKey = normalizeUrlKey(info.url || '');
    if (!urlKey) continue;
    // URL navigation: drop all hashes for this urlKey. Title-only: leave entries;
    // next Organize recomputes contentHash and treats mismatch as miss/stale.
    if (info.urlChanged) {
      topicCache.invalidateUrl(urlKey);
      mutated = true;
    }
    void computeContentHash({
      title: info.title || '',
      excerpt: '',
      url: urlKey,
    });
  }

  if (mutated) {
    await persistTopicCache(topicCache);
  }
}

/**
 * Schedule auto-dedupe after tab create / URL change (debounce = classifyDebounceMs).
 */
function scheduleDedupe() {
  if (dedupeTimer) clearTimeout(dedupeTimer);
  dedupeTimer = setTimeout(() => {
    dedupeTimer = null;
    runDedupePass().catch((err) => {
      console.warn('[tab-caption] dedupe failed', err);
    });
  }, TIMEOUTS.CACHE_SYNC_DEBOUNCE_MS);
}

async function runDedupePass() {
  await ensureHydrated();
  if (dedupeInFlight) {
    await dedupeInFlight.catch(() => {});
  }
  const config = await loadConfig();
  dedupeInFlight = runAutoDedupe({
    config,
    closingTabIds,
    activityLog,
  });
  try {
    const result = await dedupeInFlight;
    const closed = Number(result?.closed) || 0;
    if (closed > 0) {
      localMetrics = await bumpMetrics({ dedupeCloses: closed });
    }
    return result;
  } finally {
    dedupeInFlight = null;
  }
}

/**
 * Schedule reclaim after tab create/remove (debounce = classifyDebounceMs).
 * Reclaim always runs dedupe first (ADR order).
 */
function scheduleReclaim() {
  if (reclaimTimer) clearTimeout(reclaimTimer);
  reclaimTimer = setTimeout(() => {
    reclaimTimer = null;
    runReclaimPass().catch((err) => {
      console.warn('[tab-caption] reclaim failed', err);
    });
  }, TIMEOUTS.CACHE_SYNC_DEBOUNCE_MS);
}

async function runReclaimPass() {
  await ensureHydrated();
  if (reclaimInFlight) {
    await reclaimInFlight.catch(() => {});
  }
  // Let a standalone dedupe pass finish first to avoid overlapping closes.
  if (dedupeInFlight) {
    await dedupeInFlight.catch(() => {});
  }
  const config = await loadConfig();
  reclaimInFlight = maybeReclaim({
    config,
    stackStore,
    topicCache,
    closingTabIds,
    overflowPending,
    setOverflowPending,
    activityLog,
  });
  try {
    const result = await reclaimInFlight;
    const reclaimed = Number(result?.reclaimed) || 0;
    if (reclaimed > 0) {
      localMetrics = await bumpMetrics({ reclaimCount: reclaimed });
    }
    // Dedupe nested inside reclaim also reports closed counts.
    const nestedClosed = Number(result?.dedupe?.closed) || 0;
    if (nestedClosed > 0) {
      localMetrics = await bumpMetrics({ dedupeCloses: nestedClosed });
    }
    return result;
  } finally {
    reclaimInFlight = null;
  }
}

/**
 * Message router — keep surface stable.
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response?: unknown) => void} sendResponse
 */
function onMessage(message, sender, sendResponse) {
  const type = message?.type;
  if (!type) {
    sendResponse({ ok: false, error: 'missing type' });
    return false;
  }

  (async () => {
    await ensureHydrated();

    switch (type) {
      case MSG.GET_CONFIG: {
        const config = await loadConfig();
        sendResponse({ ok: true, config: redactConfigForUi(config) });
        break;
      }
      case MSG.SET_CONFIG: {
        const next = await saveConfig(message.patch ?? {});
        topicCache.maxSize = Math.max(1, Number(next.cacheSize) || DEFAULT_CONFIG.cacheSize);
        topicCache._evict();
        await persistTopicCache(topicCache);
        stackStore.maxSize = Math.max(1, Number(next.stackSize) || DEFAULT_CONFIG.stackSize);
        // Never silent-trim on shrink — warn → export/discard. Clear gate when capacity fits.
        if (stackStore.size > stackStore.maxSize) {
          const pending = buildOverflowPending({
            size: stackStore.size,
            maxSize: stackStore.maxSize,
            blockedIncoming: 0,
            reason: 'over_capacity',
          });
          await setOverflowPending(pending);
          chrome.runtime
            .sendMessage({ type: MSG.STACKS_OVERFLOW_WARN, ...pending })
            .catch(() => {});
        } else if (overflowPending?.needsUserAction) {
          await setOverflowPending(null);
          // Tell Side Panel to hide Export/Discard — CONFIG_UPDATED alone left a stale CTA.
          chrome.runtime
            .sendMessage({
              type: MSG.STACKS_OVERFLOW_WARN,
              needsUserAction: false,
              cleared: true,
              stackSize: stackStore.maxSize,
              stackCount: stackStore.size,
            })
            .catch(() => {});
        }
        await persistStackRecords(stackStore);
        chrome.runtime.sendMessage({ type: MSG.CONFIG_UPDATED }).catch(() => {});
        scheduleReclaim();
        sendResponse({ ok: true, config: redactConfigForUi(next) });
        break;
      }
      case MSG.PREVIEW_CLASSIFY_PAYLOAD: {
        const config = await loadConfig();
        const preview = buildClassifyPayloadPreview(
          {
            url: message.url ?? '',
            title: message.title ?? '',
            snippet: message.snippet,
            extractedText: message.extractedText,
          },
          {
            provider: /** @type {any} */ (config.llmProvider || ''),
            model: config.model,
            endpointBaseUrl: config.endpointBaseUrl,
          },
        );
        sendResponse({ ok: true, preview });
        break;
      }
      case MSG.PREVIEW_GROUP_PAYLOAD: {
        const config = await loadConfig();
        const currentWindowId = await resolveCurrentWindowId(message, sender);
        const preview = await buildGroupPayloadPreview({
          scope: message.scope === 'current' ? 'current' : 'all',
          currentWindowId,
          topicCache,
          config,
        });
        sendResponse({ ok: true, preview });
        break;
      }
      case MSG.CANCEL_GROUP: {
        const clientRunId =
          typeof message.clientRunId === 'number' ? message.clientRunId : null;
        const requestJobId = typeof message.jobId === 'string' ? message.jobId : null;
        if (clientRunId != null) {
          cancelledClientRunIds.add(clientRunId);
          // Bound memory — keep only recent cancel marks.
          if (cancelledClientRunIds.size > 32) {
            const first = cancelledClientRunIds.values().next().value;
            cancelledClientRunIds.delete(first);
          }
        }
        // Match by clientRunId, jobId (alarm resume), or bare cancel of the active job.
        const match =
          activeOrganizeJob &&
          ((clientRunId == null && requestJobId == null) ||
            (clientRunId != null && activeOrganizeJob.clientRunId === clientRunId) ||
            (requestJobId != null && activeOrganizeJob.jobId === requestJobId) ||
            message.cancelActive === true);
        if (match && activeOrganizeJob) {
          const { jobId, controller } = activeOrganizeJob;
          controller.abort();
          await clearOrganizeResumeAlarm();
          sendResponse({ ok: true, cancelled: true, jobId, hadActiveJob: true });
        } else {
          sendResponse({
            ok: true,
            cancelled: clientRunId != null || requestJobId != null,
            hadActiveJob: false,
            preemptive: clientRunId != null,
          });
        }
        break;
      }
      case MSG.GROUP_TABS: {
        const config = await loadConfig();
        if (!message.confirmed) {
          sendResponse({
            ok: false,
            needsConfirm: true,
            error: 'Confirm privacy preview before Organize (ADR #12).',
          });
          break;
        }
        if (config.groupOnDemandOnly === false) {
          // Still never auto-group; flag is informational for Phase 2.
        }
        const clientRunId =
          typeof message.clientRunId === 'number' ? message.clientRunId : null;
        // Cancel arrived during permission / before this handler registered the job.
        if (clientRunId != null && cancelledClientRunIds.has(clientRunId)) {
          cancelledClientRunIds.delete(clientRunId);
          sendResponse({
            ok: false,
            cancelled: true,
            llmCallsAttempted: 0,
            classified: 0,
            message: formatOrganizeCancelMessage({ llmCallsAttempted: 0 }),
            logical: [],
            assignments: [],
            physical: { applied: 0, errors: [] },
            stub: false,
          });
          break;
        }
        // Latest-wins: abort any prior Organize still refining.
        if (activeOrganizeJob) {
          activeOrganizeJob.controller.abort();
          activeOrganizeJob = null;
        }
        const controller = new AbortController();
        const jobId = `group-${Date.now()}`;
        activeOrganizeJob = { jobId, controller, clientRunId };
        // Re-check after registration — Cancel may have landed during loadConfig.
        if (clientRunId != null && cancelledClientRunIds.has(clientRunId)) {
          cancelledClientRunIds.delete(clientRunId);
          controller.abort();
        }
        const currentWindowId = await resolveCurrentWindowId(message, sender);
        let result;
        try {
          await ensureOrganizeResumeAlarm();
          result = await runOrganizeJob({
            scope: message.scope === 'current' ? 'current' : 'all',
            currentWindowId,
            confirmed: true,
            config,
            llmOpts: { useMock: message.useMock === true },
            signal: controller.signal,
            jobId,
            clientRunId,
          });
        } finally {
          if (activeOrganizeJob?.jobId === jobId) {
            activeOrganizeJob = null;
          }
          if (clientRunId != null) cancelledClientRunIds.delete(clientRunId);
        }
        if (result.ok) {
          await rememberOrganizeState(result);
        } else if (result.cancelled && Array.isArray(result.logical) && result.logical.length) {
          // Keep partial logical topics from work completed before cancel.
          await rememberOrganizeState({
            logical: result.logical,
            latestWinsAt: Date.now(),
            latestWinsSource: 'extension-organize-cancelled',
          });
        }
        scheduleReclaim();
        sendResponse(result);
        break;
      }
      case MSG.GET_LOGICAL_TOPICS: {
        sendResponse({
          ok: true,
          logical: lastOrganizeState?.logical ?? [],
          latestWinsAt: lastOrganizeState?.latestWinsAt ?? null,
          source: lastOrganizeState?.latestWinsSource ?? null,
        });
        break;
      }
      case MSG.SEARCH_QUERY: {
        const config = await loadConfig();
        const result = await runSearchQuery({
          query: message.query ?? '',
          stackStore,
          topicCache,
          pinyinEnabled: config.searchPinyinEnabled !== false,
        });
        sendResponse(result);
        break;
      }
      case MSG.ACTIVATE_TAB: {
        const tabId = Number(message.tabId);
        if (!Number.isFinite(tabId)) {
          sendResponse({ ok: false, error: 'missing tabId' });
          break;
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await chrome.tabs.update(tabId, { active: true });
          sendResponse({ ok: true, tabId });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        break;
      }
      case MSG.GET_STACKS: {
        sendResponse({
          ok: true,
          stacks: stackStore.list(),
          overflowPending,
          stub: false,
        });
        break;
      }
      case MSG.RECALL_STACK: {
        const stackId = String(message.stackId ?? '');
        const windowId = await resolveCurrentWindowId(message, sender);
        const result = await recallStack(stackId, {
          stackStore,
          windowId,
        });
        sendResponse(result);
        break;
      }
      case MSG.EXPORT_OR_DISCARD_STACKS: {
        const action = message.action === 'export' ? 'export' : 'discard';
        const result = await exportOrDiscardStacks({
          action,
          stackStore,
          overflowPending,
          setOverflowPending,
          count: message.count,
        });
        if (result.ok) {
          scheduleReclaim();
        }
        sendResponse(result);
        break;
      }
      case MSG.TEST_LLM: {
        // Keep mock for TEST_LLM — never send real secrets in connection-test path.
        const config = mergeConfig(await loadConfig());
        const client = createLlmClient({
          provider: /** @type {any} */ (config.llmProvider || undefined),
          endpointBaseUrl: config.endpointBaseUrl,
          apiKey: config.apiKey,
          model: config.model,
          useMock: true,
        });
        const preview = buildClassifyPayloadPreview(
          {
            url: message.url ?? 'https://example.com/stub',
            title: message.title ?? 'Connection test',
            snippet: 'stub',
          },
          {
            provider: /** @type {any} */ (config.llmProvider || ''),
            model: config.model,
            endpointBaseUrl: config.endpointBaseUrl,
          },
        );
        const result = await client.classifyTopic({
          url: message.url ?? 'https://example.com/stub',
          title: message.title ?? 'Connection test',
          snippet: 'stub',
        });
        sendResponse({
          ok: true,
          stub: true,
          preview,
          result,
          note: 'TEST_LLM always uses MockLlmClient. Real Anthropic/Responses calls run on confirmed Organize.',
        });
        break;
      }
      case MSG.GET_ACTIVITY_LOG: {
        sendResponse({ ok: true, entries: activityLog.list(), stub: false });
        break;
      }
      case MSG.GET_JOB_STATE: {
        const cp = organizeCheckpoint || (await loadOrganizeCheckpoint());
        organizeCheckpoint = cp;
        sendResponse({ ok: true, ...summarizeJobState(cp), stub: false });
        break;
      }
      case MSG.GET_METRICS: {
        localMetrics = await loadMetrics();
        const config = await loadConfig();
        sendResponse({
          ok: true,
          metrics: localMetrics,
          dailyLlmQuota: Number(config.dailyLlmQuota) || 0,
          stub: false,
        });
        break;
      }
      default:
        sendResponse({ ok: false, error: `unknown type: ${type}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // async sendResponse
}

chrome.runtime.onInstalled.addListener(() => {
  initPanelBehavior();
  ensureHydrated();
});

chrome.runtime.onStartup.addListener(() => {
  initPanelBehavior();
  ensureHydrated();
});

chrome.runtime.onMessage.addListener(onMessage);

// Cache sync on URL/title updates — metadata only, never LLM / never auto-group.
// URL commits also schedule cross-window auto-dedupe (Phase 5).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleCacheSync(tabId, changeInfo, tab);
  if (changeInfo.url != null || changeInfo.status === 'complete') {
    scheduleDedupe();
  }
});

chrome.tabs.onCreated.addListener(() => {
  // Reclaim pass always runs dedupe first (ADR order). Avoid a second overlapping
  // scheduleDedupe on create — runAutoDedupe is also serialized via dedupeGate.
  scheduleReclaim();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabSync.delete(tabId);
  closingTabIds.delete(tabId);
  // After user/extension close, open count may drop below max — clear path for later.
  scheduleReclaim();
});

// Periodic maintenance + Organize alarm resume (MV3 SW).
try {
  ensureMaintainAlarm();
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ALARM_NAMES.MAINTAIN) {
      scheduleReclaim();
      return;
    }
    if (alarm?.name === ALARM_NAMES.ORGANIZE_RESUME) {
      maybeResumeOrganizeFromCheckpoint().catch((err) => {
        console.warn('[tab-caption] organize resume failed', err);
      });
    }
  });
} catch {
  // alarms may be unavailable in some test environments
}

// Eager init for SW cold start
initPanelBehavior();
ensureHydrated();

// Export for tests / future modules (not used by Chrome loader)
export {
  closingTabIds,
  activityLog,
  topicCache,
  stackStore,
  MSG,
  SESSION_KEYS,
  STORAGE_KEYS,
  ensureHydrated,
  scheduleDedupe,
  runDedupePass,
  scheduleReclaim,
  runReclaimPass,
};
