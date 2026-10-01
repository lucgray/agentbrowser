// mcp-bridge: spawn a fake stdio MCP server, verify initialize/tools/list/
// tools/call and the adapter-side wiring (tool merge, dispatch, prompt extra).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectMcpServers } from '../../server/adapters/mcp-bridge.mjs';
import { createAnthropicApiSession } from '../../server/adapters/api-anthropic.mjs';
import { createOpenAiApiSession } from '../../server/adapters/api-openai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fake-mcp-server.mjs');
const SPEC = { fake: { command: process.execPath, args: [FAKE] } };

const silent = () => {};

function sse(records) {
  return records.map((r) => `event: ${r.type}\ndata: ${JSON.stringify(r)}\n\n`).join('');
}

function anthropicToolTurn(toolUses) {
  const records = [{ type: 'message_start', message: { usage: { input_tokens: 1 } } }];
  toolUses.forEach((t, i) => {
    records.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: t.id, name: t.name } });
    records.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } });
    records.push({ type: 'content_block_stop', index: i });
  });
  records.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
  records.push({ type: 'message_stop' });
  return sse(records);
}

function anthropicTextTurn(text) {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]);
}

function openaiToolTurn(calls) {
  const records = calls.map((c, i) => ({
    choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }] } }]
  }));
  records.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  records.push({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  return records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join('');
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

function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

test('connectMcpServers: initialize + tools/list namespaces tools', async () => {
  const bridge = await connectMcpServers(SPEC, { log: silent });
  assert.equal(bridge.tools.length, 1);
  assert.equal(bridge.tools[0].name, 'mcp__fake__echo');
  assert.equal(bridge.tools[0].args.type, 'object');
  bridge.close();
});

test('connectMcpServers: tools/call routes through and returns content', async () => {
  const bridge = await connectMcpServers(SPEC, { log: silent });
  const result = await bridge.call('mcp__fake__echo', { text: 'hi' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'echo:hi' }]);
  assert.equal(bridge.has('mcp__fake__echo'), true);
  assert.equal(bridge.has('echo'), false);
  bridge.close();
});

test('connectMcpServers: a bad server is skipped, the rest still connect', async () => {
  const logs = [];
  const bridge = await connectMcpServers({
    bad: { command: '/nonexistent/mcp-server-binary' },
    ...SPEC
  }, { log: (m) => logs.push(m) });
  assert.equal(bridge.tools.length, 1);
  assert.ok(logs.some((l) => l.includes('bad')));
  bridge.close();
});

test('api-anthropic: mcp tools merge into the request and dispatch to the bridge', async () => {
  const requests = [];
  const browserCalls = [];
  const session = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'k',
    config: { mcpServers: SPEC },
    fetchImpl: makeFetch([
      anthropicToolTurn([{ id: 't1', name: 'mcp__fake__echo', input: { text: 'go' } }]),
      anthropicTextTurn('done')
    ], requests),
    callBrowserTool: async (name) => { browserCalls.push(name); return {}; }
  });
  const { emit, events } = collector();
  await session.send('run echo', emit);
  session.dispose();

  assert.equal(requests.length, 2);
  const names = requests[0].body.tools.map((t) => t.name);
  assert.ok(names.includes('mcp__fake__echo'));
  assert.equal(browserCalls.length, 0);
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  assert.equal(toolResults[0].tool, 'mcp__fake__echo');
  assert.equal(toolResults[0].ok, true);
  const followUp = requests[1].body.messages.at(-1);
  assert.ok(JSON.stringify(followUp).includes('echo:go'));
});

test('api-openai: mcp tools merge into the request and dispatch to the bridge', async () => {
  const requests = [];
  const browserCalls = [];
  const session = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'k',
    config: { mcpServers: SPEC },
    fetchImpl: makeFetch([
      openaiToolTurn([{ id: 'c1', name: 'mcp__fake__echo', input: { text: 'go' } }]),
      openaiTextTurn('done')
    ], requests),
    callBrowserTool: async (name) => { browserCalls.push(name); return {}; }
  });
  const { emit } = collector();
  await session.send('run echo', emit);
  session.dispose();

  assert.equal(requests.length, 2);
  const names = requests[0].body.tools.map((t) => t.function.name);
  assert.ok(names.includes('mcp__fake__echo'));
  assert.equal(browserCalls.length, 0);
  const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg.content.includes('echo:go'));
});

test('systemPromptExtra appends to the system prompt in both adapters', async () => {
  const requestsA = [];
  const sessionA = createAnthropicApiSession({
    model: 'claude-opus-5',
    getApiKey: () => 'k',
    config: { systemPromptExtra: 'Custom rule: always be terse.' },
    fetchImpl: makeFetch([anthropicTextTurn('ok')], requestsA),
    callBrowserTool: async () => ({})
  });
  await sessionA.send('hi', () => {});
  sessionA.dispose();
  assert.ok(requestsA[0].body.system.endsWith('Custom rule: always be terse.'));

  const requestsO = [];
  const sessionO = createOpenAiApiSession({
    model: 'gpt-5.6',
    getApiKey: () => 'k',
    config: { systemPromptExtra: 'Custom rule: always be terse.' },
    fetchImpl: makeFetch([openaiTextTurn('ok')], requestsO),
    callBrowserTool: async () => ({})
  });
  await sessionO.send('hi', () => {});
  sessionO.dispose();
  assert.ok(requestsO[0].body.messages[0].content.endsWith('Custom rule: always be terse.'));
});
