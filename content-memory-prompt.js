// Shared memory prompt utility — loaded before all isolated world scripts.
// Provides showMemoryPrompt(brainName, rawMessages).
// All content scripts for the same extension/tab share one JS environment,
// so this function is available to content-isolated.js, content-claude-isolated.js,
// and content-gemini.js without any imports.

'use strict';

// ── Heuristic filter ──────────────────────────────────────────────────────────
// Keep short declarative facts; drop questions, commands, and noise.

const _SMP_NOISE = [
  'can you', 'could you', 'please ', 'write ', 'fix ', 'explain ',
  'show me', 'help me', 'help with', 'what ', 'how ', 'why ', 'when ',
  'where ', 'is ', 'are ', 'do ', 'does ', 'did ', 'will ', 'would ',
  'should ', 'make ', 'create ', 'generate', 'give me', 'tell me',
  'i need', 'i want', 'can we', 'let\'s ', 'lets ',
];

function _smpExtractFacts(messages) {
  return [...new Set(messages)]
    .filter((msg) => {
      const t = msg.trim();
      if (t.length < 20) return false;
      if (t.endsWith('?')) return false;
      const lower = t.toLowerCase();
      return !_SMP_NOISE.some((p) => lower.startsWith(p));
    })
    .map((msg) => (msg.length > 120 ? msg.slice(0, 117) + '\u2026' : msg));
}

// ── Overlay styles ────────────────────────────────────────────────────────────

const _SMP_CSS = `
#__smp__{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:'JetBrains Mono','Fira Code',monospace}
.smp-card{background:#0e0e14;border:1px solid #2a2a3a;border-radius:8px;padding:14px 16px;width:290px;box-shadow:0 4px 24px rgba(0,0,0,.6);color:#e0e0e8}
.smp-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.smp-logo{color:#00ff88;font-size:14px;line-height:1}
.smp-title{flex:1;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#a0a0b8}
.smp-brain{color:#00ff88;font-style:normal}
.smp-x{background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:2px 4px;line-height:1;font-family:inherit}
.smp-x:hover{color:#e0e0e8}
.smp-list{list-style:none;margin:0 0 12px;padding:0;max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.smp-item{display:flex;align-items:flex-start;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer}
.smp-item:hover{background:#1a1a2a}
.smp-item input{margin-top:2px;accent-color:#00ff88;cursor:pointer;flex-shrink:0}
.smp-text{font-size:10px;line-height:1.4;color:#c0c0d0;word-break:break-word;cursor:pointer}
.smp-ft{display:flex;justify-content:flex-end;gap:8px}
.smp-btn{padding:5px 12px;font-family:inherit;font-size:9px;font-weight:700;letter-spacing:.08em;border-radius:4px;cursor:pointer;border:1px solid transparent;transition:all .15s}
.smp-skip{background:transparent;border-color:#2a2a3a;color:#555}
.smp-skip:hover{border-color:#444;color:#a0a0b8}
.smp-save{background:#003322;border-color:#00ff88;color:#00ff88}
.smp-save:hover{background:#004433}
`;

// ── Overlay renderer ──────────────────────────────────────────────────────────

function showMemoryPrompt(brainName, rawMessages) {
  if (document.getElementById('__smp__')) return; // already visible

  const facts = _smpExtractFacts(rawMessages);
  if (!facts.length) return;

  // Inject styles once per page
  if (!document.getElementById('__smp_styles__')) {
    const style = document.createElement('style');
    style.id = '__smp_styles__';
    style.textContent = _SMP_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // H2: full escaping including quotes to prevent attribute injection
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const el = document.createElement('div');
  el.id = '__smp__';
  el.innerHTML = `
    <div class="smp-card">
      <div class="smp-hd">
        <span class="smp-logo">◈</span>
        <span class="smp-title">Save to <em class="smp-brain">${esc(brainName)}</em>?</span>
        <button class="smp-x" title="Skip">✕</button>
      </div>
      <ul class="smp-list">
        ${facts.map((f, i) => `
          <li class="smp-item">
            <input type="checkbox" id="__smp_f${i}__" checked />
            <label for="__smp_f${i}__" class="smp-text">${esc(f)}</label>
          </li>`).join('')}
      </ul>
      <div class="smp-ft">
        <button class="smp-btn smp-skip">Skip</button>
        <button class="smp-btn smp-save">Save to Memory</button>
      </div>
    </div>
  `;

  (document.body || document.documentElement).appendChild(el);

  const dismiss = () => el.remove();

  el.querySelector('.smp-x').addEventListener('click', dismiss);
  el.querySelector('.smp-skip').addEventListener('click', dismiss);

  el.querySelector('.smp-save').addEventListener('click', () => {
    const selected = facts.filter((_, i) => el.querySelector(`#__smp_f${i}__`)?.checked);
    if (selected.length) {
      try {
        chrome.storage.local.get(['synapse_brain_memory'], (r) => {
          const memory = r.synapse_brain_memory ?? {};
          const existing = memory[brainName]?.facts ?? [];
          const merged = [...existing, ...selected.filter((f) => !existing.includes(f))];
          memory[brainName] = { facts: merged, updatedAt: Date.now() };
          chrome.storage.local.set({ synapse_brain_memory: memory });
        });
      } catch (_) {}
    }
    dismiss();
  });

  // Auto-dismiss after 30s; pause timer on hover, restart (10s) on leave
  let timer = setTimeout(dismiss, 30000);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 10000); });
}
