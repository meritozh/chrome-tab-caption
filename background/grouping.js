/**
 * On-demand group engine (ADR Phase 2 / §5.2–5.3 Decision D).
 * Classify all eligible tabs (including reclaim candidates) → single-window merge
 * (cross-window tabs.move allowed) → physical tabGroups by topic.
 * No auto-group on tab complete.
 *
 * Flow: Side Panel Organize click → quick pass (cache hits) → refine queue (miss/stale)
 * → classify → reclaim excess → merge kept into one window → apply groups.
 * LLM results apply immediately (no Confirm / preview gate).
 */

import { MSG, TIMEOUTS, TAB_GROUP_ID_NONE } from '../shared/constants.js';
import { withTimeout, createDeadline } from '../shared/async-timeout.js';
import { normalizeUrlKey, computeContentHash } from '../shared/url-normalize.js';
import { filterEligibleTabs } from '../shared/tab-eligibility.js';
import {
  buildLogicalTopicViews,
  planPhysicalGroups,
  groupPlansByWindow,
  colorForTopicKey,
} from '../shared/physical-groups.js';
import { isSingleWindowMergeScope } from '../shared/window-merge.js';
import { mergeTopicResult, heuristicTopicsAreSynonyms } from '../shared/topic-normalize.js';
import {
  buildClassifyPayloadPreview,
  createLlmClient,
  isLlmConfigured,
  LLM_CONFIG_REQUIRED_MESSAGE,
  normalizeExistingTopics,
} from '../shared/llm-client.js';
import {
  buildSeedCandidateTopics,
  normalizeSeedTopics,
} from '../shared/seed-topics.js';
import { hasEndpointPermission } from '../shared/permissions.js';
import { capExcerpt, persistTopicCache } from '../shared/topic-cache.js';
import { extractTabContent } from '../content/extract.js';
import { organizeCancelCheckpoint } from '../shared/organize-cancel.js';
import {
  JOB_PHASES,
  createOrganizeCheckpoint,
  isOrganizeCheckpoint,
  remainingRefineItems,
  advancePhase,
  recordRefineStep,
  bumpResumeCount,
} from '../shared/task-state.js';
import { canSpendLlmCall } from '../shared/metrics.js';
import { finalizeSingleWindowOrganize } from './window-merge.js';
import { persistStackRecords } from '../shared/stack-records.js';

/**
 * @typedef {import('../shared/topic-cache.js').TopicCacheLru} TopicCacheLru
 * @typedef {import('../shared/physical-groups.js').TabTopicAssignment} TabTopicAssignment
 */

/**
 * Distinct topic labels currently used by Chrome tab groups in scope.
 * @param {'all' | 'current'} scope
 * @param {number} [currentWindowId]
 * @returns {Promise<string[]>}
 */
export async function listPhysicalGroupTopicLabels(scope, currentWindowId) {
  try {
    const tabs = await queryTabsForScope(scope, currentWindowId);
    /** @type {Set<number>} */
    const groupIds = new Set();
    for (const tab of tabs) {
      const gid = tab?.groupId;
      if (typeof gid === 'number' && gid !== TAB_GROUP_ID_NONE && gid >= 0) {
        groupIds.add(gid);
      }
    }
    /** @type {string[]} */
    const titles = [];
    for (const groupId of groupIds) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        if (group?.title) titles.push(String(group.title));
      } catch {
        // group may have closed
      }
    }
    return normalizeExistingTopics(titles);
  } catch {
    return [];
  }
}

/**
 * Labels already assigned this run (registry) + seed physical groups.
 * @param {Map<string, { label?: string }>} topicRegistry
 * @param {string[]} [seedLabels]
 */
export function existingTopicsForClassify(topicRegistry, seedLabels = []) {
  const fromRegistry = [];
  if (topicRegistry && typeof topicRegistry.values === 'function') {
    for (const rec of topicRegistry.values()) {
      if (rec?.label) fromRegistry.push(rec.label);
    }
  }
  return normalizeExistingTopics([...(seedLabels || []), ...fromRegistry]);
}

/**
 * Broadcast progress to Side Panel (fail-soft if no listeners).
 * @param {Record<string, unknown>} payload
 */
function broadcastProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: MSG.GROUP_PROGRESS, ...payload }).catch(() => {});
  } catch {
    // no listeners / SW teardown
  }
}

/**
 * Query tabs for organize scope.
 * @param {'all' | 'current'} scope
 * @param {number} [currentWindowId]
 */
export async function queryTabsForScope(scope, currentWindowId) {
  if (scope === 'current') {
    const windowId =
      typeof currentWindowId === 'number'
        ? currentWindowId
        : (await chrome.windows.getCurrent()).id;
    return chrome.tabs.query({ windowId });
  }
  return chrome.tabs.query({});
}

/**
 * Build privacy preview for an organize pass (no LLM calls).
 * @param {object} opts
 * @param {'all' | 'current'} [opts.scope]
 * @param {number} [opts.currentWindowId]
 * @param {TopicCacheLru} opts.topicCache
 * @param {Record<string, unknown>} opts.config
 */
export async function buildGroupPayloadPreview(opts) {
  const scope = opts.scope === 'current' ? 'current' : 'all';
  const tabs = filterEligibleTabs(await queryTabsForScope(scope, opts.currentWindowId));
  const config = opts.config;
  const samples = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const tab of tabs) {
    const urlKey = normalizeUrlKey(tab.url || '');
    const contentHash = await computeContentHash({
      title: tab.title || '',
      excerpt: '',
      url: urlKey,
    });
    const hit = urlKey ? opts.topicCache.peek(urlKey, contentHash) : null;
    if (hit) cacheHits += 1;
    else cacheMisses += 1;

    if (samples.length < 5) {
      const preview = buildClassifyPayloadPreview(
        {
          url: tab.url || '',
          title: tab.title || '',
          snippet: '',
          extractedText: '',
        },
        {
          provider: /** @type {any} */ (config.llmProvider || ''),
          model: /** @type {string} */ (config.model || ''),
          endpointBaseUrl: /** @type {string} */ (config.endpointBaseUrl || ''),
        },
      );
      samples.push({
        tabId: tab.id,
        windowId: tab.windowId,
        cacheStatus: hit ? 'hit' : 'miss',
        topicLabel: hit?.topicLabel || null,
        fields: preview.fields,
      });
    }
  }

  return {
    scope,
    eligibleCount: tabs.length,
    cacheHits,
    cacheMisses,
    fieldsTemplate: [
      'url',
      'title',
      'snippet',
      'extractedText',
      'provider',
      'model',
      'endpointBaseUrl',
    ],
    note: 'API key is never shown. Cache misses are classified on Organize (no confirm step).',
    samples,
    privacyShowFieldsPreview: true,
  };
}

