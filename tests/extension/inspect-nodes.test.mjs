// inspect.js's page_snapshot nodeId map (v2.29): ids are minted service-
// worker-side, the page-side expression never writes the DOM, and the map
// dies with the document. chrome.* is stubbed; Runtime.evaluate returns a
// canned snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';

const evalExpressions = [];
let evalResult = null;
const tabUpdated = [];
const debuggerEvents = [];

globalThis.chrome = {
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: (fn) => debuggerEvents.push(fn) },
    attach: async () => {},
    sendCommand: async (target, method, params) => {
      if (method === 'Runtime.evaluate') {
        evalExpressions.push(String((params && params.expression) || ''));
        return { result: { value: evalResult } };
      }
      return {};
    },
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: (fn) => tabUpdated.push(fn) },
    get: async () => ({ url: 'https://example.com/', title: 'Example' }),
  },
  storage: {
    local: { get: async () => ({}) },
    onChanged: { addListener: () => {} },
  },
};

const inspect = await import('../../extension/background/inspect.js');

const SNAP = {
  url: 'https://x.test/',
  count: 1,
  total: 1,
  nodes: [{ tag: 'a', role: '', name: 'hi', path: 'html>body>a' }],
};

test('page_snapshot mints ids SW-side and never writes the DOM', async () => {
  evalResult = SNAP;
  const res = await inspect.pageSnapshot(7, {});
  assert.equal(res.nodes[0].node, 'n1');
  // Read-only probe: a MutationObserver must not see the snapshot pass.
  assert.doesNotMatch(evalExpressions.at(-1), /setAttribute|removeAttribute|data-ab-/);
  assert.deepEqual(inspect.nodePath(7, 'n1'), { path: 'html>body>a', frame: null });
  assert.equal(inspect.nodePath(7, 'nope'), null);
});

test('a re-snapshot retires that scope\'s ids; navigation clears all', async () => {
  evalResult = SNAP;
  await inspect.pageSnapshot(9, {});
  assert.ok(inspect.nodePath(9, 'n1'));
  await inspect.pageSnapshot(9, {});
  assert.equal(inspect.nodePath(9, 'n1'), null, 'stale id survived a re-snapshot');
  assert.ok(inspect.nodePath(9, 'n2'), 're-snapshot must mint fresh ids');
  for (const fn of tabUpdated) fn(9, { url: 'https://other.test/' });
  assert.equal(inspect.nodePath(9, 'n2'), null, 'node ids survived navigation');
});

test('frame snapshots record the OOPIF session for click_element', async () => {
  evalResult = SNAP;
  for (const fn of debuggerEvents) {
    fn({ tabId: 11 }, 'Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { type: 'iframe', url: 'https://fr.test/', targetId: 't1' },
    });
  }
  const res = await inspect.pageSnapshot(11, { frame: 'sess-1' });
  assert.equal(res.nodes[0].node, 'n1');
  assert.equal(inspect.nodePath(11, 'n1').frame, 'sess-1');
});
