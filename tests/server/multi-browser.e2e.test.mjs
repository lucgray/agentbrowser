// Multi-browser routing e2e (v2.13): two fake extensions on one real hub.
// Covers coexistence (no displacement), capabilities.browsers, primary
// routing + the explicit "browser" arg, browsers_list answered hub-side,
// chat binding (events + calls return to the chat's own browser), and
// disconnect fail-over failing only that browser's in-flight calls.
//
//   node --test tests/server/multi-browser.e2e.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/hub/hub.mjs', import.meta.url));
const { WebSocket } = require('ws');

const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.join(here, '../../server/hub/hub.mjs');
const STUB = path.join(here, '../../server/hub/stub-adapter.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startHub(env = {}) {
  const port = await freePort();
  const log = path.join(os.tmpdir(), `agentchat-stub-${port}.log`);
  try { fs.unlinkSync(log); } catch {}
  const child = spawn(process.execPath, [HUB], {
    env: {
      ...process.env,
      AGENTCHAT_PORT: String(port),
      AGENTCHAT_ADAPTER_MODULE: STUB,
      STUB_LOG: log,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const deadline = Date.now() + 8000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('hub did not start: ' + stderr);
    const up = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (up) break;
    await sleep(50);
  }
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    stderrText: () => stderr,
    stop() {
      child.kill('SIGKILL');
      try { fs.unlinkSync(log); } catch {}
    }
  };
}

function waitFor(arr, pred, ms = 6000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = arr.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// Fake extension: hello carries browser {id,name} like the real one (v2.13).
// handlers: tool -> (args) => result. A handler of null means "hang" — no
// reply, used to leave a call pending across a disconnect.
function fakeExtension(hubUrl, browser, handlers = {}) {
  const ws = new WebSocket(hubUrl);
  const msgs = [];
  const calls = [];
  let closed = false;
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', version: '1.0.0', browser }));
  });
  ws.on('close', () => { closed = true; });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    msgs.push(msg);
    if (msg.type !== 'tool_call') return;
    calls.push(msg);
    const handler = handlers[msg.tool];
    if (handler === null) return; // never answered
    ws.send(JSON.stringify({
      type: 'tool_result', id: msg.id,
      ok: !!handler,
      ...(handler ? { result: handler(msg.args || {}) } : { error: `no fake handler for ${msg.tool}` })
    }));
  });
  return {
    msgs, calls, open,
    isClosed: () => closed,
    send: (o) => ws.send(JSON.stringify(o)),
    close() { try { ws.close(); } catch {} }
  };
}

// Fake harness client (role "harness"): agentbrowser CLI / mcp-proxy shape.
function fakeHarness(hubUrl, name = 'test-cli') {
  const ws = new WebSocket(hubUrl);
  const msgs = [];
  let seq = 0;
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'harness', name })));
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  return {
    msgs, open,
    call(tool, args = {}) {
      const id = `t${++seq}`;
      ws.send(JSON.stringify({ type: 'tool_call', id, tool, args }));
      return waitFor(msgs, (m) => m.type === 'tool_result' && m.id === id);
    },
    close() { try { ws.close(); } catch {} }
  };
}

const CHROME = { id: 'b-chrome', name: 'Google Chrome' };
const EDGE = { id: 'b-edge', name: 'Edge' };
const TABS = () => ({ tabs: [{ tabId: 1, url: 'https://a', title: 'A' }] });

test('two extensions coexist; capabilities lists both; harness routes to primary or named browser', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext1 = fakeExtension(hub.url, CHROME, { tabs_list: TABS, navigate: () => ({ url: 'x' }) });
  t.after(() => { ext1.close(); ext2.close(); });
  await ext1.open; // strict first connect: deterministic primary
  const ext2 = fakeExtension(hub.url, EDGE, { tabs_list: TABS, navigate: () => ({ url: 'x' }) });
  t.after(() => ext2.close());
  await ext2.open;

  // Neither displaced the other: both got capabilities listing both browsers.
  const caps = await waitFor(ext1.msgs, (m) => m.type === 'capabilities' && m.browsers.length === 2);
  assert.deepEqual(caps.browsers.map((b) => b.id), ['b-chrome', 'b-edge']);
  assert.equal(caps.browsers[0].default, true, 'first connected is primary');
  await waitFor(ext2.msgs, (m) => m.type === 'capabilities' && m.browsers.length === 2);
  assert.ok(!ext1.isClosed() && !ext2.isClosed(), 'no displacement close');

  const cli = fakeHarness(hub.url);
  t.after(() => cli.close());
  await cli.open;

  // Unqualified calls go to the primary (first connected).
  const r1 = await cli.call('tabs_list');
  assert.equal(r1.ok, true);
  assert.equal(ext1.calls.length, 1);
  assert.equal(ext2.calls.length, 0);

  // browsers_list is answered by the hub itself — never dispatched.
  const r2 = await cli.call('browsers_list');
  assert.equal(r2.ok, true);
  assert.equal(r2.result.browsers.length, 2);
  assert.equal(r2.result.using, 'b-chrome');
  assert.equal(r2.result.browsers.find((b) => b.id === 'b-chrome').default, true);
  assert.equal(r2.result.browsers.find((b) => b.id === 'b-chrome').current, true);
  assert.equal(ext1.calls.length, 1, 'browsers_list never reached the extension');

  // An explicit browser name routes to that extension, with the routing key
  // stripped before dispatch.
  const r3 = await cli.call('navigate', { url: 'https://x', browser: 'Edge' });
  assert.equal(r3.ok, true);
  assert.equal(ext2.calls.length, 1);
  assert.equal(ext2.calls[0].tool, 'navigate');
  assert.ok(!('browser' in ext2.calls[0].args), 'browser arg is consumed by the hub');

  const r4 = await cli.call('navigate', { url: 'https://x', browser: 'nope' });
  assert.equal(r4.ok, false);
  assert.match(r4.error, /no connected browser "nope"/);
});

