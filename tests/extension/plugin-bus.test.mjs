// plugin-bus (v2.24): the content-side plugin contract — service registry,
// cross-plugin call(), toolbar action slots + per-action config gate.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../../extension/content/plugin-bus.js'), 'utf8');

let chromeStore;
function load() {
  chromeStore = { pluginToolbar: {} };
  const listeners = [];
  globalThis.window = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (defaults) => Promise.resolve({ ...defaults, ...chromeStore }),
        set: (v) => { Object.assign(chromeStore, v); return Promise.resolve(); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  new Function(src)();
  return { bus: globalThis.window.__abPlugins, listeners };
}

beforeEach(() => {
  delete globalThis.window;
  delete globalThis.chrome;
});

test('provide/call routes between plugins; missing provider returns null', async () => {
  const { bus } = load();
  bus.provide('marks', { paint: (t) => 'painted:' + t, list: () => [1, 2] });
  assert.equal(bus.call('marks', 'paint', 'hi'), 'painted:hi');
  assert.deepEqual(bus.call('marks', 'list'), [1, 2]);
  assert.equal(bus.call('nope', 'paint', 'x'), null);
  assert.equal(bus.has('marks'), true);
  assert.equal(bus.has('nope'), false);
});

test('call swallows a throwing provider and returns null', () => {
  const { bus } = load();
  bus.provide('bad', { boom: () => { throw new Error('x'); } });
  assert.equal(bus.call('bad', 'boom'), null);
});

test('toolbar actions register/set/replace and config gate filters', async () => {
  const { bus } = load();
  await bus.loadToolbarConfig();
  bus.registerToolbarAction({ plugin: 'notes', id: 'hl', run: () => {} });
  bus.registerToolbarAction({ plugin: 'notes', id: 'annotate', run: () => {} });
  bus.registerToolbarAction({ plugin: 'explain', id: 'run', run: () => {} });
  assert.equal(bus.toolbarActions().length, 3);
  // setToolbarActions replaces only that plugin's slots
  bus.setToolbarActions('notes', [{ plugin: 'notes', id: 'hl', run: () => {} }]);
  assert.equal(bus.toolbarActions().length, 2);
  assert.equal(bus.toolbarActions().map((a) => a.plugin).sort().join(','), 'explain,notes');
  // config gate: default on, explicit false hides
  assert.equal(bus.toolbarEnabled('notes:hl'), true);
  chromeStore.pluginToolbar = { 'notes:hl': false };
  await bus.loadToolbarConfig();
  assert.equal(bus.toolbarEnabled('notes:hl'), false);
  assert.equal(bus.toolbarEnabled('core:ask'), true);
});

test('pluginToolbar storage change updates the gate live', async () => {
  const { bus, listeners } = load();
  await bus.loadToolbarConfig();
  assert.equal(bus.toolbarEnabled('core:ask'), true);
  listeners.forEach((fn) => fn({ pluginToolbar: { newValue: { 'core:ask': false } } }, 'local'));
  assert.equal(bus.toolbarEnabled('core:ask'), false);
});

test('page tools register and dispatch; unknown tool reports no page tool', async () => {
  chromeStore = { pluginToolbar: {} };
  const msgs = [];
  globalThis.window = {};
  globalThis.window.top = globalThis.window; // top frame — the op guard lets it through
  globalThis.chrome = {
    storage: {
      local: {
        get: (defaults) => Promise.resolve({ ...defaults, ...chromeStore }),
        set: (v) => { Object.assign(chromeStore, v); return Promise.resolve(); },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { onMessage: { addListener: (fn) => msgs.push(fn) } },
  };
  new Function(src)();
  const bus = globalThis.window.__abPlugins;
  bus.registerPageTool('page_reader', (args) => ({ mode: 'compat', got: args.action }));
  assert.deepEqual(await bus.callPageTool('page_reader', { action: 'status' }), {
    ok: true,
    result: { mode: 'compat', got: 'status' },
  });
  assert.deepEqual(await bus.callPageTool('nope', {}), { ok: false, error: 'no page tool: nope' });
  // async handlers resolve through the same envelope
  bus.registerPageTool('slow', () => Promise.resolve({ done: 1 }));
  assert.deepEqual(await bus.callPageTool('slow'), { ok: true, result: { done: 1 } });
  // thrown/rejected handlers surface as ok:false, never propagate
  bus.registerPageTool('bad', () => { throw new Error('x'); });
  const r = await bus.callPageTool('bad');
  assert.equal(r.ok, false);
  assert.match(r.error, /x/);
  // the plugin_op message route resolves sendResponse with the envelope
  const handler = msgs.find((fn) => {
    let hit = null;
    fn({ target: 'plugins', cmd: 'op', tool: 'page_reader', args: { action: 'enter' } }, null, (res) => { hit = res; });
    return hit === null || true;
  });
  assert.ok(handler);
  const res = await new Promise((resolve) =>
    handler({ target: 'plugins', cmd: 'op', tool: 'page_reader', args: { action: 'status' } }, null, resolve)
  );
  assert.equal(res.ok, true);
  assert.equal(res.result.got, 'status');
});

test('input-kind toolbar actions pass through registration like buttons', () => {
  const { bus } = load();
  bus.registerToolbarAction({ plugin: 'ask', id: 'ask', kind: 'input', icon: '✎', label: '问…', run: () => {} });
  const a = bus.toolbarActions().find((x) => x.kind === 'input');
  assert.ok(a);
  assert.equal(a.plugin, 'ask');
});
