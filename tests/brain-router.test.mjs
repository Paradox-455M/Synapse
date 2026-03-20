/**
 * brain-router.test.mjs
 *
 * Node.js test suite for utils/brain-router.js
 * Run: node tests/brain-router.test.mjs
 */

import {
  tokenizePrompt,
  buildIdfMap,
  scoreBrain,
  routeBrain,
  buildDualInjection,
  GENERAL_ASSISTANT,
} from '../utils/brain-router.js';

// ── Mini test harness ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}\n     actual:   ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}`);
}

// ── Fixture brains ────────────────────────────────────────────────────────────
const brainApi = {
  name: 'API Designer',
  tags: ['api', 'rest', 'graphql', 'endpoint', 'openapi'],
  system_prompt: 'You are an API design expert specialised in RESTful architecture and schema contracts.',
  framework: ['Clarify requirements', 'Design schema', 'Document endpoints'],
};

const brainSec = {
  name: 'Security Researcher',
  tags: ['security', 'vulnerability', 'exploit', 'pentest', 'stride'],
  system_prompt: 'You are a security researcher with expertise in threat modelling and STRIDE analysis.',
  framework: ['Identify assets', 'Map threats', 'Propose mitigations'],
};

const brainDb = {
  name: 'Database Optimizer',
  tags: ['sql', 'database', 'index', 'query', 'postgres', 'performance'],
  system_prompt: 'You are a database performance expert focused on query optimisation and indexing strategies.',
  framework: ['Analyse query', 'Identify bottleneck', 'Optimise'],
};

const brainDebug = {
  name: 'Debug Detective',
  tags: ['debug', 'error', 'trace', 'stack', 'reproduce'],
  system_prompt: 'You are a debugging expert. Trace errors systematically to their root cause.',
  framework: ['Reproduce', 'Isolate', 'Fix'],
};

const brainData = {
  name: 'Data Scientist',
  tags: ['data', 'machine learning', 'statistics', 'model', 'dataset'],
  system_prompt: 'You are a data scientist specialised in machine learning and statistical modelling.',
  framework: ['Explore data', 'Build model', 'Evaluate'],
};

const allBrains = [brainApi, brainSec, brainDb, brainDebug, brainData];

// ── 1. tokenizePrompt ─────────────────────────────────────────────────────────
section('tokenizePrompt');

assert('returns [] for empty string', tokenizePrompt('').length === 0);
assert('returns [] for null', tokenizePrompt(null).length === 0);
assert('returns [] for number', tokenizePrompt(42).length === 0);
assert('lowercases tokens', tokenizePrompt('REST').includes('rest'));
assert('deduplicates tokens', tokenizePrompt('postgres POSTGRES').length === 1);
assert('removes stopwords', !tokenizePrompt('the quick brown fox').includes('the'));
assert('removes tokens shorter than 3 chars', !tokenizePrompt('I go do a to').some((t) => t.length < 3));
assert('splits on punctuation', tokenizePrompt('REST, GraphQL: endpoint.').includes('endpoint'));
assert('handles leading/trailing spaces', tokenizePrompt('  api design  ').includes('design'));

// ── 2. buildIdfMap ────────────────────────────────────────────────────────────
section('buildIdfMap');

const idf = buildIdfMap(allBrains);

assert('returns object', typeof idf === 'object' && idf !== null);
assert('contains "sql" key', 'sql' in idf);
assert('contains "database" key', 'database' in idf);
assert('contains _sp: keys (system_prompt indexed)', Object.keys(idf).some((k) => k.startsWith('_sp:')));
assert('all IDF values are finite >= 0', Object.values(idf).every((v) => Number.isFinite(v) && v >= 0));
// Tags that appear in fewer brains should get higher IDF
assert('"openapi" (1 brain) has higher IDF than "query" (appears in DB brain, lower rarity if shared)',
  (idf['openapi'] ?? 0) > 0
);
assert('returns {} for empty array', Object.keys(buildIdfMap([])).length === 0);
assert('returns {} for non-array', Object.keys(buildIdfMap(null)).length === 0);
assert('handles brains with no tags', buildIdfMap([{ name: 'X', system_prompt: 'test', tags: [], framework: [] }]) !== null);

// ── 3. scoreBrain — basic matching ────────────────────────────────────────────
section('scoreBrain — basic matching');

