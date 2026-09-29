// Fake ACP agent for tests/server/acp.test.mjs: speaks newline-delimited
// JSON-RPC 2.0 on stdio. Answers initialize/session/new, and for
// session/prompt streams the canonical event sequence (token, tool_call with a
// title, a permission request that must be answered, tool_call_update, final
// token) before resolving the prompt.
//
// Deterministic scripted behavior — no assertions live here; the test checks
// what the adapter emitted.

let buffer = '';
const pendingPermission = new Map();
// Test hooks via env: FAKE_ACP_NO_SET_MODEL=1 makes session/set_model fail the
// way devin acp does; FAKE_ACP_ECHO=1 prepends a turn token that echoes the
// spawn env + last set_config_option call so tests can assert both channels.
const NO_SET_MODEL = process.env.FAKE_ACP_NO_SET_MODEL === '1';
let configOption = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function notify(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

let rid = 1000;
function requestPermission(sessionId) {
  const id = rid++;
  pendingPermission.set(id, sessionId);
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: 'tc1', title: 'run the tests' },
      options: [
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
      ]
    }
  });
}

function runTurn(sessionId, promptId) {
  if (process.env.FAKE_ACP_ECHO === '1') {
    notify(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `env=${process.env.FAKE_ACP_MODEL_ENV || ''} cfg=${
          configOption ? `${configOption.configId}=${configOption.value}` : ''
        }`
      }
    });
  }
  notify(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Checking the code. ' }
  });
  notify(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'tests first' }
  });
  notify(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc1',
    title: 'run the tests',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'npm test' }
  });
  requestPermission(sessionId);
  // The permission response arrives as an incoming message; when it lands we
  // finish the tool call and the prompt (see the msg.id branch below).
  pendingPermission.set(promptId, 'finish-after-permission');
}

function finishTurn(sessionId, promptId) {
  notify(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc1',
    status: 'completed',
    rawOutput: '87 passing'
  });
  notify(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'All green.' }
  });
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[fake-acp] bad json');
      continue;
    }
    // Response to our request_permission → finish the pending prompt.
    if (msg.id != null && msg.result !== undefined) {
      const sessionId = pendingPermission.get(msg.id);
      // find the paired prompt id
      for (const [k, v] of pendingPermission) {
        if (v === 'finish-after-permission') {
          finishTurn(sessionId, k);
          pendingPermission.delete(k);
        }
      }
      pendingPermission.delete(msg.id);
      continue;
    }
    if (typeof msg.method !== 'string') continue;
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId: 'sess-1', models: { availableModels: [], currentModelId: 'fake' } }
      });
    } else if (msg.method === 'session/set_model') {
      if (NO_SET_MODEL) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    } else if (msg.method === 'session/set_config_option') {
      configOption = msg.params;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/prompt') {
      runTurn(msg.params.sessionId, msg.id);
    }
    // session/cancel and other notifications: ignore.
  }
});
