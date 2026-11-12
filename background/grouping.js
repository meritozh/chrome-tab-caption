/**
 * On-demand group engine (ADR Phase 2 / §5.2–5.3).
 * LogicalTopicView (cross-window) ≠ physical per-window chrome.tabGroups.
 * Never tabs.move across windows. No auto-group on tab complete.
 *
 * Flow: privacy preview (UI) → quick pass (cache hits) → refine queue (miss/stale)
 * → classify → apply logical views + physical groups. Latest-wins on write.
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
import { mergeTopicResult, heuristicTopicsAreSynonyms } from '../shared/topic-normalize.js';
import { buildClassifyPayloadPreview, createLlmClient } from '../shared/llm-client.js';
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

/**
 * @typedef {import('../shared/topic-cache.js').TopicCacheLru} TopicCacheLru
 * @typedef {import('../shared/physical-groups.js').TabTopicAssignment} TabTopicAssignment
 */

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
    note: 'API key is never shown. Confirm to run classify on cache misses only.',
    samples,
    privacyShowFieldsPreview: true,
  };
}

/**
 * Apply physical tabGroups for planned groups — never cross-window move.
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
        // Verify tabs still live in this window (never move across)
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
 * @param {boolean} [opts.confirmed] — must be true after privacy preview
 * @param {TopicCacheLru} opts.topicCache
 * @param {Record<string, unknown>} opts.config
 * @param {{ useMock?: boolean }} [opts.llmOpts]
 * @param {AbortSignal} [opts.signal] — cooperative cancel between classify steps
 * @param {string} [opts.jobId]
 * @param {import('../shared/task-state.js').OrganizeCheckpoint} [opts.resumeFrom]
 * @param {(cp: import('../shared/task-state.js').OrganizeCheckpoint) => void | Promise<void>} [opts.onCheckpoint]
 * @param {import('../shared/metrics.js').LocalMetrics} [opts.metrics]
 * @param {number | null} [opts.clientRunId]
 */
export async function groupTabsOnDemand(opts) {
  if (!opts.confirmed && !opts.resumeFrom?.confirmed) {
    return {
      ok: false,
      error: 'Privacy preview confirmation required before classify (ADR #12).',
      needsConfirm: true,
    };
  }

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
  const onCheckpoint = opts.onCheckpoint;
  const metrics = opts.metrics;
  const dailyQuota = Number(config.dailyLlmQuota) || 0;

  const startedAt = resumeCp?.startedAt ?? Date.now();
  const deadlineMs = resumeCp?.deadlineAt
    ? Math.max(0, resumeCp.deadlineAt - Date.now())
    : TIMEOUTS.GROUP_JOB_MS;
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
    useMock: opts.llmOpts?.useMock === true || resumeCp?.useMock === true,
    resumeCount,
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
      message: 'Quick pass: applying cached topics…',
    });

    // Pass 1 — cache hits
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
      const hit = topicCache.lookup(urlKey, contentHash);
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

    // Apply quick-pass physical groups early for responsiveness
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
    if (assignments.length) {
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

  // Permission grant happens in Side Panel user-gesture; SW only checks containment.
  const useMock =
    opts.llmOpts?.useMock === true ||
    checkpoint.useMock === true ||
    !config.apiKey ||
    !config.llmProvider;
  if (!useMock) {
    const allowed = await hasEndpointPermission(
      /** @type {string} */ (config.endpointBaseUrl || ''),
      /** @type {string} */ (config.llmProvider || ''),
    );
    if (!allowed) {
      await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.ERROR, { total }));
      return {
        ok: false,
        error:
          'Host permission for the LLM endpoint is missing. Confirm Organize again after granting access.',
        needsPermission: true,
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

  const client = createLlmClient({
    provider: /** @type {any} */ (config.llmProvider || undefined),
    endpointBaseUrl: /** @type {string} */ (config.endpointBaseUrl || ''),
    apiKey: /** @type {string} */ (config.apiKey || ''),
    model: /** @type {string} */ (config.model || ''),
    useMock,
  });

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

    // Re-check cache with richer hash (title+excerpt)
    const rehit = topicCache.lookup(urlKey, contentHash) || topicCache.lookup(urlKey, priorHash);
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
      const allowLlm =
        useMock || metrics == null || canSpendLlmCall(metrics, dailyQuota);
      if (!allowLlm) {
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

      llmCallsAttempted += 1;
      // Reflect spend in caller's metrics object (SW persists separately).
      if (metrics && typeof metrics === 'object') {
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

  await emitCheckpoint(onCheckpoint, snapshotCheckpoint(JOB_PHASES.APPLYING, { total }));
  collapseHeuristicSynonyms(assignments, topicRegistry);

  const logical = buildLogicalTopicViews(assignments);
  const plans = planPhysicalGroups(assignments);
  physical = await applyPhysicalGroups(plans);

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
    message: `Done — ${logical.length} topics, ${physical.applied} window groups.`,
  });

  return {
    ok: true,
    stub: false,
    jobId,
    scope,
    logical,
    assignments,
    physical,
    classified,
    classifyErrors,
    llmCallsAttempted,
    resumeCount,
    cacheSize: topicCache.size,
    latestWinsAt: Date.now(),
    latestWinsSource: 'extension-organize',
  };
}

export { TAB_GROUP_ID_NONE };
