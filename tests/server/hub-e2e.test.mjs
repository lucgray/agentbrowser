// Independent end-to-end verification against a REAL hub over a REAL WebSocket,
// with a stub adapter module (no model tokens, no CLI spawn).
//
// Covers PROTOCOL v1.3 loop safety (section C) and cost honesty (section A).
//
//   node --test server/hub-e2e.test.mjs

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
  child.stdout.on('data', () => {});

  // Wait for the port to accept.
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
    child,
    log,
    stderrText: () => stderr,
    stubLines: () => {
      try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); }
      catch { return []; }
    },
    stop() {
      child.kill('SIGKILL');
      try { fs.unlinkSync(log); } catch {}
    }
  };
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];       // {chatId, event}
  const messages = [];     // every parsed message
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    if (msg.type === 'chat_event') events.push(msg);
    for (const w of waiters.slice()) {
      if (w.test(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    events,
    messages,
    open,
    send(obj) { ws.send(JSON.stringify(obj)); },
    waitFor(predicate, ms = 10000) {
      const hit = messages.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { test: predicate, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) {
            waiters.splice(i, 1);
            reject(new Error('timed out waiting for a message'));
          }
        }, ms);
      });
    },
    eventsFor(chatId, kind) {
      return events
        .filter((m) => m.chatId === chatId && (!kind || m.event.kind === kind))
        .map((m) => m.event);
    },
    close() { try { ws.close(); } catch {} }
  };
}

async function hello(client) {
  await client.open;
  client.send({ type: 'hello', role: 'extension', version: '1.0.0' });
  await client.waitFor((m) => m.type === 'capabilities');
}

// -----------------------------------------------------------------------
// LOOP SAFETY (check 2)
// -----------------------------------------------------------------------

test('/loop rejects n > 20 before iteration one', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'loop-cap';
  c.send({ type: 'command', chatId, name: 'loop', args: '21 do a thing', adapter: 'stub' });
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done');

  const errors = c.eventsFor(chatId, 'error');
  assert.equal(errors.length, 1, 'one error');
  assert.match(errors[0].message, /capped at 20 iterations/);
  assert.equal(c.eventsFor(chatId, 'done').length, 1, 'done exactly once');
  assert.equal(
    c.eventsFor(chatId, 'info').filter((e) => /^iteration /.test(e.message)).length,
    0,
    'no iteration ran'
  );
  // No adapter session was even created for the rejected loop.
  assert.equal(hub.stubLines().filter((l) => l.startsWith('send ')).length, 0);
  c.close();
});

test('/loop stops within one iteration of chat_abort', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '250' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'loop-abort';
  c.send({ type: 'command', chatId, name: 'loop', args: '20 keep going', adapter: 'stub' });

  // Let two iterations start, then pull the plug.
  await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId &&
      m.event.kind === 'info' && m.event.message === 'iteration 2/20'
  );
  const atAbort = c.eventsFor(chatId, 'info').filter((e) => /^iteration /.test(e.message)).length;
  c.send({ type: 'chat_abort', chatId });

  const t0 = Date.now();
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done');
  const stopMs = Date.now() - t0;

  const iterations = c.eventsFor(chatId, 'info').filter((e) => /^iteration /.test(e.message));
  assert.ok(
    iterations.length <= atAbort + 1,
    `ran ${iterations.length} iterations, abort was sent at ${atAbort}; must stop within one`
  );
  assert.ok(iterations.length < 20, 'did not run to the cap');
  assert.ok(stopMs < 1500, `took ${stopMs}ms to stop after abort`);
  const infos = c.eventsFor(chatId, 'info').map((e) => e.message).join('\n');
  assert.match(infos, /stopped by the user/);
  assert.equal(c.eventsFor(chatId, 'done').length, 1);
  assert.equal(c.eventsFor(chatId, 'meta').length, 1, 'one meta for the whole command');

  // And nothing kept sending after the stop.
  const sendsAtStop = hub.stubLines().filter((l) => l.startsWith('send ')).length;
  await sleep(700);
  assert.equal(
    hub.stubLines().filter((l) => l.startsWith('send ')).length,
    sendsAtStop,
    'no further adapter sends after the loop reported stopped'
  );
  c.close();
});

