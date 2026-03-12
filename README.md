# Synapse

Synapse is a Chrome extension that injects AI "Brain Packs" into ChatGPT, Claude, and Gemini to upgrade how they reason and respond.

Instead of using one static system prompt everywhere, Synapse routes each conversation through a specialized brain based on keyword matches, lets you manually lock a brain when needed, and supports importing custom brains for your own workflows.

## Features

- Works across ChatGPT, Claude, and Gemini
- Auto-routing based on brain tags and prompt keywords
- Manual override to pin a specific brain
- Built-in brain packs for coding, agent systems, and startup evaluation
- Custom brain import, export, edit, and sync support
- Conversation locking so follow-up turns keep the same brain
- Lightweight analytics for activations and refusal tracking

## Built-In Brains

- `Coding Architect`: architecture, backend systems, scaling, infrastructure
- `Agent Builder`: autonomous agents, tool use, orchestration, MCP, evals
- `Venture Capitalist`: startup ideas, fundraising, market analysis, investor-style feedback

## How It Works

1. Synapse loads built-in brains from `brains/*.json`.
2. It watches supported AI chat surfaces and injects the selected brain as system-level guidance.
3. In `auto` mode, Synapse scores brains by matching user text against each brain's tags.
4. In `manual` mode, the selected brain stays pinned until you switch back.
5. Custom brains are stored locally and mirrored to sync storage when possible.

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the project root folder.

## Usage

1. Open the Synapse popup from the Chrome toolbar.
2. Turn Synapse on and choose `AUTO` or `MANUAL` mode.
3. Start a conversation in ChatGPT, Claude, or Gemini.
4. Let Synapse auto-select a brain, or manually lock one before sending prompts.
5. Use the `Studio` tab to create custom brains and the `Analytics` tab to review usage.

## Brain File Format

Each brain pack is a JSON file with this shape:

```json
{
  "name": "Brain Name",
  "tags": ["keyword", "routing", "terms"],
  "system_prompt": "Detailed behavior and expertise instructions...",
  "framework": [
    "Step one",
    "Step two"
  ]
}
```

## Project Structure

```text
.
├── manifest.json
├── background.js
├── content-*.js
├── brains/
├── popup/
├── icons/
└── utils/
```

## Supported URLs

- `https://chatgpt.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

## Notes

- This project is built as a Manifest V3 Chrome extension.
- Some injection paths use `chrome.scripting` as a fallback when direct script insertion is blocked by CSP.
- Custom brain size is constrained by Chrome storage limits, so large prompts are chunked for sync storage.