/**
 * Apply physical tabGroups for planned groups.
 * Tabs must already live in plan.windowId (caller merges first for single-window Organize).
 * @param {import('../shared/physical-groups.js').PhysicalGroupPlan[]} plans
 * @param {{ latestWins?: boolean }} [opts]
 */
export async function applyPhysicalGroups(plans, opts = {}) {
  const byWindow = groupPlansByWindow(plans);
  let applied = 0;
  const errors = [];

  for (const [windowId, windowPlans] of byWindow) {
    // Existing groups in this window (for title reuse / collapse)
    /** @type {Map<string, number>} titleLower → groupId */
    const titleToGroup = new Map();
    try {
      const existing = await chrome.tabGroups.query({ windowId });
      for (const g of existing) {
        if (g.title) titleToGroup.set(g.title.toLowerCase(), g.id);
      }
    } catch (err) {
      errors.push(String(err?.message || err));
    }

    for (const plan of windowPlans) {
      if (!plan.tabIds.length) continue;
      try {
        // Verify tabs still live in the plan window (merge step already moved them).
        const live = [];
        for (const tabId of plan.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.windowId === windowId && !tab.pinned) live.push(tabId);
          } catch {
            // tab closed
          }
        }
        if (!live.length) continue;

        const existingGroupId = titleToGroup.get(plan.title.toLowerCase());
        let groupId;
        if (typeof existingGroupId === 'number') {
          groupId = existingGroupId;
          await chrome.tabs.group({ groupId, tabIds: live });
        } else {
          groupId = await chrome.tabs.group({ tabIds: live, createProperties: { windowId } });
          titleToGroup.set(plan.title.toLowerCase(), groupId);
        }

        await chrome.tabGroups.update(groupId, {
          title: plan.title.slice(0, 50),
          color: /** @type {any} */ (colorForTopicKey(plan.topicKey)),
        });
        applied += 1;
      } catch (err) {
        errors.push(`window ${windowId} / ${plan.topicKey}: ${err?.message || err}`);
      }
    }
  }

  return { applied, errors, latestWins: opts.latestWins !== false, stub: false };
}

/**
 * Soft-merge synonym topics across a batch using heuristic near-duplicates.
 * @param {TabTopicAssignment[]} assignments
 * @param {Map<string, import('../shared/topic-normalize.js').TopicRecord>} registry
 */
function collapseHeuristicSynonyms(assignments, registry) {
  const keys = [...registry.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = registry.get(keys[i]);
      const b = registry.get(keys[j]);
      if (!a || !b) continue;
      if (!heuristicTopicsAreSynonyms(a.label, b.label)) continue;
      // Keep earlier key; remap b → a
      for (const asg of assignments) {
        if (asg.topicKey === b.normalizedKey) {
          asg.topicKey = a.normalizedKey;
          asg.topicLabel = a.label;
        }
      }
      registry.delete(b.normalizedKey);
    }
  }
}

/**
 * Persist + broadcast job checkpoint (fail-soft).
 * @param {(cp: import('../shared/task-state.js').OrganizeCheckpoint) => void | Promise<void>} [onCheckpoint]
 * @param {import('../shared/task-state.js').OrganizeCheckpoint} checkpoint
 */
async function emitCheckpoint(onCheckpoint, checkpoint) {
  if (!onCheckpoint) return;
  try {
    await onCheckpoint(checkpoint);
  } catch {
    // storage / listeners may be unavailable
  }
}

/**
 * Full on-demand organize job (supports alarm resume via checkpoint).
 * @param {object} opts
 * @param {'all' | 'current'} [opts.scope]
 * @param {number} [opts.currentWindowId]
 * @param {boolean} [opts.confirmed] — legacy; Organize no longer gates on Confirm (always proceeds)
 * @param {TopicCacheLru} opts.topicCache
 * @param {Record<string, unknown>} opts.config
 * @param {AbortSignal} [opts.signal] — cooperative cancel between classify steps
 * @param {string} [opts.jobId]
 * @param {import('../shared/task-state.js').OrganizeCheckpoint} [opts.resumeFrom]
 * @param {(cp: import('../shared/task-state.js').OrganizeCheckpoint) => void | Promise<void>} [opts.onCheckpoint]
 * @param {() => void | Promise<void>} [opts.onLlmSpend] — persist daily quota immediately per call
 * @param {import('../shared/metrics.js').LocalMetrics} [opts.metrics]
 * @param {number | null} [opts.clientRunId]
 * @param {import('../shared/stack-records.js').StackRecordStore} [opts.stackStore]
 * @param {Set<number>} [opts.closingTabIds]
 * @param {(pending: object | null) => Promise<void> | void} [opts.setOverflowPending]
 * @param {object | null} [opts.overflowPending]
 * @param {{ push: (e: object) => object }} [opts.activityLog]
 * @param {boolean} [opts.clearCache] — wipe topic cache before classify
 * @param {boolean} [opts.bypassCache] — never use cache hits this run
 * @param {boolean} [opts.reorganize] — clear cache, bypass hits, reclassify Stacks
 * @param {boolean} [opts.reclassifyStacks] — refresh topics on all Stack records
 */
