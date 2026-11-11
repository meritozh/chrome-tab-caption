# chrome-tab-caption

Manifest V3 Chrome extension that organizes tabs with **on-demand** LLM topic grouping, auto-dedupe, fuzzy search (with pinyin), and **Stacks** reclaim/recall.

> Product name says “caption”; the product is a **tab manager**, not literal captions.

## Status

**Phase 2** — on-demand Organize with privacy preview, Anthropic Messages + OpenAI Responses-style LLM clients, `topicCache` hydrate (urlKey+contentHash LRU), logical cross-window topics + physical per-window `tabGroups`. Dedupe / Stacks / fuzzy search remain later phases.

Architecture and Accepted decisions live in the project ADR (agent store / docs): `tab-manager-adr.md`. Engineering patterns borrowed from [smart-tab-pilot](https://github.com/BiuBiuHu/smart-tab-pilot) are limited to shell/orchestration (Side Panel, MSG table, logical≠physical groups, short excerpt caps, quick-pass → refine + progress). Product conflicts (always-on auto-group, `storage.sync` keys, always-on content scripts, nav-graph clustering, chat/completions-only, Nano-required) are **skipped**.

## Load unpacked & try Organize

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository root (the folder that contains `manifest.json`)
4. Click the extension action icon — the **Side Panel** opens (`openPanelOnActionClick`; there is **no** `default_popup`)
5. Open **Options** → set `llmProvider` (`anthropic` or `openai-responses`), `endpointBaseUrl`, `apiKey`, `model` → Save  
   - `TEST_LLM` always uses the **mock** client (safe connection check + field preview)
6. In the Side Panel:
   - Choose scope **All windows** or **Current window**
   - Click **Organize tabs** → review the **privacy preview** (fields that would be sent; API key never shown)
   - Click **Confirm & classify** → quick cache pass, then refine/classify misses with `GROUP_PROGRESS`
   - Logical topics appear in the panel; Chrome shows physical groups **per window** (never cross-window move)

Pinned tabs and `chrome://` / `chrome-extension://` / `devtools://` pages are skipped. There is **no** auto-group on tab complete.

Optional host permissions are requested when content extract or custom endpoints need them — there is **no** default always-on `<all_urls>` content script. Extract is still a short title+URL+excerpt stub (full extractor = Phase 6).

## Architecture overview

```
UI (Side Panel + Options)
  └─ typed MSG.* ──► Service Worker orchestrator
                        ├─ Topic cache (urlKey + contentHash LRU, chrome.storage.local)
                        ├─ LLM client (Anthropic Messages | OpenAI Responses | Mock)
                        ├─ On-demand group (preview → quick pass → refine → tabGroups)
                        ├─ Dedupe / stacks (stubs → later phases)
                        └─ chrome.scripting.executeScript extract (on demand, stub)
```

| Surface | Role |
|---------|------|
| `background/` | Sole orchestrator: messages, Chrome APIs, LLM & organize jobs |
| `sidepanel/` | Primary UI: Organize CTA + privacy confirm, logical topics, search/Stacks shells |
| `options/` | LLM endpoint, thresholds, privacy fields |
| `shared/` | Pure modules: constants, URL normalize, cache, topic merge, LLM, physical plans |
| `content/` | Extract stub for on-demand injection (not registered in manifest) |

### Message types (UI ↔ SW)

| Type | Direction | Purpose |
|------|-----------|---------|
| `PREVIEW_GROUP_PAYLOAD` / `GROUP_TABS` | UI → SW | Batch privacy preview + confirmed on-demand organize |
| `PREVIEW_CLASSIFY_PAYLOAD` | UI → SW | Single-tab field preview |
| `GROUP_PROGRESS` / `JOB_STATE` | SW → UI | Batch progress |
| `GET_CONFIG` / `SET_CONFIG` / `TEST_LLM` | UI → SW | Config & mock connection test |
| `SEARCH_QUERY` / `RECALL_STACK` / … | UI → SW | Later phases |

## Development

```bash
npm test          # node --test (shared pure modules)
npm run typecheck # syntax check entry modules
```

ES modules only — no bundler required. Do **not** put API keys in the repo; Options stores them in `chrome.storage.local` only (never `storage.sync`).

## Key decisions (Accepted ADR)

- Grouping is **on-demand** (user click), not always-on
- Logical topics may span windows; physical `tabGroups` stay per-window
- URL normalize: strip hash + tracking params; keep other query
- English fine-grained topics + synonym merge
- Privacy: always show payload fields + preview before real LLM calls
- Stacks = this extension’s reclaim records (not `chrome.sessions`)
