import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleMs,
  stepDelayMs,
  enabled,
  jitterOffset,
  jitterPoint,
  curvePath,
  typeChunks,
  notePointer,
  lastPointer,
  forgetPointer,
} from '../../extension/background/humanize.js';

const BOUNDS = {
  afterClick: [150, 2000],
  keystroke: [30, 400],
  clickHold: [45, 250],
  pointerSettle: [200, 1200],
  afterNavigate: [600, 6000],
};

test('sampleMs stays inside each action clamp over many draws', () => {
  for (const [action, [min, max]] of Object.entries(BOUNDS)) {
    for (let i = 0; i < 500; i++) {
      const v = sampleMs(action);
      assert.ok(v >= min && v <= max, `${action} drew ${v} outside [${min},${max}]`);
    }
  }
});

test('sampleMs varies — a metronome is the tell we removed', () => {
  const draws = new Set();
  for (let i = 0; i < 50; i++) draws.add(Math.round(sampleMs('keystroke')));
  assert.ok(draws.size > 10, `only ${draws.size} distinct delays`);
});

test('unknown action falls back instead of throwing', () => {
  assert.ok(Number.isFinite(sampleMs('not_an_action')));
});

test('stepDelayMs stays inside the 5-9ms band', () => {
  for (let i = 0; i < 200; i++) {
    const v = stepDelayMs();
    assert.ok(v >= 5 && v <= 9);
  }
});

test('enabled() defaults to true with no chrome.* around', async () => {
  assert.equal(await enabled(), true);
});

test('jitterOffset is bounded by 15% of size, capped at 8px', () => {
  for (let i = 0; i < 500; i++) {
    assert.ok(Math.abs(jitterOffset(100)) <= 8);
    assert.ok(Math.abs(jitterOffset(20)) <= 3);
  }
});

test('jitterPoint scatters around the point, not away from it', () => {
  const pt = { x: 100, y: 50 };
  let moved = false;
  for (let i = 0; i < 50; i++) {
    const p = jitterPoint(pt, 100, 40);
    assert.ok(Math.abs(p.x - 100) <= 8 && Math.abs(p.y - 50) <= 6);
    if (p.x !== 100 || p.y !== 50) moved = true;
  }
  assert.ok(moved, 'jitter never moved the point');
});

test('curvePath ends exactly on target and produces intermediate steps', () => {
  const path = curvePath({ x: 0, y: 0 }, { x: 400, y: 300 });
  assert.ok(path.length >= 10 && path.length <= 40);
  const last = path[path.length - 1];
  assert.deepEqual(last, { x: 400, y: 300 });
  // Not a straight line: at least one midpoint leaves the diagonal.
  const offLine = path.some((p) => Math.abs(p.y - (300 / 400) * p.x) > 0.5);
  assert.ok(offLine, 'path was a straight line — no curve');
});

test('curvePath teleports when distance < 6px', () => {
  assert.deepEqual(curvePath({ x: 0, y: 0 }, { x: 3, y: 3 }), [{ x: 3, y: 3 }]);
});

test('curvePath steps clamp: short hops get 10, long hauls cap at 40', () => {
  assert.equal(curvePath({ x: 0, y: 0 }, { x: 60, y: 0 }).length, 10);
  assert.equal(curvePath({ x: 0, y: 0 }, { x: 5000, y: 0 }).length, 40);
  assert.equal(curvePath({ x: 0, y: 0 }, { x: 300, y: 0 }, { steps: 7 }).length, 7);
});

test('curvePath bounds clamp every point into the rect', () => {
  const bounds = { left: 50, top: 50, right: 250, bottom: 200 };
  const path = curvePath({ x: 0, y: 0 }, { x: 500, y: 400 }, { bounds });
  for (const p of path) {
    assert.ok(p.x >= 50 && p.x <= 250 && p.y >= 50 && p.y <= 200, `point ${p.x},${p.y} escaped`);
  }
});

test('typeChunks splits short text per code point, long text into bursts', () => {
  assert.deepEqual(typeChunks('ab'), ['a', 'b']);
  // Emoji count as one code point, same as Go's per-rune loop.
  assert.deepEqual(typeChunks('a😀b'), ['a', '😀', 'b']);
  const long = 'x'.repeat(500);
  const chunks = typeChunks(long);
  assert.ok(chunks.length < 25, `${chunks.length} bursts for 500 chars`);
  // Bursts are 20-60 chars; only the final remainder may run shorter.
  assert.ok(chunks.every((c) => [...c].length <= 60));
  assert.ok(chunks.slice(0, -1).every((c) => [...c].length >= 20));
  assert.equal(chunks.join(''), long);
});

test('pointer tracking remembers last position per tab', () => {
  notePointer(1, 10, 20);
  notePointer(1, 30, 40);
  notePointer(2, 5, 5);
  assert.deepEqual(lastPointer(1), { x: 30, y: 40 });
  assert.deepEqual(lastPointer(2), { x: 5, y: 5 });
  forgetPointer(1);
  assert.equal(lastPointer(1), null);
  notePointer(3, NaN, 7);
  assert.equal(lastPointer(3), null);
});
