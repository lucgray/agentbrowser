// End-to-end verification of the agentbrowser CLI against a REAL hub over a
// REAL WebSocket, with a fake extension answering tool_calls (no browser).
// Mirrors hub-e2e.test.mjs: spawns hub/hub.mjs with the stub adapter, wires a
// role:"extension" client that replies to tool_call with canned results.
//
//   node --test tests/server/cli-session.e2e.test.mjs

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
const CLI = path.join(here, '../../server/proxy/agentbrowser-cli.mjs');

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
    stop() {
      child.kill('SIGKILL');
      try { fs.unlinkSync(log); } catch {}
    }
  };
}

// Fake extension: hello like the real one, then answer tool_call per `handlers`
// (tool name -> args -> result object). tool_result echoes the caller's id.
function fakeExtension(hubUrl, handlers) {
  const ws = new WebSocket(hubUrl);
  const seen = [];
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'extension', version: '1.0.0' }));
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== 'tool_call') return;
    seen.push(msg);
    const handler = handlers[msg.tool];
    if (!handler) {
      ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, ok: false, error: `no fake handler for ${msg.tool}` }));
      return;
    }
    ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, ok: true, result: handler(msg.args || {}) }));
  });
  return {
    open,
    seen,
    close() { try { ws.close(); } catch {} }
  };
}

function runCli(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 'timeout', stdout, stderr });
    }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

test('CLI one-shot --output: file saved with PNG magic, stdout carries no base64', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext = fakeExtension(hub.url, {
    screenshot: () => ({ base64: PNG_B64, mimeType: 'image/png' })
  });
  t.after(() => ext.close());
  await ext.open;

  const out = path.join(os.tmpdir(), `ab-e2e-${Date.now()}.png`);
  t.after(() => { try { fs.unlinkSync(out); } catch {} });
  const { code, stdout } = await runCli(['screenshot', '{}', '--output', out, '--hub', hub.url]);
  assert.equal(code, 0, `exit ${code}: ${stdout}`);
  assert.ok(!stdout.includes('iVBOR'), 'stdout must not carry the base64 payload');
  const meta = JSON.parse(stdout.trim());
  assert.equal(meta.mimeType, 'image/png');
  assert.ok(meta.saved.endsWith('.png'));
  assert.ok(!('base64' in meta));
  assert.deepEqual([...fs.readFileSync(out).subarray(0, 8)], PNG_MAGIC);
});

test('CLI one-shot without --output: full payload prints (unchanged behavior)', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext = fakeExtension(hub.url, {
    screenshot: () => ({ base64: PNG_B64, mimeType: 'image/png' })
  });
  t.after(() => ext.close());
  await ext.open;

  const { code, stdout } = await runCli(['screenshot', '{}', '--hub', hub.url]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.base64, PNG_B64, 'pretty JSON must still carry the payload');
  assert.equal(result.mimeType, 'image/png');
});

test('CLI session: many calls share one connection, errors continue, exit stops the loop', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  const ext = fakeExtension(hub.url, {
    screenshot: () => ({ base64: PNG_B64, mimeType: 'image/png' }),
    tabs_list: () => ({ tabs: [{ tabId: 1, url: 'https://example.com', title: 'Example' }] })
  });
  t.after(() => ext.close());
  await ext.open;

  const out = path.join(os.tmpdir(), `ab-e2e-sess-${Date.now()}.png`);
  t.after(() => { try { fs.unlinkSync(out); } catch {} });
  const input = [
    '# a comment line is skipped',
    `screenshot {} --output ${out.replace(/\\/g, '/')}`,
    'tabs_list {}',
    'bogus_tool {}',
    'exit',
    'tabs_list {}' // after exit: must be ignored
  ].join('\n') + '\n';

  const { code, stdout } = await runCli(['session', '--hub', hub.url], input);
  assert.equal(code, 0, `exit ${code}: ${stdout}`);
  assert.ok(!stdout.includes('iVBOR'), 'session stdout must not carry the base64 payload');

  // The metadata line for the screenshot call.
  const metaLine = stdout.split('\n').find((l) => l.includes('"saved"'));
  assert.ok(metaLine, 'metadata line printed');
  const meta = JSON.parse(metaLine);
  assert.deepEqual([...fs.readFileSync(meta.saved).subarray(0, 8)], PNG_MAGIC);

  // tabs_list result printed exactly once (the post-exit line is ignored).
  assert.equal((stdout.match(/"tabs"/g) || []).length, 1);

  // The unknown tool errored without killing the loop.
  assert.ok(stdout.includes('unknown tool: bogus_tool'));

  // Extension answered exactly the two calls that reach it (bogus_tool is
  // rejected client-side, the post-exit line is never read).
  assert.equal(ext.seen.length, 2);
  assert.equal(ext.seen[0].tool, 'screenshot');
  assert.equal(ext.seen[1].tool, 'tabs_list');
});
