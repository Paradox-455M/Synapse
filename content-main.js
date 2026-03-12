// MAIN world — fetch + WebSocket intercept.
// Phase 4A: scored routing, turn-aware injection, memory merge, SSE refusal detection, conv locking.

(function () {
  'use strict';

  if (window.__synapseInstalled) return;
  window.__synapseInstalled = true;

  // ── State (pushed from isolated world via postMessage) ────────────────────
  let state = {
    enabled: true,
    activeBrain: null,
    brains: [],
    customBrains: [],
    mode: 'auto',
    conversationLocks: {},  // { [convId]: brainName }
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

  // ── In-memory conversation tracking ───────────────────────────────────────
  // convId → { brain, turnCount, refusalStreak }
  const convMap = new Map();
  const CONV_MAP_MAX = 50;

  function getConvId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : 'new';
  }

  // ── SPA navigation: re-sync state on route change (debounced 2s) ──────────
  let _navDebounce = null;
  function scheduleStateRefresh() {
    clearTimeout(_navDebounce);
    _navDebounce = setTimeout(() => {
      window.postMessage({ type: '__SYNAPSE_REQUEST_STATE__' }, '*');
    }, 2000);
  }

  function attachNavObserver() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', attachNavObserver, { once: true });
      return;
    }
    new MutationObserver(scheduleStateRefresh)
      .observe(document.body, { childList: true, subtree: false });
  }
  attachNavObserver();

  // ── Scored brain router ────────────────────────────────────────────────────
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

  // ── Helpers ────────────────────────────────────────────────────────────────
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function buildSystemMessage(content) {
    return {
      id: uuid(),
      author: { role: 'system' },
      content: { content_type: 'text', parts: [content] },
      create_time: Date.now() / 1000,
      metadata: {},
    };
  }

  // ── Persist conversation lock → isolated world → storage ──────────────────
  function lockConversation(convId, brainName) {
    window.postMessage({
      type: '__SYNAPSE_LOCK_CONV__',
      payload: { convId, brainName },
    }, '*');
  }

  // ── Core injection ─────────────────────────────────────────────────────────
  function tryInjectBrain(parsed) {
    const msgs = parsed.messages;
    if (!Array.isArray(msgs)) return null;

    const userMsgs = msgs.filter((m) => m.author?.role === 'user');
    if (!userMsgs.length) return null;

    const userText = userMsgs[userMsgs.length - 1]?.content?.parts?.join(' ') ?? '';
    const convId = getConvId();
    const brains = allBrains();

    // ── 1. Resolve brain (conv lock takes priority over routing) ────────────
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

    // ── 2. Turn tracking ───────────────────────────────────────────────────
    if (!convMap.has(convId)) {
      if (convMap.size >= CONV_MAP_MAX) {
        convMap.delete(convMap.keys().next().value);
      }
      convMap.set(convId, { brain, turnCount: 0, refusalStreak: 0 });
    }
    const entry = convMap.get(convId);
    entry.turnCount++;

    // ── 3. Build injection content ─────────────────────────────────────────
    let injectionContent;
    if (entry.turnCount === 1) {
      injectionContent = brain.system_prompt;
    } else {
      const fw = Array.isArray(brain.framework) ? brain.framework : [];
      injectionContent = `[Synapse Reminder] ${fw.join(' → ')}`;
    }

    // ── 4. Inject: merge with existing system message or inject fresh ───────
    const existingSystemIdx = msgs.findIndex((m) => m.author?.role === 'system');

    if (existingSystemIdx >= 0) {
      const existing = msgs[existingSystemIdx];
      const existingText = existing.content?.parts?.[0] ?? '';
      existing.content.parts[0] =
        `${existingText}\n\n---\n[Synapse Brain Active: ${brain.name}]\n${injectionContent}`;
    } else {
      const filtered = msgs.filter((m) => m.author?.role !== 'system');
      parsed.messages = [buildSystemMessage(injectionContent), ...filtered];
    }

    console.groupCollapsed('%c[Synapse] Outgoing prompt', 'color:#00ff88;font-weight:bold');
    console.log('%cInjected system content:', 'color:#00ff88', injectionContent);
    console.log('%cUser message:', 'color:#aaaaff', userText);
    console.groupEnd();

    // Notify isolated world → storage → popup (activation)
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

    // Notify isolated world → background → analytics
    window.postMessage({
      type: '__SYNAPSE_TRACK__',
      payload: {
        brainName: brain.name,
        score: routeResult?.score ?? 0,
        platform: 'chatgpt',
      },
    }, '*');

    return { modifiedBody: JSON.stringify(parsed), brain };
  }

  // ── SSE stream parser (inlined — cannot import from utils/ in script-tag context) ──
  // Parses ChatGPT's delta SSE format to extract response text.
  function parseSSEStream(stream, onText, onDone) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let finished = false;

    function processBlock(block) {
      if (finished) return;
      const lines = block.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          finished = true;
          onDone(fullText);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          let delta = null;
          // Format A: { v: [{p: "...", o: "append", v: "text"}, ...] }
          if (Array.isArray(parsed.v)) {
            const item = parsed.v.find(
              (x) => x.o === 'append' && typeof x.p === 'string' && x.p.includes('content/parts')
            );
            if (item) delta = item.v;
          }
          // Format B: { p: "...", o: "append", v: "text" }
          if (delta === null && parsed.o === 'append' &&
              typeof parsed.p === 'string' && parsed.p.includes('content/parts')) {
            delta = parsed.v;
          }
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            onText(delta);
          }
        } catch (_) { /* non-JSON line, skip */ }
      }
    }

    function pump() {
      reader.read().then(({ done: streamDone, value }) => {
        if (value) buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          if (finished) break;
          if (block.trim()) processBlock(block);
        }

        if (finished) return;

        if (streamDone) {
          if (buffer.trim()) processBlock(buffer);
          if (!finished) onDone(fullText);
          return;
        }

        pump();
      }).catch(() => {
        if (!finished) onDone(fullText);
      });
    }

    pump();
  }

  // ── Refusal detection (SSE-aware) ─────────────────────────────────────────
  function monitorRefusal(stream, brain, convId) {
    parseSSEStream(
      stream,
      (_chunk) => { /* streaming chunk — real-time check possible here */ },
      (fullText) => {
        const entry = convMap.get(convId);
        if (!entry) return;

        const hit = (brain.tags ?? []).some(
          (tag) => fullText.toLowerCase().includes(tag.toLowerCase())
        );

        if (!hit) {
          entry.refusalStreak = (entry.refusalStreak ?? 0) + 1;
          if (entry.refusalStreak >= 2) {
            window.postMessage({
              type: '__SYNAPSE_REFUSAL__',
              payload: { brainName: brain.name, streak: entry.refusalStreak },
            }, '*');
          }
        } else {
          entry.refusalStreak = 0;
        }
      }
    );
  }

  // ── Fetch intercept ────────────────────────────────────────────────────────
  async function resolveArgs(input, init) {
    if (input instanceof Request) {
      return {
        url: input.url,
        method: input.method.toUpperCase(),
        bodyText: await input.clone().text().catch(() => null),
        isRequest: true,
      };
    }
    return {
      url: typeof input === 'string' ? input : String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      bodyText: typeof init?.body === 'string' ? init.body : null,
      isRequest: false,
    };
  }

  const _fetch = window.fetch.bind(window);

  window.fetch = async function synapseInterceptor(input, init = {}) {
    const { url, method, bodyText, isRequest } = await resolveArgs(input, init);

    let injectedBrain = null;
    let modifiedInput = input;
    let modifiedInit = init;

    if (state.enabled && method === 'POST' && bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        const result = tryInjectBrain(parsed);
        if (result) {
          injectedBrain = result.brain;
          if (isRequest) {
            modifiedInput = new Request(input, { body: result.modifiedBody });
          } else {
            modifiedInit = { ...init, body: result.modifiedBody };
          }
        }
      } catch (_) { /* not JSON or not a conversation payload */ }
    }

    const response = await _fetch(modifiedInput, modifiedInit);

    // Tee the response stream for SSE-based refusal monitoring
    if (injectedBrain && response.body) {
      try {
        const convId = getConvId();
        const [pageStream, monitorStream] = response.body.tee();
        monitorRefusal(monitorStream, injectedBrain, convId);
        return new Response(pageStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (_) { /* tee unsupported, return original */ }
    }

    return response;
  };

  // ── WebSocket intercept (fallback) ────────────────────────────────────────
  const _WebSocket = window.WebSocket;

  function SynapseWebSocket(url, protocols) {
    const ws = protocols ? new _WebSocket(url, protocols) : new _WebSocket(url);
    const _send = ws.send.bind(ws);

    ws.send = function (data) {
      if (state.enabled && typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          const result = tryInjectBrain(parsed);
          if (result) return _send(result.modifiedBody);
        } catch (_) { /* not a conversation frame */ }
      }
      return _send(data);
    };

    return ws;
  }

  Object.assign(SynapseWebSocket, _WebSocket);
  SynapseWebSocket.prototype = _WebSocket.prototype;
  window.WebSocket = SynapseWebSocket;

  console.log('%c[Synapse] ◈ Ready (Phase 4A)', 'color:#00ff88;font-weight:bold;font-size:13px');
})();