export async function groupTabsOnDemand(opts) {
  const resuming = isOrganizeCheckpoint(opts.resumeFrom);
  const resumeCp = resuming ? opts.resumeFrom : null;
  const scope = resuming
    ? resumeCp.scope === 'current'
      ? 'current'
      : 'all'
    : opts.scope === 'current'
      ? 'current'
      : 'all';
  const config = opts.config;
  const topicCache = opts.topicCache;
  const signal = opts.signal;
  // Prefer explicit opts; on alarm resume fall back to checkpoint flags.
  const reorganize =
    opts.reorganize === true || resumeCp?.reorganize === true;
  const clearCache =
    !resuming && (opts.clearCache === true || reorganize || resumeCp?.clearCache === true);
  const bypassCache =
    opts.bypassCache === true ||
    reorganize ||
    resumeCp?.bypassCache === true;
  const reclassifyStacks =
    opts.reclassifyStacks === true ||
    reorganize ||
    resumeCp?.reclassifyStacks === true;
  let stacksDone = resumeCp?.stacksDone === true;
  /** @type {string[]} */
  let processedStackIds = Array.isArray(resumeCp?.processedStackIds)
    ? resumeCp.processedStackIds.slice()
    : [];
  /**
   * Candidates for classify:
   * Organize — existing Chrome groups ∪ seed topics (prefer those, then invent).
   * Reorganize — seed topics only (existing cleared; invent when nothing fits).
   * Never dump into Other.
   */
  const configSeedTopics = normalizeSeedTopics(config.seedTopics);
  /** @type {string[]} */
  let physicalGroupLabels = [];
  if (!reorganize) {
    physicalGroupLabels = await listPhysicalGroupTopicLabels(
      scope,
      typeof opts.currentWindowId === 'number'
        ? opts.currentWindowId
        : resumeCp?.currentWindowId ?? undefined,
    );
  }
  const baseCandidateTopics = buildSeedCandidateTopics({
    seedTopics: configSeedTopics,
    existingGroupLabels: physicalGroupLabels,
    reorganize,
  });
  const candidateMode = reorganize ? 'reorganize' : 'organize';
  const onCheckpoint = opts.onCheckpoint;
  const onLlmSpend = opts.onLlmSpend;
  const metrics = opts.metrics;
  const dailyQuota = Number(config.dailyLlmQuota) || 0;
  const singleWindowMerge = isSingleWindowMergeScope(config) && scope === 'all';

  const startedAt = resumeCp?.startedAt ?? Date.now();
  // Fresh wall-clock budget on resume — SW sleep must not consume the original deadlineAt.
  const deadlineMs = TIMEOUTS.GROUP_JOB_MS;
  const deadline = createDeadline(deadlineMs);
  const jobId = opts.jobId || resumeCp?.jobId || `group-${Date.now()}`;
  const clientRunId =
    opts.clientRunId != null
      ? opts.clientRunId
      : resumeCp?.clientRunId != null
        ? resumeCp.clientRunId
        : null;

  /** @type {Map<string, import('../shared/topic-normalize.js').TopicRecord>} */
  const topicRegistry = new Map();
  /** @type {TabTopicAssignment[]} */
  const assignments = resuming && Array.isArray(resumeCp.assignments)
    ? resumeCp.assignments.map((a) => ({ ...a }))
    : [];

  // Rebuild synonym registry from resumed assignments.
  for (const a of assignments) {
    if (!a?.topicKey) continue;
    if (!topicRegistry.has(a.topicKey)) {
      topicRegistry.set(a.topicKey, {
        label: a.topicLabel || a.topicKey,
        normalizedKey: a.topicKey,
        synonymKeys: [],
      });
    }
  }

  let classified = resumeCp?.classified ?? 0;
  let classifyErrors = resumeCp?.classifyErrors ?? 0;
  let llmCallsAttempted = resumeCp?.llmCallsAttempted ?? 0;
  let resumeCount = resumeCp?.resumeCount ?? 0;
  /** @type {{ applied: number, errors: string[], latestWins?: boolean, stub?: boolean }} */
  let physical = { applied: 0, errors: [] };

  /** @type {import('../shared/task-state.js').OrganizeCheckpoint} */
  let checkpoint = createOrganizeCheckpoint({
    ...(resumeCp || {}),
    jobId,
    scope,
    confirmed: true,
    clientRunId,
    currentWindowId:
      typeof opts.currentWindowId === 'number'
        ? opts.currentWindowId
        : resumeCp?.currentWindowId ?? null,
    startedAt,
    deadlineAt: Date.now() + deadlineMs,
    assignments,
    classified,
    classifyErrors,
    llmCallsAttempted,
    resumeCount,
    reorganize,
    clearCache: clearCache || resumeCp?.clearCache === true || reorganize,
    bypassCache,
    reclassifyStacks,
    stacksDone,
    processedStackIds,
    phase: resuming ? JOB_PHASES.REFINE : JOB_PHASES.QUEUED,
  });

  if (resuming) {
    checkpoint = bumpResumeCount(checkpoint);
    resumeCount = checkpoint.resumeCount;
  }

  // Factory — buildLogicalTopicViews only runs when the signal is actually aborted.
  const cancelState = () => ({
    jobId,
    scope,
    llmCallsAttempted,
    classified,
    classifyErrors,
    assignments,
    physical,
    logical: buildLogicalTopicViews(assignments),
  });

  /**
   * @returns {ReturnType<typeof organizeCancelCheckpoint>}
   */
  const checkCancel = () => organizeCancelCheckpoint(signal, cancelState);

  const snapshotCheckpoint = (phase, patch = {}) => {
    checkpoint = advancePhase(
      createOrganizeCheckpoint({
        ...checkpoint,
        assignments: assignments.slice(),
        classified,
        classifyErrors,
        llmCallsAttempted,
        resumeCount,
        ...patch,
      }),
      phase,
      patch,
    );
    return checkpoint;
  };

  const earlyCancel = checkCancel();
  if (!earlyCancel.continue) {
    await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.CANCELLED));
    broadcastProgress({
      jobId,
      phase: 'cancelled',
      done: 0,
      total: checkpoint.total || 0,
      llmCallsAttempted: 0,
      classified: 0,
      message: earlyCancel.result.message,
    });
    return earlyCancel.result;
  }

  if (clearCache && !resuming) {
    topicCache.clear();
    await persistTopicCache(topicCache);
    broadcastProgress({
      jobId,
      phase: 'clear-cache',
      done: 0,
      total: 0,
      messageKey: 'progress.clearedCache',
      message: 'Cleared topic cache…',
    });
  }

  /** @type {{ tab: chrome.tabs.Tab, urlKey: string, contentHash: string }[]} */
  let refineQueue = [];
  let total = checkpoint.total || 0;
  let refineStartIndex = 0;

  if (resuming && Array.isArray(resumeCp.refineQueue) && resumeCp.refineQueue.length) {
    refineStartIndex = Math.max(0, Number(resumeCp.refineIndex) || 0);
    total = resumeCp.total || resumeCp.refineQueue.length + assignments.length;
    broadcastProgress({
      jobId,
      phase: 'refine',
      done: assignments.length,
      total,
      resumeCount,
      message: `Resuming Organize (alarm) — ${remainingRefineItems(resumeCp).length} tabs left…`,
    });
    // Rebuild live tab refs for remaining refine items.
    for (const item of resumeCp.refineQueue) {
      let tab = null;
      try {
        tab = await chrome.tabs.get(item.tabId);
      } catch {
        tab = null;
      }
      refineQueue.push({
        tab: tab || {
          id: item.tabId,
          windowId: item.windowId,
          url: item.url,
          title: item.title,
        },
        urlKey: item.urlKey,
        contentHash: item.contentHash,
      });
    }
    await emitCheckpoint(
      onCheckpoint,
      snapshotCheckpoint(JOB_PHASES.REFINE, {
        total,
        refineQueue: resumeCp.refineQueue,
        refineIndex: refineStartIndex,
      }),
    );
  } else {
    const allTabs = filterEligibleTabs(await queryTabsForScope(scope, opts.currentWindowId));
    total = allTabs.length;

    await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.QUICK_PASS, { total }));
    broadcastProgress({
      jobId,
      phase: 'quick-pass',
      done: 0,
      total,
      messageKey: bypassCache ? 'organize.reorganizing' : 'progress.quickPass',
      message: bypassCache
        ? 'Reorganizing — classifying all tabs…'
        : 'Quick pass: applying cached topics…',
    });

    // Pass 1 — cache hits (skipped entirely when bypassCache / reorganize)
    for (let i = 0; i < allTabs.length; i++) {
      const cancelled = checkCancel();
      if (!cancelled.continue) {
        await persistTopicCache(topicCache);
        await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.CANCELLED, { total }));
        broadcastProgress({
          jobId,
          phase: 'cancelled',
          done: assignments.length,
          total,
          llmCallsAttempted,
          classified,
          message: cancelled.result.message,
        });
        return cancelled.result;
      }
      if (deadline.expired()) break;
      const tab = allTabs[i];
      const urlKey = normalizeUrlKey(tab.url || '');
      if (!urlKey) continue;
      const contentHash = await computeContentHash({
        title: tab.title || '',
        excerpt: '',
        url: urlKey,
      });
      const hit = bypassCache ? null : topicCache.lookup(urlKey, contentHash);
      if (hit) {
        const topic = mergeTopicResult(
          { topic: hit.topicLabel, synonyms: [] },
          topicRegistry,
        );
        assignments.push({
          tabId: /** @type {number} */ (tab.id),
          windowId: /** @type {number} */ (tab.windowId),
          topicKey: topic.normalizedKey,
          topicLabel: topic.label,
        });
      } else {
        refineQueue.push({ tab, urlKey, contentHash });
      }
      if (i % 8 === 0) {
        broadcastProgress({
          jobId,
          phase: 'quick-pass',
          done: i + 1,
          total,
          message: `Quick pass ${i + 1}/${total}`,
        });
      }
    }

    // Early physical apply only for legacy per-window scope — single-window
    // merge waits until reclaim + cross-window move finish.
    {
      const cancelled = checkCancel();
      if (!cancelled.continue) {
        await persistTopicCache(topicCache);
        await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.CANCELLED, { total }));
        broadcastProgress({
          jobId,
          phase: 'cancelled',
          done: assignments.length,
          total,
          llmCallsAttempted,
          classified,
          message: cancelled.result.message,
        });
        return cancelled.result;
      }
    }
    if (assignments.length && !singleWindowMerge) {
      const quickPlans = planPhysicalGroups(assignments);
      physical = await applyPhysicalGroups(quickPlans);
      broadcastProgress({
        jobId,
        phase: 'quick-pass-applied',
        done: assignments.length,
        total,
        applied: physical.applied,
        message: `Cached groups applied (${physical.applied}). Refining ${refineQueue.length}…`,
      });
    } else if (assignments.length && singleWindowMerge) {
      broadcastProgress({
        jobId,
        phase: 'quick-pass-applied',
        done: assignments.length,
        total,
        applied: 0,
        message: `Cached topics ready (${assignments.length}). Refining ${refineQueue.length}…`,
      });
    }

    const persistedQueue = refineQueue.map(({ tab, urlKey, contentHash }) => ({
      tabId: /** @type {number} */ (tab.id),
      windowId: /** @type {number} */ (tab.windowId),
      url: tab.url || '',
      title: tab.title || '',
      urlKey,
      contentHash,
    }));
    await emitCheckpoint(
      onCheckpoint,
      snapshotCheckpoint(JOB_PHASES.QUICK_PASS_APPLIED, {
        total,
        refineQueue: persistedQueue,
        refineIndex: 0,
      }),
    );
  }

  // Cache hits already applied above. Remaining cache misses require a live user LLM —
  // never invent topics (hostname / mock). All-cache-hit Organize may finish without LLM.
  const remainingRefineCount = Math.max(0, refineQueue.length - refineStartIndex);
  if (remainingRefineCount > 0) {
    if (!isLlmConfigured(config)) {
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.ERROR, { total }));
      broadcastProgress({
        jobId,
        phase: 'error',
        done: assignments.length,
        total,
        message: LLM_CONFIG_REQUIRED_MESSAGE,
      });
      return {
        ok: false,
        error: LLM_CONFIG_REQUIRED_MESSAGE,
        needsLlmConfig: true,
        jobId,
        classified,
        classifyErrors,
        llmCallsAttempted,
        assignments: assignments.slice(),
        logical: buildLogicalTopicViews(assignments),
        physical: { applied: 0, errors: [] },
      };
    }

    // Permission grant happens in Side Panel user-gesture; SW only checks containment.
    const allowed = await hasEndpointPermission(
      /** @type {string} */ (config.endpointBaseUrl || ''),
      /** @type {string} */ (config.llmProvider || ''),
    );
    if (!allowed) {
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.ERROR, { total }));
      return {
        ok: false,
        error:
          'Host permission for the LLM endpoint is missing. Run Organize again after granting access.',
        needsPermission: true,
        needsLlmConfig: false,
      };
    }
  }

  {
    const cancelled = checkCancel();
    if (!cancelled.continue) {
      await persistTopicCache(topicCache);
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.CANCELLED, { total }));
      broadcastProgress({
        jobId,
        phase: 'cancelled',
        done: assignments.length,
        total,
        llmCallsAttempted,
        classified,
        message: cancelled.result.message,
      });
      return cancelled.result;
    }
  }

  /** @type {import('../shared/llm-client.js').LlmClient | null} */
  let client = null;
  if (remainingRefineCount > 0) {
    try {
      client = createLlmClient({
        provider: /** @type {any} */ (config.llmProvider),
        endpointBaseUrl: /** @type {string} */ (config.endpointBaseUrl || ''),
        apiKey: /** @type {string} */ (config.apiKey || ''),
        model: /** @type {string} */ (config.model || ''),
      });
    } catch (err) {
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.ERROR, { total }));
      const message = String(err?.message || err || LLM_CONFIG_REQUIRED_MESSAGE);
      broadcastProgress({
        jobId,
        phase: 'error',
        done: assignments.length,
        total,
        message,
      });
      return {
        ok: false,
        error: message,
        needsLlmConfig: true,
        jobId,
      };
    }
  }

  // Pass 2 — refine queue (supports resume mid-queue)
  for (let i = refineStartIndex; i < refineQueue.length; i++) {
    const cancelled = checkCancel();
    if (!cancelled.continue) {
      await persistTopicCache(topicCache);
      await emitCheckpoint(
        onCheckpoint,
        snapshotCheckpoint(JOB_PHASES.CANCELLED, {
          total,
          refineIndex: i,
          refineQueue: checkpoint.refineQueue,
        }),
      );
      broadcastProgress({
        jobId,
        phase: 'cancelled',
        done: assignments.length,
        total,
        llmCallsAttempted,
        classified,
        message: cancelled.result.message,
      });
      return cancelled.result;
    }

    if (deadline.expired()) {
      await emitCheckpoint(
        onCheckpoint,
        snapshotCheckpoint(JOB_PHASES.TIMEOUT, {
          total,
          refineIndex: i,
          refineQueue: checkpoint.refineQueue,
        }),
      );
      broadcastProgress({
        jobId,
        phase: 'timeout',
        done: assignments.length,
        total,
        message: 'Organize budget exhausted — partial results kept.',
      });
      break;
    }

    const { tab, urlKey, contentHash: priorHash } = refineQueue[i];
    broadcastProgress({
      jobId,
      phase: 'refine',
      done: assignments.length,
      total,
      refineIndex: i + 1,
      refineTotal: refineQueue.length,
      llmCallsAttempted,
      classified,
      message: `Classifying ${i + 1}/${refineQueue.length}: ${tab.title || urlKey}`,
    });

    let excerpt = '';
    if (config.contentExtractionEnabled !== false) {
      const extracted = await extractTabContent(/** @type {number} */ (tab.id), {
        title: tab.title || '',
        url: tab.url || '',
        timeoutMs: Math.min(TIMEOUTS.EXTRACT_MS, deadline.remaining()),
      });
      excerpt = capExcerpt(extracted.excerpt || '');
    }

    const contentHash = await computeContentHash({
      title: tab.title || '',
      excerpt,
      url: urlKey,
    });

    // Re-check cache with richer hash (title+excerpt) — skipped when bypassing cache.
    const rehit = bypassCache
      ? null
      : topicCache.lookup(urlKey, contentHash) || topicCache.lookup(urlKey, priorHash);
    /** @type {TabTopicAssignment | null} */
    let stepAssignment = null;
    if (rehit) {
      const topic = mergeTopicResult(
        { topic: rehit.topicLabel, synonyms: [] },
        topicRegistry,
      );
      stepAssignment = {
        tabId: /** @type {number} */ (tab.id),
        windowId: /** @type {number} */ (tab.windowId),
        topicKey: topic.normalizedKey,
        topicLabel: topic.label,
      };
      assignments.push(stepAssignment);
    } else {
      const allowLlm = metrics == null || canSpendLlmCall(metrics, dailyQuota);
      if (!allowLlm) {
        // Quota exhausted — do not invent topics; skip remaining cache misses.
        classifyErrors += 1;
        broadcastProgress({
          jobId,
          phase: 'refine-error',
          done: assignments.length,
          total,
          message: 'Daily LLM quota reached — skipping classify for remaining cache misses.',
        });
        checkpoint = recordRefineStep(
          createOrganizeCheckpoint({
            ...checkpoint,
            assignments: assignments.slice(),
            classified,
            classifyErrors,
            llmCallsAttempted,
            refineQueue: checkpoint.refineQueue,
            refineIndex: i,
            total,
          }),
          { classifyErrors },
        );
        await emitCheckpoint(onCheckpoint, checkpoint);
        continue;
      }

      if (!client) {
        classifyErrors += 1;
        continue;
      }

      llmCallsAttempted += 1;
      // Persist spend immediately so SW kill mid-refine cannot lose daily quota counts.
      if (typeof onLlmSpend === 'function') {
        try {
          await onLlmSpend();
        } catch {
          // fail-soft — still attempt classify
        }
      } else if (metrics && typeof metrics === 'object') {
        metrics.dailyLlmCalls = (Number(metrics.dailyLlmCalls) || 0) + 1;
        metrics.llmCalls = (Number(metrics.llmCalls) || 0) + 1;
        metrics.dailyLlmDate =
          metrics.dailyLlmDate || new Date().toISOString().slice(0, 10);
      }
      try {
        const result = await withTimeout(
          client.classifyTopic({
            url: tab.url || '',
            title: tab.title || '',
            snippet: excerpt,
            extractedText: excerpt,
            preferExisting: true,
            candidateMode,
            existingTopics: existingTopicsForClassify(
              topicRegistry,
              baseCandidateTopics,
            ),
          }),
          Math.min(TIMEOUTS.CLASSIFY_MS, Math.max(500, deadline.remaining())),
          'classify',
        );
        // Keep the in-flight result (request already sent); cancel stops the next queue item.
        const topic = mergeTopicResult(result, topicRegistry);
        topicCache.upsert({
          urlKey,
          contentHash,
          topicKey: topic.normalizedKey,
          topicLabel: topic.label,
          excerpt,
        });
        // Also store under title-only hash used in quick pass for future hits
        if (contentHash !== priorHash) {
          topicCache.upsert({
            urlKey,
            contentHash: priorHash,
            topicKey: topic.normalizedKey,
            topicLabel: topic.label,
            excerpt,
          });
        }
        stepAssignment = {
          tabId: /** @type {number} */ (tab.id),
          windowId: /** @type {number} */ (tab.windowId),
          topicKey: topic.normalizedKey,
          topicLabel: topic.label,
        };
        assignments.push(stepAssignment);
        classified += 1;
      } catch (err) {
        classifyErrors += 1;
        broadcastProgress({
          jobId,
          phase: 'refine-error',
          done: assignments.length,
          total,
          message: `Classify failed: ${err?.message || err}`,
        });
      }
    }

    checkpoint = recordRefineStep(
      createOrganizeCheckpoint({
        ...checkpoint,
        assignments: assignments.slice(),
        classified,
        classifyErrors,
        llmCallsAttempted,
        refineQueue: checkpoint.refineQueue,
        refineIndex: i,
        total,
      }),
      {
        assignment: null, // already merged into assignments above
        llmCallsAttempted,
        classified,
        classifyErrors,
      },
    );
    await emitCheckpoint(onCheckpoint, checkpoint);
  }

  {
    const cancelled = checkCancel();
    if (!cancelled.continue) {
      await persistTopicCache(topicCache);
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.CANCELLED, { total }));
      broadcastProgress({
        jobId,
        phase: 'cancelled',
        done: assignments.length,
        total,
        llmCallsAttempted,
        classified,
        message: cancelled.result.message,
      });
      return cancelled.result;
    }
  }

  // Reorganize: refresh topics on every Stack record (title/url classify; no live tab extract).
  // Also runs after alarm resume when checkpoint kept reclassifyStacks / reorganize.
  // Do NOT merge/apply/reclaim until stacksDone — a deadline cut must leave the keep-set alone.
  let stacksReclassified = 0;
  if (reclassifyStacks && opts.stackStore && !stacksDone) {
    const stackResult = await reclassifyAllStacks({
      stackStore: opts.stackStore,
      topicCache,
      topicRegistry,
      config,
      seedTopics: configSeedTopics,
      client,
      signal,
      deadline,
      metrics,
      dailyQuota,
      onLlmSpend,
      jobId,
      processedStackIds,
      checkCancel,
      getStats: () => ({ llmCallsAttempted, classified, classifyErrors }),
      bumpStats: (patch) => {
        if (typeof patch.llmCallsAttempted === 'number') {
          llmCallsAttempted = patch.llmCallsAttempted;
        }
        if (typeof patch.classified === 'number') classified = patch.classified;
        if (typeof patch.classifyErrors === 'number') {
          classifyErrors = patch.classifyErrors;
        }
      },
      onStackProgress: async (ids) => {
        processedStackIds = Array.isArray(ids) ? ids.slice() : processedStackIds;
        await emitCheckpoint(
          onCheckpoint,
          snapshotCheckpoint(JOB_PHASES.REFINE, {
            total,
            stacksDone: false,
            processedStackIds,
            // Keep resume age window alive across long Reorganize / alarm gaps.
            startedAt: Date.now(),
          }),
        );
      },
    });
    if (stackResult.cancelled) {
      await persistTopicCache(topicCache);
      processedStackIds = stackResult.processedStackIds ?? processedStackIds;
      await emitCheckpoint(
        onCheckpoint,
        snapshotCheckpoint(JOB_PHASES.CANCELLED, {
          total,
          stacksDone: false,
          processedStackIds,
        }),
      );
      return stackResult.cancelled;
    }
    if (stackResult.needsLlmConfig) {
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.ERROR, { total }));
      return stackResult.needsLlmConfig;
    }
    stacksReclassified = stackResult.reclassified || 0;
    client = stackResult.client ?? client;
    processedStackIds = stackResult.processedStackIds ?? processedStackIds;
    // Only mark stacksDone when every *current* stack id was processed — never
    // because a positional index fell past a mutated list length.
    if (stackResult.complete) {
      stacksDone = true;
      await emitCheckpoint(
        onCheckpoint,
        snapshotCheckpoint(JOB_PHASES.REFINE, {
          total,
          stacksDone: true,
          processedStackIds,
        }),
      );
    } else {
      stacksDone = false;
      await persistTopicCache(topicCache);
      await emitCheckpoint(
        onCheckpoint,
        snapshotCheckpoint(JOB_PHASES.INTERRUPTED, {
          total,
          stacksDone: false,
          processedStackIds,
          startedAt: Date.now(),
        }),
      );
      broadcastProgress({
        jobId,
        phase: 'timeout',
        done: assignments.length,
        total,
        messageKey: 'organize.stacksPaused',
        message: 'Organize budget exhausted during stack reclassify — will resume.',
        llmCallsAttempted,
        classified,
      });
      // No merge / apply / reclaim — keep-set must not be touched until stacks finish.
      return {
        ok: false,
        timeout: true,
        stacksPending: true,
        stub: false,
        jobId,
        scope,
        logical: buildLogicalTopicViews(assignments),
        assignments: assignments.slice(),
        physical,
        merge: null,
        classified,
        classifyErrors,
        llmCallsAttempted,
        resumeCount,
        stacksReclassified,
        processedStackIds,
        reorganize: reorganize || undefined,
        cacheSize: topicCache.size,
        latestWinsAt: Date.now(),
        latestWinsSource: reorganize ? 'extension-reorganize' : 'extension-organize',
      };
    }
  }

  await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.APPLYING, { total }));
  collapseHeuristicSynonyms(assignments, topicRegistry);

  /** @type {Record<string, unknown> | null} */
  let merge = null;
  let finalAssignments = assignments;

  if (singleWindowMerge) {
    broadcastProgress({
      jobId,
      phase: 'merge',
      done: assignments.length,
      total,
      message: 'Merging into one window (keep top maxOpenTabs by lastAccessed)…',
    });
    try {
      merge = await finalizeSingleWindowOrganize({
        assignments,
        config,
        topicCache,
        stackStore: opts.stackStore,
        closingTabIds: opts.closingTabIds,
        setOverflowPending: opts.setOverflowPending,
        overflowPending: opts.overflowPending,
        preferredWindowId:
          typeof opts.currentWindowId === 'number' ? opts.currentWindowId : null,
        activityLog: opts.activityLog,
        tabActivity: opts.tabActivity,
        onProgress: (payload) => {
          broadcastProgress({ jobId, done: assignments.length, total, ...payload });
        },
      });
      // Empty remappedAssignments/plans are valid (e.g. every classified tab stacked).
      if (Array.isArray(merge.remappedAssignments)) {
        finalAssignments = /** @type {TabTopicAssignment[]} */ (merge.remappedAssignments);
      }
      const plans = Array.isArray(merge.plans)
        ? merge.plans
        : planPhysicalGroups(finalAssignments);
      physical = await applyPhysicalGroups(plans);
      if (Array.isArray(merge.errors) && merge.errors.length) {
        physical = {
          ...physical,
          errors: [...(physical.errors || []), ...merge.errors],
        };
      }
    } catch (err) {
      // Fail-soft: fall back to per-window plans so partial classify is not lost.
      const plans = planPhysicalGroups(assignments);
      physical = await applyPhysicalGroups(plans);
      physical.errors = [
        ...(physical.errors || []),
        `single-window merge: ${err?.message || err}`,
      ];
    }
  } else {
    const plans = planPhysicalGroups(assignments);
    physical = await applyPhysicalGroups(plans);
  }

  const logical = buildLogicalTopicViews(finalAssignments);

  await persistTopicCache(topicCache);

  await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.DONE, { total }));

  broadcastProgress({
    jobId,
    phase: 'done',
    done: assignments.length,
    total,
    applied: physical.applied,
    classified,
    classifyErrors,
    llmCallsAttempted,
    resumeCount,
    reclaimed: merge?.reclaimed ?? 0,
    targetWindowId: merge?.targetWindowId ?? null,
    message: singleWindowMerge
      ? `Done — ${logical.length} topics, ${physical.applied} groups in one window` +
        (merge?.reclaimed ? `, ${merge.reclaimed} stacked` : '') +
        '.'
      : `Done — ${logical.length} topics, ${physical.applied} window groups.`,
  });

  return {
    ok: true,
    stub: false,
    jobId,
    scope,
    logical,
    assignments: finalAssignments,
    physical,
    merge,
    classified,
    classifyErrors,
    llmCallsAttempted,
    resumeCount,
    stacksReclassified,
    reorganize: reorganize || undefined,
    cacheSize: topicCache.size,
    latestWinsAt: Date.now(),
    latestWinsSource: reorganize ? 'extension-reorganize' : 'extension-organize',
  };
}

