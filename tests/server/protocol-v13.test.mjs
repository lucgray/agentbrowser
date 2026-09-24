// Independent integration verification for PROTOCOL v1.3.
// Written by the verifier, not the builder. No network, no key, no model tokens.
//
//   node --test server/protocol-v13.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnthropicApiSession } from '../../server/adapters/api-anthropic.mjs';
import { createOpenAiApiSession } from '../../server/adapters/api-openai.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- canned SSE, written fresh -----------------------------------------

function anthropicSse(records) {
  return records.map((r) => `event: ${r.type}\ndata: ${JSON.stringify(r)}\n\n`).join('');
}

function anthropicToolTurn(toolUses) {
  const recs = [{ type: 'message_start', message: { usage: { input_tokens: 100 } } }];
  toolUses.forEach((t, i) => {
    recs.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: t.id, name: t.name }
    });
    recs.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) }
    });
    recs.push({ type: 'content_block_stop', index: i });
  });
  recs.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } });
  recs.push({ type: 'message_stop' });
  return anthropicSse(recs);
}

function anthropicTextTurn(text) {
  return anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 7 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' }
  ]);
}

function openaiToolTurn(calls) {
  const recs = calls.map((c, i) => ({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: i,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
        }]
      }
    }]
  }));
  recs.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  recs.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 200 } });
  return recs.map((r) => `data: ${JSON.stringify(r)}\n\n`).join('');
}

function openaiTextTurn(text) {
  return [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ].map((r) => `data: ${JSON.stringify(r)}\n\n`).join('');
}

function makeFetch(responses, requests) {
  return async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const body = responses.shift();
    assert.ok(body !== undefined, 'transport ran out of canned responses');
    return { ok: true, body: (async function* () { yield body; })() };
  };
}

// Deliberately staggered handlers: alpha 200ms, beta 10ms, gamma 100ms.
// If the batch ran sequentially it would take ~310ms and beta would finish
// first in wall-clock order regardless.
const STAGGER = { alpha: 200, beta: 10, gamma: 100 };

function staggeredRunner({ throwOn = null, finishOrder = [] } = {}) {
  return async (name, args) => {
    const ms = STAGGER[name];
    assert.ok(ms != null, `unexpected tool ${name}`);
    await sleep(ms);
    finishOrder.push(name);
    if (name === throwOn) throw new Error(`${name} blew up`);
    return { tool: name, echo: args };
  };
}

function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

const kinds = (events, kind) => events.filter((e) => e.kind === kind);

// -----------------------------------------------------------------------
// D1: parallel tool batch, Anthropic
// -----------------------------------------------------------------------

test('anthropic: 3-tool batch runs concurrently, ordered, id-paired', async () => {
  const requests = [];
  const finishOrder = [];
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([
      anthropicToolTurn([
        { id: 'tu_a', name: 'alpha', input: { n: 1 } },
        { id: 'tu_b', name: 'beta', input: { n: 2 } },
        { id: 'tu_c', name: 'gamma', input: { n: 3 } }
      ]),
      anthropicTextTurn('done')
    ], requests),
    callBrowserTool: staggeredRunner({ finishOrder })
  });

  const { events, emit } = collector();
  const t0 = Date.now();
  await session.send('go', emit);
  const elapsed = Date.now() - t0;

  // 3 tool_use, 3 tool_result
  const uses = kinds(events, 'tool_use');
  const results = kinds(events, 'tool_result');
  assert.equal(uses.length, 3, 'three tool_use events');
  assert.equal(results.length, 3, 'three tool_result events');
  assert.deepEqual(uses.map((e) => e.tool), ['alpha', 'beta', 'gamma']);

  // All tool_use events precede every tool_result event.
  const lastUse = events.findLastIndex((e) => e.kind === 'tool_use');
  const firstResult = events.findIndex((e) => e.kind === 'tool_result');
  assert.ok(lastUse < firstResult, 'all tool_use emitted before the first tool_result');

  // Concurrency proved two ways: handlers finished in duration order, and the
  // whole turn took ~max(200) not sum(310).
  assert.deepEqual(finishOrder, ['beta', 'gamma', 'alpha'], 'handlers overlapped');
  assert.ok(elapsed < 300, `batch took ${elapsed}ms, expected ~200 not ~310`);

  // tool_result events surface in completion order, not model order.
  assert.deepEqual(results.map((e) => e.tool), ['beta', 'gamma', 'alpha']);

  // Results fed back in ORIGINAL order with correct id pairing.
  const followUp = requests[1].body.messages;
  const lastUser = followUp[followUp.length - 1];
  assert.equal(lastUser.role, 'user');
  assert.deepEqual(lastUser.content.map((b) => b.tool_use_id), ['tu_a', 'tu_b', 'tu_c']);
  for (const block of lastUser.content) {
    assert.equal(block.type, 'tool_result');
    assert.equal(block.is_error, undefined, 'no error flag on a clean batch');
  }
  // The payload in each slot belongs to the tool that id names.
  const names = lastUser.content.map((b) => JSON.parse(b.content).tool);
  assert.deepEqual(names, ['alpha', 'beta', 'gamma'], 'payloads match their ids, not completion order');

  // The meta the hub will read: field NAMES must be the v1.3 ones, or
  // augmentMeta normalizes them to null and costUsd silently disappears for
  // the one adapter family where a dollar figure is real.
  const metas = kinds(events, 'meta');
  assert.equal(metas.length, 1);
  assert.equal(metas[0].inputTokens, 100 + 7, 'inputTokens summed across both turns');
  assert.equal(metas[0].outputTokens, 200 + 9, 'outputTokens summed across both turns');
  assert.ok('cacheReadTokens' in metas[0], 'meta carries cacheReadTokens');
  assert.ok('cacheWriteTokens' in metas[0], 'meta carries cacheWriteTokens');
  assert.equal(metas[0].adapter, 'anthropic-api');
  assert.equal(metas[0].model, 'claude-opus-5');

  assert.equal(kinds(events, 'done').length, 1);
  session.dispose();
});

