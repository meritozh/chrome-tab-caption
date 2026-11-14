# chrome-tab-caption

Chrome 标签管理扩展（MV3）— 按主题整理标签，不是字面「字幕」。

On-demand LLM topic grouping for Chrome tabs: organize when you ask, cache what you’ve classified, reclaim overflow into searchable Stacks, and merge into one window.

## Features

| | 中文 | English |
|---|---|---|
| **Organize** | Side Panel 一键整理：全量分类后按 `lastAccessed` 保留前 `maxOpenTabs`，**合并为单窗**并建物理 `tabGroups`；超额进 Stacks（仍写 topic cache） | On-demand classify → keep newest `maxOpenTabs` → **merge to one window** + topic groups; excess → Stacks (topics still cached) |
| **Side Panel** | 工具栏图标 **开关** Side Panel；Organize 仅在面板内；**设置**页为配置表（Options 仅跳转） | Toolbar icon **toggles** the panel; Organize in-panel; **Settings** table owns config (Options redirects) |
| **Search** | Stacks 上方模糊搜索（拼音/首字母）；堆栈列表过滤 + Open 命中条 | Fuzzy + pinyin above Stacks; filters stack list + open-hit strip |
| **Cache** | `urlKey` + content hash LRU，避免重复打 LLM | Topic cache so the same page isn’t reclassified |
| **Privacy** | 自配 endpoint；API key 仅存本地；设置页列出发送字段；Organize 一键直接生效 | Your endpoint, local key, fields listed in Settings; Organize applies LLM results immediately |
| **Dedupe** | 同规范化 URL（同窗或跨窗）自动关闭较旧副本（保留 active/audible/pinned/最近；跳过未保存） | Auto-close-older for normalized URLs within/across windows |
| **Stacks** | **Organize / Reorganize** 时超过 `maxOpenTabs` 回收到可搜索归档（日常浏览不自动回收）；召回读 cache/metadata 归组；触及 `stackSize` 先警告再导出/丢弃 | Reclaim past maxOpenTabs **only on Organize/Reorganize** (not while browsing); recall via cache/metadata; overflow warns then export/discard |
| **Extract** | Organize 时按需抽取主文本（Mozilla Readability + ≤~280 excerpt）；非常驻 content script | On-demand main-text extract (Mozilla Readability + ≤~280 excerpt); no always-on content scripts |
| **Hardening** | Organize 任务状态机 + `alarms` 续跑；本地计数 / 可选日配额；optional host；商店权限/隐私文案 | Task state machine + alarm resume; local metrics / optional daily LLM quota; optional hosts; store permissions & privacy outline |

Product decisions: `docs/decisions-log.md` (Accepted + §10 borrow notes). Store packaging: `docs/chrome-web-store/permissions.md`, `docs/chrome-web-store/privacy-policy-outline.md`.

## Load unpacked

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → this repo root (folder with `manifest.json`)
3. Click the action icon → **Side Panel** toggles open/close (no popup)
4. Side Panel → **Settings** → set provider / endpoint / API key / model → Save (Chrome “Options” only opens this view)
5. Settings → **Dedupe** → leave auto-close-older enabled (default) to collapse same-URL tabs across windows
6. Settings → **Content & cost** → leave extraction on (optional hosts requested on Organize); set `dailyLlmQuota` if you want a UTC-day cap (`0` = unlimited)
7. Side Panel → **Organize tabs** (fixed all windows → single window) → hosts if needed → LLM classify → groups/Stacks apply immediately
8. Settings → **Local metrics** shows on-device counters (organize / LLM / dedupe / reclaim / alarm resumes)

`TEST_LLM` hits your configured Anthropic/OpenAI Responses endpoint (no mock). Organize requires a working provider + API key — there is no hostname topic fallback. API keys stay in `chrome.storage.local` only — never commit them. If the service worker sleeps mid-Organize, a checkpoint + `chrome.alarms` resume continues the refine queue.

### Try Search (Side Panel)

1. Open the Side Panel and a few tabs (try a Chinese title for pinyin, e.g. “今日头条”)
2. Under **Stacks**, type a substring, fuzzy fragment, full pinyin, or initials (`jrtt`)
3. Stacked hits filter the list; open-tab hits appear in a compact strip above it
4. Use **↑ / ↓** then **Enter** (or click) to focus an open tab or recall a stacked one

### Try Stacks (Side Panel)

1. Settings → set `maxOpenTabs` low (e.g. `3`) for a quick demo → Save
2. Open more tabs than the threshold, then run **Organize** (or **Reorganize**) — excess tabs reclaim into Stacks with topic metadata. Day-to-day browsing does **not** auto-reclaim.
3. Side Panel → **Stacks** lists reclaimed records; **Recall** restores the URL and group (via cache/metadata)
4. Search → **Stacked** hits use the same `RECALL_STACK` path
5. If the archive hits `stackSize`, choose **Export oldest & free space** or **Discard oldest**

```bash
npm test
npm run typecheck
```
