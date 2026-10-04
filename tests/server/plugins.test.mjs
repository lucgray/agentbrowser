// Plugin layer (PROTOCOL v2.17): manifest scan, enabled-state resolution,
// prompt fragment join, tool gating via exposeTools / extraTools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {
  listPlugins,
  describePlugins,
  isEnabled,
  pluginPrompt,
  hiddenToolNames,
  effectiveTools,
  toolVisible,
} from '../../server/hub/plugins.mjs';
import { TOOLS } from '../../server/hub/tools.mjs';

const CORE_COUNT = TOOLS.length;

// User plugin dir is redirected per test via AGENTCHAT_PLUGINS_DIR.
function withPluginDir(dir, fn) {
  const prev = process.env.AGENTCHAT_PLUGINS_DIR;
  process.env.AGENTCHAT_PLUGINS_DIR = dir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.AGENTCHAT_PLUGINS_DIR;
    else process.env.AGENTCHAT_PLUGINS_DIR = prev;
  }
}

function writePlugin(root, id, manifest) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  return dir;
}

test('built-in translate plugin is discovered and enabled by default', () => {
  const all = listPlugins();
  const t = all.find((p) => p.id === 'translate');
  assert.ok(t, 'translate plugin missing');
  assert.equal(t.builtin, true);
  assert.equal(isEnabled(t, {}), true);
  assert.ok(t.exposeTools.includes('page_translate'));
  assert.ok(t.prompt.includes('page_translate'));
});

test('config.plugins overrides the manifest default both ways', () => {
  const t = listPlugins().find((p) => p.id === 'translate');
  assert.equal(isEnabled(t, { plugins: { translate: { enabled: false } } }), false);
  const off = { id: 'x', name: 'x', enabled: false, exposeTools: [], extraTools: [], prompt: '' };
  assert.equal(isEnabled(off, { plugins: { x: { enabled: true } } }), true);
});

test('disabling the translate plugin hides all its tools from effectiveTools', () => {
  const on = effectiveTools({});
  const off = effectiveTools({ plugins: { translate: { enabled: false } } });
  assert.equal(on.length, CORE_COUNT);
  const hidden = new Set([
    'page_translate', 'page_translate_stop', 'translate_para', 'translate_status',
    'translate_recent', 'translate_stats', 'translate_cache_clear',
    'subtitle_translate', 'subtitle_stop', 'subtitle_status', 'transcript_get',
    'video_download',
  ]);
  assert.equal(off.length, CORE_COUNT - hidden.size);
  for (const name of hidden) {
    assert.equal(toolVisible(name, { plugins: { translate: { enabled: false } } }), false, name);
  }
  // unrelated tools stay
  assert.ok(off.some((t) => t.name === 'navigate'));
});

test('pluginPrompt joins enabled fragments and skips disabled ones', () => {
  const p = pluginPrompt({});
  assert.ok(p.includes('## Plugin: Translation assistant'));
  assert.equal(pluginPrompt({ plugins: { translate: { enabled: false } } }), '');
});

test('user plugin adds prompt + extraTools', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-plug-'));
  try {
    writePlugin(dir, 'demo', {
      id: 'demo',
      name: 'Demo pack',
      enabled: true,
      prompt: 'Always greet with ahoy.',
      extraTools: [{ name: 'demo_thing', description: 'd', parameters: { type: 'object', properties: {} } }],
    });
    withPluginDir(dir, () => {
      const desc = describePlugins({});
      const demo = desc.find((p) => p.id === 'demo');
      assert.ok(demo);
      assert.equal(demo.builtin, false);
      assert.ok(pluginPrompt({}).includes('ahoy'));
      assert.ok(effectiveTools({}).some((t) => t.name === 'demo_thing'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('user plugin overrides a built-in of the same id', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-plug-'));
  try {
    writePlugin(dir, 'translate', {
      id: 'translate', name: 'Custom translate', enabled: true,
      prompt: 'custom', exposeTools: ['navigate'], extraTools: [],
    });
    withPluginDir(dir, () => {
      const all = listPlugins().filter((p) => p.id === 'translate');
      assert.equal(all.length, 1);
      assert.equal(all[0].name, 'Custom translate');
      assert.equal(all[0].builtin, false);
      // its exposeTools now gates 'navigate' when disabled
      assert.deepEqual(
        [...hiddenToolNames({ plugins: { translate: { enabled: false } } })],
        ['navigate']
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest naming an unknown tool warns and skips, not hides real tools', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-plug-'));
  try {
    writePlugin(dir, 'bad', {
      id: 'bad', name: 'Bad', enabled: true,
      prompt: '', exposeTools: ['no_such_tool'], extraTools: [],
    });
    withPluginDir(dir, () => {
      // disabling it hides nothing real
      const off = effectiveTools({ plugins: { bad: { enabled: false } } });
      assert.ok(off.some((t) => t.name === 'navigate'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed plugin.json is skipped, siblings still load', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-plug-'));
  try {
    const broken = path.join(dir, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'plugin.json'), '{nope');
    withPluginDir(dir, () => {
      const desc = describePlugins({});
      assert.ok(desc.some((p) => p.id === 'translate')); // builtin intact
      assert.equal(desc.some((p) => p.id === 'broken'), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
