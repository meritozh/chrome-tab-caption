# Privacy policy outline (store listing)

> Structure for a public HTTPS privacy page + Dashboard **data usage** disclosure.  
> Not legal advice. Must match runtime behavior (ADR Decisions Log + §10).

## Single purpose

Manage Chrome tabs: on-demand LLM topic grouping, duplicate tab cleanup, fuzzy search, and reclaim/recall via Stacks.

## What we collect / process

| Data | Where | Why |
|------|-------|-----|
| Tab URL, title, group metadata | Device (`chrome.tabs` / local storage) | Search, organize, dedupe, Stacks |
| Optional page excerpt (≤~280 chars) | Device; may be sent to **user** LLM endpoint | Classification quality when extraction is enabled |
| LLM endpoint URL, model, API key | `chrome.storage.local` only | User-configured classify calls |
| Topic cache / StackRecords / local metrics | `chrome.storage.local` | Avoid re-calling LLM; reclaim/recall; optional cost counters |

## What we do **not** do

- No developer-operated backend; we do **not** receive, proxy, or store user LLM traffic.
- No remote code execution; model responses are treated as topic **data** only.
- No always-on content scripts rewriting pages.
- API keys never go to `chrome.storage.sync` and are never shown in the privacy preview field list.

## Who data is sent to

Only the LLM endpoint the user configures (Anthropic Messages or OpenAI Responses-style / compatible gateway), after an in-product **privacy preview** and explicit Confirm. Fields mirror the UI: `url`, `title`, `snippet`, `extractedText`, `provider`, `model`, `endpointBaseUrl`.

## User controls

- Organize is on-demand; Cancel cooperatively stops the refine queue.
- Optional host permissions are requested at Confirm time; deny is respected.
- Content extraction and daily LLM quota are configurable in Options.
- Stacks overflow requires explicit export or discard.

## Remote code

**No.** Dashboard: “No, I am not using remote code.”

## Alignment refs

- ADR Decisions Log (#1–#12) and §10 Borrowed / Skipped
- `docs/chrome-web-store/permissions.md`
- Project checklist: store Privacy practices + User Data FAQ (user-specified servers)
