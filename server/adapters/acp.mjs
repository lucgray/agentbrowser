// ACP client adapter — drives CLI agents over the Agent Client Protocol:
// newline-delimited JSON-RPC 2.0 on stdio (PROTOCOL v2.4).
//
// One preset table covers every ACP-capable CLI. Browser tools are NOT
// injected through ACP's `mcpServers` field: the agent reaches them through
// its own shell tool and the `agentbrowser` CLI (install-skill plants the
// SKILL.md that teaches it), so this path has zero MCP dependency.
//
// Upside over the per-CLI NDJSON parsers in generic-cli.mjs: tool calls arrive
// as structured `tool_call` updates that already carry a human-readable
// `title`, and session resume/permission/cancel are protocol operations
// instead of per-CLI flags.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveBin } from './generic-cli.mjs';
import { labelFromAgentbrowser } from './cli-label.mjs';

function logWarn(context, err) {
  console.error('[acp]', context, err && err.message ? err.message : err);
}

const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null
};

const ACP_PROTOCOL_VERSION = 1;

// Handshake and session setup requests get a bounded wait; session/prompt has
// no timeout (a turn legitimately runs as long as the agent needs).
const CONTROL_TIMEOUT_MS = 30000;

// Spawn lines per CLI. `bin` is what probeAdapter checks for on PATH — for the
// npm-wrapped agents the wrapper self-provisions (codex-acp bundles
// @openai/codex; agy-acp can auto-install agy), so `npx` is the real prereq.
export const ACP_PRESETS = {
  'acp-gemini': {
    label: 'Gemini (ACP)',
    command: 'gemini',
    args: ['--acp'],
    bin: 'gemini'
  },
  'acp-codex': {
    label: 'Codex (ACP)',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    bin: 'npx',
    // codex-acp needs a codex binary or its bundled dep; CODEX_PATH overrides.
    detail: 'runs via npx @agentclientprotocol/codex-acp'
  },
  'acp-opencode': {
    label: 'OpenCode (ACP)',
    command: 'opencode',
    args: ['acp'],
    bin: 'opencode'
  },
  'acp-copilot': {
    label: 'Copilot (ACP)',
    command: 'copilot',
    args: ['--acp'],
    bin: 'copilot'
  },
  'acp-grok': {
    label: 'Grok (ACP)',
    command: 'grok',
    args: ['agent', 'stdio', '--always-approve'],
    bin: 'grok'
  },
  'acp-claude': {
    label: 'Claude Code (ACP)',
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    bin: 'npx',
    detail: 'runs via npx @zed-industries/claude-code-acp; needs Claude auth or ANTHROPIC_API_KEY'
  },
  'acp-agy': {
    label: 'Antigravity (ACP)',
    command: 'npx',
    args: ['-y', 'agy-acp'],
    bin: 'npx',
    env: { AGY_EXTRA_ARGS: '--dangerously-skip-permissions' },
    detail: 'runs via npx agy-acp; agy has no native ACP so its permission prompts cannot be answered — auto-approving instead'
  },
  'acp-devin': {
    label: 'Devin (ACP)',
    command: 'devin',
    args: ['acp'],
    bin: 'devin',
    // devin acp rejects session/set_model; the documented channel is the
    // DEVIN_MODEL env var the spawned server reads at startup.
    modelEnv: 'DEVIN_MODEL'
  }
};

export const ACP_NAMES = Object.keys(ACP_PRESETS);

// ACP tool_call.kind values → a stable tool name for our chips. The agent's
// own `title` rides as the chip label, so this is only the fallback noun.
const KIND_TO_TOOL = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'bash',
  think: 'think',
  fetch: 'fetch',
  switch_mode: 'switch_mode',
  other: 'tool'
};

function toolNameFor(kind, title) {
  const mapped = kind && KIND_TO_TOOL[kind];
  if (mapped) return mapped;
  if (typeof title === 'string' && title.trim()) return 'tool';
  return 'tool';
}

