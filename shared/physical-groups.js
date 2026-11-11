/**
 * Physical per-window tabGroups planning (ADR §3.1 / §5.3).
 * Logical topics may span windows; physical writes never tabs.move across windows.
 * Same window + same topicKey → at most one chrome.tabGroups entity.
 */

/**
 * @typedef {object} TabTopicAssignment
 * @property {number} tabId
 * @property {number} windowId
 * @property {string} topicKey
 * @property {string} topicLabel
 */

/**
 * @typedef {object} PhysicalGroupPlan
 * @property {number} windowId
 * @property {string} topicKey
 * @property {string} title
 * @property {number[]} tabIds
 */

/** Chrome tabGroups colors (cycled by topicKey). */
export const GROUP_COLORS = Object.freeze([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

/**
 * Stable color pick from topicKey.
 * @param {string} topicKey
 * @returns {string}
 */
export function colorForTopicKey(topicKey) {
  const key = String(topicKey || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/**
 * Collapse assignments into per-window physical group plans.
 * Never mixes windowIds inside a plan.
 * @param {TabTopicAssignment[]} assignments
 * @returns {PhysicalGroupPlan[]}
 */
export function planPhysicalGroups(assignments) {
  /** @type {Map<string, PhysicalGroupPlan>} */
  const map = new Map();
  for (const a of assignments || []) {
    if (typeof a.tabId !== 'number' || typeof a.windowId !== 'number') continue;
    if (!a.topicKey) continue;
    const key = `${a.windowId}\0${a.topicKey}`;
    let plan = map.get(key);
    if (!plan) {
      plan = {
        windowId: a.windowId,
        topicKey: a.topicKey,
        title: a.topicLabel || a.topicKey,
        tabIds: [],
      };
      map.set(key, plan);
    }
    if (!plan.tabIds.includes(a.tabId)) plan.tabIds.push(a.tabId);
    // Prefer longer / more recent label if provided
    if (a.topicLabel && a.topicLabel.length >= plan.title.length) {
      plan.title = a.topicLabel;
    }
  }
  return [...map.values()].filter((p) => p.tabIds.length > 0);
}

/**
 * Build cross-window LogicalTopicView list from assignments.
 * @param {TabTopicAssignment[]} assignments
 * @returns {{ topicKey: string, label: string, windowIds: number[], tabIds: number[] }[]}
 */
export function buildLogicalTopicViews(assignments) {
  /** @type {Map<string, { topicKey: string, label: string, windowIds: Set<number>, tabIds: number[] }>} */
  const map = new Map();
  for (const a of assignments || []) {
    if (typeof a.tabId !== 'number' || !a.topicKey) continue;
    let view = map.get(a.topicKey);
    if (!view) {
      view = {
        topicKey: a.topicKey,
        label: a.topicLabel || a.topicKey,
        windowIds: new Set(),
        tabIds: [],
      };
      map.set(a.topicKey, view);
    }
    view.windowIds.add(a.windowId);
    if (!view.tabIds.includes(a.tabId)) view.tabIds.push(a.tabId);
    if (a.topicLabel) view.label = a.topicLabel;
  }
  return [...map.values()].map((v) => ({
    topicKey: v.topicKey,
    label: v.label,
    windowIds: [...v.windowIds].sort((a, b) => a - b),
    tabIds: v.tabIds,
  }));
}

/**
 * Group plans by windowId for sequential Chrome API application.
 * @param {PhysicalGroupPlan[]} plans
 * @returns {Map<number, PhysicalGroupPlan[]>}
 */
export function groupPlansByWindow(plans) {
  /** @type {Map<number, PhysicalGroupPlan[]>} */
  const byWindow = new Map();
  for (const plan of plans || []) {
    const list = byWindow.get(plan.windowId) || [];
    list.push(plan);
    byWindow.set(plan.windowId, list);
  }
  return byWindow;
}
