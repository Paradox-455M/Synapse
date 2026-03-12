// MAIN world — Claude.ai fetch intercept.
// Phase 4A: probe pass (logs all POSTs) + injection on confirmed endpoint.

(function () {
  'use strict';

  if (window.__synapseClaudeInstalled) return;
  window.__synapseClaudeInstalled = true;

  // ── State (pushed from isolated world via postMessage) ────────────────────
  let state = {
    enabled: true,
    activeBrain: null,
    brains: [],
    customBrains: [],
    mode: 'auto',
    conversationLocks: {},
  };

  function allBrains() {
    return [...(state.brains ?? []), ...(state.customBrains ?? [])];
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__SYNAPSE_STATE__') {
      state = { ...state, ...event.data.payload };
    }
  });

  window.postMessage({ type: '__SYNAPSE_REQUEST_STATE__' }, '*');

  function getConvId() {
    // Claude conversation IDs appear in URLs like /chat/<uuid>
    const match = location.pathname.match(/\/chat\/([^/?#]+)/);
    return match ? match[1] : location.pathname;
  }

  // ── Scored brain router (copied inline — no ES module import available) ───
  function selectBrain(userText) {
    if (!state.enabled) return null;
    const brains = allBrains();
    if (!brains.length) return null;

    if (state.mode === 'manual') {
      if (!state.activeBrain) return null;
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (!brain) return null;
      return { brain, score: 0, matchedTags: [], isManual: true };
    }

    const lower = userText.toLowerCase();
    let bestBrain = null, bestScore = 0, bestMatchedTags = [];

    for (const brain of brains) {
      if (!Array.isArray(brain.tags)) continue;
      const matched = brain.tags.filter((tag) => lower.includes(tag.toLowerCase()));
      if (matched.length > bestScore) {
        bestScore = matched.length;
        bestBrain = brain;
        bestMatchedTags = matched;
      }
    }

    if (bestScore >= 1) {
      return { brain: bestBrain, score: bestScore, matchedTags: bestMatchedTags, isManual: false };
    }

    if (state.activeBrain) {
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (brain) return { brain, score: 0, matchedTags: [], isManual: false };
    }

    return null;
  }

  function lockConversation(convId, brainName) {
    window.postMessage({ type: '__SYNAPSE_LOCK_CONV__', payload: { convId, brainName } }, '*');
  }

  // ── Extract user text from Claude request body ────────────────────────────
  // Claude uses various body shapes; try common prompt fields.
  function extractUserText(parsed) {
    // Shape: { prompt: "..." }
    if (typeof parsed.prompt === 'string') return parsed.prompt;
    // Shape: { messages: [{role:"human", content:"..."}] }
    if (Array.isArray(parsed.messages)) {
      const human = [...parsed.messages].reverse().find(
        (m) => m.role === 'human' || m.role === 'user'
      );
      if (human) {
        if (typeof human.content === 'string') return human.content;
        if (Array.isArray(human.content)) {
          return human.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join(' ');
        }
      }
    }
    // Shape: { human_turn: "..." }
    if (typeof parsed.human_turn === 'string') return parsed.human_turn;
    return '';
  }

  // ── Scrub prefix from the rendered chat bubble ────────────────────────────
  // Claude reflects the server-sent message content back into the DOM, so the
  // injected prefix can appear in the user's message bubble. This observer
  // strips it as soon as the node appears.
  function scrubRenderedMessage(prefix) {
    const startTime = Date.now();
    const obs = new MutationObserver(() => {
      if (Date.now() - startTime > 5000) { obs.disconnect(); return; }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.startsWith(prefix)) {
          node.nodeValue = node.nodeValue.slice(prefix.length);
          obs.disconnect();
          return;
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Core injection ─────────────────────────────────────────────────────────
  function tryInjectBrain(parsed, bodyText) {
    if (!state.enabled) return null;

    const userText = extractUserText(parsed);
    if (!userText) return null;

    const convId = getConvId();
    const brains = allBrains();

    // Resolve brain (conv lock takes priority)
    let brain = null;
    let routeResult = null;
    const lockedBrainName = state.conversationLocks?.[convId];

    if (lockedBrainName) {
      brain = brains.find((b) => b.name === lockedBrainName) ?? null;
    }

    if (!brain) {
      routeResult = selectBrain(userText);
      if (!routeResult) return null;
      brain = routeResult.brain;
      lockConversation(convId, brain.name);
    }

    // Stateless turn detection — survives page reloads
    const isFirstTurn = !Array.isArray(parsed.messages) ||
      !parsed.messages.some((m) => m.role === 'assistant');

    // Build injection prefix
    const fw = Array.isArray(brain.framework) ? brain.framework : [];
    let prefix;
    if (isFirstTurn) {
      prefix = `[Context: You are operating as ${brain.name}. ${brain.system_prompt}]\n\n`;
    } else {
      prefix = `[Synapse Reminder: ${fw.join(' → ')}]\n\n`;
    }

    // ── Inject into user message body (system field not accepted by claude.ai API) ──
    let modifiedBody = null;
    if (typeof parsed.prompt === 'string') {
      parsed.prompt = prefix + parsed.prompt;
      modifiedBody = JSON.stringify(parsed);
    } else if (Array.isArray(parsed.messages)) {
      const msgs = parsed.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'human' || msgs[i].role === 'user') {
          if (typeof msgs[i].content === 'string') {
            msgs[i].content = prefix + msgs[i].content;
          } else if (Array.isArray(msgs[i].content)) {
            const firstText = msgs[i].content.find((c) => c.type === 'text');
            if (firstText) firstText.text = prefix + (firstText.text ?? '');
            else msgs[i].content.unshift({ type: 'text', text: prefix });
          }
          break;
        }
      }
      modifiedBody = JSON.stringify(parsed);
    }
    if (!modifiedBody) return null;

    // Scrub prefix from rendered bubble — Claude reflects server content back into the DOM
    scrubRenderedMessage(prefix);

    console.groupCollapsed('%c[Synapse:Claude] Outgoing prompt', 'color:#7c6fff;font-weight:bold');
    console.log('%cInjected prefix:', 'color:#7c6fff', prefix);
    console.log('%cUser message:', 'color:#aaaaff', userText);
    console.groupEnd();

    window.postMessage({
      type: '__SYNAPSE_ACTIVATION__',
      payload: {
        brainName: brain.name,
        matchedTags: routeResult?.matchedTags ?? [],
        score: routeResult?.score ?? 0,
        isManual: routeResult?.isManual ?? !!lockedBrainName,
        timestamp: Date.now(),
      },
    }, '*');

    window.postMessage({
      type: '__SYNAPSE_TRACK__',
      payload: { brainName: brain.name, score: routeResult?.score ?? 0, platform: 'claude' },
    }, '*');

    return modifiedBody;
  }

  // ── Fetch intercept ────────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);

  window.fetch = async function synapseClaudeInterceptor(input, init = {}) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    const method = (
      typeof input === 'string' ? (init?.method ?? 'GET') :
      input instanceof Request   ? input.method :
      init?.method ?? 'GET'
    ).toUpperCase();

    // ── Injection: guard on known conversation endpoint
    // To identify the endpoint: temporarily add console.log('[Synapse:Claude] POST →', url) here.
    const isConvEndpoint = url.includes('/api/append_message') ||
                           url.includes('/api/organizations') && url.includes('/chat_conversations');

    if (state.enabled && method === 'POST' && isConvEndpoint) {
      try {
        let bodyText;
        if (input instanceof Request) {
          bodyText = await input.clone().text().catch(() => null);
        } else {
          bodyText = typeof init?.body === 'string' ? init.body : null;
        }

        if (bodyText) {
          const parsed = JSON.parse(bodyText);
          const modifiedBody = tryInjectBrain(parsed, bodyText);
          if (modifiedBody) {
            if (input instanceof Request) {
              input = new Request(input, { body: modifiedBody });
            } else {
              init = { ...init, body: modifiedBody };
            }
          }
        }
      } catch (_) { /* not JSON or not a conversation payload */ }
    }

    return _fetch(input, init);
  };

  console.log('%c[Synapse:Claude] ◈ Ready (probe + injection)', 'color:#7c6fff;font-weight:bold;font-size:13px');
})();
