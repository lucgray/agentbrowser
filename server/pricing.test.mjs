// Token-accounting tests: pricing math + usage parsing for every source that
// reports it. Everything runs off canned output — no CLI is spawned and no API
// is called.
//
//   node --test pricing.test.mjs
//   node pricing.test.mjs          (node's test runner picks it up either way)

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRICES, costFor, isMetered, priceFor } from './adapters/pricing.mjs';
import { usageFromApi as sdkUsage } from './adapters/claude-agent-sdk.mjs';
import { usageFromApi as cliUsage } from './adapters/claude-cli.mjs';
import { HARNESSES, GENERIC_CLI_NAMES } from './adapters/generic-cli.mjs';

const NO_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null
};

// Drives a stream preset's onLine over canned JSONL messages and returns the
// usage it accumulated. Mirrors what handleLine does in the adapter.
function runStream(presetName, messages) {
  const preset = HARNESSES[presetName];
  const state = { usage: { ...NO_USAGE }, turnCount: 1 };
  for (const msg of messages) preset.onLine(msg, state, () => {});
  return state.usage;
}

// Same for the buffered presets, whose stdout is handed to parseOutput on exit.
function runBuffered(presetName, text) {
  const preset = HARNESSES[presetName];
  const state = { usage: { ...NO_USAGE }, turnCount: 1 };
  preset.parseOutput(text, state, () => {});
  return state.usage;
}

// --- pricing table ----------------------------------------------------------

test('PRICES carries the current Anthropic rates', () => {
  const expected = {
    'claude-fable-5': [10, 50],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-opus-4-7': [5, 25],
    'claude-opus-4-6': [5, 25],
    // introductory rate, active through 2026-08-31
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-4-5': [1, 5]
  };
  for (const [model, [input, output]] of Object.entries(expected)) {
    assert.equal(PRICES[model].inputPerMTok, input, `${model} input`);
    assert.equal(PRICES[model].outputPerMTok, output, `${model} output`);
  }
});

test('cache rates are the documented multipliers of the base input rate', () => {
  const opus = PRICES['claude-opus-5'];
  assert.equal(opus.cacheReadPerMTok, 0.5); // 0.1x of 5
  assert.equal(opus.cacheWritePerMTok, 6.25); // 1.25x of 5
});

test('the OpenAI entries are flagged as unverified estimates', () => {
  assert.equal(PRICES['gpt-5.6'].estimate, true);
  assert.equal(PRICES.o4.estimate, true);
});

test('priceFor tolerates provider prefixes and dated snapshots', () => {
  assert.equal(priceFor('anthropic.claude-opus-5').inputPerMTok, 5);
  assert.equal(priceFor('claude-haiku-4-5-20251001').inputPerMTok, 1);
  assert.equal(priceFor('CLAUDE-OPUS-5').inputPerMTok, 5);
  assert.equal(priceFor('llama-3'), null);
  assert.equal(priceFor(null), null);
});

// --- costFor ----------------------------------------------------------------

test('costFor prices a metered turn correctly', () => {
  // 1M input + 1M output on Opus 5 = $5 + $25.
  assert.equal(costFor('claude-opus-5', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: null,
    cacheWriteTokens: null
  }), 30);

  // Cache buckets bill at 0.1x / 1.25x of the input rate and are additive,
  // because Anthropic reports input_tokens exclusive of them.
  // 1M read = $0.50, 1M write = $6.25.
  assert.equal(costFor('claude-opus-5', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000
  }), 6.75);

  // A realistic small turn: 12k in / 800 out / 40k cached read on Sonnet 5
  // at the introductory 2/10 rate (active through 2026-08-31).
  // 12000*2 + 800*10 + 40000*0.2 = 24000 + 8000 + 8000 = 40000 / 1e6
  assert.equal(costFor('claude-sonnet-5', {
    inputTokens: 12_000,
    outputTokens: 800,
    cacheReadTokens: 40_000,
    cacheWriteTokens: null
  }), 0.04);
});

