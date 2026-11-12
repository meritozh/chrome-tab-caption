# chrome-tab-caption

Chrome 标签管理扩展（MV3）— 按主题整理标签，不是字面「字幕」。

On-demand LLM topic grouping for Chrome tabs: organize when you ask, cache what you’ve classified, reclaim overflow into searchable Stacks, and merge into one window.

## Features

| | 中文 | English |
|---|---|---|
| **Organize** | Side Panel 一键整理：全量分类后按 `lastAccessed` 保留前 `maxOpenTabs`，**合并为单窗**并建物理 `tabGroups`；超额进 Stacks（仍写 topic cache） | On-demand classify → keep newest `maxOpenTabs` → **merge to one window** + topic groups; excess → Stacks (topics still cached) |
| **Side Panel** | 工具栏图标 **开关** Side Panel；Organize 仅在面板内；Options 只做设置 | Toolbar icon **toggles** the panel; Organize only in-panel; Options = settings |
| **Search** | 内存模糊搜索（拼音/首字母）+ 按最近使用排序；Open / Stacked 分区 | In-memory fuzzy + pinyin/initials, recency-first; Open / Stacked results |
| **Cache** | `urlKey` + content hash LRU，避免重复打 LLM | Topic cache so the same page isn’t reclassified |
| **Privacy** | 自配 endpoint；API key 仅存本地；发送前字段预览 | Your endpoint, local key, always preview payload fields |
| **Dedupe** | 同规范化 URL（同窗或跨窗）自动关闭较旧副本（保留 active/audible/pinned/最近；跳过未保存） | Auto-close-older for normalized URLs within/across windows |
| **Stacks** | 超过 `maxOpenTabs` 时回收到可搜索归档；召回读 cache/metadata 归组；触及 `stackSize` 先警告再导出/丢弃 | Reclaim past maxOpenTabs; recall merges via cache/metadata; overflow warns then export/discard |
| **Extract** | Organize 时按需抽取主文本（Mozilla Readability + ≤~280 excerpt）；非常驻 content script | On-demand main-text extract (Mozilla Readability + ≤~280 excerpt); no always-on content scripts |
| **Hardening** | Organize 任务状态机 + `alarms` 续跑；本地计数 / 可选日配额；optional host；商店权限/隐私文案 | Task state machine + alarm resume; local metrics / optional daily LLM quota; optional hosts; store permissions & privacy outline |

Product decisions: `docs/decisions-log.md` (Accepted + §10 borrow notes). Store packaging: `docs/chrome-web-store/permissions.md`, `docs/chrome-web-store/privacy-policy-outline.md`.

## Load unpacked

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → this repo root (folder with `manifest.json`)
3. Click the action icon → **Side Panel** toggles open/close (no popup)
4. **Options** → set provider / endpoint / API key / model → Save (settings only — Organize is in the panel)
5. Options → **Dedupe** → leave auto-close-older enabled (default) to collapse same-URL tabs across windows
6. Options → **Content & cost** → leave extraction on (optional hosts at Confirm); set `dailyLlmQuota` if you want a UTC-day cap (`0` = unlimited)
7. Side Panel → **Organize tabs** (All windows) → review privacy preview → **Confirm & classify** → tabs merge into one window
8. Options → **Local metrics** shows on-device counters (organize / LLM / dedupe / reclaim / alarm resumes)

`TEST_LLM` uses a mock client. API keys stay in `chrome.storage.local` only — never commit them. If the service worker sleeps mid-Organize, a checkpoint + `chrome.alarms` resume continues the refine queue.

### Try Search (Side Panel)

1. Open the Side Panel and a few tabs (try a Chinese title for pinyin, e.g. “今日头条”)
2. In **Search**, type a substring, fuzzy fragment, full pinyin, or initials (`jrtt`)
3. Results split into **Open** (live tabs) and **Stacked** (this extension’s `stackRecords`)
4. Use **↑ / ↓** then **Enter** (or click) to focus an open tab or recall a stacked one

### Try Stacks (Side Panel)

1. Options → set `maxOpenTabs` low (e.g. `3`) for a quick demo → Save
2. Run **Organize** (or open more tabs than the threshold); excess tabs reclaim into Stacks with topic metadata
3. Side Panel → **Stacks** lists reclaimed records; **Recall** restores the URL and group (via cache/metadata)
4. Search → **Stacked** hits use the same `RECALL_STACK` path
5. If the archive hits `stackSize`, choose **Export oldest & free space** or **Discard oldest**

```bash
npm test
npm run typecheck
```
