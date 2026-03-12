const BRAIN_FILES = [
  'brains/coding-architect.json',
  'brains/agent-builder.json',
];

// ── Built-in brain loader ─────────────────────────────────────────────────
async function loadBrains() {
  const brains = [];
  for (const file of BRAIN_FILES) {
    try {
      const res = await fetch(chrome.runtime.getURL(file));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      brains.push(await res.json());
    } catch (err) {
      console.error(`[Synapse] Failed to load brain: ${file}`, err);
    }
  }
  return brains;
}

// ── Sync storage helpers (chunked, respects 8KB item limit) ───────────────
const CHUNK_SIZE = 7000; // bytes — leaves headroom under 8KB sync item limit

async function saveCustomBrainsToSync(brains) {
  const items = {};
  const index = [];

  for (let i = 0; i < brains.length; i++) {
    const brain = brains[i];
    const { system_prompt = '', ...meta } = brain;
    const serialized = JSON.stringify(brain);

    if (new Blob([serialized]).size <= CHUNK_SIZE) {
      items[`syn_cb_${i}`] = brain;
      index.push({ i, chunked: false });
    } else {
      // Split system_prompt into chunks
      const chunks = [];
      for (let offset = 0; offset < system_prompt.length; offset += CHUNK_SIZE) {
        chunks.push(system_prompt.slice(offset, offset + CHUNK_SIZE));
      }
      chunks.forEach((c, ci) => { items[`syn_cb_${i}_c${ci}`] = c; });
      items[`syn_cb_${i}`] = { ...meta, _chunkCount: chunks.length };
      index.push({ i, chunked: true, chunkCount: chunks.length });
    }
  }

  items['syn_cb_index'] = index;
  await chrome.storage.sync.set(items);
}

async function loadCustomBrainsFromSync() {
  const { syn_cb_index: index = [] } = await chrome.storage.sync.get('syn_cb_index');
  if (!index.length) return [];

  const brains = [];
  for (const { i, chunked, chunkCount } of index) {
    const base = (await chrome.storage.sync.get(`syn_cb_${i}`))[`syn_cb_${i}`];
    if (!base) continue;

    if (!chunked) {
      brains.push(base);
      continue;
    }

    const chunkKeys = Array.from({ length: chunkCount }, (_, ci) => `syn_cb_${i}_c${ci}`);
    const chunks = await chrome.storage.sync.get(chunkKeys);
    base.system_prompt = chunkKeys.map((k) => chunks[k] ?? '').join('');
    delete base._chunkCount;
    brains.push(base);
  }

  return brains;
}

// ── Migration guard: copy customBrains from local → sync (once) ───────────
async function maybeMigrateToSync() {
  try {
    const local = await chrome.storage.local.get(['customBrains', '_syncMigrated']);
    const { syn_cb_index } = await chrome.storage.sync.get('syn_cb_index');

    if (local.customBrains?.length && !syn_cb_index && !local._syncMigrated) {
      await saveCustomBrainsToSync(local.customBrains);
      await chrome.storage.local.set({ _syncMigrated: true });
      console.log('[Synapse] Migrated custom brains to sync storage');
    }
  } catch (err) {
    console.warn('[Synapse] Sync migration skipped:', err.message);
  }
}

// ── Storage initialisation ────────────────────────────────────────────────
async function initStorage() {
  const brains = await loadBrains();
  const existing = await chrome.storage.local.get([
    'activeBrain', 'enabled', 'mode',
    'customBrains', 'conversationLocks', 'lastActivation', 'refusalWarning',
    'synapse_analytics',
  ]);

  // Restore custom brains from sync if local is empty (cross-device restore)
  let customBrains = existing.customBrains ?? [];
  if (!customBrains.length) {
    try {
      const fromSync = await loadCustomBrainsFromSync();
      if (fromSync.length) {
        customBrains = fromSync;
        console.log(`[Synapse] Restored ${customBrains.length} custom brain(s) from sync`);
      }
    } catch (_) {}
  }

  await chrome.storage.local.set({
    brains,
    activeBrain:        existing.activeBrain        ?? (brains[0]?.name ?? null),
    enabled:            existing.enabled            ?? true,
    mode:               existing.mode               ?? 'auto',
    customBrains,
    conversationLocks:  existing.conversationLocks  ?? {},
    lastActivation:     existing.lastActivation     ?? null,
    refusalWarning:     existing.refusalWarning      ?? null,
    synapse_analytics:  existing.synapse_analytics   ?? { brains: {}, totalActivations: 0, lastReset: new Date().toISOString() },
  });

  // Mirror settings + customBrains to sync (for cross-device)
  try {
    const { activeBrain, enabled, mode } = existing;
    await chrome.storage.sync.set({
      activeBrain: activeBrain ?? (brains[0]?.name ?? null),
      enabled:     enabled     ?? true,
      mode:        mode        ?? 'auto',
    });
    if (customBrains.length) await saveCustomBrainsToSync(customBrains);
  } catch (_) {}

  await maybeMigrateToSync();

  console.log(`[Synapse] Initialized with ${brains.length} built-in brains`);
}

