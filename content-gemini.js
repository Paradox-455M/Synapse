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
  };

  // In isolated world, read chrome.storage directly
  function loadState(cb) {
    chrome.storage.local.get(
      ['brains', 'customBrains', 'activeBrain', 'enabled', 'mode', 'synapse_brain_memory'],
      (raw) => {
        synapseState = {
          enabled:      raw.enabled                  ?? true,
          activeBrain:  raw.activeBrain              ?? null,
          brains:       raw.brains                   ?? [],
          customBrains: raw.customBrains             ?? [],
          mode:         raw.mode                     ?? 'auto',
          brainMemory:  raw.synapse_brain_memory      ?? {},
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

  function selectBrain(userText) {
    if (!synapseState.enabled) return null;
    const brains = allBrains();
    if (!brains.length) return null;

    if (synapseState.mode === 'manual') {
      if (!synapseState.activeBrain) return null;
      return brains.find((b) => b.name === synapseState.activeBrain) ?? null;
    }

    const lower = userText.toLowerCase();
    let bestBrain = null, bestScore = 0;

    for (const brain of brains) {
      if (!Array.isArray(brain.tags)) continue;
      const score = brain.tags.filter((tag) => lower.includes(tag.toLowerCase())).length;
      if (score > bestScore) { bestScore = score; bestBrain = brain; }
    }

    if (bestBrain) return bestBrain;

    if (synapseState.activeBrain) {
      return brains.find((b) => b.name === synapseState.activeBrain) ?? null;
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

    const brain = selectBrain(userText);
    if (!brain) return;

    // Accumulate for memory prompt on nav-away
    const convKey = getConvKey();
    const msgs = sessionMessages.get(convKey) ?? [];
    if (!msgs.includes(userText)) {
      msgs.push(userText);
      sessionMessages.set(convKey, msgs);
    }
    _lastActiveBrain = brain;
    const turn = nextTurn(convKey);

    const fw = Array.isArray(brain.framework) ? brain.framework : [];
    let prefix;
    let injectedMem = null;
    if (turn === 1) {
      injectedMem = synapseState.brainMemory?.[brain.name] ?? null;
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
    el.style.visibility = 'hidden';
    setTextValue(el, fullPrompt);
    requestAnimationFrame(() => {
      setTextValue(el, userText);
      el.style.visibility = '';
    });

    // Strip the prefix from the rendered chat bubble
    scrubRenderedMessage(prefix);

    console.groupCollapsed('%c[Synapse:Gemini] Outgoing prompt', 'color:#00ff88;font-weight:bold');
    console.log('%cInjected prefix:', 'color:#00ff88', prefix);
    if (injectedMem?.facts?.length) {
      console.log('%cMemory (%d fact%s):', 'color:#ffaa00;font-weight:bold', injectedMem.facts.length, injectedMem.facts.length === 1 ? '' : 's', injectedMem.facts);
    } else if (turn === 1) {
      console.log('%cMemory:', 'color:#555', '(none)');
    }
    console.log('%cUser message:', 'color:#aaaaff', userText);
    console.log('%cFull prompt sent:', 'color:#ffffff', fullPrompt);
    console.groupEnd();

    // Track activation
    chrome.storage.local.set({ lastActivation: {
      brainName: brain.name,
      score: 0,
      matchedTags: [],
      isManual: synapseState.mode === 'manual',
      timestamp: Date.now(),
    }});
    chrome.runtime.sendMessage({
      type: 'TRACK_ACTIVATION',
      brainName: brain.name,
      score: 0,
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
    _lastPath = location.pathname;

    // Show memory prompt if a brain was active in the previous conversation
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
