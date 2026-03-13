'use strict';

const MAX_CUSTOM_BRAINS = 10;
const MAX_SYSTEM_PROMPT_CHARS = 8000; // L2: cap to prevent over-token API requests

// ── DOM refs — global ──────────────────────────────────────────────────────
const masterToggle          = document.getElementById('masterToggle');
const modeAuto              = document.getElementById('modeAuto');
const modeManual            = document.getElementById('modeManual');
const statusDot             = document.getElementById('statusDot');
const statusText            = document.getElementById('statusText');
const footerHint            = document.getElementById('footerHint');

// ── DOM refs — BRAINS tab ──────────────────────────────────────────────────
const brainList             = document.getElementById('brainList');
const customCount           = document.getElementById('customCount');
const lastActivationSection = document.getElementById('lastActivationSection');
const activationBrain       = document.getElementById('activationBrain');
const activationScore       = document.getElementById('activationScore');
const activationDetail      = document.getElementById('activationDetail');
const convSection           = document.getElementById('convSection');
const convIdText            = document.getElementById('convIdText');
const convBrainText         = document.getElementById('convBrainText');
const convUnlock            = document.getElementById('convUnlock');
const importBtn             = document.getElementById('importBtn');
const exportBtn             = document.getElementById('exportBtn');
const brainFileInput        = document.getElementById('brainFileInput');
const importError           = document.getElementById('importError');
const refusalBanner         = document.getElementById('refusalBanner');
const refusalText           = document.getElementById('refusalText');
const refusalDismiss        = document.getElementById('refusalDismiss');

// ── DOM refs — STUDIO tab ──────────────────────────────────────────────────
const studioTitle           = document.getElementById('studioTitle');
const studioClear           = document.getElementById('studioClear');
const studioName            = document.getElementById('studioName');
const studioTags            = document.getElementById('studioTags');
const studioTagChips        = document.getElementById('studioTagChips');
const studioTokenBadge      = document.getElementById('studioTokenBadge');
const studioSystemPrompt    = document.getElementById('studioSystemPrompt');
const studioSyncWarning     = document.getElementById('studioSyncWarning');
const studioFramework       = document.getElementById('studioFramework');
const studioAddStep         = document.getElementById('studioAddStep');
const studioError           = document.getElementById('studioError');
const studioSave            = document.getElementById('studioSave');
const studioTest            = document.getElementById('studioTest');
const studioToast           = document.getElementById('studioToast');

// ── DOM refs — MEMORY section ──────────────────────────────────────────────
const memorySection             = document.getElementById('memorySection');
const memoryBrainName           = document.getElementById('memoryBrainName');
const memoryTextarea            = document.getElementById('memoryTextarea');
const memorySave                = document.getElementById('memorySave');
const memoryToast               = document.getElementById('memoryToast');

// ── DOM refs — ANALYTICS tab ───────────────────────────────────────────────
const analyticsTotal        = document.getElementById('analyticsTotal');
const analyticsChart        = document.getElementById('analyticsChart');
const analyticsReset        = document.getElementById('analyticsReset');
const analyticsResetConfirm = document.getElementById('analyticsResetConfirm');
const analyticsResetYes     = document.getElementById('analyticsResetYes');

// ── Module state ───────────────────────────────────────────────────────────
let currentState = {};
let currentConvId = null;
let _editingBrainName = null; // null = new brain, string = editing existing

// ── Helpers ───────────────────────────────────────────────────────────────
function escHtml(str) {
  // H1: escape quotes to prevent attribute injection XSS
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10)   return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Tab switching ──────────────────────────────────────────────────────────
const tabBtns   = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

