# Chrome Web Store — permission justifications

> Aligns with Project ADR §7 / Decisions Log / §10 Borrowed (optional hosts, no always-on `content_scripts`).  
> Paste into the Developer Dashboard **Privacy → permissions** fields; tweak only if runtime behavior changes.

**Manifest posture (keep):**

```text
permissions: tabs, tabGroups, windows, storage, alarms, sidePanel, scripting
optional_host_permissions: http://*/*, https://*/*
```

No install-time `host_permissions`. No always-on `content_scripts`. Side Panel action has **no** `default_popup`.

| Permission | Justification |
|------------|---------------|
| **tabs** | Read open tab titles and URLs across windows so the user can search, group, dedupe, and reclaim tabs. Used only for tab-management features; not sold or sent to developer servers. |
| **tabGroups** | Create and update Chrome tab groups to match topics the user requested after on-demand classification. |
| **windows** | Enumerate windows so logical topics, dedupe, and Stacks can work across multiple Chrome windows. |
| **storage** | Persist settings (LLM endpoint, thresholds), topic cache, Stacks records, and local metrics in `chrome.storage.local`. API keys stay local; nothing is synced to developer infrastructure. |
| **alarms** | Schedule deferred reclaim / maintenance and resume interrupted Organize jobs while the MV3 service worker may sleep. |
| **sidePanel** | Primary UI: open the Side Panel from the action icon for organize, search, and Stacks. |
| **scripting** | On user-triggered Organize (and only when content extraction is enabled), inject a short extract script to read a capped page excerpt for classification. Not injected on every page load by default. |
| **optional_host_permissions** (`http://*/*`, `https://*/*`) | Requested at runtime when the user confirms Organize — LLM endpoint origin and, if extraction is on, page origins. Not granted at install; user can deny. Broad patterns are needed because tab URLs and user endpoints are arbitrary; we do not use always-on `<all_urls>` content scripts. |

## Product constraints (do not weaken)

- Grouping is **on-demand** (user click + privacy preview), not always-on.
- API keys only in `chrome.storage.local` (never `sync`).
- LLM traffic goes to the **user-configured** endpoint; the extension does not proxy or receive it.
- English fine topics, URL normalize (hash + tracking only), activate-then-remove dedupe, Stacks reclaim/recall — see Decisions Log.
