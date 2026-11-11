# chrome-tab-caption

Chrome 标签管理扩展（MV3）— 按主题整理标签，不是字面「字幕」。

On-demand LLM topic grouping for Chrome tabs: organize when you ask, cache what you’ve classified, reclaim overflow into searchable Stacks.

## Features

| | 中文 | English |
|---|---|---|
| **Organize** | Side Panel 一键按主题分组（跨窗口逻辑主题；物理 `tabGroups` 仍按窗口） | On-demand topic groups — logical topics across windows, physical groups per window |
| **Search** | 内存模糊搜索（拼音/首字母）+ 按最近使用排序；Open / Stacked 分区 | In-memory fuzzy + pinyin/initials, recency-first; Open / Stacked results |
| **Cache** | `urlKey` + content hash LRU，避免重复打 LLM | Topic cache so the same page isn’t reclassified |
| **Privacy** | 自配 endpoint；API key 仅存本地；发送前字段预览 | Your endpoint, local key, always preview payload fields |
| **Roadmap** | 自动去重 · Stacks 回收/召回 | Auto-dedupe · Stacks reclaim/recall |

Product decisions live in the Project ADR (`docs/tab-manager-adr.md`). Chrome Web Store packaging notes: `docs/chrome-web-store-checklist.md`.

## Load unpacked

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → this repo root (folder with `manifest.json`)
3. Click the action icon → **Side Panel** opens (no popup)
4. **Options** → set provider / endpoint / API key / model → Save
5. Side Panel → **Organize tabs** → review privacy preview → **Confirm & classify**

`TEST_LLM` uses a mock client. API keys stay in `chrome.storage.local` only — never commit them.

### Try Search (Side Panel)

1. Open the Side Panel and a few tabs (try a Chinese title for pinyin, e.g. “今日头条”)
2. In **Search**, type a substring, fuzzy fragment, full pinyin, or initials (`jrtt`)
3. Results split into **Open** (live tabs) and **Stacked** (this extension’s `stackRecords` — empty until Phase 4 reclaim)
4. Use **↑ / ↓** then **Enter** (or click) to focus an open tab; Stacked Enter calls the Phase 4 `RECALL_STACK` stub

```bash
npm test
npm run typecheck
```
