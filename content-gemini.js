// Isolated world — Gemini DOM injection.
// run_at: document_idle
// Gemini uses protobuf (not JSON fetch), so we inject via DOM interception.

(function () {
  'use strict';

  if (window.__synapseGeminiInstalled) return;
  window.__synapseGeminiInstalled = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let synapseState = {
    enabled: true,
    activeBrain: null,
    brains: [],
    customBrains: [],
    mode: 'auto',
    brainMemory: {},
    conversationLocks: {},
  };

  // In isolated world, read chrome.storage directly
  function loadState(cb) {
    chrome.storage.local.get(
      ['brains', 'customBrains', 'activeBrain', 'enabled', 'mode', 'synapse_brain_memory', 'conversationLocks'],
      (raw) => {
        synapseState = {
          enabled:           raw.enabled               ?? true,
          activeBrain:       raw.activeBrain            ?? null,
          brains:            raw.brains                 ?? [],
          customBrains:      raw.customBrains           ?? [],
          mode:              raw.mode                   ?? 'auto',
          brainMemory:       raw.synapse_brain_memory   ?? {},
          conversationLocks: raw.conversationLocks      ?? {},
        };
        if (cb) cb();
      }
    );
  }

  loadState();

  // Keep state fresh when storage changes
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadState();
  });

  // pathname → string[] — user messages sent this session, for memory prompts
  const sessionMessages = new Map();
  let _lastActiveBrain = null;

  // Deduplication: prevent double-fire when Gemini SPA-navigates to a new conv URL
  // after the first send (the rAF restore's input events can re-queue the message).
  let _lastInjectText = '', _lastInjectAt = 0;

  // ── Turn tracking via sessionStorage — survives SPA navigation, resets on reload ──
  function getConvKey() {
    return location.pathname;
  }

  function getTurn(convKey) {
    return parseInt(sessionStorage.getItem(`syn_turn_${convKey}`) || '0');
  }

  function nextTurn(convKey) {
    const n = getTurn(convKey) + 1;
    sessionStorage.setItem(`syn_turn_${convKey}`, String(n));
    return n;
  }

  // ── Brain router ───────────────────────────────────────────────────────────
  function allBrains() {
    return [...(synapseState.brains ?? []), ...(synapseState.customBrains ?? [])];
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

  function selectBrain(userText, sessionTags) {
    if (!synapseState.enabled) return null;
    const brains = allBrains();
    if (!brains.length) return null;

    if (synapseState.mode === 'manual') {
      if (!synapseState.activeBrain) return null;
      const brain = brains.find((b) => b.name === synapseState.activeBrain) ?? null;
      return brain ? { brain, score: 0, matchedTags: [], isManual: true } : null;
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

    if (synapseState.activeBrain) {
      const brain = brains.find((b) => b.name === synapseState.activeBrain) ?? null;
      return brain ? { brain, score: 0, matchedTags: [], isManual: false } : null;
    }

    return null;
  }

  // ── Read textarea value from Gemini's contenteditable ─────────────────────
  function getTextareaEl() {
    return (
      document.querySelector('[aria-label="Enter a prompt here"]') ||
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][data-placeholder]')
    );
  }

  function getTextValue(el) {
    return el?.innerText ?? el?.textContent ?? '';
  }

  function setTextValue(el, text) {
    // Gemini uses a contenteditable div backed by a framework (likely Angular/React)
    // Dispatch native events to trigger internal state update
    el.focus();
    el.innerText = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // ── Scrub prefix from the first rendered user message node ───────────────
  function scrubRenderedMessage(prefix) {
    const startTime = Date.now();
    const obs = new MutationObserver(() => {
      if (Date.now() - startTime > 3000) { obs.disconnect(); return; }
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

  // ── Inject brain context before send ──────────────────────────────────────
  function injectOnSend(el) {
    if (!synapseState.enabled) return;

    // Strip any stale Synapse prefix left over from a previous turn
    const rawText = getTextValue(el).trim();
    const userText = rawText.replace(/^\[Synapse[^\n]*\]\s[\s\S]*?---\n+/, '').trim();
    if (!userText) return;

    // Deduplicate: Gemini navigates /app → /app/CONV_ID after the first send.
    // The rAF restore dispatches input events that can re-queue and re-trigger this.
    const now = Date.now();
    if (userText === _lastInjectText && now - _lastInjectAt < 2000) return;
    _lastInjectText = userText;
    _lastInjectAt = now;

    const convKey = getConvKey();
    // Real Gemini conv path looks like /app/SomeConvId (not bare /app)
    const isRealConvPath = /\/app\/\w/.test(convKey);

    // Read session tags from prior turn for context blending
    let sessionTags = [];
    try {
      const stored = sessionStorage.getItem('synapse_tags_' + convKey);
      if (stored) sessionTags = JSON.parse(stored);
    } catch (_) {}

    // Check conversation lock: if this conv is already locked to a brain, use it
    const lockedBrainName = synapseState.conversationLocks?.[convKey] ?? null;
    let brain = null;
    let routeResult = null;

    if (lockedBrainName) {
      brain = allBrains().find((b) => b.name === lockedBrainName) ?? null;
    }

    if (!brain) {
      routeResult = selectBrain(userText, sessionTags);
      if (!routeResult) return;
      brain = routeResult.brain;

      // Lock this conversation to the routed brain (real conv paths only)
      if (isRealConvPath) {
        chrome.storage.local.get(['conversationLocks'], (data) => {
          const locks = data.conversationLocks ?? {};
          if (!locks[convKey]) {
            locks[convKey] = brain.name;
            chrome.storage.local.set({ conversationLocks: locks });
          }
        });
      }

      // Persist matched tags for next turn's session context
      if (routeResult.matchedTags?.length) {
        try {
          sessionStorage.setItem('synapse_tags_' + convKey, JSON.stringify(routeResult.matchedTags));
        } catch (_) {}
      }
    }

    // Accumulate for memory prompt on nav-away
    const msgs = sessionMessages.get(convKey) ?? [];
    if (!msgs.includes(userText)) {
      msgs.push(userText);
      sessionMessages.set(convKey, msgs);
    }
    _lastActiveBrain = brain;
    const turn = nextTurn(convKey);

    const fw = Array.isArray(brain.framework) ? brain.framework : [];
    let prefix;
    if (turn === 1) {
      const injectedMem = synapseState.brainMemory?.[brain.name] ?? null;
      const memBlock = injectedMem?.facts?.length
        ? `\n[Synapse Memory]\n${injectedMem.facts.map((f) => `- ${f}`).join('\n')}\n`
        : '';
      prefix = `[Synapse: ${brain.name}] ${brain.system_prompt}${memBlock}\n\n---\n`;
    } else {
      prefix = `[Synapse Reminder: ${fw.join(' → ')}]\n\n---\n`;
    }

    const fullPrompt = prefix + userText;

    // Inject invisibly: hide the element, swap value, let Gemini read it,
    // then restore original text before the next paint.
    // NOTE: restore uses el.innerText directly (no input events) to avoid
    // Gemini's framework re-queuing the message on the restore dispatch.
    el.style.visibility = 'hidden';
    setTextValue(el, fullPrompt);
    requestAnimationFrame(() => {
      el.innerText = userText; // cosmetic restore — no framework events
      el.style.visibility = '';
    });

    // Strip the prefix from the rendered chat bubble
    scrubRenderedMessage(prefix);

    console.log('%c[Synapse:Gemini]', 'color:#00ff88;font-weight:bold', `◈ "${brain.name}" | turn ${turn} | score: ${routeResult?.score?.toFixed(3) ?? 'locked'}`);

    // Track activation
    chrome.storage.local.set({ lastActivation: {
      brainName: brain.name,
      score: routeResult?.score ?? 0,
      matchedTags: routeResult?.matchedTags ?? [],
      isManual: routeResult?.isManual ?? !!lockedBrainName,
      timestamp: Date.now(),
    }});
    chrome.runtime.sendMessage({
      type: 'TRACK_ACTIVATION',
      brainName: brain.name,
      score: routeResult?.score ?? 0,
      platform: 'gemini',
    });
  }

  // ── Attach send listeners to the textarea element ─────────────────────────
  function attachListeners(el) {
    if (el.__synapseGeminiAttached) return;
    el.__synapseGeminiAttached = true;

    // Keydown: Enter without Shift
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        injectOnSend(el);
      }
    }, true); // capture phase — runs before framework handlers

  }

  // Also intercept send-button clicks
  function attachSendButton() {
    const btn = document.querySelector('button[aria-label="Send message"]') ||
                document.querySelector('button[data-mat-icon-name="send"]') ||
                document.querySelector('button.send-button');
    if (btn && !btn.__synapseGeminiAttached) {
      btn.__synapseGeminiAttached = true;
      btn.addEventListener('click', () => {
        const el = getTextareaEl();
        if (el) injectOnSend(el);
      }, true);
    }
  }

  // ── Find / watch for the input element ────────────────────────────────────
  function tryAttach() {
    const el = getTextareaEl();
    if (el) {
      attachListeners(el);
      attachSendButton();
    }
  }

  // Initial attempt
  tryAttach();

  // MutationObserver fallback for SPA rendering
  const observer = new MutationObserver(() => {
    tryAttach();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Re-run on SPA navigation + fire memory prompt on nav-away
  let _lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === _lastPath) return;
    const prevPath = _lastPath;
    const newPath = location.pathname;
    _lastPath = newPath;

    // Detect same-conversation transition: /app → /app/CONV_ID
    // Gemini assigns the real conv ID after the first message is sent.
    // Carry over turn count, session tags, and accumulated messages so
    // subsequent turns correctly get the short reminder, not the full prompt again.
    const isSameConvTransition = prevPath === '/app' && newPath.startsWith('/app/');

    if (isSameConvTransition) {
      // Copy turn count
      const stagedTurn = getTurn(prevPath);
      if (stagedTurn > 0 && getTurn(newPath) === 0) {
        sessionStorage.setItem(`syn_turn_${newPath}`, String(stagedTurn));
      }
      // Copy session tags
      try {
        const stagedTags = sessionStorage.getItem('synapse_tags_' + prevPath);
        if (stagedTags && !sessionStorage.getItem('synapse_tags_' + newPath)) {
          sessionStorage.setItem('synapse_tags_' + newPath, stagedTags);
        }
      } catch (_) {}
      // Copy accumulated messages
      const stagedMsgs = sessionMessages.get(prevPath);
      if (stagedMsgs?.length && !sessionMessages.has(newPath)) {
        sessionMessages.set(newPath, [...stagedMsgs]);
      }
      // Do NOT fire memory prompt — this is the same conversation, not a nav-away
      setTimeout(tryAttach, 500);
      return;
    }

    // Genuine nav-away: show memory prompt for the previous conversation
    const prevBrain = _lastActiveBrain;
    const prevMsgs = sessionMessages.get(prevPath) ?? [];
    if (prevBrain && prevMsgs.length) {
      showMemoryPrompt(prevBrain.name, prevMsgs);
    }
    _lastActiveBrain = null;

    setTimeout(tryAttach, 500);
  }, 500);

  console.log('%c[Synapse:Gemini] ◈ Ready', 'color:#00ff88;font-weight:bold;font-size:13px');
})();
