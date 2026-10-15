import test from 'node:test';
import assert from 'node:assert/strict';
import * as tabops from '../../extension/background/tabops.js';

test('begin/end ledger lifecycle; same-agent overlap stays silent', () => {
  tabops._reset();
  assert.equal(tabops.begin(7, 'c1', 'claude#aaa', 'click'), null);
  assert.equal(tabops.begin(7, 'c2', 'claude#aaa', 'type_text'), null);
  assert.deepEqual(tabops.agentsOn(7), ['claude#aaa']);
  assert.equal(tabops.opsFor(7).length, 2);
  tabops.end(7, 'c1');
  assert.equal(tabops.opsFor(7).length, 1);
  tabops.end(7, 'c2');
  assert.equal(tabops.opsFor(7).length, 0);
  assert.deepEqual(tabops.snapshot(), {});
});

test('foreign agent overlap returns an advisory naming the operator', () => {
  tabops._reset();
  tabops.begin(9, 'c1', 'claude#aaa', 'drag');
  const note = tabops.begin(9, 'c2', 'codex#bbb', 'type_text');
  assert.doesNotMatch(note, /codex/); // names the *other* op, not the caller
  assert.match(note, /claude#aaa/);
  assert.match(note, /drag/);
  assert.match(note, /tab 9/);
  // a later op from the first agent sees the newcomer too
  assert.match(tabops.begin(9, 'c3', 'claude#aaa', 'scroll'), /codex#bbb/);
});

test('snapshot groups ops per tab; dropTab clears', () => {
  tabops._reset();
  tabops.begin(1, 'c1', 'a#1', 'click');
  tabops.begin(2, 'c2', 'b#2', 'navigate');
  const snap = tabops.snapshot();
  assert.equal(snap[1][0].agent, 'a#1');
  assert.equal(snap[2][0].tool, 'navigate');
  tabops.dropTab(1);
  assert.equal(tabops.opsFor(1).length, 0);
  assert.equal(tabops.opsFor(2).length, 1);
});
