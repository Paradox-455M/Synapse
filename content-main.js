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
    brainMemory: {},        // { [brainName]: { facts: string[], updatedAt: number } }
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
  // convId → { brain, refusalStreak }
  const convMap = new Map();
  const CONV_MAP_MAX = 50;

  // convId → Set<string> — user messages sent this session, for memory prompts
  const sessionMessages = new Map();

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

  // ── Nav-away: fire memory prompt when user leaves a conversation ──────────
  let _lastNavConvId = getConvId();
  setInterval(() => {
    const current = getConvId();
    if (current === _lastNavConvId) return;
    const prev = _lastNavConvId;
    _lastNavConvId = current;
    if (prev === 'new') return;
    const prevBrain = convMap.get(prev)?.brain;
    if (!prevBrain) return;
    const prevMsgs = sessionMessages.get(prev);
    if (!prevMsgs?.size) return;
    window.postMessage({
      type: '__SYNAPSE_NAV_AWAY__',
      payload: { brainName: prevBrain.name, messages: [...prevMsgs] },
    }, '*');
  }, 1000);

  // ── Routing utilities (inlined from utils/brain-router.js) ─────────────────
  const _RT_STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'with', 'this', 'that',
    'have', 'from', 'they', 'will', 'what', 'how', 'why', 'can',
    'you', 'your', 'my', 'me', 'it', 'its', 'use', 'used', 'using',
  ]);

  function _tokenize(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    try {
      const raw = text.toLowerCase().split(/[\s,.()\[\]{}"'`]+/)
        .filter((t) => t.length >= 3 && !_RT_STOPWORDS.has(t));
      return [...new Set(raw)];
    } catch (_) { return []; }
  }

  function _buildIdf(brains) {
    if (!Array.isArray(brains) || !brains.length) return {};
    const N = brains.length, df = {};
    for (const brain of brains) {
      if (!brain || typeof brain !== 'object') continue;
      if (Array.isArray(brain.tags)) {
        const seen = new Set();
        for (const tag of brain.tags) {
          const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
          if (!t || seen.has(t)) continue;
          df[t] = (df[t] ?? 0) + 1; seen.add(t);
        }
      }
      const spText = typeof brain.system_prompt === 'string' ? brain.system_prompt.slice(0, 200) : '';
      if (spText) {
        const seenSp = new Set();
        for (const tok of _tokenize(spText)) {
          const key = '_sp:' + tok;
          if (seenSp.has(key)) continue;
          df[key] = (df[key] ?? 0) + 1; seenSp.add(key);
        }
      }
    }
    const idf = {};
    for (const [tag, count] of Object.entries(df)) {
      const v = Math.log((N + 1) / (count + 1));
      idf[tag] = Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    return idf;
  }

  function _scoreOne(brain, tokens, idf, raw) {
    if (!brain || !Array.isArray(brain.tags) || !brain.tags.length || !tokens.length) return 0;
    const rawLow = typeof raw === 'string' ? raw.toLowerCase() : '';
    let score = 0;
    for (const tag of brain.tags) {
      const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
      if (!t) continue;
      try {
        let hit = false, mult = 1.0;
        if (t.indexOf(' ') >= 0) {
          if (rawLow && rawLow.includes(t)) { hit = true; mult = 1.5; }
        } else if (t.length < 5) {
          if (rawLow) {
            const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            hit = new RegExp('\\b' + esc + '\\b').test(rawLow);
          }
        } else {
          hit = tokens.some((tok) => typeof tok === 'string' && tok && (t.includes(tok) || tok.includes(t)));
        }
        if (hit) score += (Number.isFinite(idf[t]) ? idf[t] : 1.0) * mult;
      } catch (_) {}
    }
    const spText = typeof brain.system_prompt === 'string' ? brain.system_prompt.slice(0, 200) : '';
    if (spText) {
      const seen = new Set();
      for (const st of _tokenize(spText)) {
        if (seen.has(st)) continue; seen.add(st);
        if (tokens.some((tok) => typeof tok === 'string' && tok && (st.includes(tok) || tok.includes(st)))) {
          score += (Number.isFinite(idf['_sp:' + st]) ? idf['_sp:' + st] : 1.0) * 0.4;
        }
      }
    }
    return (score / Math.log2(tokens.length + 2)) || 0;
  }

  function _matchedTags(brain, tokens, raw) {
    if (!brain || !Array.isArray(brain.tags)) return [];
    const rawLow = typeof raw === 'string' ? raw.toLowerCase() : '';
    return brain.tags.filter((tag) => {
      const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
      if (!t) return false;
      if (t.indexOf(' ') >= 0) return rawLow ? rawLow.includes(t) : false;
      if (t.length < 5) {
        if (!rawLow) return false;
        try {
          const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('\\b' + esc + '\\b').test(rawLow);
        } catch (_) { return false; }
      }
      return tokens.some((tok) => typeof tok === 'string' && tok && (t.includes(tok) || tok.includes(t)));
    });
  }

  let _idfCache = null, _idfSig = '';
  function _getIdf(brains) {
    const sig = brains.map((b) => (b.name || '') + ':' + (b.tags ? b.tags.length : 0)).join('|');
    if (sig !== _idfSig) { _idfCache = _buildIdf(brains); _idfSig = sig; }
    return _idfCache;
  }

  // ── Brain router ───────────────────────────────────────────────────────────
  function selectBrain(userText, sessionTags) {
    if (!state.enabled) return null;

    const brains = allBrains();
    if (!brains.length) {
      console.warn('[Synapse] ⚠ No brains loaded — state not synced yet. Re-requesting…');
      window.postMessage({ type: '__SYNAPSE_REQUEST_STATE__' }, '*');
      return null;
    }

    if (state.mode === 'manual') {
      if (!state.activeBrain) return null;
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (!brain) {
        console.warn(`[Synapse] Manual mode — activeBrain "${state.activeBrain}" not found`);
        return null;
      }
      return { brain, score: 0, matchedTags: [], isManual: true };
    }

    // Auto mode: IDF-weighted scoring
    const tokens = _tokenize(userText);
    const idf = _getIdf(brains);
    const scored = brains
      .map((brain) => ({ brain, score: _scoreOne(brain, tokens, idf, userText) }))
      .filter((e) => e.score > 0);

    // Session context bonus: prior-turn matched tags boost overlapping brains by 30%
    const sTags = Array.isArray(sessionTags) ? sessionTags : [];
    if (sTags.length && scored.length) {
      const tagVals = Object.entries(idf)
        .filter(([k]) => k.indexOf('_sp:') !== 0).map(([, v]) => v);
      const avgIdf = tagVals.length ? tagVals.reduce((a, b) => a + b, 0) / tagVals.length : 1.0;
      for (const e of scored) {
        const bTags = (e.brain.tags ?? [])
          .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : '')).filter(Boolean);
        const overlap = sTags
          .filter((t) => bTags.includes(typeof t === 'string' ? t.trim().toLowerCase() : '')).length;
        if (overlap > 0) e.score += 0.3 * overlap * avgIdf;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length) {
      const best = scored[0];
      return {
        brain: best.brain,
        score: best.score,
        matchedTags: _matchedTags(best.brain, tokens, userText),
        isManual: false,
      };
    }

    // Fallback 1: activeBrain
    if (state.activeBrain) {
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (brain) return { brain, score: 0, matchedTags: [], isManual: false };
    }

    // Fallback 2: first available brain
    if (brains.length) return { brain: brains[0], score: 0, matchedTags: [], isManual: false };

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

    // Support both legacy format (author.role) and newer format (role directly)
    const userMsgs = msgs.filter((m) => m.author?.role === 'user' || m.role === 'user');
    if (!userMsgs.length) return null;

    const lastUser = userMsgs[userMsgs.length - 1];
    // Support content.parts[] (legacy) and content as string (new format)
    let userText = '';
    if (Array.isArray(lastUser?.content?.parts)) {
      userText = lastUser.content.parts.join(' ');
    } else if (typeof lastUser?.content === 'string') {
      userText = lastUser.content;
    } else if (Array.isArray(lastUser?.content)) {
      // OpenAI-style: [{ type: 'text', text: '...' }]
      userText = lastUser.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ');
    }
    const convId = getConvId();
    const brains = allBrains();

    // Accumulate for memory prompt on nav-away (Set = O(1) dedup)
    if (userText) {
      if (!sessionMessages.has(convId)) sessionMessages.set(convId, new Set());
      sessionMessages.get(convId).add(userText);
    }

    // ── 1. Resolve brain (conv lock takes priority over routing) ────────────
    let brain = null;
    let routeResult = null;

    // Never read or write conversationLocks for 'new' — it's a shared placeholder
    // that would pollute every subsequent fresh conversation.
    const lockedBrainName = convId !== 'new' ? (state.conversationLocks?.[convId] ?? null) : null;

    if (lockedBrainName) {
      brain = brains.find((b) => b.name === lockedBrainName) ?? null;
    }

    // Detect 'new' → real UUID transition: URL updated after turn 1 fired as 'new'.
    // convMap still holds the 'new' entry from this session — this is the same conversation.
    const isNewToUuidTransition = !brain && convId !== 'new' && !lockedBrainName && convMap.has('new');

    if (!brain && isNewToUuidTransition) {
      brain = convMap.get('new').brain;
      convMap.delete('new');
      lockConversation(convId, brain.name);
    }

    // Get session tags from prior turn for context blending
    const sessionTags = convMap.get(convId)?.matchedTags ?? [];

    if (!brain) {
      routeResult = selectBrain(userText, sessionTags);
      if (!routeResult) return null;
      brain = routeResult.brain;
      // Only lock real conversation IDs — never 'new'
      if (convId !== 'new') lockConversation(convId, brain.name);
    }

    // ── 2. Turn tracking ───────────────────────────────────────────────────
    // isFirstTurn: no persisted lock + not seen in this session + not a 'new'→uuid continuation
    const isFirstTurn = !lockedBrainName && !convMap.has(convId) && !isNewToUuidTransition;

    if (!convMap.has(convId)) {
      if (convMap.size >= CONV_MAP_MAX) {
        convMap.delete(convMap.keys().next().value);
      }
      convMap.set(convId, { brain, refusalStreak: 0, matchedTags: routeResult?.matchedTags ?? [] });
    } else if (routeResult?.matchedTags?.length) {
      convMap.get(convId).matchedTags = routeResult.matchedTags;
    }
    const entry = convMap.get(convId);

    // ── 3. Build injection content ─────────────────────────────────────────
    let injectionContent;
    if (isFirstTurn) {
      const mem = state.brainMemory?.[brain.name];
      const memBlock = mem?.facts?.length
        ? `\n\n[Synapse Memory]\n${mem.facts.map((f) => `- ${f}`).join('\n')}`
        : '';
      injectionContent = brain.system_prompt + memBlock;
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

    console.log('%c[Synapse]', 'color:#00ff88;font-weight:bold', `◈ "${brain.name}" | turn ${isFirstTurn ? 1 : 'N'} | score: ${routeResult?.score ?? 'locked'}`);

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
    const fullChunks = []; // array join avoids O(n²) string allocation
    let finished = false;

    function processBlock(block) {
      if (finished) return;
      const lines = block.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          finished = true;
          onDone(fullChunks.join(''));
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
            fullChunks.push(delta);
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
          if (!finished) onDone(fullChunks.join(''));
          return;
        }

        pump();
      }).catch(() => {
        if (!finished) onDone(fullChunks.join(''));
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
  // Matches /backend-api/conversation and /backend-api/f/conversation only.
  // Does NOT match /backend-api/sentinel/..., /backend-api/lat/r, etc.
  const _CONV_URL = /\/backend-api\/(f\/)?conversation(\/[^/]*)?$/;

  const _fetch = window.fetch.bind(window);

  window.fetch = async function synapseInterceptor(input, init = {}) {
    // ── Fast path: skip immediately if disabled or wrong URL/method ──────────
    const url    = input instanceof Request ? input.url    : String(input);
    const method = (input instanceof Request ? input.method : (init?.method ?? 'GET')).toUpperCase();

    if (!state.enabled || method !== 'POST' || !_CONV_URL.test(url)) {
      return _fetch(input, init);
    }

    // ── Read body only for conversation requests ──────────────────────────────
    let bodyText = null;
    const isRequest = input instanceof Request;
    if (isRequest) {
      bodyText = await input.clone().text().catch(() => null);
    } else if (typeof init?.body === 'string') {
      bodyText = init.body;
    }

    let injectedBrain = null;
    let modifiedInput = input;
    let modifiedInit  = init;

    if (bodyText) {
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
        } catch (_) { /* not a JSON conversation frame */ }
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
