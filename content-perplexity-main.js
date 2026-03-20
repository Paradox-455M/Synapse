// MAIN world — Perplexity.ai fetch intercept.
// Perplexity uses JSON POST to /rest/sse/* endpoints with a `query` field.

(function () {
  'use strict';

  if (window.__synapsePerplexityInstalled) return;
  window.__synapsePerplexityInstalled = true;

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
    // Perplexity conversation URLs: /search/<slug>
    const match = location.pathname.match(/\/search\/([^/?#]+)/);
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
      window.postMessage({ type: '__SYNAPSE_REQUEST_STATE__' }, '*');
      return null;
    }

    if (state.mode === 'manual') {
      if (!state.activeBrain) return null;
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      return brain ? { brain, score: 0, matchedTags: [], isManual: true } : null;
    }

    const tokens = _tokenize(userText);
    const idf = _getIdf(brains);
    const scored = brains
      .map((brain) => ({ brain, score: _scoreOne(brain, tokens, idf, userText) }))
      .filter((e) => e.score > 0);

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

    if (state.activeBrain) {
      const brain = brains.find((b) => b.name === state.activeBrain) ?? null;
      if (brain) return { brain, score: 0, matchedTags: [], isManual: false };
    }

    return null;
  }

  function lockConversation(convId, brainName) {
    window.postMessage({ type: '__SYNAPSE_LOCK_CONV__', payload: { convId, brainName } }, '*');
  }

  // ── Refusal detection ─────────────────────────────────────────────────────
  function checkPerplexityRefusal(responseText, brain) {
    if (!brain || !responseText || responseText.length < 80) return;
    const lower = responseText.toLowerCase();
    const longTags = (brain.tags ?? []).filter((t) => typeof t === 'string' && t.trim().length >= 4);
    if (!longTags.length) return;
    const tagHit = longTags.some((tag) => lower.includes(tag.trim().toLowerCase()));
    if (!tagHit) {
      window.postMessage({
        type: '__SYNAPSE_REFUSAL__',
        payload: { brainName: brain.name, streak: 1, timestamp: Date.now() },
      }, '*');
      console.warn('%c[Synapse:Perplexity] ⚠ Possible refusal — brain tags absent in response', 'color:#ff8800;font-weight:bold');
    }
  }

  function monitorPerplexityRefusal(stream, brain) {
    if (!stream) return;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let collected = '';
      const pump = () => {
        reader.read().then(({ value, done }) => {
          if (value) collected += decoder.decode(value, { stream: !done });
          if (done || collected.length >= 600) {
            checkPerplexityRefusal(collected, brain);
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

  // ── Nav-away: show memory prompt when user leaves a conversation ──────────
  let _lastNavConvId = getConvId();
  setInterval(() => {
    const current = getConvId();
    if (current === _lastNavConvId) return;
    const prev = _lastNavConvId;
    _lastNavConvId = current;
    if (prev === '/') return; // skip home page
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

  // ── Fetch intercept ────────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);

  window.fetch = async function synapsePerplexityInterceptor(input, init = {}) {
    const url = typeof input === 'string' ? input
      : (input instanceof Request ? input.url : String(input));
    const method = (
      typeof input === 'string' ? (init?.method ?? 'GET') :
      input instanceof Request   ? input.method :
      init?.method ?? 'GET'
    ).toUpperCase();

    // Perplexity's AI endpoints: /rest/sse/* and /api/ask/*
    const isConvEndpoint = method === 'POST' && (
      url.includes('/rest/sse/') || url.includes('/api/ask/')
    );

    let injectedBrain = null;

    if (state.enabled && isConvEndpoint) {
      try {
        let bodyText;
        if (input instanceof Request) {
          bodyText = await input.clone().text().catch(() => null);
        } else {
          bodyText = typeof init?.body === 'string' ? init.body : null;
        }

        if (bodyText) {
          const parsed = JSON.parse(bodyText);

          // Extract user query — Perplexity uses `query` field
          const userText = typeof parsed.query === 'string' ? parsed.query.trim() : '';
          if (userText) {
            const convId = getConvId();

            // First turn: no follow-up UUID means this is the opening message
            const isFirstTurn = !parsed.in_page_follow_up_response_uuid &&
                                 !parsed.follow_up_response_uuid;

            const sessionTags = convTagMap.get(convId) ?? [];

            // Resolve brain: lock → route
            const lockedBrainName = (!isFirstTurn || state.mode === 'manual')
              ? (state.conversationLocks?.[convId] ?? null)
              : null;

            let brain = null;
            let routeResult = null;

            if (lockedBrainName) {
              brain = allBrains().find((b) => b.name === lockedBrainName) ?? null;
            }

            if (!brain) {
              routeResult = selectBrain(userText, sessionTags);
              if (routeResult) {
                brain = routeResult.brain;
                if (routeResult.matchedTags?.length) convTagMap.set(convId, routeResult.matchedTags);
                lockConversation(convId, brain.name);
              }
            }

            if (brain) {
              injectedBrain = brain;

              const fw = Array.isArray(brain.framework) ? brain.framework : [];
              let prefix;

              if (isFirstTurn) {
                const mem = state.brainMemory?.[brain.name];
                const memBlock = mem?.facts?.length
                  ? `\n[Synapse Memory]\n${mem.facts.map((f) => `- ${f}`).join('\n')}`
                  : '';
                // Truncate system_prompt to 300 chars for query-based injection
                const sp = brain.system_prompt.slice(0, 300);
                prefix = `[Context: ${brain.name} — ${sp}${memBlock}]\n\n`;
              } else {
                prefix = `[Reminder: ${fw.join(' → ')}]\n\n`;
              }

              parsed.query = prefix + userText;
              const modifiedBody = JSON.stringify(parsed);

              if (input instanceof Request) {
                input = new Request(input, { body: modifiedBody });
              } else {
                init = { ...init, body: modifiedBody };
              }

              // Accumulate for memory prompt on nav-away
              const msgs = sessionMessages.get(convId) ?? [];
              if (!msgs.includes(userText)) {
                msgs.push(userText);
                sessionMessages.set(convId, msgs);
              }

              console.log('%c[Synapse:Perplexity]', 'color:#22aaff;font-weight:bold',
                `◈ "${brain.name}" | turn ${isFirstTurn ? 1 : 'N'} | score: ${routeResult?.score?.toFixed(3) ?? 'locked'}`);

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
                payload: { brainName: brain.name, score: routeResult?.score ?? 0, platform: 'perplexity' },
              }, '*');
            }
          }
        }
      } catch (_) { /* not JSON or not a conversation payload */ }
    }

    const response = await _fetch(input, init);

    // Tee response for refusal detection
    if (injectedBrain && response.ok && response.body) {
      try {
        const [mainStream, monitorStream] = response.body.tee();
        monitorPerplexityRefusal(monitorStream, injectedBrain);
        return new Response(mainStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (_) {}
    }

    return response;
  };

  console.log('%c[Synapse:Perplexity] ◈ Ready', 'color:#22aaff;font-weight:bold;font-size:13px');
})();