test('costFor returns null when it cannot price honestly', () => {
  const usage = { inputTokens: 1000, outputTokens: 100 };
  assert.equal(costFor('some-unknown-model', usage), null, 'unknown model');
  assert.equal(costFor(null, usage), null, 'no model');
  assert.equal(costFor('claude-opus-5', NO_USAGE), null, 'no usage reported');
  assert.equal(costFor('claude-opus-5', null), null, 'no usage object');
});

test('costFor returns null for every subscription-backed adapter', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  for (const adapter of [
    'claude-cli', 'claude-agent-sdk', 'codex', 'opencode',
    'copilot', 'grok', 'agy', 'gemini'
  ]) {
    assert.equal(
      costFor('claude-opus-5', usage, adapter), null,
      `${adapter} must not show a dollar figure — the user is on a flat plan`
    );
  }
});

test('costFor prices the metered adapters', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(costFor('claude-opus-5', usage, 'anthropic-api'), 30);
  assert.equal(costFor('gpt-5.6', usage, 'openai-api'), 11.25);
  // Metered but the model is unknown to the table: still null, never 0.
  assert.equal(costFor('mystery-model', usage, 'anthropic-api'), null);
});

test('isMetered is an allowlist of the two BYO-key adapters', () => {
  assert.equal(isMetered('anthropic-api'), true);
  assert.equal(isMetered('openai-api'), true);
  for (const adapter of [
    'claude-cli', 'claude-agent-sdk', ...GENERIC_CLI_NAMES, 'nonsense', undefined
  ]) {
    assert.equal(isMetered(adapter), false, `${adapter} defaults to unmetered`);
  }
});

// --- claude-agent-sdk / claude-cli ------------------------------------------

// Both read the same Anthropic wire shape (SDKResultMessage.usage is
// NonNullableUsage, i.e. BetaUsage; the CLI's stream-json result line is the
// same object from the same binary).
const CANNED_RESULT_USAGE = {
  input_tokens: 421,
  output_tokens: 1893,
  cache_read_input_tokens: 41_000,
  cache_creation_input_tokens: 7_205,
  service_tier: 'standard'
};

const EXPECTED_RESULT_USAGE = {
  inputTokens: 421,
  outputTokens: 1893,
  cacheReadTokens: 41_000,
  cacheWriteTokens: 7_205
};

test('claude-agent-sdk parses SDKResultMessage.usage', () => {
  assert.deepEqual(sdkUsage(CANNED_RESULT_USAGE), EXPECTED_RESULT_USAGE);
  assert.deepEqual(sdkUsage(undefined), NO_USAGE);
  assert.deepEqual(sdkUsage({}), NO_USAGE);
});

test('claude-cli parses the stream-json result usage', () => {
  const resultLine = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    total_cost_usd: 0.0187,
    usage: CANNED_RESULT_USAGE
  });
  assert.deepEqual(cliUsage(JSON.parse(resultLine).usage), EXPECTED_RESULT_USAGE);
  assert.deepEqual(cliUsage(null), NO_USAGE);
});

test('the parsed Claude usage prices out against the table', () => {
  // 421*5 + 1893*25 + 41000*0.5 + 7205*6.25 = 2105 + 47325 + 20500 + 45031.25
  assert.equal(
    costFor('claude-opus-5', EXPECTED_RESULT_USAGE, 'anthropic-api'),
    0.114961
  );
});

// --- codex ------------------------------------------------------------------

test('codex reports usage on turn.completed', () => {
  const usage = runStream('codex', [
    { type: 'thread.started', thread_id: 'thr_1' },
    { type: 'item.completed', item: { item_type: 'agent_message', text: 'hi' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 12_400,
        cached_input_tokens: 11_008,
        cache_write_input_tokens: 1_024,
        output_tokens: 733,
        reasoning_output_tokens: 256,
        total_tokens: 13_133
      }
    }
  ]);
  assert.deepEqual(usage, {
    inputTokens: 12_400,
    outputTokens: 733,
    cacheReadTokens: 11_008,
    cacheWriteTokens: 1_024
  });
});

test('codex reports nulls when the turn never completes', () => {
  const usage = runStream('codex', [{ type: 'thread.started', thread_id: 'thr_1' }]);
  assert.deepEqual(usage, NO_USAGE);
});

