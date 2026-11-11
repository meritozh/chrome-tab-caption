/**
 * In-memory fuzzy search over tab/stack documents (ADR §5.5 Phase 3).
 * Fields: title, url, topicLabel, groupTitle + pinyin/initials.
 * Ranking: match quality, then recency-first (lastAccessed / reclaimedAt).
 * Pure — no Chrome APIs.
 */

import { textMatchesPinyin } from './pinyin.js';

/**
 * @typedef {'open' | 'stacked'} SearchPartition
 */

/**
 * @typedef {object} SearchDocument
 * @property {string} id
 * @property {SearchPartition} partition
 * @property {string} title
 * @property {string} url
 * @property {string} [topicLabel]
 * @property {string} [groupTitle]
 * @property {string} [favIconUrl]
 * @property {number} [tabId]
 * @property {number} [windowId]
 * @property {string} [stackId]
 * @property {number} lastAccessed  ms epoch — open: tab.lastAccessed; stacked: reclaimedAt/lastAccessedAt
 */

/**
 * @typedef {object} ScoredHit
 * @property {SearchDocument} doc
 * @property {number} matchScore  higher = better match quality
 * @property {number} lastAccessed
 */

/**
 * Normalize query for Latin fuzzy / substring matching.
 * @param {string} q
 */
export function normalizeQuery(q) {
  return String(q ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Case-insensitive substring / consecutive subsequence score.
 * Higher is better. 0 = no match.
 * @param {string} haystack
 * @param {string} needle  already normalized lowercase
 */
export function fuzzyScore(haystack, needle) {
  if (!needle) return 0;
  const text = String(haystack ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!text) return 0;

  if (text === needle) return 1000;
  const idx = text.indexOf(needle);
  if (idx === 0) return 900 - Math.min(80, text.length - needle.length);
  if (idx > 0) return 700 - Math.min(100, idx);

  // Contiguous-ish subsequence (chars in order, prefer denser runs)
  let qi = 0;
  let runs = 0;
  let inRun = false;
  for (let i = 0; i < text.length && qi < needle.length; i++) {
    if (text[i] === needle[qi]) {
      qi += 1;
      if (inRun) runs += 1;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  if (qi < needle.length) return 0;
  return 200 + Math.min(200, runs * 10) - Math.min(50, text.length);
}

/**
 * Best match score across indexed fields (Latin fuzzy + optional pinyin).
 * @param {SearchDocument} doc
 * @param {string} query
 * @param {{ pinyinEnabled?: boolean }} [opts]
 */
export function scoreDocument(doc, query, opts = {}) {
  const needle = normalizeQuery(query);
  if (!needle) return 0;

  const fields = [
    { value: doc.title, weight: 1.0 },
    { value: doc.topicLabel, weight: 0.85 },
    { value: doc.groupTitle, weight: 0.75 },
    { value: doc.url, weight: 0.55 },
  ];

  let best = 0;
  for (const f of fields) {
    if (!f.value) continue;
    const latin = fuzzyScore(f.value, needle) * f.weight;
    if (latin > best) best = latin;

    if (opts.pinyinEnabled !== false && textMatchesPinyin(f.value, query)) {
      // Pinyin hits sit between prefix and loose subsequence.
      const py = 550 * f.weight;
      if (py > best) best = py;
    }
  }
  return best;
}

/**
 * Search documents: keep matches, rank match quality then recency-first.
 * @param {SearchDocument[]} docs
 * @param {string} query
 * @param {{ pinyinEnabled?: boolean, limit?: number }} [opts]
 * @returns {{ open: ScoredHit[], stacked: ScoredHit[] }}
 */
export function searchDocuments(docs, query, opts = {}) {
  const needle = normalizeQuery(query);
  /** @type {ScoredHit[]} */
  const hits = [];

  if (!needle) {
    return { open: [], stacked: [] };
  }

  for (const doc of docs) {
    const matchScore = scoreDocument(doc, query, opts);
    if (matchScore <= 0) continue;
    hits.push({
      doc,
      matchScore,
      lastAccessed: Number(doc.lastAccessed) || 0,
    });
  }

  hits.sort((a, b) => {
    // Coarse match tiers first, then recency-first within tier (ADR searchRank).
    const tierA = Math.floor(a.matchScore / 100);
    const tierB = Math.floor(b.matchScore / 100);
    if (tierB !== tierA) return tierB - tierA;
    if (b.lastAccessed !== a.lastAccessed) return b.lastAccessed - a.lastAccessed;
    return b.matchScore - a.matchScore;
  });

  const limit = Math.max(0, opts.limit ?? 50);
  const open = [];
  const stacked = [];
  for (const hit of hits) {
    if (hit.doc.partition === 'open') {
      if (open.length < limit) open.push(hit);
    } else if (hit.doc.partition === 'stacked') {
      if (stacked.length < limit) stacked.push(hit);
    }
  }
  return { open, stacked };
}

/**
 * Build a SearchDocument for an open Chrome tab.
 * @param {{ id?: number, title?: string, url?: string, favIconUrl?: string, windowId?: number, lastAccessed?: number }} tab
 * @param {{ topicLabel?: string, groupTitle?: string }} [meta]
 * @returns {SearchDocument | null}
 */
export function documentFromTab(tab, meta = {}) {
  if (typeof tab?.id !== 'number') return null;
  return {
    id: `open:${tab.id}`,
    partition: 'open',
    title: tab.title ?? '',
    url: tab.url ?? '',
    topicLabel: meta.topicLabel,
    groupTitle: meta.groupTitle,
    favIconUrl: tab.favIconUrl,
    tabId: tab.id,
    windowId: tab.windowId,
    lastAccessed: Number(tab.lastAccessed) || 0,
  };
}

/**
 * Build a SearchDocument from a StackRecord.
 * @param {{ id: string, title?: string, url?: string, favIconUrl?: string, topicLabel?: string, groupTitle?: string, reclaimedAt?: number, lastAccessedAt?: number }} record
 * @returns {SearchDocument | null}
 */
export function documentFromStack(record) {
  if (!record?.id) return null;
  const lastAccessed =
    Number(record.lastAccessedAt) || Number(record.reclaimedAt) || 0;
  return {
    id: `stacked:${record.id}`,
    partition: 'stacked',
    title: record.title ?? '',
    url: record.url ?? '',
    topicLabel: record.topicLabel,
    groupTitle: record.groupTitle,
    favIconUrl: record.favIconUrl,
    stackId: record.id,
    lastAccessed,
  };
}
