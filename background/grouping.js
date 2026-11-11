/**
 * On-demand group engine stub (Phase 2).
 * LogicalTopicView (cross-window) ≠ physical per-window chrome.tabGroups.
 * Never tabs.move across windows. No auto-group on tab complete.
 */

/**
 * @typedef {object} LogicalTopicView
 * @property {string} topicKey
 * @property {string} label
 * @property {number[]} windowIds
 * @property {number[]} tabIds
 */

/**
 * @param {unknown} _tabs
 * @param {{ scope?: 'all' | 'current' }} [_opts]
 * @returns {Promise<{ logical: LogicalTopicView[], stub: true }>}
 */
export async function groupTabsOnDemand(_tabs, _opts = {}) {
  return { logical: [], stub: true };
}

/**
 * Apply physical tabGroups for one window only.
 * @param {number} _windowId
 * @param {LogicalTopicView[]} _views
 */
export async function applyPhysicalGroups(_windowId, _views) {
  // Phase 2: merge same topicKey within window; never create duplicate titles.
  return { applied: 0, stub: true };
}
