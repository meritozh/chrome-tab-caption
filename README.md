# chrome-tab-caption

Manifest V3 Chrome extension that organizes tabs with **on-demand** LLM topic grouping, auto-dedupe, fuzzy search (with pinyin), and **Stacks** reclaim/recall.

> Product name says “caption”; the product is a **tab manager**, not literal captions.

## Status

**Phase 0/1 scaffold** — loadable MV3 shell with Side Panel + Options + service worker message table and domain stubs. Full grouping / dedupe / stacks / LLM are intentionally not implemented yet.

Architecture and Accepted decisions live in the project ADR (agent store / docs): `tab-manager-adr.md`. Engineering patterns borrowed from [smart-tab-pilot](https://github.com/BiuBiuHu/smart-tab-pilot) are limited to shell/orchestration (Side Panel, MSG table, logical≠physical groups, activate-then-remove dedupe order, short excerpt caps). Product conflicts (always-on auto-group, `storage.sync` keys, always-on content scripts, nav-graph clustering, etc.) are **skipped**.

## Load unpacked

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository root (the folder that contains `manifest.json`)
4. Click the extension action icon — the **Side Panel** opens (`openPanelOnActionClick`; there is **no** `default_popup`)
5. Right-click the extension → **Options** for LLM endpoint / thresholds stubs

Optional host permissions are requested later when content extract or custom endpoints need them — there is **no** default always-on `<all_urls>` content script.

## Architecture overview

```
UI (Side Panel + Options)
  └─ typed MSG.* ──► Service Worker orchestrator
                        ├─ Topic cache (urlKey + contentHash LRU)
                        ├─ LLM client abstraction (Anthropic | OpenAI Responses)
                        ├─ On-demand group / dedupe / stacks (stubs → later phases)
                        └─ chrome.scripting.executeScript extract (on demand)
```

| Surface | Role |
|---------|------|
| `background/` | Sole orchestrator: messages, Chrome APIs, future LLM & jobs |
| `sidepanel/` | Primary UI: Organize CTA, search, Stacks, privacy preview shell |
| `options/` | LLM endpoint, `maxOpenTabs` / `cacheSize` / `stackSize`, privacy fields |
| `shared/` | Pure modules: constants, URL normalize, cache/stacks/LLM interfaces |
| `content/` | Extract stub for future on-demand injection (not registered in manifest) |

### Message types (UI ↔ SW)

| Type | Direction | Purpose |
|------|-----------|---------|
| `GROUP_TABS` / `PREVIEW_CLASSIFY_PAYLOAD` | UI → SW | On-demand group + privacy preview |
| `SEARCH_QUERY` / `RECALL_STACK` / `EXPORT_OR_DISCARD_STACKS` | UI → SW | Search & stacks |
| `GET_CONFIG` / `SET_CONFIG` / `TEST_LLM` | UI → SW | Config & connection test |
| `GROUP_PROGRESS` / `JOB_STATE` | SW → UI | Batch progress |
| `STACKS_OVERFLOW_WARN` / `ACTIVITY_LOG` | SW → UI | Overflow & activity |

## Development

```bash
npm test          # node --test (shared pure modules)
npm run typecheck # syntax check entry modules
```

ES modules only — no bundler required for the scaffold. Do **not** put API keys in the repo; Options stores them in `chrome.storage.local`.

## Key decisions (Accepted ADR)

- Grouping is **on-demand** (user click), not always-on
- Logical topics may span windows; physical `tabGroups` stay per-window
- URL normalize: strip hash + tracking params; keep other query
- English fine-grained topics + synonym merge
- Privacy: always show payload fields + preview before real LLM calls
- Stacks = this extension’s reclaim records (not `chrome.sessions`)