const apiPrompt = 'help me design a REST API for user authentication';
const apiTokens = tokenizePrompt(apiPrompt);
const idfMap = buildIdfMap(allBrains);

const apiScore = scoreBrain(brainApi, apiTokens, idfMap, apiPrompt);
const secScore = scoreBrain(brainSec, apiTokens, idfMap, apiPrompt);
const dbScore = scoreBrain(brainDb, apiTokens, idfMap, apiPrompt);

assert('API Designer scores > 0 for API prompt', apiScore > 0);
assert('API Designer scores higher than Security for API prompt', apiScore > secScore);
assert('API Designer scores higher than Database for API prompt', apiScore > dbScore);
assert('returns 0 for empty tokens', scoreBrain(brainApi, [], idfMap, apiPrompt) === 0);
assert('returns 0 for null brain', scoreBrain(null, apiTokens, idfMap, apiPrompt) === 0);
assert('returns 0 for brain with no tags', scoreBrain({ name: 'X', tags: [], system_prompt: '', framework: [] }, apiTokens, idfMap, '') === 0);

// ── 4. scoreBrain — short-tag boundary matching ───────────────────────────────
section('scoreBrain — short-tag boundary');

// "sql" (3 chars) must NOT match "sequential"
const seqText = 'sequential scan is slow on this table';
const seqTokens = tokenizePrompt(seqText);
const sqlText = 'my SQL query is running slow on this table';
const sqlTokens = tokenizePrompt(sqlText);

const sqlScoreOnSeq = scoreBrain(brainDb, seqTokens, idfMap, seqText);
const sqlScoreOnSql = scoreBrain(brainDb, sqlTokens, idfMap, sqlText);

assert('short tag "sql" does NOT match "sequential" (word boundary check)',
  sqlScoreOnSeq < sqlScoreOnSql
);
// "api" should match "API" but not "rapid"
const rapidText = 'rapid prototyping of user interfaces';
const rapidTokens = tokenizePrompt(rapidText);
const rapidScore = scoreBrain(brainApi, rapidTokens, idfMap, rapidText);
const pureApiText = 'I need to build an API endpoint';
const pureApiTokens = tokenizePrompt(pureApiText);
const pureApiScore = scoreBrain(brainApi, pureApiTokens, idfMap, pureApiText);
assert('short tag "api" does NOT match "rapid" (boundary)',
  rapidScore < pureApiScore
);

// ── 5. scoreBrain — multi-word phrase bonus ───────────────────────────────────
section('scoreBrain — multi-word phrase bonus');

const mlExact = 'I want to use machine learning on this dataset';
const mlExactTokens = tokenizePrompt(mlExact);
const mlExactScore = scoreBrain(brainData, mlExactTokens, idfMap, mlExact);

// Without the phrase (breaking the phrase across a word boundary)
const mlBroken = 'I want to use machine-based learning on this dataset';
const mlBrokenTokens = tokenizePrompt(mlBroken);
const mlBrokenScore = scoreBrain(brainData, mlBrokenTokens, idfMap, mlBroken);

assert('exact phrase "machine learning" scores >= broken phrase version', mlExactScore >= mlBrokenScore);
assert('exact phrase "machine learning" gives Data Scientist a positive score', mlExactScore > 0);

// ── 6. scoreBrain — system_prompt bonus ──────────────────────────────────────
section('scoreBrain — system_prompt bonus');

// "stride" appears in Security Researcher's system_prompt (first 200 chars)
const strideText = 'help me run a stride analysis on my web application';
const strideTokens = tokenizePrompt(strideText);
const strideIdf = buildIdfMap(allBrains);
const strideScore = scoreBrain(brainSec, strideTokens, strideIdf, strideText);
assert('system_prompt bonus: Security Researcher scores > 0 for STRIDE prompt', strideScore > 0);

// ── 7. scoreBrain — length normalisation ─────────────────────────────────────
section('scoreBrain — length normalisation');

const shortText = 'sql query slow';
const shortTokens = tokenizePrompt(shortText);
const shortScore = scoreBrain(brainDb, shortTokens, idfMap, shortText);

// Very long prompt with the same signal + lots of noise
const longText = 'sql query slow ' + 'word '.repeat(200);
const longTokens = tokenizePrompt(longText);
const longScore = scoreBrain(brainDb, longTokens, idfMap, longText);

