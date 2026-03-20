# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Installation & Loading

There is no build step. Load the extension directly into Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the repo root

After any code change, click the reload icon on the extensions page (or use the keyboard shortcut). On `popup/` changes, just close and reopen the popup.

## Architecture

Synapse is a Manifest V3 Chrome extension. It operates across three execution contexts that communicate via `postMessage` and `chrome.runtime.sendMessage`:

### Execution contexts

**Service Worker (`background.js`)**
- Loads built-in brains from `brains/*.json` on install/startup
- Owns all storage writes (the single source of truth)
- Message handlers: `GET_STATE`, `SET_STATE`, `SAVE_BRAIN_MEMORY`, `SAVE_BRAIN_MEMORY`, `TRACK_ACTIVATION`, `TRACK_REFUSAL`, `CSP_FALLBACK_NEEDED`, `CSP_FALLBACK_NEEDED_CLAUDE`
- Syncs settings (`activeBrain`, `enabled`, `mode`) and custom brains to `chrome.storage.sync` for cross-device access; chunked writes handle Chrome's 8 KB sync item limit

**Isolated world content scripts**
- `content-isolated.js` (chatgpt.com) and `content-claude-isolated.js` (claude.ai): bridge between the MAIN world and chrome.* APIs
- Load storage and push state to the MAIN world via `postMessage({ type: '__SYNAPSE_STATE__', ... })`
- Listen for postMessages from MAIN world (`__SYNAPSE_ACTIVATION__`, `__SYNAPSE_LOCK_CONV__`, `__SYNAPSE_REFUSAL__`, `__SYNAPSE_TRACK__`, `__SYNAPSE_NAV_AWAY__`) and write to storage or forward to background
- `content-gemini.js` runs in isolated world directly (no MAIN world injection needed) and intercepts at the DOM level
- `content-memory-prompt.js` is loaded before all isolated scripts and defines `showMemoryPrompt()`, which all three platforms share

**MAIN world scripts (injected)**
- `content-main.js` (ChatGPT) and `content-claude-main.js` (Claude.ai): injected as `<script>` tags by the isolated world; run in the page's JavaScript context, enabling `window.fetch` and `window.WebSocket` overriding
- Intercept outgoing conversation API calls, select a brain, and mutate the request body before it's sent
- On CSP block, the isolated world sends `CSP_FALLBACK_NEEDED` to background, which uses `chrome.scripting.executeScript` to inject the MAIN world script instead

### Injection strategy per platform

| Platform | API format | Injection method |
|---|---|---|
| ChatGPT | JSON fetch + WebSocket to `/backend-api/conversation` | Intercept `window.fetch` + `window.WebSocket` in MAIN world; inject system message into `messages[]` |
| Claude.ai | JSON fetch to `/api/append_message` or `/api/organizations/.../chat_conversations` | Intercept `window.fetch` in MAIN world; prepend `[Context: ...]` prefix to the last human message |
| Gemini | Protobuf (not JSON fetch) | DOM-based: intercept `keydown` Enter and send-button click in isolated world; set `contenteditable` text to prefixed prompt, then restore original text after one frame |

### Brain routing (auto mode)

In `content-main.js` and `content-claude-main.js`: simple substring tag matching — score = number of brain tags found in the user's text. Highest score wins; falls back to `activeBrain` if no match.

`utils/brain-router.js` is the advanced router (IDF-weighted, conflict detection, `routeBrain`/`buildDualInjection` API) — pure JS, no chrome.* APIs, usable in Node for testing. It is **not yet wired into the content scripts**; the content scripts have their own inline `selectBrain()`.

`utils/sse-parser.js` is the reference SSE parser — also inlined into `content-main.js` because script-tag injection cannot use ES module imports.

### Turn-awareness

- **ChatGPT**: `convMap` (in-memory Map) tracks per-conversation `{ brain, refusalStreak }`. First turn injects full `system_prompt + memory`; subsequent turns inject a short `[Synapse Reminder]` with the framework steps. SSE response is tee'd to detect refusals (model not following the brain).
- **Claude.ai**: Stateless — detects first turn by absence of any `role: assistant` message in the request body.
- **Gemini**: `sessionStorage` keyed by pathname; turn count increments on each send.

### Storage layout (`chrome.storage.local`)

| Key | Description |
|---|---|
| `brains` | Built-in brains array (loaded from `brains/*.json`) |
| `customBrains` | User-created brains array |
| `activeBrain` | Currently selected brain name |
| `enabled` | Master on/off boolean |
| `mode` | `"auto"` or `"manual"` |
| `conversationLocks` | `{ [convId]: brainName }` — persists brain selection per conversation |
| `lastActivation` | Last activation event for popup display |
| `refusalWarning` | `{ brainName, streak, timestamp }` — shown as popup badge |
| `synapse_analytics` | `{ brains: { [name]: { activations, totalScore, refusals, platforms } }, totalActivations }` |
| `synapse_brain_memory` | `{ [brainName]: { facts: string[], updatedAt } }` — memory facts per brain |

## Brain file format

```json
{
  "name": "Brain Name",
  "tags": ["keyword", "routing", "terms"],
  "system_prompt": "...",
  "framework": ["Step one", "Step two"]
}
```

Built-in brains live in `brains/`. Custom brains are stored in `chrome.storage.local` and mirrored to `chrome.storage.sync` (chunked at 7 KB per item).

## Security model

Content scripts on AI sites are considered untrusted callers:
- `SET_STATE` messages from content scripts (detected via `sender.tab`) are restricted to `activeBrain`, `enabled`, `mode`
- `SAVE_BRAIN_MEMORY` validates `brainName` (string ≤ 200 chars) and sanitizes `facts` (array of strings, each ≤ 500 chars, max 100 entries)
- `__SYNAPSE_REFUSAL__` payload is stripped to `{ brainName, streak, timestamp }` only
- `__SYNAPSE_LOCK_CONV__` validates `brainName` against the known brains list before writing
- CSP fallback handlers check `sender.url` matches the expected origin before calling `chrome.scripting.executeScript`
- `brains/*.json` is not in `web_accessible_resources` (brain data reaches the MAIN world via `__SYNAPSE_STATE__` postMessage only)
- `escHtml()` in `popup/popup.js` escapes `&`, `<`, `>`, `"`, `'`; `esc()` in `content-memory-prompt.js` does the same

## Constraints

- No build pipeline, bundler, or package manager. All scripts are plain JS files loaded directly.
- MAIN world scripts (`content-main.js`, `content-claude-main.js`) cannot use ES module `import` — they are injected as `<script>` tags. Any shared utilities must be inlined.
- `utils/brain-router.js` and `utils/sse-parser.js` use `export` and are usable from Node test harnesses but cannot be imported by content scripts.
- `system_prompt` is capped at `MAX_SYSTEM_PROMPT_CHARS = 8000` characters (enforced in `popup/popup.js`).
- Custom brain limit: 10 per user (`MAX_CUSTOM_BRAINS`).