test('chat binds its events and calls to its own browser; primary follows chat activity', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext1 = fakeExtension(hub.url, CHROME, { tabs_list: TABS });
  const ext2 = fakeExtension(hub.url, EDGE, { tabs_list: TABS });
  t.after(() => { ext1.close(); ext2.close(); });
  await Promise.all([ext1.open, ext2.open]);
  await waitFor(ext2.msgs, (m) => m.type === 'capabilities');

  const chatId = 'mb-chat';
  ext2.send({ type: 'chat', chatId, text: 'hi', adapter: 'stub' });
  const done = await waitFor(
    ext2.msgs,
    (m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done'
  );
  assert.equal(done.browser.id, 'b-edge', 'chat_event echoes the bound browser');
  assert.ok(
    !ext1.msgs.some((m) => m.type === 'chat_event' && m.chatId === chatId),
    'chat events never leak to the other browser'
  );

  // Chat activity made Edge primary: unqualified harness calls follow it.
  const cli = fakeHarness(hub.url);
  t.after(() => cli.close());
  await cli.open;
  const r = await cli.call('tabs_list');
  assert.equal(r.ok, true);
  assert.equal(ext2.calls.length, 1);
  assert.equal(ext1.calls.length, 0);

  const list = await cli.call('browsers_list');
  assert.equal(list.result.using, 'b-edge');
});

test('disconnect fails only that browser\'s pending calls and primary moves on', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext1 = fakeExtension(hub.url, CHROME, { tabs_list: TABS });
  const ext2 = fakeExtension(hub.url, EDGE, { tabs_list: TABS, slow_tool: null });
  t.after(() => { ext1.close(); ext2.close(); });
  await Promise.all([ext1.open, ext2.open]);
  await waitFor(ext2.msgs, (m) => m.type === 'capabilities' && m.browsers.length === 2);

  // Make Edge primary via a chat.
  ext2.send({ type: 'chat', chatId: 'mb-die', text: 'hi', adapter: 'stub' });
  await waitFor(ext2.msgs, (m) => m.type === 'chat_event' && m.event.kind === 'done');

  const cli = fakeHarness(hub.url);
  t.after(() => cli.close());
  await cli.open;

  // A call that stays pending on Edge, then Edge goes away mid-flight.
  const pendingResult = cli.call('slow_tool');
  await waitFor(ext2.calls, () => true);
  ext2.close();
  const dead = await pendingResult;
  assert.equal(dead.ok, false);
  assert.match(dead.error, /extension disconnected/);

  // The surviving browser took over as primary and still serves calls.
  const r = await cli.call('tabs_list');
  assert.equal(r.ok, true);
  assert.equal(ext1.calls.length, 1);

  // Same-id reconnect only replaces the stale socket, not the other browser.
  const ext2b = fakeExtension(hub.url, EDGE, { tabs_list: TABS });
  t.after(() => ext2b.close());
  await ext2b.open;
  await waitFor(ext1.msgs, (m) => m.type === 'capabilities' && m.browsers.length === 2);
  assert.ok(!ext1.isClosed(), 'the other browser is untouched by a reconnect');
  const r2 = await cli.call('navigate', { url: 'https://x', browser: 'b-edge' });
  assert.equal(r2.ok, false); // ext2b has no navigate handler -> extension-side error proves routing
  assert.match(r2.error, /no fake handler for navigate/);
});

// A second live socket claiming an already-connected browser id — a cloned or
// synced profile — is rejected with `superseded`, not swapped in: closing the
// incumbent would start a reconnect ping-pong between two auto-reconnecting
// clients. The incumbent keeps its slot; the newcomer backs off client-side.
test('a duplicate live browser id is superseded, incumbent keeps the slot', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext1 = fakeExtension(hub.url, CHROME, { tabs_list: TABS });
  t.after(() => ext1.close());
  await ext1.open;
  await waitFor(ext1.msgs, (m) => m.type === 'capabilities' && m.browsers.length === 1);

  const dup = fakeExtension(hub.url, { id: 'b-chrome', name: 'Chrome clone' }, { tabs_list: TABS });
  t.after(() => dup.close());
  await dup.open;
  const rejected = await waitFor(dup.msgs, (m) => m.type === 'superseded');
  assert.match(rejected.reason, /b-chrome/);
  await waitFor([0], () => dup.isClosed() && 'closed', 4000).catch(() => {});
  assert.ok(dup.isClosed(), 'duplicate socket is closed by the hub');
  assert.ok(!ext1.isClosed(), 'incumbent is not displaced by a duplicate hello');

  // The incumbent still serves calls; the connection table never saw the clone.
  const cli = fakeHarness(hub.url);
  t.after(() => cli.close());
  await cli.open;
  const r = await cli.call('browsers_list');
  assert.equal(r.result.browsers.length, 1);
  assert.equal(r.result.browsers[0].id, 'b-chrome');
  const r2 = await cli.call('tabs_list');
  assert.equal(r2.ok, true);
  assert.equal(ext1.calls.length, 1);
  assert.equal(dup.calls.length, 0, 'no call ever routed to the rejected socket');
});