chrome.runtime.onInstalled.addListener(initStorage);
chrome.runtime.onStartup.addListener(initStorage);

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get([
      'brains', 'customBrains', 'activeBrain', 'enabled',
      'mode', 'lastActivation', 'conversationLocks', 'refusalWarning',
      'synapse_analytics',
    ], sendResponse);
    return true;
  }

  if (msg.type === 'SET_STATE') {
    chrome.storage.local.set(msg.payload, async () => {
      // Mirror settings-tier keys to sync storage
      const syncPayload = {};
      for (const key of ['activeBrain', 'enabled', 'mode']) {
        if (key in msg.payload) syncPayload[key] = msg.payload[key];
      }
      if (Object.keys(syncPayload).length) {
        chrome.storage.sync.set(syncPayload).catch(() => {});
      }
      // Mirror customBrains to sync if updated
      if ('customBrains' in msg.payload) {
        saveCustomBrainsToSync(msg.payload.customBrains).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Analytics: activation tracking ───────────────────────────────────────
  if (msg.type === 'TRACK_ACTIVATION') {
    const { brainName, score = 0, platform = 'chatgpt' } = msg;
    if (!brainName) return;

    chrome.storage.local.get(['synapse_analytics'], ({ synapse_analytics }) => {
      const analytics = synapse_analytics ?? { brains: {}, totalActivations: 0, lastReset: new Date().toISOString() };
      if (!analytics.brains) analytics.brains = {};
      if (!analytics.totalActivations) analytics.totalActivations = 0;

      if (!analytics.brains[brainName]) {
        analytics.brains[brainName] = {
          activations: 0,
          totalScore: 0,
          refusals: 0,
          platforms: { chatgpt: 0, claude: 0, gemini: 0 },
        };
      }

      const entry = analytics.brains[brainName];
      entry.activations = (entry.activations ?? 0) + 1;
      entry.totalScore  = (entry.totalScore  ?? 0) + score;
      if (!entry.platforms) entry.platforms = { chatgpt: 0, claude: 0, gemini: 0 };
      entry.platforms[platform] = (entry.platforms[platform] ?? 0) + 1;
      analytics.totalActivations = (analytics.totalActivations ?? 0) + 1;

      chrome.storage.local.set({ synapse_analytics: analytics });
    });
    return;
  }

  // ── Analytics: refusal tracking ───────────────────────────────────────────
  if (msg.type === 'TRACK_REFUSAL') {
    const { brainName } = msg;
    if (!brainName) return;

    chrome.storage.local.get(['synapse_analytics'], ({ synapse_analytics }) => {
      const analytics = synapse_analytics ?? { brains: {}, totalActivations: 0 };
      if (!analytics.brains?.[brainName]) return;
      analytics.brains[brainName].refusals = (analytics.brains[brainName].refusals ?? 0) + 1;
      chrome.storage.local.set({ synapse_analytics: analytics });
    });
    return;
  }

  // ── CSP fallback: script tag blocked, inject via chrome.scripting ─────────
  if (msg.type === 'CSP_FALLBACK_NEEDED') {
    const tabId = sender?.tab?.id;
    if (!tabId) return;
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-main.js'],
      world: 'MAIN',
    }).then(() => {
      console.log('[Synapse] CSP fallback activated for tab', tabId);
    }).catch((err) => {
      console.error('[Synapse] CSP fallback failed:', err.message);
    });
  }

  if (msg.type === 'CSP_FALLBACK_NEEDED_CLAUDE') {
    const tabId = sender?.tab?.id;
    if (!tabId) return;
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-claude-main.js'],
      world: 'MAIN',
    }).then(() => {
      console.log('[Synapse:Claude] CSP fallback activated for tab', tabId);
    }).catch((err) => {
      console.error('[Synapse:Claude] CSP fallback failed:', err.message);
    });
  }
});
