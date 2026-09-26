import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPanelRouter,
  windowIdFromPortName,
  DEFAULT_WINDOW,
} from '../../extension/background/panel-router.js';

function fakePort() {
  return { postMessage() {}, disconnect() {} };
}

test('windowIdFromPortName parses sidepanel:<id> and bare sidepanel', () => {
  assert.equal(windowIdFromPortName('sidepanel:7'), 7);
  assert.equal(windowIdFromPortName('sidepanel'), DEFAULT_WINDOW);
  assert.equal(windowIdFromPortName('sidepanel:abc'), null);
  assert.equal(windowIdFromPortName('other'), null);
});

test('chat events route to the window that started the chat', () => {
  const r = createPanelRouter();
  const a = fakePort();
  const b = fakePort();
  r.connect(1, a);
  r.connect(2, b);

  r.noteInbound(1, { type: 'chat', chatId: 'c1' });
  r.noteInbound(2, { type: 'chat', chatId: 'c2' });

  assert.deepEqual(r.route({ type: 'chat_event', chatId: 'c1' }), [1]);
  assert.deepEqual(r.route({ type: 'chat_event', chatId: 'c2' }), [2]);
});

test('events for unknown chatIds are dropped', () => {
  const r = createPanelRouter();
  r.connect(1, fakePort());
  r.connect(2, fakePort());
  assert.deepEqual(r.route({ type: 'chat_event', chatId: 'nobody' }), []);
});

test('a second window does not steal the first window', () => {
  const r = createPanelRouter();
  r.connect(1, fakePort());
  r.connect(2, fakePort()); // used to replace the single panelPort
  r.noteInbound(1, { type: 'chat', chatId: 'c1' });
  assert.deepEqual(r.route({ type: 'chat_event', chatId: 'c1' }), [1]);
});

test('broadcast types reach every connected panel', () => {
  const r = createPanelRouter();
  r.connect(1, fakePort());
  r.connect(2, fakePort());
  for (const type of ['status', 'capabilities', 'chat_list']) {
    assert.deepEqual(r.route({ type }).sort(), [1, 2]);
  }
});

test('chat_resumed routes to the window that asked', () => {
  const r = createPanelRouter();
  r.connect(1, fakePort());
  r.connect(2, fakePort());
  r.noteInbound(2, { type: 'chat_resume', chatId: 'c9' });
  assert.deepEqual(r.route({ type: 'chat_resumed', chatId: 'c9' }), [2]);
});

test('events are dropped when the owning window disconnected', () => {
  const r = createPanelRouter();
  const a = fakePort();
  r.connect(1, a);
  r.connect(2, fakePort());
  r.noteInbound(1, { type: 'chat', chatId: 'c1' });
  r.disconnect(1, a);
  assert.deepEqual(r.route({ type: 'chat_event', chatId: 'c1' }), []);
});

test('disconnect ignores a stale port so a reconnect is not clobbered', () => {
  const r = createPanelRouter();
  const oldPort = fakePort();
  const newPort = fakePort();
  r.connect(1, oldPort);
  r.connect(1, newPort);
  r.disconnect(1, oldPort);
  assert.equal(r.ports.get(1), newPort);
});

test('unaddressed messages fall back to the most recent sender', () => {
  const r = createPanelRouter();
  r.connect(1, fakePort());
  r.connect(2, fakePort());
  r.noteInbound(1, { type: 'chat_list' });
  assert.deepEqual(r.route({ type: 'mystery' }), [1]);
});

test('no ports routes nothing', () => {
  const r = createPanelRouter();
  assert.deepEqual(r.route({ type: 'status' }), []);
});