function switchTab(tabName) {
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabName));
  tabPanels.forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-${tabName}`));
  if (tabName === 'analytics') renderAnalytics(currentState.synapse_analytics);
}

tabBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ── Brain schema validation ────────────────────────────────────────────────
function validateBrain(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Root must be a JSON object'];
  }
  if (!obj.name || typeof obj.name !== 'string' || obj.name.trim().length < 3) {
    errors.push('name: at least 3 characters required');
  }
  if (!Array.isArray(obj.tags) || obj.tags.length === 0) {
    errors.push('tags: at least 1 tag required');
  } else if (obj.tags.some((t) => typeof t !== 'string')) {
    errors.push('tags: all items must be strings');
  }
  if (!obj.system_prompt || typeof obj.system_prompt !== 'string' ||
      obj.system_prompt.trim().length < 50) {
    errors.push('system_prompt: at least 50 characters required');
  } else if (obj.system_prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    errors.push(`system_prompt: exceeds ${MAX_SYSTEM_PROMPT_CHARS} character limit`);
  }
  if (!Array.isArray(obj.framework) || obj.framework.length < 2) {
    errors.push('framework: at least 2 steps required');
  } else if (obj.framework.some((f) => typeof f !== 'string')) {
    errors.push('framework: all items must be strings');
  }
  return errors;
}

// ── Render (BRAINS tab) ────────────────────────────────────────────────────
function render(state) {
  currentState = state;
  const {
    enabled, activeBrain, brains = [], customBrains = [],
    mode, lastActivation, refusalWarning, conversationLocks = {},
    brainMemory = {},
  } = state;

  masterToggle.checked = enabled;
  document.body.classList.toggle('disabled', !enabled);

  modeAuto.classList.toggle('active', mode === 'auto');
  modeManual.classList.toggle('active', mode === 'manual');

  // Status bar
  if (!enabled) {
    statusDot.className = 'status-dot off';
    statusText.textContent = 'Disabled — passing through untouched';
  } else {
    statusDot.className = 'status-dot active';
    statusText.textContent = mode === 'manual'
      ? `Manual lock · ${activeBrain ?? 'no brain pinned'}`
      : 'Auto-routing · keywords trigger brains';
  }

  footerHint.textContent = mode === 'manual'
    ? 'Manual override · pinned brain always fires'
    : 'Auto-router · keywords select brain · fallback to pinned';

  // Refusal banner
  if (refusalWarning?.brainName) {
    refusalBanner.style.display = '';
    refusalText.textContent =
      `"${refusalWarning.brainName}" may be ignored. Try Manual Override.`;
  } else {
    refusalBanner.style.display = 'none';
  }

  // Last activation card
  if (lastActivation?.brainName) {
    lastActivationSection.style.display = '';
    activationBrain.textContent = lastActivation.brainName;
    if (lastActivation.isManual) {
      activationScore.textContent = 'manual';
      activationScore.className = 'activation-score manual';
      activationDetail.textContent = `Manual override · ${timeAgo(lastActivation.timestamp)}`;
    } else {
      const score = lastActivation.score ?? 0;
      activationScore.textContent = score > 0 ? `score: ${score}` : 'fallback';
      activationScore.className = 'activation-score ' + (score > 0 ? 'scored' : 'fallback');
      const tags = (lastActivation.matchedTags ?? []).slice(0, 5).join(', ');
      activationDetail.textContent =
        (tags ? `matched: ${tags}` : 'no keyword match') + ` · ${timeAgo(lastActivation.timestamp)}`;
    }
  } else {
    lastActivationSection.style.display = 'none';
  }

  // Active conversation lock section
  if (currentConvId) {
    const lockedBrain = conversationLocks[currentConvId];
    convSection.style.display = '';
    convIdText.textContent = currentConvId.slice(0, 8) + '…';
    convBrainText.textContent = lockedBrain ?? 'no lock';
    convBrainText.className = 'conv-brain' + (lockedBrain ? ' locked' : ' unlocked');
    convUnlock.style.display = lockedBrain ? '' : 'none';
  } else {
    convSection.style.display = 'none';
  }

  // Memory section — show facts for active brain
  if (activeBrain) {
    memorySection.style.display = '';
    memoryBrainName.textContent = `· ${activeBrain}`;
    const facts = brainMemory[activeBrain]?.facts ?? [];
    memoryTextarea.value = facts.join('\n');
  } else {
    memorySection.style.display = 'none';
  }

  // Merged brain list
  const allBrains = [
    ...brains.map((b) => ({ ...b, _builtin: true })),
    ...customBrains.map((b) => ({ ...b, _custom: true })),
  ];

  brainList.innerHTML = '';

  if (!allBrains.length) {
    const li = document.createElement('li');
    li.className = 'brain-item';
    li.style.cursor = 'default';
    li.innerHTML = '<span style="color:var(--text-dim);font-size:11px">No brains loaded</span>';
    brainList.appendChild(li);
  } else {
    for (const b of allBrains) {
      brainList.appendChild(buildBrainItem(b, activeBrain, mode));
    }
  }

  customCount.textContent = customBrains.length > 0
    ? `${customBrains.length}/${MAX_CUSTOM_BRAINS} custom`
    : '';

  exportBtn.disabled = !activeBrain;
  exportBtn.title = activeBrain ? `Export "${activeBrain}" as .json` : 'No active brain to export';

  // Refresh analytics panel if it's visible
  const analyticsPanel = document.getElementById('tab-analytics');
  if (analyticsPanel && !analyticsPanel.classList.contains('hidden')) {
    renderAnalytics(state.synapse_analytics);
  }
}

function buildBrainItem(b, activeBrain, mode) {
  const isPinned = b.name === activeBrain;
  const isLocked = isPinned && mode === 'manual';
  const li = document.createElement('li');
  li.className = `brain-item${isPinned ? ' selected' : ''}`;

  const tagPreview = (b.tags ?? []).slice(0, 5).join(' · ');
  const customBadge = b._custom ? '<span class="custom-badge">Custom</span>' : '';
  const lockIcon = isLocked ? ' <span class="lock-icon">⊕</span>' : '';

  const pencilBtn = b._custom
    ? `<button class="pencil-btn" data-name="${escHtml(b.name)}" title="Edit brain">✎</button>`
    : `<button class="pencil-btn disabled" disabled title="Built-in brain — export to customize">✎</button>`;

  li.innerHTML = `
    <span class="brain-item-indicator"></span>
    <span class="brain-item-info">
      <span class="brain-item-name">${escHtml(b.name)}${lockIcon} ${customBadge}</span>
      <span class="brain-item-tags">${escHtml(tagPreview)}</span>
    </span>
    ${pencilBtn}
    ${b._custom
      ? `<button class="delete-btn" data-name="${escHtml(b.name)}" title="Delete brain">✕</button>`
      : ''}
    <button class="override-btn ${isLocked ? 'active' : ''}" data-name="${escHtml(b.name)}">
      ${isLocked ? 'LOCKED' : 'LOCK'}
    </button>
  `;

  li.addEventListener('click', (e) => {
    if (e.target.closest('.override-btn, .delete-btn, .pencil-btn')) return;
    selectBrainAction(b.name);
  });

  li.querySelector('.override-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLocked) {
      setMode('auto');
    } else {
      chrome.runtime.sendMessage(
        { type: 'SET_STATE', payload: { activeBrain: b.name, mode: 'manual' } },
        loadState
      );
    }
  });

  if (b._custom) {
    li.querySelector('.pencil-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditBrain(b);
    });
    li.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCustomBrain(b.name);
    });
  }

  return li;
}

// ── Actions (BRAINS tab) ───────────────────────────────────────────────────
function selectBrainAction(name) {
  chrome.runtime.sendMessage({ type: 'SET_STATE', payload: { activeBrain: name } }, loadState);
}

function setMode(mode) {
  chrome.runtime.sendMessage({ type: 'SET_STATE', payload: { mode } }, loadState);
}

function deleteCustomBrain(name) {
  const updated = (currentState.customBrains ?? []).filter((b) => b.name !== name);
  chrome.runtime.sendMessage({ type: 'SET_STATE', payload: { customBrains: updated } }, loadState);
}

// ── Import ────────────────────────────────────────────────────────────────
function showImportError(msg) {
  importError.textContent = msg;
  importError.style.display = '';
  setTimeout(() => { importError.style.display = 'none'; }, 4000);
}

importBtn.addEventListener('click', () => {
  importError.style.display = 'none';
  brainFileInput.value = '';
  brainFileInput.click();
});

brainFileInput.addEventListener('change', () => {
  const file = brainFileInput.files?.[0];
  if (!file) return;

  const current = currentState.customBrains ?? [];
  if (current.length >= MAX_CUSTOM_BRAINS) {
    showImportError(`Custom brain limit reached (${MAX_CUSTOM_BRAINS}/${MAX_CUSTOM_BRAINS}). Delete one first.`);
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    let obj;
    try {
      obj = JSON.parse(e.target.result);
    } catch {
      showImportError('Invalid file: not valid JSON.');
      return;
    }

    const errors = validateBrain(obj);
    if (errors.length) {
      showImportError('Validation failed: ' + errors.join(' · '));
      return;
    }

    const allNames = [
      ...(currentState.brains ?? []),
      ...(currentState.customBrains ?? []),
    ].map((b) => b.name.toLowerCase());

    if (allNames.includes(obj.name.toLowerCase())) {
      showImportError(`A brain named "${obj.name}" already exists.`);
      return;
    }

    const updated = [...current, obj];
    chrome.runtime.sendMessage(
      { type: 'SET_STATE', payload: { customBrains: updated } },
      loadState
    );
  };
  reader.readAsText(file);
});

// ── Export ────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const name = currentState.activeBrain;
  if (!name) return;

  const all = [...(currentState.brains ?? []), ...(currentState.customBrains ?? [])];
  const brain = all.find((b) => b.name === name);
  if (!brain) return;

  const { _builtin, _custom, ...clean } = brain;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/\s+/g, '-').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Conversation unlock ───────────────────────────────────────────────────
convUnlock.addEventListener('click', () => {
  if (!currentConvId) return;
  chrome.storage.local.get(['conversationLocks'], ({ conversationLocks = {} }) => {
    const updated = { ...conversationLocks };
    delete updated[currentConvId];
    chrome.runtime.sendMessage(
      { type: 'SET_STATE', payload: { conversationLocks: updated } },
      loadState
    );
  });
});

// ── Brain memory save ─────────────────────────────────────────────────────
memorySave.addEventListener('click', () => {
  const brainName = currentState.activeBrain;
  if (!brainName) return;
  const facts = memoryTextarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
  chrome.runtime.sendMessage({ type: 'SAVE_BRAIN_MEMORY', brainName, facts }, () => {
    memoryToast.style.display = '';
    setTimeout(() => { memoryToast.style.display = 'none'; }, 2500);
  });
});

// ── Mode buttons ──────────────────────────────────────────────────────────
modeAuto.addEventListener('click', () => setMode('auto'));
modeManual.addEventListener('click', () => {
  const brain = currentState.activeBrain ?? currentState.brains?.[0]?.name ?? null;
  chrome.runtime.sendMessage(
    { type: 'SET_STATE', payload: { mode: 'manual', activeBrain: brain } },
    loadState
  );
});

masterToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage(
    { type: 'SET_STATE', payload: { enabled: masterToggle.checked } },
    loadState
  );
});

refusalDismiss.addEventListener('click', () => {
  chrome.storage.local.remove('refusalWarning', loadState);
});

// ── Brain Studio ───────────────────────────────────────────────────────────

function openEditBrain(brain) {
  _editingBrainName = brain.name;
  studioTitle.textContent = 'EDIT BRAIN';

  studioName.value = brain.name;
  studioTags.value = (brain.tags ?? []).join(', ');
  studioSystemPrompt.value = brain.system_prompt ?? '';
  renderTagChips();
  updateTokenEstimate();

  // Populate framework steps
  studioFramework.innerHTML = '';
  (brain.framework ?? []).forEach((step) => addFrameworkStep(step));
  if (!brain.framework?.length) {
    addFrameworkStep('');
    addFrameworkStep('');
  }

  switchTab('studio');
}

function clearStudioForm() {
  _editingBrainName = null;
  studioTitle.textContent = 'NEW BRAIN';
  studioName.value = '';
  studioTags.value = '';
  studioSystemPrompt.value = '';
  studioTagChips.innerHTML = '';
  studioFramework.innerHTML = '';
  studioError.style.display = 'none';
  updateTokenEstimate();
  addFrameworkStep('');
  addFrameworkStep('');
}

studioClear.addEventListener('click', clearStudioForm);

// Initialize with 2 blank framework steps
addFrameworkStep('');
addFrameworkStep('');

function addFrameworkStep(value = '') {
  const row = document.createElement('div');
  row.className = 'framework-row';
  row.innerHTML = `
    <input class="framework-input" type="text" value="${escHtml(value)}" placeholder="Step description…" />
    <button class="framework-remove" title="Remove step">✕</button>
  `;
  row.querySelector('.framework-remove').addEventListener('click', () => {
    const rows = studioFramework.querySelectorAll('.framework-row');
    if (rows.length > 1) row.remove();
  });
  studioFramework.appendChild(row);
}

studioAddStep.addEventListener('click', () => addFrameworkStep(''));

function renderTagChips() {
  const tags = studioTags.value.split(',').map((t) => t.trim()).filter(Boolean);
  studioTagChips.innerHTML = tags
    .map((t) => `<span class="tag-chip">${escHtml(t)}</span>`)
    .join('');
}

studioTags.addEventListener('input', renderTagChips);

function updateTokenEstimate() {
  const text = studioSystemPrompt.value;
  const tokens = Math.ceil(text.length / 4);
  studioTokenBadge.textContent = `~${tokens} tokens`;
  studioTokenBadge.className = 'token-badge ' + (
    tokens < 200 ? 'green' : tokens <= 500 ? 'yellow' : 'red'
  );
  studioSyncWarning.style.display = text.length > 6000 ? '' : 'none';
}

studioSystemPrompt.addEventListener('input', updateTokenEstimate);

function getFrameworkSteps() {
  return Array.from(studioFramework.querySelectorAll('.framework-input'))
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function showStudioError(msg) {
  studioError.textContent = msg;
  studioError.style.display = '';
  setTimeout(() => { studioError.style.display = 'none'; }, 5000);
}

function showStudioToast(msg) {
  studioToast.textContent = msg;
  studioToast.style.display = '';
  setTimeout(() => { studioToast.style.display = 'none'; }, 2500);
}

studioSave.addEventListener('click', () => {
  const name = studioName.value.trim();
  const tags = studioTags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const system_prompt = studioSystemPrompt.value.trim();
  const framework = getFrameworkSteps();

  const brain = { name, tags, system_prompt, framework };
  const errors = validateBrain(brain);
  if (errors.length) {
    showStudioError(errors.join(' · '));
    return;
  }

  const current = currentState.customBrains ?? [];
  const allNames = [
    ...(currentState.brains ?? []),
    ...current,
  ].map((b) => b.name.toLowerCase());

  if (_editingBrainName) {
    // Replace the brain being edited
    const updated = current.map((b) =>
      b.name === _editingBrainName ? brain : b
    );
    chrome.runtime.sendMessage(
      { type: 'SET_STATE', payload: { customBrains: updated } },
      () => {
        loadState();
        clearStudioForm();
        switchTab('brains');
      }
    );
  } else {
    // New brain — check duplicate name
    if (allNames.includes(name.toLowerCase())) {
      showStudioError(`A brain named "${name}" already exists.`);
      return;
    }
    if (current.length >= MAX_CUSTOM_BRAINS) {
      showStudioError(`Brain limit reached (${MAX_CUSTOM_BRAINS}). Delete one first.`);
      return;
    }
    const updated = [...current, brain];
    chrome.runtime.sendMessage(
      { type: 'SET_STATE', payload: { customBrains: updated } },
      () => {
        loadState();
        clearStudioForm();
        switchTab('brains');
      }
    );
  }
});

studioTest.addEventListener('click', () => {
  const text = studioSystemPrompt.value.trim();
  if (!text) {
    showStudioToast('System prompt is empty.');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showStudioToast('System prompt copied to clipboard.');
  }).catch(() => {
    showStudioToast('Clipboard access denied.');
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────
function renderAnalytics(analytics) {
  if (!analytics || !analytics.totalActivations) {
    analyticsTotal.textContent = '';
    analyticsChart.innerHTML =
      '<span style="color:var(--text-dim);font-size:11px">No activations yet</span>';
    return;
  }

  analyticsTotal.textContent = `Total: ${analytics.totalActivations}`;

  const brainEntries = Object.entries(analytics.brains ?? {})
    .sort((a, b) => b[1].activations - a[1].activations);

  if (!brainEntries.length) {
    analyticsChart.innerHTML =
      '<span style="color:var(--text-dim);font-size:11px">No activations yet</span>';
    return;
  }

  const maxActivations = Math.max(1, ...brainEntries.map(([, d]) => d.activations));

  analyticsChart.innerHTML = '';
  for (const [name, data] of brainEntries) {
    const pct = (data.activations / maxActivations) * 100;
    const platforms = data.platforms ?? {};
    const platformStr = Object.entries(platforms)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}:${n}`)
      .join(' ');

    const row = document.createElement('div');
    row.className = 'analytics-row';
    row.innerHTML = `
      <div class="analytics-name" title="${escHtml(name)}">${escHtml(name)}</div>
      <div class="analytics-bar-wrap">
        <div class="analytics-bar" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="analytics-meta">
        <span class="analytics-count">${data.activations}</span>
        ${data.refusals > 0
          ? `<span class="analytics-refusals">${data.refusals} refusal${data.refusals > 1 ? 's' : ''}</span>`
          : ''}
        ${platformStr ? `<span class="analytics-platforms">${escHtml(platformStr)}</span>` : ''}
      </div>
    `;
    analyticsChart.appendChild(row);
  }
}

analyticsReset.addEventListener('click', () => {
  analyticsResetConfirm.style.display = '';
  analyticsReset.style.display = 'none';
});

analyticsResetYes.addEventListener('click', () => {
  const fresh = { brains: {}, totalActivations: 0, lastReset: new Date().toISOString() };
  chrome.runtime.sendMessage(
    { type: 'SET_STATE', payload: { synapse_analytics: fresh } },
    () => {
      analyticsResetConfirm.style.display = 'none';
      analyticsReset.style.display = '';
      loadState();
    }
  );
});

// ── Load ──────────────────────────────────────────────────────────────────
function loadState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) {
      statusText.textContent = 'Error: extension not ready';
      return;
    }
    render(response ?? { enabled: false, activeBrain: null, brains: [], customBrains: [], mode: 'auto' });
  });
}

// Clear refusal badge when popup opens
chrome.action.setBadgeText({ text: '' });

// Get current tab conversation ID (supports chatgpt.com)
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs?.[0]?.url ?? '';
  const match = url.match(/chatgpt\.com\/c\/([^/?#]+)/);
  currentConvId = match ? match[1] : null;
  loadState();
});

chrome.storage.onChanged.addListener(() => loadState());
