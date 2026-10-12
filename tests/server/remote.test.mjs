// Remote relay (PROTOCOL v2.26): token auth, harness role-lock, allowlist
// enforcement on tool_calls, capabilities filtering, token generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

// Resolve ws from this repo's server/node_modules — not from a hardcoded
// absolute path, which only exists on the machine that wrote the test.
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');

const {
  startRemote,
  ensureRemoteToken,
  remoteAllowedTools,
  remoteToolSchemas,
  filterCapabilities,
} = await import('../../server/remote.mjs');

function cfg(over = {}) {
  return {
    remote: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-0123456789abcdef',
      allowTools: ['navigate', 'screenshot'],
      allowPlugins: [],
      ...over,
    },
  };
}

// A fake hub: captures what the relay forwards upstream and answers
// tool_calls so the remote side sees results.
async function fakeHub() {
  const got = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      got.push(msg);
      if (msg.type === 'tool_call') {
        ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, ok: true, result: { ran: msg.tool } }));
      } else if (msg.type === 'get_capabilities') {
        ws.send(JSON.stringify({
          type: 'capabilities',
          adapters: [],
          plugins: [
            { id: 'margin', name: 'Margin', enabled: true, tools: ['page_reader'] },
            { id: 'notes', name: 'Notes', enabled: true, tools: ['notes_save'] },
          ],
        }));
      } else if (msg.type === 'plugins_list') {
        ws.send(JSON.stringify({
          type: 'plugins',
          plugins: [
            { id: 'margin', name: 'Margin', enabled: true, tools: ['page_reader'] },
            { id: 'notes', name: 'Notes', enabled: true, tools: ['notes_save'] },
          ],
        }));
      }
    });
  });
  await once(wss, 'listening');
  const port = wss.address().port;
  return { got, port, close: () => wss.close() };
}

async function startRelay(config, hubPort) {
  const handle = await startRemote(config, {
    hubUrl: `ws://127.0.0.1:${hubPort}`,
    log: () => {},
  });
  assert.equal(handle.ok, true, JSON.stringify(handle));
  // port 0 in config → real port comes back on the handle
  return handle;
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('ensureRemoteToken generates once and persists', () => {
  const c = { remote: {} };
  const a = ensureRemoteToken(c);
  assert.equal(a.generated, true);
  assert.ok(a.token.length >= 16);
  const b = ensureRemoteToken(c);
  assert.equal(b.generated, false);
  assert.equal(b.token, a.token);
});

test('remoteAllowedTools merges allowTools with allowPlugins extraTools', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-remote-'));
  try {
    const pdir = path.join(dir, 'history');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(path.join(pdir, 'plugin.json'), JSON.stringify({
      id: 'history', name: 'History', extraTools: [{ name: 'history_recent' }],
    }));
    const prev = process.env.AGENTCHAT_PLUGINS_DIR;
    process.env.AGENTCHAT_PLUGINS_DIR = dir;
    try {
      const allow = remoteAllowedTools(cfg({ allowPlugins: ['history'] }));
      assert.ok(allow.has('navigate'));
      assert.ok(allow.has('history_recent'));
      assert.ok(!allow.has('click'));
    } finally {
      if (prev === undefined) delete process.env.AGENTCHAT_PLUGINS_DIR;
      else process.env.AGENTCHAT_PLUGINS_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filterCapabilities injects allowed schemas and drops unshared plugins', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-remote-'));
  try {
    const pdir = path.join(dir, 'history');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(path.join(pdir, 'plugin.json'), JSON.stringify({
      id: 'history', name: 'History', extraTools: [{ name: 'history_recent' }],
    }));
    const prev = process.env.AGENTCHAT_PLUGINS_DIR;
    process.env.AGENTCHAT_PLUGINS_DIR = dir;
    try {
      const c = cfg({ allowPlugins: ['history'] });
      const allow = {
        tools: remoteAllowedTools(c),
        plugins: new Set(['history']),
        schemas: remoteToolSchemas(c),
      };
      const msg = filterCapabilities({
        type: 'capabilities',
        adapters: [{ name: 'x' }],
        plugins: [
          { id: 'history', name: 'History', tools: ['history_recent'] },
          { id: 'notes', name: 'Notes', tools: ['notes_save'] },
        ],
      }, allow);
      // Discovery: remote sees real schemas for its allowed tools.
      assert.deepEqual(
        msg.tools.map((t) => t.name).sort(),
        ['history_recent', 'navigate', 'screenshot']
      );
      // Unshared plugin invisible; shared plugin's tools intact.
      assert.deepEqual(msg.plugins.map((p) => p.id), ['history']);
      assert.deepEqual(msg.plugins[0].tools, ['history_recent']);
      assert.equal(msg.adapters[0].name, 'x');
      // type:plugins frames get the same plugin filtering.
      const pf = filterCapabilities({
        type: 'plugins',
        plugins: msg.plugins.concat([{ id: 'notes', tools: ['notes_save'] }]),
      }, allow);
      assert.deepEqual(pf.plugins.map((p) => p.id), ['history']);
    } finally {
      if (prev === undefined) delete process.env.AGENTCHAT_PLUGINS_DIR;
      else process.env.AGENTCHAT_PLUGINS_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bad token is refused at upgrade', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    await assert.rejects(wsOpen(`ws://127.0.0.1:${relay.port}/?token=wrong`), /401|Unexpected/);
  } finally {
    relay.close(); hub.close();
  }
});

test('allowlisted tool round-trips; unshared tool denied relay-side', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    const ws = await wsOpen(`ws://127.0.0.1:${relay.port}/?token=${cfg().remote.token}`);
    ws.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'grok' }));
    const replies = [];
    ws.on('message', (d) => replies.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'tool_call', id: 'a1', tool: 'navigate', args: { url: 'x' } }));
    ws.send(JSON.stringify({ type: 'tool_call', id: 'a2', tool: 'click', args: {} }));
    await new Promise((r) => setTimeout(r, 300));
    const r1 = replies.find((m) => m.id === 'a1');
    const r2 = replies.find((m) => m.id === 'a2');
    assert.ok(r1 && r1.ok && r1.result.ran === 'navigate');
    assert.ok(r2 && r2.ok === false && /not shared remotely/.test(r2.error));
    // Denied call never reached the hub.
    assert.ok(!hub.got.some((m) => m.id === 'a2'));
    ws.close();
  } finally {
    relay.close(); hub.close();
  }
});

