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
| **Dedupe** | 同规范化 URL（同窗或跨窗）自动关闭较旧副本（保留 active/audible/pinned/最近；跳过未保存） | Auto-close-older for normalized URLs within/across windows |
| **Stacks** | 超过 `maxOpenTabs` 时回收到可搜索归档；召回恢复分组；触及 `stackSize` 先警告再导出/丢弃 | Reclaim past maxOpenTabs into searchable archive; recall restores groups; overflow warns then export/discard |

Product decisions live in the Project ADR (`docs/tab-manager-adr.md`). Chrome Web Store packaging notes: `docs/chrome-web-store-checklist.md`.

## Load unpacked

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → this repo root (folder with `manifest.json`)
3. Click the action icon → **Side Panel** opens (no popup)
4. **Options** → set provider / endpoint / API key / model → Save
5. Options → **Dedupe** → leave auto-close-older enabled (default) to collapse same-URL tabs across windows
6. Side Panel → **Organize tabs** → review privacy preview → **Confirm & classify**

`TEST_LLM` uses a mock client. API keys stay in `chrome.storage.local` only — never commit them.

### Try Search (Side Panel)

1. Open the Side Panel and a few tabs (try a Chinese title for pinyin, e.g. “今日头条”)
2. In **Search**, type a substring, fuzzy fragment, full pinyin, or initials (`jrtt`)
3. Results split into **Open** (live tabs) and **Stacked** (this extension’s `stackRecords`)
4. Use **↑ / ↓** then **Enter** (or click) to focus an open tab or recall a stacked one

### Try Stacks (Side Panel)

1. Options → set `maxOpenTabs` low (e.g. `3`) for a quick demo → Save
2. Open more tabs than that threshold; the service worker reclaims least-recently-accessed tabs (skips pinned / audible / unsaved)
3. Side Panel → **Stacks** lists reclaimed records; **Recall** restores the URL and group metadata
4. Search → **Stacked** hits use the same `RECALL_STACK` path
5. If the archive hits `stackSize`, choose **Export oldest & free space** or **Discard oldest**

```bash
npm test
npm run typecheck
```
