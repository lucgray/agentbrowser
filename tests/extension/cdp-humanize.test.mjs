import test from 'node:test';
import assert from 'node:assert/strict';

// cdp.js with chrome.* stubbed: every debugger command lands in `calls`
// with a timestamp, so the humanized input sequence can be asserted.
let calls = [];
let stored = {};
const storageListeners = [];

globalThis.chrome = {
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
    attach: async () => {},
    sendCommand: async (target, method, params) => {
      calls.push({ method, params, t: Date.now() });
      if (method === 'Runtime.evaluate') {
        const expr = String((params && params.expression) || '');
        // The pointer-start/viewport probe — element expressions use
        // innerWidth too, so match the probe's exact shape.
        if (expr.trimStart().startsWith('JSON.stringify({x: innerWidth')) {
          return { result: { value: '{"x":400,"y":300}' } };
        }
        // Superset that satisfies overlay, elementCheck and elementPoint probes.
        return {
          result: {
            value: {
              found: true, count: 1, visible: true, occluded: false,
              x: 100, y: 100, w: 50, h: 20, tag: 'button', path: 'button',
            },
          },
        };
      }
      return {};
    },
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    get: async () => ({ url: 'https://example.com/', title: 'Example' }),
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: stored[key] }),
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
};

const cdp = await import('../../extension/background/cdp.js');

function reset() {
  calls = [];
  stored = {};
}

const moves = () => calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved');
const of = (type) => calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === type);

test('click walks a curved trail, then holds before release', async () => {
  reset();
  await cdp.click(1, 100, 100);
  const mv = moves();
  assert.ok(mv.length >= 10, `only ${mv.length} move events — no approach trail`);
  const last = mv[mv.length - 1].params;
  assert.deepEqual([last.x, last.y], [100, 100], 'trail must land on the target');
  const press = of('mousePressed');
  const release = of('mouseReleased');
  assert.ok(press && release);
  assert.equal(press.params.x, 100);
  assert.equal(release.params.x, 100);
  assert.ok(release.t - press.t >= 45, `press lasted ${release.t - press.t}ms — a 0ms tap is a tell`);
});

test('click_element jitters the aim inside the element and re-probes before pressing', async () => {
  reset();
  const res = await cdp.clickElement(1, 'button', 0, 0, {});
  assert.equal(res.clicked, true);
  const press = of('mousePressed');
  // Aim scatter: inside the element rect (center 100,100 size 50x20),
  // jitter bounded by ±15% of size.
  assert.ok(Math.abs(press.params.x - 100) <= 7.5 && Math.abs(press.params.y - 100) <= 3,
    `aim ${press.params.x},${press.params.y} escaped the element`);
  const evals = calls.filter((c) => c.method === 'Runtime.evaluate').length;
  assert.ok(evals >= 4, `expected aim + stillOn re-probes plus pointer probe, got ${evals}`);
  // Press comes after the approach trail, not before it.
  const lastMove = moves().at(-1);
  assert.ok(lastMove && lastMove.t <= press.t);
});

test('type_text goes per code point with keystroke gaps', async () => {
  reset();
  const t0 = Date.now();
  const res = await cdp.typeText(1, 'hey', undefined, {});
  assert.equal(res.typed, 3);
  const inserts = calls.filter((c) => c.method === 'Input.insertText');
  assert.deepEqual(inserts.map((c) => c.params.text), ['h', 'e', 'y']);
  assert.ok(Date.now() - t0 >= 30, 'no keystroke interval at all');
});

test('press_key holds the key down before releasing', async () => {
  reset();
  await cdp.pressKey(1, 'Enter', {});
  const down = calls.find((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'rawKeyDown');
  const up = calls.find((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyUp');
  assert.ok(down && up);
  assert.ok(up.t - down.t >= 45, `key held ${up.t - down.t}ms`);
});

test('humanize:false keeps the old press-release, zero trail', async () => {
  reset();
  await cdp.click(1, 100, 100, { humanize: false });
  assert.equal(moves().length, 0);
  assert.ok(of('mousePressed') && of('mouseReleased'));
});

test('storage humanize=false disables pacing globally', async () => {
  reset();
  stored = { humanize: false };
  for (const fn of storageListeners) fn({ humanize: { newValue: false } }, 'local');
  await cdp.click(1, 100, 100);
  assert.equal(moves().length, 0);
  for (const fn of storageListeners) fn({ humanize: { newValue: true } }, 'local');
});

const overlayEvals = () =>
  calls.filter(
    (c) =>
      c.method === 'Runtime.evaluate' &&
      String((c.params && c.params.expression) || '').includes('agentchat-overlay-root')
  );

// The pill is page-visible DOM — a MutationObserver can see it — so it must
// not appear unless the user explicitly opted in (v2.29).
test('overlay never injects by default', async () => {
  reset();
  await cdp.click(1, 50, 50);
  await new Promise((r) => setTimeout(r, 300)); // past OVERLAY_TIMEOUT_MS
  assert.equal(overlayEvals().length, 0, 'overlay DOM injected despite default-off');
});

test('overlayEnabled:true opts the pill back in', async () => {
  reset();
  for (const fn of storageListeners) fn({ overlayEnabled: { newValue: true } }, 'local');
  await cdp.click(1, 50, 50);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(overlayEvals().length >= 1, 'overlay did not inject when enabled');
  for (const fn of storageListeners) fn({ overlayEnabled: { newValue: false } }, 'local');
});