test('anthropic: cache buckets reach the meta (they price at 0.1x and 1.25x)', async () => {
  const requests = [];
  // message_start carrying the cached buckets alongside input_tokens.
  const cached = anthropicSse([
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500
        }
      }
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
    { type: 'message_stop' }
  ]);
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([cached], requests),
    callBrowserTool: async () => ({})
  });
  const { events, emit } = collector();
  await session.send('go', emit);
  const meta = kinds(events, 'meta')[0];
  assert.equal(meta.inputTokens, 40);
  assert.equal(meta.outputTokens, 60);
  assert.equal(meta.cacheReadTokens, 1000, 'cache reads must not be dropped');
  assert.equal(meta.cacheWriteTokens, 500, 'cache writes must not be dropped');

  // And the price table turns them into the right dollar figure.
  const { costFor } = await import('../../server/adapters/pricing.mjs');
  // opus 5: in 5, out 25, cacheRead 0.5, cacheWrite 6.25 per MTok
  const expected = (40 * 5 + 60 * 25 + 1000 * 0.5 + 500 * 6.25) / 1e6;
  assert.equal(costFor('claude-opus-5', meta), Math.round(expected * 1e6) / 1e6);
  session.dispose();
});

test('anthropic: the concurrency cap of 6 actually binds', async () => {
  const requests = [];
  let inFlight = 0;
  let peak = 0;
  const names = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([
      anthropicToolTurn(names.map((n, i) => ({ id: 'tu_' + i, name: n }))),
      anthropicTextTurn('done')
    ], requests),
    callBrowserTool: async (name) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(50);
      inFlight -= 1;
      return { tool: name };
    }
  });
  const { events, emit } = collector();
  const t0 = Date.now();
  await session.send('go', emit);
  const elapsed = Date.now() - t0;

  assert.equal(peak, 6, `peak concurrency was ${peak}, cap is 6`);
  // 7 calls at 6-wide: two waves, ~100ms. Sequential would be ~350ms.
  assert.ok(elapsed >= 90, `finished in ${elapsed}ms, two waves should take ~100ms`);
  assert.ok(elapsed < 250, `finished in ${elapsed}ms, expected ~100ms not ~350ms`);

  const followUp = requests[1].body.messages;
  const lastUser = followUp[followUp.length - 1];
  assert.deepEqual(
    lastUser.content.map((b) => b.tool_use_id),
    names.map((_, i) => 'tu_' + i),
    'all seven results in original order'
  );
  session.dispose();
});

test('openai: meta carries the v1.3 field names', async () => {
  const requests = [];
  const session = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([openaiTextTurn('hi')], requests),
    callBrowserTool: async () => ({})
  });
  const { events, emit } = collector();
  await session.send('go', emit);
  const meta = kinds(events, 'meta')[0];
  assert.ok(meta, 'one meta');
  assert.equal(meta.adapter, 'openai-api');
  assert.ok('inputTokens' in meta && 'outputTokens' in meta);
  session.dispose();
});

