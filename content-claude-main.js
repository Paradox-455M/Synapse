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
    brainMemory: {},
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
      console.warn('[Synapse:Claude] ⚠ No brains loaded — state not synced yet. Re-requesting…');
      window.postMessage({ type: '__SYNAPSE_REQUEST_STATE__' }, '*');
      return null;
    }

    if (state.mode === 'manual') {
      if (!state.activeBrain) return null;
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (!brain) {
        console.warn(`[Synapse:Claude] Manual mode — activeBrain "${state.activeBrain}" not found`);
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

  function lockConversation(convId, brainName) {
    window.postMessage({ type: '__SYNAPSE_LOCK_CONV__', payload: { convId, brainName } }, '*');
  }

  // ── Refusal detection: check if the model ignored the brain ───────────────
  function checkClaudeRefusal(responseText, brain) {
    if (!brain || !responseText || responseText.length < 80) return;
    const lower = responseText.toLowerCase();
    // Only check brains with meaningful tags (length >= 4)
    const longTags = (brain.tags ?? []).filter((t) => typeof t === 'string' && t.trim().length >= 4);
    if (!longTags.length) return;
    const tagHit = longTags.some((tag) => lower.includes(tag.trim().toLowerCase()));
    if (!tagHit) {
      window.postMessage({
        type: '__SYNAPSE_REFUSAL__',
        payload: { brainName: brain.name, streak: 1, timestamp: Date.now() },
      }, '*');
      console.warn('%c[Synapse:Claude] ⚠ Possible refusal — brain tags absent in response', 'color:#ff8800;font-weight:bold');
    }
  }

  function monitorClaudeRefusal(stream, brain) {
    if (!stream) return;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let collected = '';
      const pump = () => {
        reader.read().then(({ value, done }) => {
          if (value) collected += decoder.decode(value, { stream: !done });
          if (done || collected.length >= 600) {
            checkClaudeRefusal(collected, brain);
            if (!done) reader.cancel().catch(() => {});
          } else {
            pump();
          }
        }).catch(() => {});
      };
      pump();
    } catch (_) {}
  }

  // convId → string[] — matched tags from prior turn, for session context blending
  const convTagMap = new Map();

  // convId → string[] — user messages sent this session, for memory prompts
  const sessionMessages = new Map();

  // ── Nav-away: fire memory prompt when user leaves a conversation ──────────
  let _lastNavConvId = getConvId();
  setInterval(() => {
    const current = getConvId();
    if (current === _lastNavConvId) return;
    const prev = _lastNavConvId;
    _lastNavConvId = current;
    // Claude's fallback convId is the full pathname — skip those
    if (prev.startsWith('/')) return;
    const prevBrain = allBrains().find(
      (b) => b.name === state.conversationLocks?.[prev]
    );
    if (!prevBrain) return;
    const prevMsgs = sessionMessages.get(prev) ?? [];
    if (!prevMsgs.length) return;
    window.postMessage({
      type: '__SYNAPSE_NAV_AWAY__',
      payload: { brainName: prevBrain.name, messages: prevMsgs },
    }, '*');
  }, 1000);

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
  // Claude reflects the server-sent message content back into the DOM. The
  // prefix is multi-line, so React splits it across text nodes at each \n —
  // a startsWith check on the full string never matches. Instead, anchor on
  // the first line (which fits in one text node) and trim to the end marker.
  function scrubRenderedMessage(prefix) {
    const firstLine = prefix.split('\n')[0]; // fits in a single text node
    const endMark = ']\n\n';                 // closing delimiter of [Context:…]\n\n or [Synapse Reminder:…]\n\n
    const startTime = Date.now();
    const obs = new MutationObserver(() => {
      if (Date.now() - startTime > 5000) { obs.disconnect(); return; }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue?.includes(firstLine)) continue;
        const idx = node.nodeValue.indexOf(firstLine);
        const endIdx = node.nodeValue.indexOf(endMark, idx);
        if (endIdx >= 0) {
          // Full prefix is in this single node
          node.nodeValue = node.nodeValue.slice(0, idx) + node.nodeValue.slice(endIdx + endMark.length);
        } else {
          // Prefix is split across nodes — strip from anchor to end of this node
          node.nodeValue = node.nodeValue.slice(0, idx);
        }
        obs.disconnect();
        return;
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

    // Accumulate for memory prompt on nav-away
    if (userText) {
      const msgs = sessionMessages.get(convId) ?? [];
      if (!msgs.includes(userText)) {
        msgs.push(userText);
        sessionMessages.set(convId, msgs);
      }
    }
    const brains = allBrains();

    // Stateless first-turn detection — survives page reloads; computed before
    // lock lookup so a stale lock can be bypassed on the first auto-mode turn.
    const isFirstTurn = !Array.isArray(parsed.messages) ||
      !parsed.messages.some((m) => m.role === 'assistant');

    // Resolve brain: conv lock takes priority, but on the first turn in auto
    // mode skip the persisted lock — it may be stale session data from a prior
    // page load (unlike ChatGPT's in-memory convMap, this lock is persisted).
    let brain = null;
    let routeResult = null;
    const lockedBrainName = (!isFirstTurn || state.mode === 'manual')
      ? (state.conversationLocks?.[convId] ?? null)
      : null;

    if (lockedBrainName) {
      brain = brains.find((b) => b.name === lockedBrainName) ?? null;
    }

    if (!brain) {
      const sessionTags = convTagMap.get(convId) ?? [];
      routeResult = selectBrain(userText, sessionTags);
      if (!routeResult) return null;
      brain = routeResult.brain;
      if (routeResult.matchedTags?.length) convTagMap.set(convId, routeResult.matchedTags);
      lockConversation(convId, brain.name);
    }

    // Build injection content
    const fw = Array.isArray(brain.framework) ? brain.framework : [];
    let prefix; // user-message prepend form (last-resort fallback)
    if (isFirstTurn) {
      const mem = state.brainMemory?.[brain.name];
      const memBlock = mem?.facts?.length
        ? `\n\n[Synapse Memory]\n${mem.facts.map((f) => `- ${f}`).join('\n')}`
        : '';
      prefix = `[Context: You are operating as ${brain.name}. ${brain.system_prompt}${memBlock}]\n\n`;
    } else {
      prefix = `[Synapse Reminder: ${fw.join(' → ')}]\n\n`;
    }

    // ── Inject: system_prompt field → system role message → user message (last resort) ──
    // Priority 1/2 never appear in the user's bubble so scrubRenderedMessage is not needed.
    let modifiedBody = null;
    let usedUserPrepend = false;

    if ('system_prompt' in parsed) {
      // Priority 1: top-level system_prompt field (not reflected in user bubble)
      const existing = parsed.system_prompt ?? '';
      parsed.system_prompt = existing
        ? `${existing}\n\n---\n[Synapse Brain: ${brain.name}]\n${prefix}`
        : prefix;
      modifiedBody = JSON.stringify(parsed);
    } else if (Array.isArray(parsed.messages)) {
      const sysIdx = parsed.messages.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        // Priority 2: merge into existing system message (not reflected in user bubble)
        const s = parsed.messages[sysIdx];
        const existingText = typeof s.content === 'string' ? s.content : '';
        s.content = existingText ? `${existingText}\n\n---\n${prefix}` : prefix;
        modifiedBody = JSON.stringify(parsed);
      } else {
        // Priority 3: prepend to last human/user message (visible in bubble — scrub needed)
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
            usedUserPrepend = true;
            break;
          }
        }
        if (usedUserPrepend) modifiedBody = JSON.stringify(parsed);
      }
    } else if (typeof parsed.prompt === 'string') {
      // Priority 4: legacy prompt field
      parsed.prompt = prefix + parsed.prompt;
      modifiedBody = JSON.stringify(parsed);
      usedUserPrepend = true;
    }

    if (!modifiedBody) return null;

    // Only scrub if we modified the user's visible message
    if (usedUserPrepend) scrubRenderedMessage(prefix);

    console.log('%c[Synapse:Claude]', 'color:#7c6fff;font-weight:bold', `◈ "${brain.name}" | turn ${isFirstTurn ? 1 : 'N'} | score: ${routeResult?.score ?? 'locked'}`);

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

    return { modifiedBody, brain };
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

    const isConvEndpoint = url.includes('/api/append_message') ||
                           url.includes('/api/organizations') && url.includes('/chat_conversations');

    let injectedBrain = null;

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
          const injResult = tryInjectBrain(parsed, bodyText);
          const { modifiedBody, brain: brainRef } = injResult ?? {};
          if (modifiedBody) {
            injectedBrain = brainRef;
            if (input instanceof Request) {
              input = new Request(input, { body: modifiedBody });
            } else {
              init = { ...init, body: modifiedBody };
            }
          }
        }
      } catch (_) { /* not JSON or not a conversation payload */ }
    }

    const response = await _fetch(input, init);

    // Tee the response body to monitor for refusals without blocking Claude
    if (injectedBrain && response.ok && response.body) {
      try {
        const [mainStream, monitorStream] = response.body.tee();
        monitorClaudeRefusal(monitorStream, injectedBrain);
        return new Response(mainStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (_) { /* tee not supported — fall through */ }
    }

    return response;
  };

  console.log('%c[Synapse:Claude] ◈ Ready (probe + injection)', 'color:#7c6fff;font-weight:bold;font-size:13px');
})();
