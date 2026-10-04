import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'ab-catalog-'));
// Isolate the cache through the product's own override. os.homedir() ignores
// HOME on Windows, so env-only redirection would silently touch the real
// catalog from a test run.
process.env.AGENTCHAT_CATALOG_DIR = path.join(tmpHome, 'catalog');

const { loadCatalog } = await import('../../server/adapters/model-catalog.mjs');
const CACHE = path.join(process.env.AGENTCHAT_CATALOG_DIR, 'model-catalog.json');

function seedCache(models, probedAt = Date.now()) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ probedAt, models }));
}

function writeShim(file, body) {
  if (process.platform === 'win32') {
    writeFileSync(file, body.cmd);
  } else {
    writeFileSync(file, body.sh);
    chmodSync(file, 0o755);
  }
  return file;
}

// Prints the two indented lines the devin parser matches. Shims are
// per-platform: Windows runs .cmd through cmd.exe — it cannot exec sh scripts.
function fakeDevinShim() {
  return writeShim(path.join(tmpHome, process.platform === 'win32' ? 'fake-devin.cmd' : 'fake-devin.sh'), {
    sh: '#!/bin/sh\nprintf "Available models\\n  swe-2  SWE-2\\n  swe-2-high  SWE-2 High\\n"\n',
    cmd: ['@echo off', 'echo Available models', 'echo   swe-2  SWE-2', 'echo   swe-2-high  SWE-2 High', ''].join('\r\n')
  });
}

// Prints nothing: the probe comes back empty, deterministically on every OS.
function emptyDevinShim() {
  return writeShim(path.join(tmpHome, process.platform === 'win32' ? 'empty-devin.cmd' : 'empty-devin.sh'), {
    sh: '#!/bin/sh\nexit 0\n',
    cmd: '@echo off\r\n'
  });
}

function withDevinShim(t, shim) {
  const old = process.env.AGENTCHAT_BIN_DEVIN;
  process.env.AGENTCHAT_BIN_DEVIN = shim;
  t.after(() => {
    if (old === undefined) delete process.env.AGENTCHAT_BIN_DEVIN;
    else process.env.AGENTCHAT_BIN_DEVIN = old;
  });
}

test('acp-<cli> mirrors the base probe — one probe feeds both transports', async (t) => {
  withDevinShim(t, fakeDevinShim());
  const models = await loadCatalog({ force: true });
  assert.deepEqual(models.devin, [
    { id: 'swe-2', label: 'SWE-2' },
    { id: 'swe-2-high', label: 'SWE-2 High' },
  ]);
  assert.deepEqual(models['acp-devin'], models.devin);
  // agy has no model probe to mirror — only probed CLIs get acp keys.
  for (const base of ['codex', 'opencode', 'grok', 'gemini', 'copilot', 'claude']) {
    assert.ok(`acp-${base}` in models, `acp-${base} mirrored`);
    assert.deepEqual(models[`acp-${base}`], models[base]);
  }
});

test('fresh cache missing new probe keys still resolves them (upgrade window)', async (t) => {
  withDevinShim(t, fakeDevinShim());
  // Pre-upgrade cache shape: fresh timestamp, base keys only, no acp-* keys.
  seedCache({ devin: [{ id: 'swe-2', label: 'SWE-2' }] });
  const models = await loadCatalog();
  assert.deepEqual(models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
  // The rewritten cache now carries the mirrored acp keys.
  const written = JSON.parse(readFileSync(CACHE, 'utf8'));
  assert.deepEqual(written.models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
});

test('stale cache falls back per-key when probes return empty', async (t) => {
  withDevinShim(t, emptyDevinShim());
  seedCache({ devin: [{ id: 'swe-2', label: 'SWE-2' }] }, Date.now() - 7 * 60 * 60 * 1000);
  const models = await loadCatalog();
  assert.deepEqual(models.devin, [{ id: 'swe-2', label: 'SWE-2' }]);
  assert.deepEqual(models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
});

test('a failed probe never erases a known-good list — even under force', async (t) => {
  // A good catalog exists from an earlier run…
  seedCache({ devin: [{ id: 'swe-2', label: 'SWE-2' }] }, Date.now() - 7 * 60 * 60 * 1000);
  // …then the binary breaks (or the probe times out) and something forces a
  // re-probe: the empty result must not overwrite the last known-good list.
  withDevinShim(t, emptyDevinShim());
  const models = await loadCatalog({ force: true });
  assert.deepEqual(models.devin, [{ id: 'swe-2', label: 'SWE-2' }]);
  const written = JSON.parse(readFileSync(CACHE, 'utf8'));
  assert.deepEqual(written.models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
});