function truncate(s, max = 200) {
  const str = String(s == null ? '' : s);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// Picks the permission outcome for a `session/request_permission` from the
// agent. Browser-side actions keep their own consent gate (agentbrowser CLI →
// hub → tool_call), so auto-approving the CLI's local tools here matches what
// the non-ACP adapters already do (--dangerously-* flags everywhere).
function pickPermissionOption(options) {
  const list = Array.isArray(options) ? options : [];
  return (
    list.find((o) => o && o.kind === 'allow_once') ||
    list.find((o) => o && typeof o.kind === 'string' && o.kind.startsWith('allow')) ||
    null
  );
}

export function createAcpSession(name, ctx) {
  const preset = ACP_PRESETS[name];
  if (!preset) throw new Error(`unknown ACP preset "${name}"`);
  return createAcpSpecSession(name, preset, ctx);
}

// split from createAcpSession so tests can drive the JSON-RPC machinery with a
// fake agent (e.g. `node -e <script>`) instead of a real CLI binary.
export function createAcpSpecSession(name, spec, ctx) {

  const state = {
    sessionId: null,
    proc: null,
    lineBuffer: '',
    stderrTail: '',
    spawnError: null,
    nextId: 1,
    pending: new Map(), // request id -> {resolve, reject}
    toolNames: new Map(), // toolCallId -> tool name (for pairing results)
    initialized: false,
    spawning: null
  };
  let turn = null; // {emit, resolve, startedAt}
  let closed = false;

  function endTurn(errorMessage) {
    const t = turn;
    if (!t) return;
    turn = null;
    if (errorMessage) t.emit({ kind: 'error', message: errorMessage });
    t.emit({
      kind: 'meta',
      model: ctx && ctx.model ? ctx.model : null,
      adapter: name,
      elapsedMs: Date.now() - t.startedAt,
      ...EMPTY_USAGE
    });
    t.emit({ kind: 'done' });
    t.resolve();
  }

  function writeMsg(msg) {
    if (!state.proc || !state.proc.stdin.writable) {
      throw new Error('acp process is not running');
    }
    state.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  function sendRequest(method, params, timeoutMs = 0) {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      state.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); }
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (state.pending.delete(id)) {
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        timer.unref();
      }
      try {
        writeMsg({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        state.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  function sendNotify(method, params) {
    try {
      writeMsg({ jsonrpc: '2.0', method, params });
    } catch (err) {
      logWarn(`notification ${method} failed`, err);
    }
  }

  function respond(id, result) {
    try {
      writeMsg({ jsonrpc: '2.0', id, result });
    } catch (err) {
      logWarn(`responding to request ${id} failed`, err);
    }
  }

  function respondError(id, code, message) {
    try {
      writeMsg({ jsonrpc: '2.0', id, error: { code, message } });
    } catch (err) {
      logWarn(`error response to request ${id} failed`, err);
    }
  }

  // Agent → client requests. We advertise no fs/terminal capabilities, so the
  // only request a well-behaved agent sends is request_permission; answer the
  // rest with method-not-found instead of hanging the agent.
  function handleAgentRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const options = msg.params && msg.params.options;
      const pick = pickPermissionOption(options);
      if (pick) {
        respond(msg.id, { outcome: { outcome: 'selected', optionId: pick.optionId } });
      } else {
        respond(msg.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    respondError(msg.id, -32601, `method not supported by this client: ${msg.method}`);
  }

  function handleSessionUpdate(update) {
    if (!update || typeof update !== 'object' || !turn) return;
    const emit = turn.emit;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content && update.content.text;
        if (text) emit({ kind: 'token', text: String(text) });
        return;
      }
      case 'agent_thought_chunk': {
        const text = update.content && update.content.text;
        if (text) emit({ kind: 'thinking', text: String(text) });
        return;
      }
      case 'tool_call': {
        const tool = toolNameFor(update.kind, update.title);
        if (update.toolCallId) state.toolNames.set(String(update.toolCallId), tool);
        const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};
        emit({
          kind: 'tool_use',
          tool,
          label:
            labelFromAgentbrowser(raw.command || raw.cmd) ||
            raw.label ||
            (typeof update.title === 'string' ? truncate(update.title) : undefined),
          args: raw,
          id: update.toolCallId == null ? undefined : String(update.toolCallId)
        });
        return;
      }
      case 'tool_call_update': {
        const status = update.status;
        if (status !== 'completed' && status !== 'failed') return;
        const id = update.toolCallId == null ? undefined : String(update.toolCallId);
        const tool = (id && state.toolNames.get(id)) || 'tool';
        const summary =
          update.rawOutput != null
            ? truncate(
                typeof update.rawOutput === 'object'
                  ? JSON.stringify(update.rawOutput)
                  : update.rawOutput
              )
            : Array.isArray(update.content)
              // content items nest one level deeper: {type:'content', content:{text}}
              ? truncate(
                  update.content
                    .map((c) => (c && c.content && c.content.text) || (c && c.text) || '')
                    .join(' ')
                )
              : 'ok';
        if (id) state.toolNames.delete(id);
        emit({ kind: 'tool_result', tool, ok: status === 'completed', summary, id });
        return;
      }
      case 'plan': {
        const n = Array.isArray(update.entries) ? update.entries.length : 0;
        if (n > 0) emit({ kind: 'info', message: `plan: ${n} step(s)` });
        return;
      }
      default:
        return;
    }
  }

  function handleLine(line) {
    const clean = line.trim();
    if (!clean) return;
    let msg;
    if (clean.startsWith('{')) {
      try {
        msg = JSON.parse(clean);
      } catch (err) {
        logWarn('dropping malformed JSON-RPC line', err);
        return;
      }
    } else {
      return; // non-JSON noise on stdout
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = state.pending.get(msg.id);
      if (!p) return;
      state.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `acp error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && typeof msg.method === 'string') {
      try {
        handleAgentRequest(msg);
      } catch (err) {
        logWarn(`agent request ${msg.method} handler threw`, err);
        respondError(msg.id, -32603, 'internal error');
      }
      return;
    }
    if (msg.method === 'session/update') {
      try {
        handleSessionUpdate(msg.params && msg.params.update);
      } catch (err) {
        logWarn('session/update handler threw, event skipped', err);
      }
    }
  }

  function onProcessExit(code) {
    const tail = state.stderrTail.trim();
    const spawnErr = state.spawnError;
    state.spawnError = null;
    const reason = tail || spawnErr || `exit code ${code}`;
    state.proc = null;
    state.sessionId = null;
    state.initialized = false;
    for (const [id, p] of state.pending) {
      p.reject(new Error(`acp process exited: ${reason}`));
    }
    state.pending.clear();
    if (closed) return;
    if (turn) endTurn(`acp agent exited mid-turn (${reason})`);
  }

  async function ensureProcess() {
    if (state.proc) return;
    if (state.spawning) return state.spawning;
    state.spawning = (async () => {
      // resolveBin knows the Windows shims (npx is npx.cmd); spawning a .cmd
      // needs the shell, and a bare unresolved name only works through it too.
      const binPath = resolveBin(spec.command);
      const cliShell =
        process.platform === 'win32' &&
        (binPath === spec.command || /\.(cmd|bat)$/i.test(binPath));
      const env = { ...process.env, ...(spec.env || {}) };
      // ctx.model is fixed for the session's life (the hub respawns the
      // session on a model switch), so a spawn-time env channel works.
      if (spec.modelEnv && ctx && ctx.model) env[spec.modelEnv] = ctx.model;
      const proc = spawn(binPath, spec.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: cliShell
      });
      state.proc = proc;
      state.lineBuffer = '';
      state.stderrTail = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        state.lineBuffer += chunk;
        let idx;
        while ((idx = state.lineBuffer.indexOf('\n')) !== -1) {
          handleLine(state.lineBuffer.slice(0, idx));
          state.lineBuffer = state.lineBuffer.slice(idx + 1);
        }
      });
      proc.stderr.on('data', (chunk) => {
        state.stderrTail = (state.stderrTail + chunk).slice(-2000);
      });
      // Writes to a dead agent's stdin throw EPIPE synchronously AND emit an
      // async 'error' on the socket — without a listener that becomes an
      // uncaughtException and takes the whole hub down.
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        stream.on('error', (err) => logWarn(`${name} stream error`, err));
      }
      proc.on('error', (err) => {
        logWarn(`${name} spawn failed`, err);
        state.spawnError = `cannot start "${spec.command} ${spec.args.join(' ')}": ${err.message}`;
        onProcessExit(-1);
      });
      proc.on('exit', (code) => onProcessExit(code));

      const killOnFail = (err) => {
        // A spawned-but-uninitialized agent is unusable — kill it so the next
        // send() starts fresh instead of orphaning the process.
        try {
          proc.kill('SIGKILL');
        } catch (killErr) {
          logWarn(`${name} cleanup kill failed`, killErr);
        }
        state.proc = null;
        throw err;
      };

      let init;
      try {
        init = await sendRequest('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false
          },
          clientInfo: { name: 'agentbrowser', version: '2.4' }
        }, CONTROL_TIMEOUT_MS);
      } catch (err) {
        killOnFail(err);
      }
      const methods = init && Array.isArray(init.authMethods) ? init.authMethods : [];
      if (methods.length > 0 && init.agentCapabilities && init.agentCapabilities.promptCapabilities === undefined) {
        // Some agents advertise auth methods but still serve prompts; only warn
        // loudly when authentication is clearly required.
        if (turn) {
          turn.emit({
            kind: 'info',
            message: `agent advertises auth methods (${methods.map((m) => m.id || m.name || m).join(', ')}); continuing`
          });
        }
      }
      state.initialized = true;
    })();
    try {
      await state.spawning;
    } finally {
      state.spawning = null;
    }
  }

  async function ensureSession() {
    await ensureProcess();
    if (state.sessionId) return;
    const res = await sendRequest('session/new', {
      cwd: process.cwd(),
      mcpServers: []
    }, CONTROL_TIMEOUT_MS);
    const sessionId = res && res.sessionId;
    if (!sessionId) throw new Error('session/new returned no sessionId');
    state.sessionId = sessionId;
    if (ctx && ctx.model) {
      try {
        await sendRequest('session/set_model', { sessionId, modelId: ctx.model }, CONTROL_TIMEOUT_MS);
      } catch (err) {
        // Agents without set_model may still take a model through the newer
        // config-option channel (devin acp exposes a "model" config option).
        logWarn('session/set_model rejected, trying set_config_option', err);
        try {
          await sendRequest('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: ctx.model
          }, CONTROL_TIMEOUT_MS);
        } catch (fallbackErr) {
          // The preset default still applies.
          logWarn('session/set_config_option rejected, keeping agent default', fallbackErr);
        }
      }
    }
  }

  return {
    async send(text, emit) {
      if (closed) {
        emit({ kind: 'error', message: 'session disposed' });
        emit({ kind: 'done' });
        return;
      }
      if (turn) {
        emit({ kind: 'error', message: 'a turn is already in progress for this chat' });
        emit({ kind: 'done' });
        return;
      }
      await new Promise((resolve) => {
        turn = { emit, resolve, startedAt: Date.now() };
        (async () => {
          try {
            await ensureSession();
            const res = await sendRequest('session/prompt', {
              sessionId: state.sessionId,
              prompt: [{ type: 'text', text: String(text) }]
            });
            endTurn();
            void res;
          } catch (err) {
            endTurn(err && err.message ? err.message : String(err));
          }
        })();
      });
    },
    abort() {
      if (state.sessionId) sendNotify('session/cancel', { sessionId: state.sessionId });
    },
    dispose() {
      closed = true;
      // Never leave a turn's promise dangling: the hub awaits send().
      endTurn('session disposed');
      if (state.proc) {
        const proc = state.proc;
        state.proc = null;
        try {
          proc.stdin.end();
        } catch (err) {
          logWarn('closing acp stdin failed', err);
        }
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          logWarn('killing acp process failed', err);
        }
      }
    }
  };
}
