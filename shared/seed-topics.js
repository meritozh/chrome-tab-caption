/**
 * Domain seed topic taxonomy (no Other / 其他 catch-all).
 * Editable in Settings; wired into Organize / Reorganize classify prompts.
 */

/** Default domain buckets — zh labels OK with English aliases. */
export const DEFAULT_SEED_TOPICS = Object.freeze([
  '开源 · AI / Agents',
  '开源 · 前端 / Web',
  '开源 · 基础设施',
  '阅读 · AI / Agents',
  '阅读 · 前端 / Web',
  '阅读 · 基础设施',
  '视频',
  '社交与通讯',
  '购物与生活',
]);

/**
 * Normalize a seed list from config, form textarea, or array.
 * Empty array is valid (user cleared seeds). null/undefined → defaults.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeSeedTopics(value) {
  if (value == null) return [...DEFAULT_SEED_TOPICS];
  /** @type {unknown[]} */
  let items;
  if (typeof value === 'string') {
    items = value.split(/\r?\n/);
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    return [...DEFAULT_SEED_TOPICS];
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const label = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * One topic per line for Settings textarea.
 * @param {unknown} value
 * @returns {string}
 */
export function seedTopicsToText(value) {
  return normalizeSeedTopics(value).join('\n');
}

/**
 * Build candidate topic labels for classify prompts.
 * Organize: existing Chrome groups first, then seeds (registry merged by caller).
 * Reorganize: seeds only (existing groups cleared / not preferred).
 *
 * @param {{
 *   seedTopics?: unknown,
 *   existingGroupLabels?: unknown,
 *   reorganize?: boolean,
 * }} opts
 * @returns {string[]}
 */
export function buildSeedCandidateTopics(opts = {}) {
  const seeds = normalizeSeedTopics(opts.seedTopics);
  if (opts.reorganize) return seeds;
  const groups = Array.isArray(opts.existingGroupLabels)
    ? opts.existingGroupLabels
    : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of [...groups, ...seeds]) {
    const label = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
