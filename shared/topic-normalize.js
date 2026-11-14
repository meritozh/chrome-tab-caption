/**
 * Domain topic labels (zh seeds OK) + synonym merge (ADR §5.2 / Decisions #4).
 * Heuristic normalize; LLM may suggest synonyms that collapse into one normalizedKey.
 */

/**
 * @typedef {object} TopicRecord
 * @property {string} normalizedKey
 * @property {string} label
 * @property {string[]} synonymKeys
 */

/**
 * Normalize a topic label into a stable key (letters/digits, incl. CJK).
 * @param {string | undefined | null} label
 * @returns {string}
 */
export function normalizeTopicKey(label) {
  if (!label || typeof label !== 'string') return '';
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Title-case English display labels; preserve CJK / mixed seed taxonomy labels as-is.
 * @param {string} label
 * @returns {string}
 */
export function formatTopicLabel(label) {
  const cleaned = String(label || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'General';
  // Seed taxonomy uses Chinese domain labels — do not title-case / mangle them.
  if (/[\u3400-\u9fff]/.test(cleaned)) return cleaned;
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on']);
  return cleaned
    .split(' ')
    .map((word, i) => {
      // Keep short acronyms (AI, API, ML) intact.
      if (/^[A-Z0-9]{2,6}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Build synonym key set from label + optional synonym strings.
 * @param {string} label
 * @param {string[] | undefined} synonyms
 * @returns {string[]}
 */
export function collectSynonymKeys(label, synonyms = []) {
  const keys = new Set();
  const primary = normalizeTopicKey(label);
  if (primary) keys.add(primary);
  for (const s of synonyms || []) {
    const k = normalizeTopicKey(s);
    if (k) keys.add(k);
  }
  return [...keys];
}

/**
 * Find an existing topic that matches label or any synonym (bidirectional).
 * @param {string} label
 * @param {string[] | undefined} synonyms
 * @param {Iterable<TopicRecord>} existing
 * @returns {TopicRecord | null}
 */
export function findSynonymMergeTarget(label, synonyms, existing) {
  const incoming = new Set(collectSynonymKeys(label, synonyms));
  if (!incoming.size) return null;
  for (const topic of existing) {
    const known = new Set([
      topic.normalizedKey,
      ...(topic.synonymKeys || []),
      normalizeTopicKey(topic.label),
    ]);
    for (const key of incoming) {
      if (known.has(key)) return topic;
    }
  }
  return null;
}

/**
 * Merge classify result into topic registry (map by normalizedKey).
 * Returns the canonical topic after synonym collapse.
 * @param {{ topic: string, synonyms?: string[] }} result
 * @param {Map<string, TopicRecord>} registry
 * @returns {TopicRecord}
 */
export function mergeTopicResult(result, registry) {
  const label = formatTopicLabel(result.topic || 'General');
  const synonymKeys = collectSynonymKeys(label, result.synonyms);
  const hit = findSynonymMergeTarget(label, result.synonyms, registry.values());
  if (hit) {
    const mergedSynonyms = new Set([...(hit.synonymKeys || []), ...synonymKeys]);
    mergedSynonyms.delete(hit.normalizedKey);
    const next = {
      normalizedKey: hit.normalizedKey,
      label: hit.label,
      synonymKeys: [...mergedSynonyms],
    };
    registry.set(hit.normalizedKey, next);
    return next;
  }
  const normalizedKey = normalizeTopicKey(label) || 'general';
  const next = {
    normalizedKey,
    label,
    synonymKeys: synonymKeys.filter((k) => k !== normalizedKey),
  };
  registry.set(normalizedKey, next);
  return next;
}

/**
 * Heuristic synonym pairs for common English near-duplicates (no LLM required).
 * Used as a soft assist when merging labels across a batch.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function heuristicTopicsAreSynonyms(a, b) {
  const ka = normalizeTopicKey(a);
  const kb = normalizeTopicKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Plural / singular light touch
  if (ka + 's' === kb || kb + 's' === ka) return true;
  if (ka.endsWith('ies') && kb === ka.slice(0, -3) + 'y') return true;
  if (kb.endsWith('ies') && ka === kb.slice(0, -3) + 'y') return true;
  // Prefix containment for short shared stems (min length guard)
  const shorter = ka.length <= kb.length ? ka : kb;
  const longer = ka.length <= kb.length ? kb : ka;
  if (shorter.length >= 8 && longer.startsWith(shorter + ' ')) return true;
  return false;
}