test('/loop stops when the extension disconnects', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '150' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'loop-disconnect';
  c.send({ type: 'command', chatId, name: 'loop', args: '20 keep going', adapter: 'stub' });
  await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId &&
      m.event.kind === 'info' && m.event.message === 'iteration 2/20'
  );

  // The user walks away: the panel/extension socket goes.
  c.close();
  await sleep(400);
  const sendsSoon = hub.stubLines().filter((l) => l.startsWith('send ')).length;
  await sleep(1200);
  const sendsLater = hub.stubLines().filter((l) => l.startsWith('send ')).length;

  assert.equal(sendsLater, sendsSoon, 'the loop kept running after the extension disconnected');
  assert.ok(sendsLater < 20, `ran ${sendsLater} of 20 iterations, so it stopped early`);
  assert.match(hub.stderrText(), /extension disconnected/);
  assert.match(hub.stderrText(), /aborting \/loop \(extension disconnected\)/);
});

// A `chat` arriving mid-loop is REFUSED (PROTOCOL: one turn at a time per
// chatId), so it never reaches getSessionEntry and never disposes the session.
// That is what makes disposeSession's abortCommand call defensive rather than
// the disconnect path's twin: the reachable stops are chat_abort and the
// extension going away, both proved above.
test('a chat arriving mid-loop is refused and does not disturb the loop', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '150' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'loop-guard';
  c.send({ type: 'command', chatId, name: 'loop', args: '5 keep going', adapter: 'stub' });
  await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId &&
      m.event.kind === 'info' && m.event.message === 'iteration 2/5'
  );

  c.send({ type: 'chat', chatId, text: 'switch', adapter: 'codex', model: 'claude-sonnet-5' });
  const err = await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'error'
  );
  assert.match(err.event.message, /still running in this chat/);

  // The loop survives the refused chat and finishes all five iterations.
  await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId &&
      m.event.kind === 'info' && /finished 5 of 5 iterations/.test(m.event.message || ''),
    8000
  );
  const iterations = c.eventsFor(chatId, 'info').filter((e) => /^iteration /.test(e.message));
  assert.equal(iterations.length, 5);
  // No adapter switch happened: every send went to the stub under the original
  // adapter name, and no session was disposed mid-command.
  assert.equal(hub.stubLines().filter((l) => l.startsWith('send stub')).length, 5);
  assert.ok(!/session disposed/.test(hub.stderrText()));
  c.close();
});

test('/goal wall-clock cap binds (dispatch maxMs, clamped)', async () => {
  const { dispatch, LOOP_MAX_MS } = await import('../../server/hub/commands.mjs');
  const events = [];
  const controller = new AbortController();
  let sends = 0;
  const session = {
    async send(text, emit) {
      sends += 1;
      await sleep(60);
      emit({ kind: 'token', text: 'GOAL: NOT MET' });
      emit({ kind: 'meta', inputTokens: 10, outputTokens: 20 });
      emit({ kind: 'done' });
    },
    abort() { controller.abort(); },
    dispose() {}
  };
  const ctx = {
    chatId: 'x', adapter: 'stub', model: null, context: null,
    callBrowserTool: async () => ({}),
    createSession: async () => session,
    abort: () => controller.abort(),
    touch: () => {},
    log: () => {}
  };
  const t0 = Date.now();
  await dispatch('goal', {
    args: 'the page says hello',
    session,
    emit: (e) => events.push(e),
    ctx,
    signal: controller.signal,
    maxMs: 300
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `goal ran ${elapsed}ms past a 300ms cap`);
  assert.ok(sends < 20, `ran ${sends} iterations, the wall clock should have cut it first`);
  const infos = events.filter((e) => e.kind === 'info').map((e) => e.message).join('\n');
  assert.match(infos, /wall clock cap/);
  // maxMs can only tighten: a caller asking for more than 15 minutes gets 15.
  assert.equal(LOOP_MAX_MS, 15 * 60 * 1000);
});

test('a second command on a live chatId is refused', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '250' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'one-turn';
  c.send({ type: 'command', chatId, name: 'loop', args: '20 keep going', adapter: 'stub' });
  await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId &&
      m.event.kind === 'info' && m.event.message === 'iteration 1/20'
  );
  c.send({ type: 'command', chatId, name: 'help', args: '', adapter: 'stub' });
  const err = await c.waitFor(
    (m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'error'
  );
  assert.match(err.event.message, /already running/);
  c.send({ type: 'chat_abort', chatId });
  c.close();
});