// --- opencode ---------------------------------------------------------------

function stepFinish(input, output, reasoning, read, write) {
  return {
    type: 'step_finish',
    sessionID: 'ses_1',
    part: {
      type: 'step-finish',
      reason: 'tool-calls',
      cost: 0.0031,
      tokens: { input, output, reasoning, cache: { read, write } }
    }
  };
}

test('opencode sums usage across every step of one turn', () => {
  const usage = runStream('opencode', [
    stepFinish(1000, 50, 10, 400, 200),
    { type: 'tool_use', part: { tool: 'read_page', state: { status: 'completed', output: 'ok' } } },
    stepFinish(2000, 80, 20, 900, 0),
    stepFinish(3000, 120, 0, 1500, 0)
  ]);
  // Taking only the last step_finish would undercount every multi-step turn.
  assert.deepEqual(usage, {
    inputTokens: 6000,
    outputTokens: 280, // (50+10) + (80+20) + (120+0) — reasoning counts as output
    cacheReadTokens: 2800,
    cacheWriteTokens: 200
  });
});

test('opencode reports nulls when no step finished', () => {
  const usage = runStream('opencode', [
    { type: 'text', part: { text: 'hello' } }
  ]);
  assert.deepEqual(usage, NO_USAGE);
});

// --- grok -------------------------------------------------------------------

test('grok reports usage on the final JSON object', () => {
  const stdout = JSON.stringify({
    text: 'Here is a summary...',
    stopReason: 'end_turn',
    sessionId: 'abc123',
    num_turns: 7,
    usage: {
      input_tokens: 7210,
      cache_read_input_tokens: 41_000,
      cache_creation_input_tokens: 0,
      output_tokens: 1893,
      reasoning_tokens: 412,
      total_tokens: 50_103
    },
    total_cost_usd: 0.01268905
  });
  const usage = runBuffered('grok', stdout);
  assert.deepEqual(usage, {
    inputTokens: 7210,
    outputTokens: 1893,
    cacheReadTokens: 41_000,
    cacheWriteTokens: 0
  });
});

test('grok reports nulls when the response carries no usage', () => {
  const usage = runBuffered('grok', JSON.stringify({ text: 'hi', sessionId: 'a' }));
  assert.deepEqual(usage, NO_USAGE);
});

// --- gemini -----------------------------------------------------------------

test('gemini reports usage from the result stats block', () => {
  const usage = runStream('gemini', [
    { type: 'init', session_id: 'sess_1', model: 'gemini-3-pro' },
    { type: 'message', role: 'assistant', content: 'done' },
    {
      type: 'result',
      status: 'success',
      stats: {
        total_tokens: 25_120,
        input_tokens: 22_000,
        output_tokens: 3120,
        cached: 18_500,
        input: 3500,
        duration_ms: 8123,
        tool_calls: 4,
        models: {}
      }
    }
  ]);
  assert.deepEqual(usage, {
    inputTokens: 22_000,
    outputTokens: 3120,
    cacheReadTokens: 18_500, // gemini reports no cache-write bucket
    cacheWriteTokens: null
  });
});

test('gemini still reports usage on an errored result', () => {
  const usage = runStream('gemini', [
    {
      type: 'result',
      status: 'error',
      error: 'boom',
      stats: { input_tokens: 100, output_tokens: 5, cached: 0 }
    }
  ]);
  assert.equal(usage.inputTokens, 100);
});

// --- copilot / agy ----------------------------------------------------------

test('copilot and agy report nulls — their output has no usage to parse', () => {
  assert.deepEqual(runBuffered('copilot', 'Here is the answer.\n'), NO_USAGE);
  assert.deepEqual(runBuffered('agy', 'Here is the answer.\n'), NO_USAGE);
});

test('exactly four of the seven generic CLIs report usage', () => {
  const reporting = ['codex', 'opencode', 'grok', 'gemini'];
  const silent = ['copilot', 'agy', 'devin'];
  assert.deepEqual([...reporting, ...silent].sort(), [...GENERIC_CLI_NAMES].sort());
});
