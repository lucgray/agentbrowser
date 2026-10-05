import test from 'node:test';
import assert from 'node:assert/strict';

let stored = {};
let fetchImpl = async () => { throw new Error('unstubbed fetch'); };

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: stored[key] }),
    },
  },
};
globalThis.fetch = (...args) => fetchImpl(...args);

const direct = await import('../../extension/background/direct.js');

function anthropicJson(body, init = {}) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
    ...init,
  });
}

function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

test('isEnabled requires enabled+provider+apiKey', () => {
  assert.equal(direct.isEnabled({}), false);
  assert.equal(direct.isEnabled({ enabled: true }), false);
  assert.equal(direct.isEnabled({ enabled: true, provider: 'anthropic' }), false);
  assert.equal(direct.isEnabled({ enabled: true, provider: 'anthropic', apiKey: 'k' }), true);
});

test('enabled() reads abDirect from chrome.storage', async () => {
  stored = {};
  assert.equal(await direct.enabled(), false);
  stored = { abDirect: { enabled: true, provider: 'openai', apiKey: 'k' } };
  assert.equal(await direct.enabled(), true);
});

test('capabilitiesFor names the configured provider and model', () => {
  const caps = direct.capabilitiesFor({ provider: 'anthropic', model: 'claude-x' });
  assert.equal(caps.type, 'capabilities');
  assert.equal(caps.adapters[0].name, 'direct-anthropic');
  assert.equal(caps.adapters[0].defaultModel, 'claude-x');
  const o = direct.capabilitiesFor({ provider: 'openai' });
  assert.equal(o.adapters[0].name, 'direct-openai');
  assert.equal(o.adapters[0].defaultModel, 'gpt-4o-mini');
});

test('sendChat anthropic: text reply streams status→token→meta→done', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'k', model: 'm1' } };
  let req;
  fetchImpl = (url, init) => { req = { url, init }; return anthropicJson({
    content: [{ type: 'text', text: 'hello back' }],
    usage: { input_tokens: 11, output_tokens: 5 },
  }); };
  const { events, emit } = collect();
  await direct.sendChat(
    { type: 'chat', chatId: 'c1', text: 'hi' },
    { emit, execTool: async () => { throw new Error('should not run'); }, gate: null }
  );
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.init.headers['x-api-key'], 'k');
  assert.equal(JSON.parse(req.init.body).model, 'm1');
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['status', 'token', 'meta', 'done']);
  assert.equal(events[1].text, 'hello back');
  assert.equal(events[2].adapter, 'direct-anthropic');
  assert.equal(events[2].inputTokens, 11);
});

test('sendChat anthropic: tool_use round trips through execTool then final text', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'k' } };
  const bodies = [];
  let calls = 0;
  fetchImpl = (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) {
      return anthropicJson({
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tu_1', name: 'tabs_list', input: { label: '列标签' } },
        ],
        usage: {},
      });
    }
    return anthropicJson({ content: [{ type: 'text', text: 'two tabs open' }], usage: {} });
  };
  const seen = [];
  const { events, emit } = collect();
  await direct.sendChat(
    { type: 'chat', chatId: 'c2', text: 'how many tabs' },
    {
      emit,
      execTool: async (tool, args) => { seen.push([tool, args]); return { tabs: 2 }; },
      gate: async () => {},
    }
  );
  assert.deepEqual(seen, [['tabs_list', { label: '列标签' }]]);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('tool_use'));
  const tr = events.find((e) => e.kind === 'tool_result');
  assert.equal(tr.ok, true);
  assert.equal(tr.tool, 'tabs_list');
  // Second request carries the tool_result as a user message.
  const last = bodies[1].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'tu_1');
  assert.equal(events.at(-1).kind, 'done');
});