test('anthropic: one throwing handler errors only its own id', async () => {
  const requests = [];
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([
      anthropicToolTurn([
        { id: 'tu_a', name: 'alpha' },
        { id: 'tu_b', name: 'beta' },
        { id: 'tu_c', name: 'gamma' }
      ]),
      anthropicTextTurn('recovered')
    ], requests),
    callBrowserTool: staggeredRunner({ throwOn: 'beta' })
  });

  const { events, emit } = collector();
  await session.send('go', emit);

  const results = kinds(events, 'tool_result');
  assert.equal(results.length, 3);
  const byTool = Object.fromEntries(results.map((e) => [e.tool, e.ok]));
  assert.deepEqual(byTool, { alpha: true, beta: false, gamma: true });

  const followUp = requests[1].body.messages;
  const lastUser = followUp[followUp.length - 1];
  assert.deepEqual(lastUser.content.map((b) => b.tool_use_id), ['tu_a', 'tu_b', 'tu_c']);
  assert.equal(lastUser.content[0].is_error, undefined);
  assert.equal(lastUser.content[1].is_error, true, 'only the failing id is is_error');
  assert.equal(lastUser.content[2].is_error, undefined);
  assert.match(String(lastUser.content[1].content), /beta blew up/);
  assert.equal(JSON.parse(lastUser.content[0].content).tool, 'alpha');
  assert.equal(JSON.parse(lastUser.content[2].content).tool, 'gamma');
  assert.equal(kinds(events, 'done').length, 1);
  session.dispose();
});

// -----------------------------------------------------------------------
// D1: parallel tool batch, OpenAI (positional pairing against tool_calls)
// -----------------------------------------------------------------------

test('openai: 3-tool batch runs concurrently, ordered, id-paired', async () => {
  const requests = [];
  const finishOrder = [];
  const session = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([
      openaiToolTurn([
        { id: 'call_a', name: 'alpha', input: { n: 1 } },
        { id: 'call_b', name: 'beta', input: { n: 2 } },
        { id: 'call_c', name: 'gamma', input: { n: 3 } }
      ]),
      openaiTextTurn('done')
    ], requests),
    callBrowserTool: staggeredRunner({ finishOrder })
  });

  const { events, emit } = collector();
  const t0 = Date.now();
  await session.send('go', emit);
  const elapsed = Date.now() - t0;

  const uses = kinds(events, 'tool_use');
  const results = kinds(events, 'tool_result');
  assert.equal(uses.length, 3);
  assert.equal(results.length, 3);
  assert.deepEqual(uses.map((e) => e.tool), ['alpha', 'beta', 'gamma']);

  const lastUse = events.findLastIndex((e) => e.kind === 'tool_use');
  const firstResult = events.findIndex((e) => e.kind === 'tool_result');
  assert.ok(lastUse < firstResult, 'all tool_use emitted before the first tool_result');

  assert.deepEqual(finishOrder, ['beta', 'gamma', 'alpha']);
  assert.ok(elapsed < 300, `batch took ${elapsed}ms, expected ~200 not ~310`);
  assert.deepEqual(results.map((e) => e.tool), ['beta', 'gamma', 'alpha']);

  // OpenAI pairs positionally against assistant.tool_calls. Walk the follow-up
  // request: the assistant message then exactly three tool messages, in the
  // model's original order, each tool_call_id matching its assistant slot.
  const msgs = requests[1].body.messages;
  const assistantIndex = msgs.findLastIndex((m) => m.role === 'assistant');
  const assistant = msgs[assistantIndex];
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ['call_a', 'call_b', 'call_c']);
  const toolMsgs = msgs.slice(assistantIndex + 1).filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 3);
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_a', 'call_b', 'call_c']);
  const payloadNames = toolMsgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return JSON.parse(c).tool;
  });
  assert.deepEqual(payloadNames, ['alpha', 'beta', 'gamma'], 'payload matches its tool_call_id');

  assert.equal(kinds(events, 'done').length, 1);
  session.dispose();
});

test('openai: one throwing handler errors only its own call id', async () => {
  const requests = [];
  const session = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch([
      openaiToolTurn([
        { id: 'call_a', name: 'alpha' },
        { id: 'call_b', name: 'beta' },
        { id: 'call_c', name: 'gamma' }
      ]),
      openaiTextTurn('recovered')
    ], requests),
    callBrowserTool: staggeredRunner({ throwOn: 'beta' })
  });

  const { events, emit } = collector();
  await session.send('go', emit);

  const results = kinds(events, 'tool_result');
  assert.equal(results.length, 3);
  assert.deepEqual(
    Object.fromEntries(results.map((e) => [e.tool, e.ok])),
    { alpha: true, beta: false, gamma: true }
  );

  const msgs = requests[1].body.messages;
  const assistantIndex = msgs.findLastIndex((m) => m.role === 'assistant');
  const toolMsgs = msgs.slice(assistantIndex + 1).filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_a', 'call_b', 'call_c']);
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  assert.match(text(toolMsgs[1]), /beta blew up/, 'the failing slot carries its own error');
  assert.equal(JSON.parse(text(toolMsgs[0])).tool, 'alpha');
  assert.equal(JSON.parse(text(toolMsgs[2])).tool, 'gamma');
  assert.equal(kinds(events, 'done').length, 1);
  session.dispose();
});
