import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHub } from '../../server/native/hub-keeper.mjs';
import { manifestJson, launcherSource, BROWSERS } from '../../server/native/install.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hubkeeper-'));
}

test('ensureHub: port already up -> already:true, no spawn', async () => {
  let spawns = 0;
  const res = await ensureHub({
    port: 9999,
    lock: path.join(tmpdir(), 'l'),
    probeFn: async () => true,
    spawnFn: () => spawns++,
    waitMs: 100,
  });
  assert.equal(res.ok, true);
  assert.equal(res.already, true);
  assert.equal(spawns, 0);
});

test('ensureHub: port closed -> one spawn; concurrent callers share it', async () => {
  let spawns = 0;
  let up = false;
  const probeFn = async () => up;
  const spawnFn = () => {
    spawns++;
    setTimeout(() => {
      up = true;
    }, 30);
  };
  const dir = tmpdir();
  const opts = { port: 9999, lock: path.join(dir, 'l'), probeFn, spawnFn, waitMs: 2000 };
  const [a, b] = await Promise.all([ensureHub(opts), ensureHub({ ...opts })]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(spawns, 1);
  // lock released afterwards — a later ensure can take it again
  assert.equal(fs.existsSync(path.join(dir, 'l')), false);
});

test('ensureHub: spawn throws -> ok:false, lock freed', async () => {
  const dir = tmpdir();
  const lock = path.join(dir, 'l');
  const res = await ensureHub({
    port: 9999,
    lock,
    probeFn: async () => false,
    spawnFn: () => {
      throw new Error('boom');
    },
    waitMs: 50,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
  assert.equal(fs.existsSync(lock), false);
});

test('ensureHub: never comes up -> ok:false within waitMs', async () => {
  const res = await ensureHub({
    port: 9999,
    lock: path.join(tmpdir(), 'l'),
    probeFn: async () => false,
    spawnFn: () => {},
    waitMs: 300,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not listening/);
});

test('manifestJson: name, launcher path, stdio, allowed origin', () => {
  const m = manifestJson('abc123', '/home/u/.agentchat/native/run-host');
  assert.equal(m.name, 'com.agentbrowser.hub');
  assert.equal(m.path, '/home/u/.agentchat/native/run-host');
  assert.equal(m.type, 'stdio');
  assert.deepEqual(m.allowed_origins, ['chrome-extension://abc123/']);
});

test('launcherSource: absolute node + keeper path on both platforms', () => {
  const posix = launcherSource('linux', '/usr/bin/node', '/repo/server/native/hub-keeper.mjs');
  assert.match(posix, /^#!\/bin\/sh\nexec "\/usr\/bin\/node" "\/repo\/server\/native\/hub-keeper\.mjs"\n$/);
  const win = launcherSource('win32', 'C:\\node\\node.exe', 'C:\\repo\\server\\native\\hub-keeper.mjs');
  assert.match(win, /"C:\\node\\node\.exe" "C:\\repo\\server\\native\\hub-keeper\.mjs"/);
});

test('BROWSERS covers all four channels on every platform', () => {
  for (const name of ['chrome', 'edge', 'brave', 'chromium']) {
    assert.ok(BROWSERS[name].linux, name);
    assert.ok(BROWSERS[name].darwin, name);
    assert.ok(BROWSERS[name].win32, name);
  }
});
