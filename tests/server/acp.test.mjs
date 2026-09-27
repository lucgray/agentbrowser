import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAcpSpecSession, ACP_PRESETS, ACP_NAMES } from '../../server/adapters/acp.mjs';
import { createSession, probeAdapter } from '../../server/adapters/base.mjs';

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
const SPEC = { command: process.execPath, args: [FAKE_AGENT] };

function collect(session, text) {
  const events = [];
  return session
    .send(text, (e) => events.push(e))
    .then(() => events);
}

test('acp adapters are registered for every preset', () => {
  assert.equal(ACP_NAMES.length, 8);
  for (const name of ACP_NAMES) {
    assert.ok(ACP_PRESETS[name].command, `${name} has a spawn command`);
    assert.doesNotThrow(() => createSession(name, {}), `${name} creates a session`);
  }
});

test('a full ACP turn emits token, titled tool chip, gated result, meta, done', async () => {
  const session = createAcpSpecSession('acp-fake', SPEC, { model: null });
  const events = await collect(session, 'run the tests');
  session.dispose();

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds[kinds.length - 2], 'meta');
  assert.equal(kinds[kinds.length - 1], 'done');

  const tokens = events.filter((e) => e.kind === 'token').map((e) => e.text);
  assert.deepEqual(tokens, ['Checking the code. ', 'All green.']);

  const thinking = events.find((e) => e.kind === 'thinking');
  assert.equal(thinking.text, 'tests first');

  const call = events.find((e) => e.kind === 'tool_use');
  assert.equal(call.tool, 'bash');
  assert.equal(call.label, 'run the tests');
  assert.equal(call.id, 'tc1');

  const result = events.find((e) => e.kind === 'tool_result');
  assert.equal(result.ok, true);
  assert.equal(result.id, 'tc1');
  assert.equal(result.summary, '87 passing');

  // The turn only resolved because our permission auto-answer unblocked the
  // fake agent — proves request_permission is answered, not hung.
}, { timeout: 15000 });

test('concurrent send on a live turn is refused', async () => {
  const session = createAcpSpecSession('acp-fake', SPEC, { model: null });
  const first = collect(session, 'first');
  const secondEvents = await collect(session, 'second');
  assert.equal(secondEvents[0].kind, 'error');
  assert.match(secondEvents[0].message, /already in progress/);
  assert.equal(secondEvents[1].kind, 'done');
  await first;
  session.dispose();
}, { timeout: 15000 });

test('probeAdapter reports acp presets by their spawn prerequisite', () => {
  // npx is installed with node, so the npm-wrapped presets probe ready here;
  // the native-bin presets report missing-cli on this CI-less box.
  const probe = probeAdapter('acp-gemini');
  assert.equal(probe.status === 'ready' || probe.status === 'missing-cli', true);
});

test('session/new failure surfaces as error + done', async () => {
  const dead = { command: process.execPath, args: ['-e', 'process.exit(1)'] };
  const session = createAcpSpecSession('acp-dead', dead, { model: null });
  const events = await collect(session, 'hi');
  session.dispose();
  assert.equal(events[0].kind, 'error');
  assert.equal(events[events.length - 1].kind, 'done');
}, { timeout: 15000 });