// -----------------------------------------------------------------------
// COST HONESTY (check 3) — end to end through the hub, not through pricing.mjs
// -----------------------------------------------------------------------

const SUBSCRIPTION = ['claude-cli', 'codex', 'copilot', 'grok', 'agy', 'claude-agent-sdk', 'gemini', 'opencode', 'devin'];
const METERED = ['anthropic-api', 'openai-api'];

test('costUsd is null for every subscription-backed adapter and a number for the metered API adapters', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '5' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const seen = {};
  for (const adapter of [...SUBSCRIPTION, ...METERED]) {
    const chatId = 'cost-' + adapter;
    c.send({ type: 'chat', chatId, text: 'hi', adapter, model: 'claude-opus-5' });
    await c.waitFor(
      (m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done'
    );
    const metas = c.eventsFor(chatId, 'meta');
    assert.equal(metas.length, 1, `${adapter}: exactly one meta`);
    seen[adapter] = metas[0];
  }

  for (const adapter of SUBSCRIPTION) {
    assert.equal(
      seen[adapter].costUsd, null,
      `${adapter} is subscription-backed, costUsd must be null (got ${seen[adapter].costUsd})`
    );
  }
  for (const adapter of METERED) {
    assert.equal(
      typeof seen[adapter].costUsd, 'number',
      `${adapter} is metered, costUsd must be a number (got ${seen[adapter].costUsd})`
    );
    assert.ok(seen[adapter].costUsd > 0, `${adapter} costUsd should be positive`);
  }
  // 1000 in + 2000 out on claude-opus-5 = 1000*5/1e6 + 2000*25/1e6 = 0.055
  assert.equal(seen['anthropic-api'].costUsd, 0.055);

  // Every meta carries the full v1.3 field set, whatever the adapter reported.
  for (const adapter of Object.keys(seen)) {
    const m = seen[adapter];
    for (const field of [
      'model', 'adapter', 'elapsedMs', 'inputTokens', 'outputTokens',
      'cacheReadTokens', 'cacheWriteTokens', 'sessionInputTokens',
      'sessionOutputTokens', 'costUsd'
    ]) {
      assert.ok(field in m, `${adapter} meta is missing ${field}`);
    }
    assert.equal(m.adapter, adapter);
  }
  c.close();
});

test('session totals accumulate once per turn, not twice', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '5' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  const chatId = 'totals';
  for (let turn = 1; turn <= 3; turn += 1) {
    c.send({ type: 'chat', chatId, text: 'hi ' + turn, adapter: 'stub', model: 'claude-opus-5' });
    await c.waitFor(
      (m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done' &&
        c.eventsFor(chatId, 'done').length === turn
    );
  }
  const metas = c.eventsFor(chatId, 'meta');
  assert.equal(metas.length, 3, 'one meta per turn, no duplicate from the hub synthesizer');
  assert.deepEqual(metas.map((m) => m.inputTokens), [1000, 1000, 1000]);
  assert.deepEqual(metas.map((m) => m.sessionInputTokens), [1000, 2000, 3000]);
  assert.deepEqual(metas.map((m) => m.sessionOutputTokens), [2000, 4000, 6000]);
  c.close();
});

// -----------------------------------------------------------------------
// SEAM (check 4)
// -----------------------------------------------------------------------

