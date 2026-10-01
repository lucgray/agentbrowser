import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'ab-catalog-'));
process.env.HOME = tmpHome;

const { loadCatalog } = await import('../../server/adapters/model-catalog.mjs');
const CACHE = path.join(tmpHome, '.agentchat', 'model-catalog.json');

function seedCache(models, probedAt = Date.now()) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ probedAt, models }));
}

function fakeDevinShim() {
  const shim = path.join(tmpHome, 'fake-devin.sh');
  writeFileSync(shim, '#!/bin/sh\nprintf "SWE-2 (swe-2)\\n  swe-2  SWE-2\\n  swe-2-high  SWE-2 High\\n"\n');
  chmodSync(shim, 0o755);
  return shim;
}

test('acp-<cli> mirrors the base probe — one probe feeds both transports', async () => {
  process.env.AGENTCHAT_BIN_DEVIN = fakeDevinShim();
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

test('fresh cache missing new probe keys still resolves them (upgrade window)', async () => {
  // Pre-upgrade cache shape: fresh timestamp, base keys only, no acp-* keys.
  seedCache({ devin: [{ id: 'swe-2', label: 'SWE-2' }] });
  const models = await loadCatalog();
  assert.deepEqual(models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
  // The rewritten cache now carries the mirrored acp keys.
  const written = JSON.parse(readFileSync(CACHE, 'utf8'));
  assert.deepEqual(written.models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
});

test('stale cache falls back per-key when probes return empty', async () => {
  delete process.env.AGENTCHAT_BIN_DEVIN;
  seedCache({ devin: [{ id: 'swe-2', label: 'SWE-2' }] }, Date.now() - 7 * 60 * 60 * 1000);
  const models = await loadCatalog();
  assert.deepEqual(models.devin, [{ id: 'swe-2', label: 'SWE-2' }]);
  assert.deepEqual(models['acp-devin'], [{ id: 'swe-2', label: 'SWE-2' }]);
});
