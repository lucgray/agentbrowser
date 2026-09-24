// Smoke test for hub.mjs routing. No browser, no LLM.
// Usage: node hub.mjs (in another process), then: node smoke.mjs
// Simulates the extension (answers tool_calls) and a harness client
// (sends a tool_call), and checks the round trip plus the
// "no extension connected" fast-fail.
import WebSocket from 'ws';

const URL = `ws://127.0.0.1:${process.env.AGENTCHAT_PORT || 9010}`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
}

function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve(ws); });
    ws.on('error', reject);
  });
}

function nextMessage(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    function onMsg(data) {
      const m = JSON.parse(data.toString());
      if (!pred || pred(m)) { clearTimeout(t); ws.off('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}

// 1. Harness call with NO extension connected -> fast ok:false
{
  const harness = await connect({ type: 'hello', role: 'harness', name: 'smoke' });
  harness.send(JSON.stringify({ type: 'tool_call', id: 'h0', tool: 'tabs_list', args: {} }));
  try {
    const r = await nextMessage(harness, m => m.type === 'tool_result' && m.id === 'h0');
    check('no-extension fast-fail', r.ok === false && /no extension/i.test(r.error || ''), JSON.stringify(r));
  } catch (e) { check('no-extension fast-fail', false, e.message); }
  harness.close();
}

// 2. Fake extension answers a harness tool_call end to end
{
  const ext = await connect({ type: 'hello', role: 'extension', version: '1.0.0' });
  ext.on('message', data => {
    const m = JSON.parse(data.toString());
    if (m.type === 'tool_call') {
      ext.send(JSON.stringify({ type: 'tool_result', id: m.id, ok: true, result: { echo: m.tool, args: m.args } }));
    }
  });
  await new Promise(r => setTimeout(r, 200));

  const harness = await connect({ type: 'hello', role: 'harness', name: 'smoke2' });
  harness.send(JSON.stringify({ type: 'tool_call', id: 'h1', tool: 'read_page', args: { maxChars: 5 } }));
  try {
    const r = await nextMessage(harness, m => m.type === 'tool_result' && m.id === 'h1');
    check('harness->ext round trip', r.ok === true && r.result?.echo === 'read_page' && r.result?.args?.maxChars === 5, JSON.stringify(r));
  } catch (e) { check('harness->ext round trip', false, e.message); }

  // 3. Displacement: second extension hello closes the first
  const ext2 = await connect({ type: 'hello', role: 'extension', version: '1.0.0' });
  const closed = await new Promise(res => {
    const t = setTimeout(() => res(false), 3000);
    ext.on('close', () => { clearTimeout(t); res(true); });
  });
  check('extension displacement', closed);

  // 4. New extension serves calls after displacement
  ext2.on('message', data => {
    const m = JSON.parse(data.toString());
    if (m.type === 'tool_call') {
      ext2.send(JSON.stringify({ type: 'tool_result', id: m.id, ok: true, result: { v: 2 } }));
    }
  });
  harness.send(JSON.stringify({ type: 'tool_call', id: 'h2', tool: 'tabs_list', args: {} }));
  try {
    const r = await nextMessage(harness, m => m.type === 'tool_result' && m.id === 'h2');
    check('post-displacement routing', r.ok === true && r.result?.v === 2, JSON.stringify(r));
  } catch (e) { check('post-displacement routing', false, e.message); }

  harness.close(); ext2.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
