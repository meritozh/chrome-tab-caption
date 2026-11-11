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
 * Full on-demand organize job.
 * @param {object} opts
 * @param {'all' | 'current'} [opts.scope]
 * @param {number} [opts.currentWindowId]
 * @param {boolean} [opts.confirmed] — must be true after privacy preview
 * @param {TopicCacheLru} opts.topicCache
 * @param {Record<string, unknown>} opts.config
 * @param {{ useMock?: boolean }} [opts.llmOpts]
 */
export async function groupTabsOnDemand(opts) {
  if (!opts.confirmed) {
    return {
      ok: false,
      error: 'Privacy preview confirmation required before classify (ADR #12).',
      needsConfirm: true,
    };
  }

  const scope = opts.scope === 'current' ? 'current' : 'all';
  const config = opts.config;
  const topicCache = opts.topicCache;
  const deadline = createDeadline(TIMEOUTS.GROUP_JOB_MS);
  const jobId = `group-${Date.now()}`;

  /** @type {Map<string, import('../shared/topic-normalize.js').TopicRecord>} */
  const topicRegistry = new Map();
  /** @type {TabTopicAssignment[]} */
  const assignments = [];

  const allTabs = filterEligibleTabs(await queryTabsForScope(scope, opts.currentWindowId));
  const total = allTabs.length;

  broadcastProgress({
    jobId,
    phase: 'quick-pass',
    done: 0,
    total,
    message: 'Quick pass: applying cached topics…',
  });

  /** @type {{ tab: chrome.tabs.Tab, urlKey: string, contentHash: string }[]} */
  const refineQueue = [];

  // Pass 1 — cache hits
  for (let i = 0; i < allTabs.length; i++) {
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
  let physical = { applied: 0, errors: /** @type {string[]} */ ([]) };
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

  // Permission grant happens in Side Panel user-gesture; SW only checks containment.
  const useMock = opts.llmOpts?.useMock === true || !config.apiKey || !config.llmProvider;
  if (!useMock) {
    const allowed = await hasEndpointPermission(
      /** @type {string} */ (config.endpointBaseUrl || ''),
      /** @type {string} */ (config.llmProvider || ''),
    );
    if (!allowed) {
      return {
        ok: false,
        error:
          'Host permission for the LLM endpoint is missing. Confirm Organize again after granting access.',
        needsPermission: true,
      };
    }
  }

  const client = createLlmClient({
    provider: /** @type {any} */ (config.llmProvider || undefined),
    endpointBaseUrl: /** @type {string} */ (config.endpointBaseUrl || ''),
    apiKey: /** @type {string} */ (config.apiKey || ''),
    model: /** @type {string} */ (config.model || ''),
    useMock,
  });

  let classified = 0;
  let classifyErrors = 0;

  // Pass 2 — refine queue
  for (let i = 0; i < refineQueue.length; i++) {
    if (deadline.expired()) {
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
    if (rehit) {
      const topic = mergeTopicResult(
        { topic: rehit.topicLabel, synonyms: [] },
        topicRegistry,
      );
      assignments.push({
        tabId: /** @type {number} */ (tab.id),
        windowId: /** @type {number} */ (tab.windowId),
        topicKey: topic.normalizedKey,
        topicLabel: topic.label,
      });
      continue;
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
      assignments.push({
        tabId: /** @type {number} */ (tab.id),
        windowId: /** @type {number} */ (tab.windowId),
        topicKey: topic.normalizedKey,
        topicLabel: topic.label,
      });
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

  collapseHeuristicSynonyms(assignments, topicRegistry);

  const logical = buildLogicalTopicViews(assignments);
  const plans = planPhysicalGroups(assignments);
  physical = await applyPhysicalGroups(plans);

  await persistTopicCache(topicCache);

  broadcastProgress({
    jobId,
    phase: 'done',
    done: assignments.length,
    total,
    applied: physical.applied,
    classified,
    classifyErrors,
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
    cacheSize: topicCache.size,
    latestWinsAt: Date.now(),
    latestWinsSource: 'extension-organize',
  };
}

export { TAB_GROUP_ID_NONE };
