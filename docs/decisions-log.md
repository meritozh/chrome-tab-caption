# Decisions Log (Accepted) + engineering borrow notes

Canonical product ADR lives in the Project store (`docs/tab-manager-adr.md`). This file keeps the **Accepted** decisions and §10 borrow posture visible in-repo for reviewers and store listing.

## Accepted product decisions

1. **Group scope** — **Organize merges into one Chrome window** (cross-window `tabs.move` allowed). Classify all eligible tabs (including excess); keep top `maxOpenTabs` by `lastAccessed`; excess → Stacks **with** LLM/cache topics written for later recall grouping. (Revised 2026-11-13; supersedes “logical-only / never cross-window move”.)
2. **Dedupe** — Auto-close older duplicates for the same normalized URL **including across windows**.
3. **URL normalize** — Strip hash + tracking params only; keep other query.
4. **Topics** — Fine-grained **English** labels; merge synonyms to one `normalizedKey`.
5. **Auto-group** — **Off**. User click only; manual vs extension writes are **latest-wins**; cache syncs on tab updates.
6. **Reclaim protection** — Exclude unsaved / `beforeunload` risk; current window may be reclaimed.
7. **Recall** — Restore saved group metadata from StackRecords; prefer topic cache when merging into the live window.
8. **Content** — Optional meta/snippet; on-demand main-text extract with short excerpt cap; no always-on `content_scripts`.
9. **Search** — Pinyin + fuzzy; **recency-first**.
10. **Stack overflow** — Warn first; user chooses export or discard.
11. **UI** — Side Panel primary + simple Options; no extra onboarding. **Toolbar icon toggles** the Side Panel (open↔close). Organize CTA lives **only** in the Side Panel (Options = settings only).
12. **Privacy UX** — Always show payload fields + preview before real LLM calls.

## Engineering (Borrowed / Skipped from smart-tab-pilot)

**Borrow:** Side Panel shell, SW message table, activate-then-remove dedupe, short excerpt + on-demand `executeScript`, quick-pass → refine + timeouts/`GROUP_PROGRESS`, local LRU cache keyed by `urlKey+contentHash`, suppressClosed closes, Open/Stacked search shell. Single-window merge + topic-tagged Stacks are product-owned (not Pilot).

**Skip:** Always-on auto-group, Gemini Nano / completions-only as primary, nav-graph clustering, always-on `<all_urls>` content scripts, API key in `storage.sync`, missing payload preview, locale-mixed topics, `chrome.sessions` as Stacks, hash-preserving dedupe, legacy popup.

## Phase 7 hardening (this release)

- Organize **task state machine** + session checkpoint
- `chrome.alarms` **resume** for interrupted refine queues
- Optional host request gated by content-extraction setting
- **Local** metrics + optional `dailyLlmQuota`
- Store permissions / privacy outline under `docs/chrome-web-store/`
