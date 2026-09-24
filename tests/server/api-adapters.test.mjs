// Scratch tests for the two native API adapters: PROTOCOL v1.3 D1 (parallel
// tool batches) plus screenshot-history pruning.
//
// No network, no key: ctx.fetchImpl feeds canned SSE and ctx.getApiKey returns
// a dummy string, so this runs offline.
//
//   node server/api-adapters.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnthropicApiSession } from '../../server/adapters/api-anthropic.mjs';
import { createOpenAiApiSession } from '../../server/adapters/api-openai.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- canned SSE ---------------------------------------------------------

function sse(records) {
  return records.map((r) => `event: ${r.type}\ndata: ${JSON.stringify(r)}\n\n`).join('');
}

function anthropicToolTurn(toolUses) {
  const records = [{ type: 'message_start', message: { usage: { input_tokens: 11 } } }];
  toolUses.forEach((t, i) => {
    records.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: t.id, name: t.name }
    });
    records.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) }
    });
    records.push({ type: 'content_block_stop', index: i });
  });
  records.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 22 }
  });
  records.push({ type: 'message_stop' });
  return sse(records);
}

function anthropicTextTurn(text) {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ]);
}

function openaiToolTurn(calls) {
  const records = calls.map((c, i) => ({
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
  records.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  records.push({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } });
  return records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join('');
}

function openaiTextTurn(text) {
  const records = [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ];
  return records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join('');
}

// --- harness ------------------------------------------------------------

function makeFetch(responses, requests) {
  return async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const body = responses.shift();
    assert.ok(body !== undefined, 'transport ran out of canned responses');
    return {
      ok: true,
      body: (async function* () { yield body; })()
    };
  };
}

// name -> {delayMs, result} | {delayMs, throws}
function makeToolRunner(spec, log) {
  return async (name, args) => {
    const entry = spec[name];
    assert.ok(entry, `unexpected tool ${name}`);
    await sleep(entry.delayMs);
    if (log) log.push(name);
    if (entry.throws) throw new Error(entry.throws);
    return typeof entry.result === 'function' ? entry.result(args) : entry.result;
  };
}

function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

const kinds = (events, kind) => events.filter((e) => e.kind === kind);

function anthropicSession({ responses, tools, log }) {
  const requests = [];
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch(responses, requests),
    callBrowserTool: makeToolRunner(tools, log)
  });
  return { session, requests };
}

function openaiSession({ responses, tools, log }) {
  const requests = [];
  const session = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'test-key',
    fetchImpl: makeFetch(responses, requests),
    callBrowserTool: makeToolRunner(tools, log)
  });
  return { session, requests };
}

// Anthropic: last user message of the follow-up request.
function lastToolResults(request) {
  const msgs = request.body.messages;
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  return last.content;
}

function countImages(messages, type) {
  let n = 0;
  const scan = (array) => {
    for (const b of array) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === type) n += 1;
      else if (b.type === 'tool_result' && Array.isArray(b.content)) scan(b.content);
    }
  };
  for (const m of messages) if (Array.isArray(m.content)) scan(m.content);
  return n;
}

// The surviving image payloads, in history order. Anthropic keeps them at
// block.source.data, OpenAI at part.image_url.url.
function imagePayloads(messages, type) {
  const out = [];
  const scan = (array) => {
    for (const b of array) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image') out.push(b.source.data);
      else if (b.type === 'image_url') out.push(b.image_url.url);
      else if (b.type === 'tool_result' && Array.isArray(b.content)) scan(b.content);
    }
  };
  for (const m of messages) if (Array.isArray(m.content)) scan(m.content);
  return type === 'image_url' ? out.map((u) => String(u).split(',').pop()) : out;
}

function countPlaceholders(messages) {
  let n = 0;
  const scan = (array) => {
    for (const b of array) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && String(b.text).includes('screenshot from an earlier step')) n += 1;
      else if (b.type === 'tool_result' && Array.isArray(b.content)) scan(b.content);
    }
  };
  for (const m of messages) if (Array.isArray(m.content)) scan(m.content);
  return n;
}

// --- Anthropic ----------------------------------------------------------

const THREE = [
  { id: 'toolu_slow', name: 'tabs_list' },
  { id: 'toolu_fast', name: 'read_page' },
  { id: 'toolu_mid', name: 'navigate' }
];