test('non-harness hello is rejected and closed', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    const ws = await wsOpen(`ws://127.0.0.1:${relay.port}/?token=${cfg().remote.token}`);
    const replies = [];
    ws.on('message', (d) => replies.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', name: 'evil' }));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(replies.some((m) => /harness clients only/.test(m.error || '')));
    assert.equal(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING, true);
    assert.ok(!hub.got.some((m) => m.type === 'hello'));
  } finally {
    relay.close(); hub.close();
  }
});

test('capabilities carry only shared plugins and injected allowed schemas', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    const ws = await wsOpen(`ws://127.0.0.1:${relay.port}/?token=${cfg().remote.token}`);
    ws.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'grok' }));
    const caps = new Promise((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'capabilities') resolve(m);
      });
    });
    ws.send(JSON.stringify({ type: 'get_capabilities' }));
    const m = await caps;
    // Real schemas injected for allowTools.
    assert.deepEqual(m.tools.map((t) => t.name).sort(), ['navigate', 'screenshot']);
    // No plugins are shared → plugins[] list is empty.
    assert.deepEqual(m.plugins, []);
    ws.close();
  } finally {
    relay.close(); hub.close();
  }
});

test('plugins frames are filtered to shared plugins only', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    const ws = await wsOpen(`ws://127.0.0.1:${relay.port}/?token=${cfg().remote.token}`);
    ws.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'grok' }));
    const got = new Promise((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'plugins') resolve(m);
      });
    });
    ws.send(JSON.stringify({ type: 'plugins_list' }));
    const m = await got;
    assert.deepEqual(m.plugins, []);
    ws.close();
  } finally {
    relay.close(); hub.close();
  }
});

test('remote name is tagged remote:<name> on the upstream hello', async () => {
  const hub = await fakeHub();
  const relay = await startRelay(cfg({ port: 0 }), hub.port);
  try {
    const ws = await wsOpen(`ws://127.0.0.1:${relay.port}/?token=${cfg().remote.token}`);
    ws.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'grok' }));
    await new Promise((r) => setTimeout(r, 200));
    const hello = hub.got.find((m) => m.type === 'hello');
    assert.equal(hello.name, 'remote:grok');
    ws.close();
  } finally {
    relay.close(); hub.close();
  }
});