/**
 * Remaining stack records not yet in the processed-id set (stable across list mutations).
 * @param {{ id?: string }[]} stacks
 * @param {Iterable<string>} processedIds
 */
export function remainingStacksForReclassify(stacks, processedIds) {
  const done = new Set(
    [...(processedIds || [])].map((id) => String(id || '')).filter(Boolean),
  );
  const list = Array.isArray(stacks) ? stacks : [];
  return list.filter((s) => s?.id && !done.has(String(s.id)));
}

/**
 * Progress counts relative to the *current* stack list (intersection of
 * processed ids with live ids) so discarded/recalled ids cannot inflate current.
 * @param {{ id?: string }[]} stacks
 * @param {Iterable<string>} processedIds
 * @returns {{ done: number, total: number, current: number }}
 */
export function stackReclassifyProgressCounts(stacks, processedIds) {
  const done = new Set(
    [...(processedIds || [])].map((id) => String(id || '')).filter(Boolean),
  );
  const list = Array.isArray(stacks) ? stacks : [];
  const liveIds = list
    .map((s) => (s?.id ? String(s.id) : ''))
    .filter(Boolean);
  const total = liveIds.length;
  const doneOnLive = liveIds.filter((id) => done.has(id)).length;
  const pending = total - doneOnLive;
  return {
    done: doneOnLive,
    total,
    // Next item about to run, or total when finished.
    current: pending > 0 ? doneOnLive + 1 : total,
  };
}