test('capabilities carries the command registry and the lane field survives the wire', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '5' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await c.open;
  c.send({ type: 'hello', role: 'extension', version: '1.0.0' });
  const caps = await c.waitFor((m) => m.type === 'capabilities');

  assert.ok(Array.isArray(caps.adapters) && caps.adapters.length > 0);
  assert.ok(Array.isArray(caps.commands), 'capabilities.commands present');
  const { COMMANDS } = await import('../../server/hub/commands.mjs');
  assert.deepEqual(caps.commands, JSON.parse(JSON.stringify(COMMANDS)));
  for (const cmd of caps.commands) {
    for (const field of ['name', 'args', 'summary', 'scope']) {
      assert.ok(field in cmd, `command ${cmd.name} missing ${field}`);
    }
    assert.ok(cmd.scope === 'client' || cmd.scope === 'server');
  }

  // /parallel tags every lane event.
  const chatId = 'lanes';
  c.send({
    type: 'command', chatId, name: 'parallel', args: 'read the page', adapter: 'stub',
    context: { currentTab: null, tabs: [{ tabId: 11, url: 'a', title: 'A' }, { tabId: 22, url: 'b', title: 'B' }] }
  });
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === chatId && m.event.kind === 'done');

  const tokens = c.eventsFor(chatId, 'token');
  assert.equal(tokens.length, 2, 'one token event per lane');
  const laneTabIds = tokens.map((e) => e.lane && e.lane.tabId).sort();
  assert.deepEqual(laneTabIds, [11, 22]);
  for (const e of tokens) {
    assert.equal(typeof e.lane.index, 'number');
    assert.equal(typeof e.lane.title, 'string');
  }
  const summary = c.eventsFor(chatId, 'info').map((e) => e.message).join('\n');
  assert.match(summary, /2 ok, 0 failed/);
  assert.equal(c.eventsFor(chatId, 'meta').length, 1);
  assert.equal(c.eventsFor(chatId, 'done').length, 1);
  // Lane usage is summed into the one command meta.
  assert.equal(c.eventsFor(chatId, 'meta')[0].inputTokens, 2000);

  // Lane sessions are disposed with the command. A leak here is an orphaned
  // CLI child process per lane on the real adapters.
  const lines = hub.stubLines();
  assert.equal(lines.filter((l) => l.startsWith('create ')).length, 2, 'two lane sessions created');
  assert.equal(lines.filter((l) => l.startsWith('dispose ')).length, 2, 'both lane sessions disposed');
  c.close();
});

test('goalMet: last marker wins and NOT MET never reads as met', async () => {
  const { goalMet } = await import('../../server/hub/commands.mjs');
  assert.equal(goalMet('GOAL: NOT MET'), false);
  assert.equal(goalMet('GOAL: MET'), true);
  assert.equal(goalMet('goal: met'), true, 'case insensitive');
  assert.equal(goalMet('GOAL:   NOT   MET'), false, 'tolerates spacing');
  assert.equal(goalMet('I will end with GOAL: MET when done.\n\nGOAL: NOT MET'), false, 'last marker wins');
  assert.equal(goalMet('Earlier I said GOAL: NOT MET.\n\nGOAL: MET'), true, 'last marker wins');
  assert.equal(goalMet('no marker at all'), false);
  assert.equal(goalMet(''), false);
  assert.equal(goalMet(null), false);
});

test('/parallel with no tagged tabs is an error, and /help needs no session', async (t) => {
  const hub = await startHub({ STUB_SEND_MS: '5' });
  t.after(() => hub.stop());
  const c = connect(hub.port);
  await hello(c);

  c.send({ type: 'command', chatId: 'p0', name: 'parallel', args: 'do it', adapter: 'stub' });
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === 'p0' && m.event.kind === 'done');
  assert.match(c.eventsFor('p0', 'error')[0].message, /needs @-tagged tabs/);

  c.send({ type: 'command', chatId: 'h0', name: 'help', args: '', adapter: 'stub' });
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === 'h0' && m.event.kind === 'done');
  const help = c.eventsFor('h0', 'info').map((e) => e.message).join('\n');
  assert.match(help, /\/loop/);
  assert.match(help, /\/parallel/);
  assert.equal(c.eventsFor('h0', 'error').length, 0);
  // No session was created for /help.
  assert.equal(hub.stubLines().filter((l) => l.startsWith('create ')).length, 0);

  // A client-scope command reaching the hub is an error + done, not a crash.
  c.send({ type: 'command', chatId: 'c0', name: 'clear', args: '', adapter: 'stub' });
  await c.waitFor((m) => m.type === 'chat_event' && m.chatId === 'c0' && m.event.kind === 'done');
  assert.match(c.eventsFor('c0', 'error')[0].message, /handled by the side panel/);
  c.close();
});
