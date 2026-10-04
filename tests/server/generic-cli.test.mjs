import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGenericCliSession } from '../../server/adapters/generic-cli.mjs';

// Stand-in for `devin -p`: dies with the real resume error whenever -c is in
// argv, otherwise echoes its argv so the test can inspect what was passed.
// POSIX gets a sh script; Windows gets a .cmd — cmd.exe cannot exec sh scripts.
const FAKE_DEVIN_SH = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-c" ]; then
    echo "Error: failed to start ACP agent session" >&2
    exit 1
  fi
done
echo "ok:$*"
`;

const FAKE_DEVIN_CMD = [
  '@echo off',
  'setlocal enabledelayedexpansion',
  'set "ARGS="',
  ':loop',
  'if "%~1"=="" goto done',
  'if "%~1"=="-c" (',
  '  echo Error: failed to start ACP agent session 1>&2',
  '  exit /b 1',
  ')',
  'set "ARGS=!ARGS! %~1"',
  'shift',
  'goto loop',
  ':done',
  'echo ok!ARGS!',
  ''
].join('\r\n');

function withFakeDevin(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-devin-cli-'));
  const win = process.platform === 'win32';
  const bin = join(dir, win ? 'fake-devin.cmd' : 'fake-devin');
  writeFileSync(bin, win ? FAKE_DEVIN_CMD : FAKE_DEVIN_SH);
  if (!win) chmodSync(bin, 0o755);
  const old = process.env.AGENTCHAT_BIN_DEVIN;
  process.env.AGENTCHAT_BIN_DEVIN = bin;
  t.after(() => {
    if (old === undefined) delete process.env.AGENTCHAT_BIN_DEVIN;
    else process.env.AGENTCHAT_BIN_DEVIN = old;
    rmSync(dir, { recursive: true, force: true });
  });
}

function collect(session, text) {
  const events = [];
  return session.send(text, (e) => events.push(e)).then(() => events);
}

test('devin preset passes --model and retries once without -c on resume failure', async (t) => {
  withFakeDevin(t);
  const session = createGenericCliSession('devin', { model: 'swe-2-high' });

  const first = await collect(session, 'hello');
  const firstTok = first.find((e) => e.kind === 'token');
  assert.ok(firstTok, 'first turn produced a token');
  assert.match(firstTok.text, /--model swe-2-high/);
  assert.equal(first[first.length - 1].kind, 'done');

  const second = await collect(session, 'again');
  session.dispose();

  assert.equal(second.find((e) => e.kind === 'error'), undefined);
  const info = second.find((e) => e.kind === 'info');
  assert.ok(info && /retrying as a fresh chat/.test(info.message), 'notes the -c retry');
  const tok = second.find((e) => e.kind === 'token');
  assert.ok(tok, 'retry turn produced a token');
  assert.equal(/ -c /.test(` ${tok.text} `), false);
  assert.match(tok.text, /--model swe-2-high/);
  assert.equal(second[second.length - 1].kind, 'done');
}, { timeout: 15000 });