test('sendChat anthropic: tool failure surfaces as is_error tool_result, not a crash', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'k' } };
  let calls = 0;
  const bodies = [];
  fetchImpl = (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) {
      return anthropicJson({
        content: [{ type: 'tool_use', id: 'tu_9', name: 'navigate', input: { url: 'https://x' } }],
        usage: {},
      });
    }
    return anthropicJson({ content: [{ type: 'text', text: 'nav failed, sorry' }], usage: {} });
  };
  const { events, emit } = collect();
  await direct.sendChat(
    { type: 'chat', chatId: 'c3', text: 'go' },
    { emit, execTool: async () => { throw new Error('no such tab'); }, gate: null }
  );
  const tr = events.find((e) => e.kind === 'tool_result');
  assert.equal(tr.ok, false);
  assert.equal(bodies[1].messages.at(-1).content[0].is_error, true);
  assert.equal(events.at(-1).kind, 'done');
});

test('sendChat openai: tool_calls become role:tool messages', async () => {
  stored = { abDirect: { enabled: true, provider: 'openai', apiKey: 'k' } };
  const bodies = [];
  let calls = 0;
  fetchImpl = (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', tool_calls: [
            { id: 'call_1', function: { name: 'read_page', arguments: '{"tabId":3}' } },
          ] } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'page says hi' } }] }),
    });
  };
  const { events, emit } = collect();
  await direct.sendChat(
    { type: 'chat', chatId: 'c4', text: 'read' },
    { emit, execTool: async () => ({ text: 'hi' }), gate: null }
  );
  assert.equal(bodies[0].tools[0].type, 'function');
  assert.equal(bodies[0].messages[0].role, 'system');
  const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  const token = events.find((e) => e.kind === 'token');
  assert.equal(token.text, 'page says hi');
});

test('sendChat on a disabled config emits error+done without fetch', async () => {
  stored = { abDirect: {} };
  let fetched = false;
  fetchImpl = () => { fetched = true; return anthropicJson({}); };
  const { events, emit } = collect();
  await direct.sendChat({ type: 'chat', chatId: 'c5', text: 'x' }, { emit, execTool: async () => {}, gate: null });
  assert.equal(fetched, false);
  assert.deepEqual(events.map((e) => e.kind), ['error', 'done']);
});

test('a second sendChat on a busy chat is refused', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'k' } };
  let release;
  fetchImpl = () => new Promise((res) => { release = () => res(anthropicJson({ content: [] })); });
  const first = collect();
  const p = direct.sendChat({ type: 'chat', chatId: 'c6', text: 'a' }, { emit: first.emit, execTool: async () => {}, gate: null });
  const second = collect();
  await direct.sendChat({ type: 'chat', chatId: 'c6', text: 'b' }, { emit: second.emit, execTool: async () => {}, gate: null });
  assert.equal(second.events[0].kind, 'error');
  assert.match(second.events[0].message, /in progress/);
  release();
  await p;
});

test('abort() finishes the in-flight turn without an error event', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'k' } };
  fetchImpl = (_u, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
  const { events, emit } = collect();
  const p = direct.sendChat({ type: 'chat', chatId: 'c7', text: 'a' }, { emit, execTool: async () => {}, gate: null });
  await new Promise((r) => setTimeout(r, 10));
  direct.abort('c7');
  await p;
  assert.equal(events.at(-1).kind, 'done');
  assert.ok(!events.some((e) => e.kind === 'error'));
});

test('api errors surface as error+done', async () => {
  stored = { abDirect: { enabled: true, provider: 'anthropic', apiKey: 'bad' } };
  fetchImpl = () => Promise.resolve({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'invalid api key' } }),
  });
  const { events, emit } = collect();
  await direct.sendChat({ type: 'chat', chatId: 'c8', text: 'x' }, { emit, execTool: async () => {}, gate: null });
  const err = events.find((e) => e.kind === 'error');
  assert.match(err.message, /401.*invalid api key/);
  assert.equal(events.at(-1).kind, 'done');
});
