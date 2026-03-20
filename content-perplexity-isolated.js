// Isolated world — Perplexity.ai bridge.
// Mirrors content-claude-isolated.js pattern but targets content-perplexity-main.js.

// ── Inject MAIN world script ───────────────────────────────────────────────
(function injectMainScript() {
  if (document.getElementById('__synapse_perplexity_main__')) return;

  const script = document.createElement('script');
  script.id = '__synapse_perplexity_main__';
  script.src = chrome.runtime.getURL('content-perplexity-main.js');

  script.onerror = () => {
    console.log('[Synapse:Perplexity] Script tag blocked, requesting CSP fallback…');
    try { chrome.runtime.sendMessage({ type: 'CSP_FALLBACK_NEEDED_PERPLEXITY' }); } catch (_) {}
  };

  (document.head || document.documentElement).appendChild(script);
})();

// ── Push storage state to MAIN world ──────────────────────────────────────
function buildStatePayload(raw) {
  const rawLocks = raw.conversationLocks ?? {};
  const convLocks = {};
  for (const [k, v] of Object.entries(rawLocks)) {
    convLocks[k] = typeof v === 'string' ? v : (v?.brainName ?? v);
  }
  return {
    brains:            raw.brains            ?? [],
    customBrains:      raw.customBrains      ?? [],
    activeBrain:       raw.activeBrain       ?? null,
    enabled:           raw.enabled           ?? true,
    mode:              raw.mode              ?? 'auto',
    conversationLocks: convLocks,
    brainMemory:       raw.synapse_brain_memory ?? {},
  };
}

function loadAndPush() {
  try {
    chrome.storage.local.get(
      ['brains', 'customBrains', 'activeBrain', 'enabled', 'mode', 'conversationLocks', 'synapse_brain_memory'],
      (raw) => window.postMessage({ type: '__SYNAPSE_STATE__', payload: buildStatePayload(raw) }, '*')
    );
  } catch (_) {}
}

loadAndPush();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAndPush);
}
setTimeout(loadAndPush, 500);

try {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadAndPush();
  });
} catch (_) {}

// ── Message bridge ─────────────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { type, payload } = event.data ?? {};

  if (type === '__SYNAPSE_REQUEST_STATE__') {
    loadAndPush();
    return;
  }

  if (type === '__SYNAPSE_ACTIVATION__') {
    try { chrome.storage.local.set({ lastActivation: payload }); } catch (_) {}
    return;
  }

  if (type === '__SYNAPSE_LOCK_CONV__') {
    const { convId, brainName } = payload ?? {};
    if (!convId || !brainName) return;
    if (typeof brainName !== 'string' || brainName.length > 200) return;
    try {
      chrome.storage.local.get(['brains', 'customBrains', 'conversationLocks'], (r) => {
        const allBrains = [...(r.brains ?? []), ...(r.customBrains ?? [])];
        if (!allBrains.some((b) => b.name === brainName)) return;
        const locks = { ...(r.conversationLocks ?? {}) };
        const keys = Object.keys(locks);
        if (keys.length >= 50 && !(convId in locks)) {
          delete locks[keys[0]];
        }
        locks[convId] = brainName;
        chrome.storage.local.set({ conversationLocks: locks });
      });
    } catch (_) {}
    return;
  }

  if (type === '__SYNAPSE_REFUSAL__') {
    try {
      chrome.storage.local.set({
        refusalWarning: {
          brainName: String(payload?.brainName ?? '').slice(0, 200),
          streak: Number(payload?.streak ?? 0),
          timestamp: Date.now(),
        },
      });
      chrome.action.setBadgeText({ text: '⚠' });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4466' });
      chrome.runtime.sendMessage({ type: 'TRACK_REFUSAL', brainName: payload?.brainName });
    } catch (_) {}
    return;
  }

  if (type === '__SYNAPSE_TRACK__') {
    try { chrome.runtime.sendMessage({ type: 'TRACK_ACTIVATION', ...payload }); } catch (_) {}
    return;
  }

  if (type === '__SYNAPSE_NAV_AWAY__') {
    const { brainName, messages } = payload ?? {};
    if (brainName && messages?.length) showMemoryPrompt(brainName, messages);
    return;
  }
});