const STAGGERED = {
  tabs_list: { delayMs: 200, result: { from: 'tabs_list' } },
  read_page: { delayMs: 10, result: { from: 'read_page' } },
  navigate: { delayMs: 100, result: { from: 'navigate' } }
};

test('anthropic: 3 tool_use blocks run concurrently, results keep original order', async () => {
  const { session, requests } = anthropicSession({
    responses: [anthropicToolTurn(THREE), anthropicTextTurn('all done')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const t0 = Date.now();
  await session.send('go', emit);
  const elapsed = Date.now() - t0;

  const uses = kinds(events, 'tool_use');
  const results = kinds(events, 'tool_result');
  assert.equal(uses.length, 3);
  assert.equal(results.length, 3);

  // every tool_use is emitted before any tool_result
  const lastUse = events.findLastIndex((e) => e.kind === 'tool_use');
  const firstResult = events.findIndex((e) => e.kind === 'tool_result');
  assert.ok(lastUse < firstResult, 'tool_use events must all precede tool_result events');

  assert.deepEqual(uses.map((e) => e.tool), ['tabs_list', 'read_page', 'navigate']);
  // results surface in COMPLETION order: 10ms, 100ms, 200ms
  assert.deepEqual(results.map((e) => e.tool), ['read_page', 'navigate', 'tabs_list']);

  // ...but the follow-up request carries them in ORIGINAL order, paired to ids
  const blocks = lastToolResults(requests[1]);
  assert.deepEqual(
    blocks.map((b) => b.tool_use_id),
    ['toolu_slow', 'toolu_fast', 'toolu_mid']
  );
  assert.deepEqual(
    blocks.map((b) => JSON.parse(b.content).from),
    ['tabs_list', 'read_page', 'navigate']
  );

  // sequential would be 310ms; parallel is bounded by the slowest call
  assert.ok(elapsed < 250, `expected parallel execution, took ${elapsed}ms`);
});

test('anthropic: single tool call keeps the old event shape and ordering', async () => {
  const { session, requests } = anthropicSession({
    responses: [
      anthropicToolTurn([{ id: 'toolu_1', name: 'read_page' }]),
      anthropicTextTurn('ok')
    ],
    tools: STAGGERED
  });
  const { events, emit } = collector();
  await session.send('go', emit);

  assert.deepEqual(events.map((e) => e.kind), [
    'status', 'tool_use', 'tool_result', 'token', 'meta', 'done'
  ]);
  const blocks = lastToolResults(requests[1]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tool_use_id, 'toolu_1');
  assert.equal(blocks[0].is_error, undefined);
});

test('anthropic: one throwing tool becomes is_error, siblings still complete', async () => {
  const { session, requests } = anthropicSession({
    responses: [anthropicToolTurn(THREE), anthropicTextTurn('recovered')],
    tools: {
      ...STAGGERED,
      read_page: { delayMs: 10, throws: 'tab is gone' }
    }
  });
  const { events, emit } = collector();
  await session.send('go', emit);

  const results = kinds(events, 'tool_result');
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((e) => [e.tool, e.ok]),
    [['read_page', false], ['navigate', true], ['tabs_list', true]]
  );

  const blocks = lastToolResults(requests[1]);
  assert.deepEqual(blocks.map((b) => b.tool_use_id), ['toolu_slow', 'toolu_fast', 'toolu_mid']);
  assert.equal(blocks[0].is_error, undefined);
  assert.equal(blocks[1].is_error, true);
  assert.match(blocks[1].content, /tab is gone/);
  assert.equal(blocks[2].is_error, undefined);
});

test('anthropic: abort mid-batch ends the turn with every tool_use answered', async () => {
  const { session, requests } = anthropicSession({
    responses: [anthropicToolTurn(THREE), anthropicTextTurn('never reached')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const sent = session.send('go', emit);
  await sleep(30); // the 10ms call has landed, the 100/200ms ones have not
  session.abort();
  await sent;

  assert.equal(requests.length, 1, 'aborted turn must not issue a follow-up request');
  assert.equal(kinds(events, 'done').length, 1);

  const msgs = session._messages;
  const assistant = msgs.find((m) => m.role === 'assistant');
  const useIds = assistant.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const last = msgs[msgs.length - 1];
  assert.deepEqual(last.content.map((b) => b.tool_use_id), useIds);

  // nothing lands in the history after the turn ended
  const depth = msgs.length;
  await sleep(250);
  assert.equal(session._messages.length, depth);
  assert.equal(kinds(events, 'done').length, 1);
});

test('anthropic: dispose mid-batch leaves no orphaned writes into the session', async () => {
  const { session } = anthropicSession({
    responses: [anthropicToolTurn(THREE), anthropicTextTurn('never reached')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const sent = session.send('go', emit);
  await sleep(30);
  session.dispose();
  await sent;

  assert.equal(session._messages.length, 0);
  await sleep(250); // the 100ms and 200ms calls settle after the turn ended
  assert.equal(session._messages.length, 0, 'a settled tool must not repopulate a disposed session');
  assert.equal(kinds(events, 'done').length, 1);
});

test('anthropic: history keeps only the 2 most recent screenshots', async () => {
  const shot = (n) => ({ id: `toolu_s${n}`, name: 'screenshot', input: { n } });
  const { session } = anthropicSession({
    responses: [
      anthropicToolTurn([shot(1), shot(2), shot(3)]),
      anthropicTextTurn('first turn done'),
      anthropicToolTurn([shot(4)]),
      anthropicTextTurn('second turn done')
    ],
    tools: {
      screenshot: {
        delayMs: 5,
        result: (args) => ({ base64: `IMG${args.n}`, mimeType: 'image/png' })
      }
    }
  });
  const { emit } = collector();
  await session.send('shoot', emit);
  await session.send('shoot again', emit);

  const msgs = session._messages;
  assert.equal(countImages(msgs, 'image'), 2);
  assert.equal(countPlaceholders(msgs), 2);
  // the two that survive are the NEWEST two, not the oldest two
  assert.deepEqual(imagePayloads(msgs, 'image'), ['IMG3', 'IMG4']);

  // every tool_result still answers its tool_use and every content array is
  // non-empty, so the message shape stays valid after the swap
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      assert.ok(typeof b.tool_use_id === 'string' && b.tool_use_id.length > 0);
      if (Array.isArray(b.content)) assert.ok(b.content.length > 0);
    }
  }
});

// --- OpenAI -------------------------------------------------------------

const THREE_CALLS = [
  { id: 'call_slow', name: 'tabs_list' },
  { id: 'call_fast', name: 'read_page' },
  { id: 'call_mid', name: 'navigate' }
];

function toolMessages(request) {
  return request.body.messages.filter((m) => m.role === 'tool');
}

test('openai: 3 tool calls run concurrently, results keep original order', async () => {
  const { session, requests } = openaiSession({
    responses: [openaiToolTurn(THREE_CALLS), openaiTextTurn('all done')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const t0 = Date.now();
  await session.send('go', emit);
  const elapsed = Date.now() - t0;

  const uses = kinds(events, 'tool_use');
  const results = kinds(events, 'tool_result');
  assert.equal(uses.length, 3);
  assert.equal(results.length, 3);

  const lastUse = events.findLastIndex((e) => e.kind === 'tool_use');
  const firstResult = events.findIndex((e) => e.kind === 'tool_result');
  assert.ok(lastUse < firstResult, 'tool_use events must all precede tool_result events');

  assert.deepEqual(uses.map((e) => e.tool), ['tabs_list', 'read_page', 'navigate']);
  assert.deepEqual(results.map((e) => e.tool), ['read_page', 'navigate', 'tabs_list']);

  const tools = toolMessages(requests[1]);
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['call_slow', 'call_fast', 'call_mid']);
  assert.deepEqual(
    tools.map((m) => JSON.parse(m.content).from),
    ['tabs_list', 'read_page', 'navigate']
  );

  assert.ok(elapsed < 250, `expected parallel execution, took ${elapsed}ms`);
});

test('openai: single tool call keeps the old event shape and ordering', async () => {
  const { session, requests } = openaiSession({
    responses: [openaiToolTurn([{ id: 'call_1', name: 'read_page' }]), openaiTextTurn('ok')],
    tools: STAGGERED
  });
  const { events, emit } = collector();
  await session.send('go', emit);

  assert.deepEqual(events.map((e) => e.kind), [
    'status', 'tool_use', 'tool_result', 'token', 'meta', 'done'
  ]);
  const tools = toolMessages(requests[1]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_call_id, 'call_1');
});

test('openai: one throwing tool still answers its id, siblings complete', async () => {
  const { session, requests } = openaiSession({
    responses: [openaiToolTurn(THREE_CALLS), openaiTextTurn('recovered')],
    tools: { ...STAGGERED, read_page: { delayMs: 10, throws: 'tab is gone' } }
  });
  const { events, emit } = collector();
  await session.send('go', emit);

  const results = kinds(events, 'tool_result');
  assert.deepEqual(
    results.map((e) => [e.tool, e.ok]),
    [['read_page', false], ['navigate', true], ['tabs_list', true]]
  );

  const tools = toolMessages(requests[1]);
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['call_slow', 'call_fast', 'call_mid']);
  assert.match(tools[1].content, /tab is gone/);
});

test('openai: abort mid-batch answers every tool_call before ending', async () => {
  const { session, requests } = openaiSession({
    responses: [openaiToolTurn(THREE_CALLS), openaiTextTurn('never reached')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const sent = session.send('go', emit);
  await sleep(30);
  session.abort();
  await sent;

  assert.equal(requests.length, 1);
  assert.equal(kinds(events, 'done').length, 1);

  const msgs = session._messages;
  const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
  const callIds = assistant.tool_calls.map((c) => c.id);
  const answered = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(answered, callIds);

  const depth = msgs.length;
  await sleep(250);
  assert.equal(session._messages.length, depth);
});

test('openai: dispose mid-batch leaves no orphaned writes into the session', async () => {
  const { session } = openaiSession({
    responses: [openaiToolTurn(THREE_CALLS), openaiTextTurn('never reached')],
    tools: STAGGERED
  });
  const { events, emit } = collector();

  const sent = session.send('go', emit);
  await sleep(30);
  session.dispose();
  await sent;

  assert.equal(session._messages.length, 0);
  await sleep(250);
  assert.equal(session._messages.length, 0);
  assert.equal(kinds(events, 'done').length, 1);
});

test('openai: history keeps only the 2 most recent screenshots', async () => {
  const shot = (n) => ({ id: `call_s${n}`, name: 'screenshot', input: { n } });
  const { session } = openaiSession({
    responses: [
      openaiToolTurn([shot(1), shot(2), shot(3)]),
      openaiTextTurn('first turn done'),
      openaiToolTurn([shot(4)]),
      openaiTextTurn('second turn done')
    ],
    tools: {
      screenshot: {
        delayMs: 5,
        result: (args) => ({ base64: `IMG${args.n}`, mimeType: 'image/png' })
      }
    }
  });
  const { emit } = collector();
  await session.send('shoot', emit);
  await session.send('shoot again', emit);

  const msgs = session._messages;
  assert.equal(countImages(msgs, 'image_url'), 2);
  assert.equal(countPlaceholders(msgs), 2);
  // the two that survive are the NEWEST two, not the oldest two
  assert.deepEqual(imagePayloads(msgs, 'image_url'), ['IMG3', 'IMG4']);

  // every tool_call_id is still answered and no content array went empty
  for (const m of msgs) {
    if (Array.isArray(m.content)) assert.ok(m.content.length > 0);
    if (m.role === 'tool') assert.ok(m.tool_call_id);
  }
});

test('concurrency stays capped at 6', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `t${i}`);
  const tools = {};
  let inFlight = 0;
  let peak = 0;
  for (const n of names) tools[n] = { delayMs: 30, result: { n } };

  // instrumented tool runner: counts how many calls overlap
  const inner = makeToolRunner(tools);
  const responses = [
    anthropicToolTurn(names.map((n, i) => ({ id: `toolu_${i}`, name: n }))),
    anthropicTextTurn('done')
  ];
  const reqs = [];
  const s = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'k',
    fetchImpl: makeFetch(responses, reqs),
    callBrowserTool: async (name, args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await inner(name, args);
      } finally {
        inFlight -= 1;
      }
    }
  });
  const { emit } = collector();
  await s.send('go', emit);

  assert.equal(peak, 6, `expected the batch to cap at 6 in flight, saw ${peak}`);
  const blocks = lastToolResults(reqs[1]);
  assert.deepEqual(blocks.map((b) => b.tool_use_id), names.map((_, i) => `toolu_${i}`));
});