/**
 * Reclassify every StackRecord via LLM (or skip when quota exhausted).
 * Updates stackStore in place and persists; also upserts topic cache.
 * Resume skips ids already in processedStackIds (not a positional index).
 *
 * @param {object} opts
 */
async function reclassifyAllStacks(opts) {
  const stacks = opts.stackStore?.list?.() ?? [];
  /** @type {Set<string>} */
  const processed = new Set(
    (Array.isArray(opts.processedStackIds) ? opts.processedStackIds : [])
      .map((id) => String(id || ''))
      .filter(Boolean),
  );
  const pending = remainingStacksForReclassify(stacks, processed);
  if (!stacks.length || pending.length === 0) {
    // Complete only when every *current* stack id is processed (or none exist).
    return {
      reclassified: 0,
      client: opts.client,
      complete: true,
      processedStackIds: [...processed],
    };
  }

  let client = opts.client;
  const config = opts.config;
  const topicCache = opts.topicCache;
  const topicRegistry = opts.topicRegistry;
  const deadline = opts.deadline;
  const metrics = opts.metrics;
  const dailyQuota = opts.dailyQuota;
  const onLlmSpend = opts.onLlmSpend;
  const jobId = opts.jobId;
  const checkCancel = opts.checkCancel;
  const getStats = opts.getStats;
  const bumpStats = opts.bumpStats;
  const onStackProgress = opts.onStackProgress;

  if (!isLlmConfigured(config)) {
    return {
      needsLlmConfig: {
        ok: false,
        error: LLM_CONFIG_REQUIRED_MESSAGE,
        needsLlmConfig: true,
        jobId,
        ...getStats(),
        logical: [],
        assignments: [],
        physical: { applied: 0, errors: [] },
      },
    };
  }

  if (!client) {
    const allowed = await hasEndpointPermission(
      /** @type {string} */ (config.endpointBaseUrl || ''),
      /** @type {string} */ (config.llmProvider || ''),
    );
    if (!allowed) {
      return {
        needsLlmConfig: {
          ok: false,
          error:
            'Host permission for the LLM endpoint is missing. Run Organize again after granting access.',
          needsPermission: true,
          needsLlmConfig: false,
          jobId,
        },
      };
    }
    try {
      client = createLlmClient({
        provider: /** @type {any} */ (config.llmProvider),
        endpointBaseUrl: /** @type {string} */ (config.endpointBaseUrl || ''),
        apiKey: /** @type {string} */ (config.apiKey || ''),
        model: /** @type {string} */ (config.model || ''),
      });
    } catch (err) {
      return {
        needsLlmConfig: {
          ok: false,
          error: String(err?.message || err || LLM_CONFIG_REQUIRED_MESSAGE),
          needsLlmConfig: true,
          jobId,
        },
      };
    }
  }

  let reclassified = 0;
  let complete = true;

  for (let i = 0; i < stacks.length; i++) {
    const stack = stacks[i];
    const stackId = stack?.id ? String(stack.id) : '';
    if (!stackId || processed.has(stackId)) continue;

    const cancelled = checkCancel();
    if (!cancelled.continue) {
      await persistStackRecords(opts.stackStore);
      return {
        cancelled: cancelled.result,
        reclassified,
        client,
        complete: false,
        processedStackIds: [...processed],
      };
    }
    if (deadline.expired()) {
      complete = false;
      break;
    }

    // Counts vs live list only — discarded processed ids must not inflate current.
    const liveStacks = opts.stackStore?.list?.() ?? stacks;
    const { done, total, current } = stackReclassifyProgressCounts(
      liveStacks,
      processed,
    );
    broadcastProgress({
      jobId,
      phase: 'stacks',
      done,
      total,
      current,
      messageKey: 'progress.stacks',
      messageParams: { current, total },
      message: `Reclassifying stacks ${current}/${total}: ${stack.title || stack.url}`,
      ...getStats(),
    });

    const markProcessed = async () => {
      processed.add(stackId);
      if (typeof onStackProgress === 'function') {
        try {
          await onStackProgress([...processed]);
        } catch {
          // fail-soft
        }
      }
    };

    const urlKey = normalizeUrlKey(stack.url || '');
    if (!urlKey) {
      await markProcessed();
      continue;
    }

    const contentHash = await computeContentHash({
      title: stack.title || '',
      excerpt: '',
      url: urlKey,
    });

    const allowLlm = metrics == null || canSpendLlmCall(metrics, dailyQuota);
    if (!allowLlm) {
      bumpStats({ classifyErrors: (getStats().classifyErrors || 0) + 1 });
      await markProcessed();
      continue;
    }

    bumpStats({ llmCallsAttempted: (getStats().llmCallsAttempted || 0) + 1 });
    if (typeof onLlmSpend === 'function') {
      try {
        await onLlmSpend();
      } catch {
        // fail-soft
      }
    } else if (metrics && typeof metrics === 'object') {
      metrics.dailyLlmCalls = (Number(metrics.dailyLlmCalls) || 0) + 1;
      metrics.llmCalls = (Number(metrics.llmCalls) || 0) + 1;
      metrics.dailyLlmDate =
        metrics.dailyLlmDate || new Date().toISOString().slice(0, 10);
    }

    try {
      const result = await withTimeout(
        client.classifyTopic({
          url: stack.url || '',
          title: stack.title || '',
          snippet: '',
          extractedText: '',
          // Stack reclassify is part of Reorganize — prefer seeds, invent when needed.
          preferExisting: true,
          candidateMode: 'reorganize',
          existingTopics: existingTopicsForClassify(
            topicRegistry,
            opts.seedTopics || normalizeSeedTopics(config?.seedTopics),
          ),
        }),
        Math.min(TIMEOUTS.CLASSIFY_MS, Math.max(500, deadline.remaining())),
        'classify-stack',
      );
      const topic = mergeTopicResult(result, topicRegistry);
      topicCache.upsert({
        urlKey,
        contentHash,
        topicKey: topic.normalizedKey,
        topicLabel: topic.label,
        excerpt: '',
      });
      opts.stackStore.update(stack.id, {
        topicKey: topic.normalizedKey,
        topicLabel: topic.label,
        groupTitle: topic.label,
        groupColor: colorForTopicKey(topic.normalizedKey),
      });
      reclassified += 1;
      bumpStats({ classified: (getStats().classified || 0) + 1 });
    } catch (err) {
      bumpStats({ classifyErrors: (getStats().classifyErrors || 0) + 1 });
      const errCounts = stackReclassifyProgressCounts(
        opts.stackStore?.list?.() ?? stacks,
        processed,
      );
      broadcastProgress({
        jobId,
        phase: 'refine-error',
        done: errCounts.done,
        total: errCounts.total,
        message: `Stack classify failed: ${err?.message || err}`,
        ...getStats(),
      });
    }

    await markProcessed();
  }

  // Re-read list: complete only if every current id was processed (mutations-safe).
  const live = opts.stackStore?.list?.() ?? stacks;
  complete =
    complete && remainingStacksForReclassify(live, processed).length === 0;

  await persistStackRecords(opts.stackStore);
  await persistTopicCache(topicCache);
  return { reclassified, client, complete, processedStackIds: [...processed] };
}

export { TAB_GROUP_ID_NONE };