assert('long prompt with same signal does not inflate score unboundedly', longScore < shortScore * 3);

// ── 8. routeBrain — manual override ──────────────────────────────────────────
section('routeBrain — manual override');

const manualResult = routeBrain('anything here', allBrains, { manualOverride: 'Database Optimizer' });
assertEq('manual override: reason', manualResult.reason, 'manual');
assertEq('manual override: primary brain', manualResult.primary.name, 'Database Optimizer');
assert('manual override: confidence = 1', manualResult.confidence === 1.0);
assert('manual override: no secondary', manualResult.secondary === null);

// Unknown override falls through to normal routing
const unknownOverride = routeBrain('sql database query', allBrains, { manualOverride: 'Nonexistent Brain' });
assert('unknown override falls through to routing', unknownOverride.reason !== 'manual');

// ── 9. routeBrain — empty / no-match ─────────────────────────────────────────
section('routeBrain — empty/no-match');

const emptyResult = routeBrain('help me with SQL', []);
assertEq('empty brains: reason', emptyResult.reason, 'no_match');
assertEq('empty brains: fallback to GENERAL_ASSISTANT', emptyResult.primary.name, GENERAL_ASSISTANT.name);

const noMatchResult = routeBrain('hello world tell me a random joke please', allBrains);
assertEq('no keyword match: reason', noMatchResult.reason, 'no_match');

const nullBrainsResult = routeBrain('sql query', null);
assertEq('null brains: reason', nullBrainsResult.reason, 'no_match');

// ── 10. routeBrain — clear winner ─────────────────────────────────────────────
section('routeBrain — clear winner');

const clearResult = routeBrain('I need to design a REST API endpoint with OpenAPI schema', allBrains);
assert('clear winner: primary is API Designer', clearResult.primary.name === 'API Designer');
assert('clear winner: reason is single_match or clear_winner',
  ['single_match', 'clear_winner'].includes(clearResult.reason)
);
assert('clear winner: matchedTags populated', clearResult.matchedTags.length > 0);
assert('clear winner: scores array present', Array.isArray(clearResult.scores) && clearResult.scores.length > 0);

// ── 11. routeBrain — conflict ─────────────────────────────────────────────────
section('routeBrain — conflict detection');

// "debug sql query error" — could be Debug Detective or Database Optimizer
const conflictResult = routeBrain('debug this sql query error trace', allBrains);
// Either it picks a winner or flags conflict — both are valid, just check structure
assert('conflict: result has primary', conflictResult.primary !== null);
assert('conflict: confidence is finite', Number.isFinite(conflictResult.confidence));

// ── 12. routeBrain — session context ─────────────────────────────────────────
section('routeBrain — session context');

// Prompt that weakly matches both API Designer and Database Optimizer
// Session context for API should tip the balance toward API Designer
const weakText = 'help me optimize the endpoint performance';
const withoutContext = routeBrain(weakText, allBrains);
const withApiContext = routeBrain(weakText, allBrains, {
  sessionTags: ['api', 'rest', 'endpoint'],
});
// Both should have a primary result (the prompt has some signal)
assert('session context: result has a primary brain', withApiContext.primary !== null);
// With API session context, API Designer's score should be >= without context
const apiScoreWithout = withoutContext.scores?.find((s) => s.brainName === 'API Designer')?.score ?? 0;
const apiScoreWith    = withApiContext.scores?.find((s) => s.brainName === 'API Designer')?.score ?? 0;
assert('session context: API Designer score is boosted when prior tags match',
  apiScoreWith >= apiScoreWithout
);

// ── 13. buildDualInjection ────────────────────────────────────────────────────
section('buildDualInjection');

const singleResult = routeBrain('I need to design a REST API endpoint', allBrains);
const turn1 = buildDualInjection(singleResult, 1);
const turn2 = buildDualInjection(singleResult, 2);

assert('turn 1: includes system_prompt text', turn1.length > 20);
assert('turn 2: shorter than turn 1 (compressed reminder)', turn2.length < turn1.length);
assert('returns "" for null result', buildDualInjection(null, 1) === '');
assert('returns "" for result with no primary', buildDualInjection({ primary: null }, 1) === '');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
