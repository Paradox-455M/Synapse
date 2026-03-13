/**
 * brain-router.js
 *
 * Pure routing logic: prompt → best-matching brain(s).
 * No chrome.* API calls, no DOM access, no fetch.
 * Safe to import in content scripts, popup, and Node test harnesses.
 *
 * Defensive by design: every public function accepts malformed, null, or
 * undefined inputs and returns a valid result rather than throwing.
 */

'use strict';

// ── General assistant fallback ────────────────────────────────────────────────
// Returned whenever no brain matches. Never surfaced in the marketplace UI.

/** @type {Brain} */
const GENERAL_ASSISTANT = Object.freeze({
  id: 'general_assistant',
  name: 'General Assistant',
  tags: [],
  priority: 0,
  system_prompt: 'You are a helpful, thoughtful assistant. Answer clearly and concisely.',
  framework: ['Understand the request', 'Respond directly', 'Offer follow-up if needed'],
});

// ── Stopword list ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'with', 'this', 'that',
  'have', 'from', 'they', 'will', 'what', 'how', 'why', 'can',
  'you', 'your', 'my', 'me', 'it', 'its', 'use', 'used', 'using',
]);

// ── Internal: safe string coercion ────────────────────────────────────────────

/** Returns s as a trimmed lowercase string, or '' if s is not a non-empty string. */
function _str(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** Returns n as a finite number, or fallback if n is NaN / Infinity / non-number. */
function _num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

// ── 1. tokenizePrompt ─────────────────────────────────────────────────────────

/**
 * Tokenize a raw prompt string into a deduplicated array of lowercase tokens.
 *
 * - Lowercases the input
 * - Splits on whitespace and common punctuation
 * - Removes tokens shorter than 3 characters
 * - Removes common English stopwords
 * - Deduplicates
 *
 * Never throws. Returns [] for any non-string input.
 *
 * @param {*} prompt - Raw user input (expected string)
 * @returns {string[]} Deduplicated lowercase tokens
 *
 * @example
 * tokenizePrompt("How do I design a scalable Go backend with Redis?")
 * // → ["how", "design", "scalable", "backend", "redis"]
 */
function tokenizePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return [];

  try {
    const raw = prompt
      .toLowerCase()
      .split(/[\s,.()\[\]{}"'`]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

    return [...new Set(raw)];
  } catch (_) {
    return [];
  }
}

// ── 2. buildIdfMap ────────────────────────────────────────────────────────────

/**
 * Build an IDF (Inverse Document Frequency) weight map from a list of brains.
 *
 * Formula: IDF(tag) = log((N + 1) / (df + 1))
 * +1 smoothing prevents division by zero and log(0).
 *
 * Tags common across many brains get low weight; rare tags get high weight.
 * Skips null/undefined entries and non-string tags silently.
 *
 * Never throws. Returns {} for any unusable input.
 *
 * @param {*} brains - Array of brain pack objects
 * @returns {Record<string, number>} Map of { tag: idfScore }
 */
function buildIdfMap(brains) {
  if (!Array.isArray(brains) || !brains.length) return {};

  const N = brains.length;
  const df = {}; // tag → count of brains containing it

  for (const brain of brains) {
    if (!brain || typeof brain !== 'object') continue;
    if (!Array.isArray(brain.tags)) continue;

    const seen = new Set();
    for (const tag of brain.tags) {
      const t = _str(tag);
      if (!t) continue; // skip null, undefined, empty, non-string tags
      if (!seen.has(t)) {
        df[t] = (df[t] ?? 0) + 1;
        seen.add(t);
      }
    }
  }

  const idf = {};
  for (const [tag, count] of Object.entries(df)) {
    const score = Math.log((N + 1) / (count + 1));
    // Clamp: log result should always be >= 0 given the formula, but guard anyway
    idf[tag] = Number.isFinite(score) ? Math.max(0, score) : 0;
  }

  return idf;
}

// ── 3. scoreBrain ─────────────────────────────────────────────────────────────

/**
 * Score a single brain against a tokenized prompt using IDF-weighted tag matching.
 *
 * Partial matching: a tag fires if any token includes the tag as a substring
 * OR the tag includes the token as a substring.
 * Catches "kubernetes" matching "kube", "architecture" matching "architect".
 *
 * Never throws. Returns 0 for any malformed input.
 *
 * @param {*} brain - Brain pack to score
 * @param {*} tokens - Tokenized prompt (from tokenizePrompt)
 * @param {*} idfMap - IDF weights (from buildIdfMap)
 * @returns {number} Total score (>= 0); higher = stronger match
 */
function scoreBrain(brain, tokens, idfMap) {
  if (!brain || typeof brain !== 'object') return 0;
  if (!Array.isArray(brain.tags) || !brain.tags.length) return 0;
  if (!Array.isArray(tokens) || !tokens.length) return 0;

  const map = (idfMap !== null && typeof idfMap === 'object') ? idfMap : {};

  let score = 0;
  for (const tag of brain.tags) {
    const t = _str(tag);
    if (!t) continue;
    try {
      const hit = tokens.some((tok) => {
        if (typeof tok !== 'string' || !tok) return false;
        return t.includes(tok) || tok.includes(t);
      });
      if (hit) {
        const weight = _num(map[t], 1.0);
        score += weight;
      }
    } catch (_) {
      // Defensive: skip this tag if anything unexpected happens
    }
  }

  return _num(score, 0);
}

// ── 4. routeBrain ─────────────────────────────────────────────────────────────

/**
 * Route a user prompt to the best-matching brain(s).
 *
 * Handles:
 * - Manual override (force a specific brain by id or name)
 * - null / undefined / non-array brains → GENERAL_ASSISTANT fallback
 * - Null entries inside the brains array are silently skipped
 * - No tag matches → GENERAL_ASSISTANT fallback
 * - Single match → "single_match"
 * - Clear winner (relative score gap > 25%) → "clear_winner"
 * - Conflict (gap ≤ 25%) → "conflict" with primary + secondary
 *
 * Tiebreaker when scores are equal: higher brain.priority wins;
 * if priority also ties, alphabetical by brain.name.
 *
 * Never throws. Always returns a valid RouterResult.
 *
 * @param {*} prompt - Raw user prompt
 * @param {*} brains - Available brain packs
 * @param {*} [options] - { manualOverride?: string } — brain id or name to force
 * @returns {RouterResult}
 */
function routeBrain(prompt, brains, options) {
  // Normalise options — caller may pass null, undefined, or a non-object
  const opts = (options !== null && options !== undefined && typeof options === 'object')
    ? options
    : {};

  // Filter to valid brain objects only
  const allBrains = Array.isArray(brains)
    ? brains.filter((b) => b !== null && b !== undefined && typeof b === 'object')
    : [];

  // ── Manual override ────────────────────────────────────────────────────────
  // Match by id first, fall back to name (existing brains lack an id field)
  if (opts.manualOverride && typeof opts.manualOverride === 'string') {
    const needle = opts.manualOverride.toLowerCase();
    const brain = allBrains.find(
      (b) => _str(b.id) === needle || _str(b.name) === needle
    );
    if (brain) {
      return {
        primary: brain,
        secondary: null,
        confidence: 1.0,
        reason: 'manual',
        matchedTags: [],
        scores: [{ brainId: brain.id ?? brain.name ?? '', brainName: brain.name ?? '', score: 1.0 }],
      };
    }
    // Override brain not found — fall through to normal routing
  }

  // ── Empty brain list ───────────────────────────────────────────────────────
  if (!allBrains.length) {
    return _noMatchResult();
  }

  // ── Tokenize + score ───────────────────────────────────────────────────────
  const tokens = tokenizePrompt(prompt);
  const idfMap = buildIdfMap(allBrains);

  const scored = allBrains
    .map((brain) => ({ brain, score: scoreBrain(brain, tokens, idfMap) }))
    .filter((e) => Number.isFinite(e.score) && e.score > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      // Tiebreaker 1: higher priority wins
      const pa = _num(a.brain.priority, 0);
      const pb = _num(b.brain.priority, 0);
      if (pb !== pa) return pb - pa;
      // Tiebreaker 2: alphabetical by name
      return (a.brain.name ?? '').localeCompare(b.brain.name ?? '');
    });

  // ── No matches ────────────────────────────────────────────────────────────
  if (!scored.length) {
    return _noMatchResult();
  }

  const top = scored[0];
  const topMatchedTags = _getMatchedTags(top.brain, tokens);
  const topScores = scored.slice(0, 3).map((e) => ({
    brainId: e.brain.id ?? e.brain.name ?? '',
    brainName: e.brain.name ?? '',
    score: e.score,
  }));

  // ── Single match ──────────────────────────────────────────────────────────
  if (scored.length === 1) {
    return {
      primary: top.brain,
      secondary: null,
      confidence: 1.0,
      reason: 'single_match',
      matchedTags: topMatchedTags,
      scores: topScores,
    };
  }

  // ── Conflict detection ────────────────────────────────────────────────────
  const gap = top.score - scored[1].score;
  // top.score > 0 is guaranteed by the filter above
  const relativeGap = _num(gap / top.score, 0);

  if (relativeGap > 0.25) {
    return {
      primary: top.brain,
      secondary: null,
      confidence: relativeGap,
      reason: 'clear_winner',
      matchedTags: topMatchedTags,
      scores: topScores,
    };
  }

  return {
    primary: top.brain,
    secondary: scored[1].brain,
    confidence: relativeGap,
    reason: 'conflict',
    matchedTags: topMatchedTags,
    scores: topScores,
  };
}

// ── 5. buildDualInjection ─────────────────────────────────────────────────────

/**
 * Build the system context string to inject into the AI request.
 *
 * Turn 1: full system_prompt + framework for primary; framework-only for secondary.
 * Turn 2+: compressed reminder (~40 tokens max).
 *
 * Secondary brain framed as "Supporting perspective", never as "You are also".
 * Secondary system_prompt is NEVER included — framework steps only.
 *
 * Never throws. Returns '' if result is null/missing.
 *
 * @param {*} result - Output from routeBrain() (RouterResult)
 * @param {*} turnNumber - 1-indexed turn counter (defaults to turn 2+ if invalid)
 * @returns {string} Injection-ready string
 */
function buildDualInjection(result, turnNumber) {
  if (!result || typeof result !== 'object' || !result.primary) return '';

  const primary = result.primary;
  const secondary = result.secondary ?? null;

  // Normalise turnNumber: anything other than a positive integer ≥ 1 defaults to turn 2+
  const turn = (Number.isInteger(turnNumber) && turnNumber >= 1) ? turnNumber : 2;

  const fw = (brain) => {
    if (!brain || !Array.isArray(brain.framework)) return '';
    return brain.framework
      .filter((s) => typeof s === 'string' && s.trim())
      .join(' → ');
  };

  const primaryName = primary.name || 'Brain';
  const primaryPrompt = (typeof primary.system_prompt === 'string' && primary.system_prompt.trim())
    ? primary.system_prompt.trim()
    : '';

  if (turn === 1) {
    let out = primaryPrompt
      ? `${primaryPrompt}\nFramework: ${fw(primary)}`
      : `Framework: ${fw(primary)}`;

    if (secondary) {
      const secName = secondary.name || 'Supporting Brain';
      const secFw = fw(secondary);
      if (secFw) {
        out +=
          `\n\n---\n\nSupporting perspective — ${secName}:\n` +
          `Consider also: ${secFw}`;
      }
    }
    return out;
  }

  // Turn 2+: compressed reminder
  let out = `[Synapse] ${primaryName} active. Framework: ${fw(primary)}`;
  if (secondary) {
    const secName = secondary.name || 'Supporting Brain';
    out += ` Also consider ${secName} perspective.`;
  }
  return out;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** @returns {RouterResult} */
function _noMatchResult() {
  return {
    primary: GENERAL_ASSISTANT,
    secondary: null,
    confidence: 0,
    reason: 'no_match',
    matchedTags: [],
    scores: [],
  };
}

/**
 * Return the subset of a brain's tags that fired against the token set.
 * Never throws; non-string tags are silently skipped.
 *
 * @param {*} brain
 * @param {string[]} tokens
 * @returns {string[]}
 */
function _getMatchedTags(brain, tokens) {
  if (!brain || !Array.isArray(brain.tags)) return [];
  if (!Array.isArray(tokens) || !tokens.length) return [];
  return brain.tags.filter((tag) => {
    const t = _str(tag);
    if (!t) return false;
    return tokens.some((tok) => typeof tok === 'string' && tok && (t.includes(tok) || tok.includes(t)));
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

export {
  tokenizePrompt,
  buildIdfMap,
  scoreBrain,
  routeBrain,
  buildDualInjection,
  GENERAL_ASSISTANT,
};

// ── JSDoc type stubs (no runtime cost) ───────────────────────────────────────

/**
 * @typedef {Object} Brain
 * @property {string} [id]
 * @property {string} name
 * @property {string[]} tags
 * @property {number} [priority]
 * @property {string} system_prompt
 * @property {string[]} framework
 */

/**
 * @typedef {Object} RouterResult
 * @property {Brain} primary
 * @property {Brain|null} secondary
 * @property {number} confidence
 * @property {"manual"|"no_match"|"single_match"|"clear_winner"|"conflict"} reason
 * @property {string[]} matchedTags
 * @property {Array<{brainId: string, brainName: string, score: number}>} scores
 */
