// Isolated world — chrome API access only.
// Bridges storage ↔ MAIN world, persists activation/lock/refusal events.

// ── Inject MAIN world script ───────────────────────────────────────────────
(function injectMainScript() {
  if (document.getElementById('__synapse_main__')) return;

  const script = document.createElement('script');
  script.id = '__synapse_main__';
  script.src = chrome.runtime.getURL('content-main.js');

  script.onerror = () => {
    try { chrome.runtime.sendMessage({ type: 'CSP_FALLBACK_NEEDED' }); } catch (_) {}
  };

  (document.head || document.documentElement).appendChild(script);
})();

// ── Push storage state to MAIN world ──────────────────────────────────────
function buildStatePayload(raw) {
  // Project conversationLocks to simple { [convId]: brainName } for MAIN world
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
  };
}

function loadAndPush() {
  try {
    chrome.storage.local.get(
      ['brains', 'customBrains', 'activeBrain', 'enabled', 'mode', 'conversationLocks'],
      (raw) => window.postMessage({ type: '__SYNAPSE_STATE__', payload: buildStatePayload(raw) }, '*')
    );
  } catch (_) { /* extension context invalidated — page still open after reload */ }
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

  // State refresh request (SPA navigation)
  if (type === '__SYNAPSE_REQUEST_STATE__') {
    loadAndPush();
    return;
  }

  // Brain activation → persist lastActivation for popup display
  if (type === '__SYNAPSE_ACTIVATION__') {
    try { chrome.storage.local.set({ lastActivation: payload }); } catch (_) {}
    return;
  }

  // Conversation lock → persist with 50-entry cap
  if (type === '__SYNAPSE_LOCK_CONV__') {
    const { convId, brainName } = payload ?? {};
    if (!convId || !brainName) return;
    try {
      chrome.storage.local.get(['conversationLocks'], ({ conversationLocks = {} }) => {
        const locks = { ...conversationLocks };
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

  // Refusal detected → persist warning + set action badge + track in analytics
  if (type === '__SYNAPSE_REFUSAL__') {
    try {
      chrome.storage.local.set({ refusalWarning: { ...payload, timestamp: Date.now() } });
      chrome.action.setBadgeText({ text: '⚠' });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4466' });
      chrome.runtime.sendMessage({ type: 'TRACK_REFUSAL', brainName: payload?.brainName });
    } catch (_) {}
    return;
  }

  // Analytics tracking → forward to background
  if (type === '__SYNAPSE_TRACK__') {
    try { chrome.runtime.sendMessage({ type: 'TRACK_ACTIVATION', ...payload }); } catch (_) {}
    return;
  }
});
