// Generic per-turn CLI adapter (PROTOCOL.md "Adapter interface").
//
// One configurable factory covering every headless-capable coding CLI on this
// machine. Unlike claude-cli.mjs (persistent child), each send() spawns one
// process for that turn, captures stdout, strips ANSI, extracts the assistant
// text per the CLI's output format, and emits token then done exactly once.
// Conversation memory uses each CLI's own resume mechanism; the session id is
// tracked in per-session state between turns.
//
// Browser tools reach every CLI through mcp-proxy.mjs. CLIs with a
// per-invocation MCP mechanism (flag or config file discovered from cwd) get
// a config generated in os.tmpdir() at session start. agy only reads a global
// config file, so it gets a guarded, merge-only ensureRegistered() instead.

import { spawn } from 'node:child_process';
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync,
  readdirSync, statSync, existsSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_PROXY_PATH = path.resolve(__dirname, '..', 'mcp-proxy.mjs');

// Presets name a bare command; the absolute path is resolved at spawn time so
// no install layout is baked in. Order: $AGENTCHAT_BIN_<NAME> override, then
// $PATH, then a few common install dirs that a GUI-launched process inherits
// an incomplete PATH for. Falls back to the bare name so spawn's own ENOENT
// carries the message.
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.opencode', 'bin')
];

function logWarn(context, err) {
  console.error('[generic-cli]', context + ':', (err && err.message) || err);
}

function resolveBin(name) {
  const override = process.env[`AGENTCHAT_BIN_${name.toUpperCase()}`];
  if (override) return override;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    // existsSync probes instead of a throwing statSync: a miss is control
    // flow here, not an error worth logging.
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return name;
}

// CSI, OSC (BEL- or ST-terminated), and lone two-byte escape sequences.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

function stripAnsi(s) {
  return s ? s.replace(ANSI_RE, '') : s;
}

function truncate(s, max = 200) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function summarize(value) {
  if (value == null) return 'ok';
  if (typeof value === 'string') return truncate(value) || 'ok';
  try {
    return truncate(JSON.stringify(value));
  } catch (err) {
    logWarn('summarize fell back for unserializable value', err);
    return 'ok';
  }
}

// Tool names may arrive prefixed by the harness (mcp__browser__click etc).
function shortToolName(name) {
  if (!name) return 'tool';
  return name.replace(/^mcp__browser__/, '').replace(/^browser__/, '').replace(/^browser\./, '');
}

function parseLooseJson(text) {
  const t = (text || '').trim();
  // Shape guard keeps non-JSON lines from ever throwing; the one real parse
  // attempt below is on the {..} slice, where a failure is a malformed blob
  // and worth a warning.
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch (err) {
      logWarn('malformed JSON text, trying loose slice', err);
    }
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (err) {
      logWarn('unparseable JSON blob, returning null', err);
    }
  }
  return null;
}

function emitPlainReply(text, emit) {
  const reply = (text || '').trim();
  if (reply) emit({ kind: 'token', text: reply });
}

// --- usage ------------------------------------------------------------------
//
// Four of the six presets expose token usage in their JSON output: codex,
// opencode, grok and gemini. copilot and agy print plain text with no usage
// anywhere, so their turns report nulls — no estimating from character counts.
//
// Every preset spawns one process per turn, so a process-scoped counter is
// already turn-scoped. The exception is opencode, which emits one step_finish
// per assistant step and therefore has to be summed across the turn.
//
// The four sources do NOT agree on whether the input count includes the cached
// buckets (per-preset notes below). That is left as reported rather than
// normalized — reshaping a provider's number is how you end up with a count
// that is confidently wrong.
const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null
};

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Sum that keeps null distinct from 0: null + null stays null ("not reported"),
// but null + 5 is 5. Only used by opencode's multi-step accumulation.
function addField(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

// Last report wins. Correct for the presets whose counter is already cumulative
// over the process (codex turn.completed, grok's final object, gemini's stats).
function setUsage(state, usage) {
  state.usage = { ...EMPTY_USAGE, ...usage };
}

// Accumulate across several reports within one turn (opencode's step_finish).
function addUsage(state, usage) {
  const current = state.usage || EMPTY_USAGE;
  state.usage = {
    inputTokens: addField(current.inputTokens, usage.inputTokens),
    outputTokens: addField(current.outputTokens, usage.outputTokens),
    cacheReadTokens: addField(current.cacheReadTokens, usage.cacheReadTokens),
    cacheWriteTokens: addField(current.cacheWriteTokens, usage.cacheWriteTokens)
  };
}

// --- agy global MCP registration (only CLI with no per-invocation option) ---

const AGY_MCP_CONFIG = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
const AGY_CONV_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
let agyRegistered = false;

// Merge-only: reads the existing global config, keeps every entry, and adds a
// server for mcp-proxy.mjs only if none is registered yet. Never overwrites an
// existing entry; if the name "browser" is taken it uses "agentchat-browser".
function ensureAgyRegistered(port) {
  if (agyRegistered) return;
  let config = {};
  try {
    config = JSON.parse(readFileSync(AGY_MCP_CONFIG, 'utf8'));
  } catch (err) {
    logWarn('agy mcp config unreadable, starting from empty', err);
    config = {};
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  const already = Object.values(config.mcpServers).some((s) =>
    s && Array.isArray(s.args) && s.args.includes(MCP_PROXY_PATH) && !s.disabled);
  if (already) {
    agyRegistered = true;
    return;
  }
  const name = config.mcpServers.browser ? 'agentchat-browser' : 'browser';
  const entry = { command: 'node', args: [MCP_PROXY_PATH] };
  if (port) entry.env = { AGENTCHAT_PORT: port };
  config.mcpServers[name] = entry;
  mkdirSync(path.dirname(AGY_MCP_CONFIG), { recursive: true });
  writeFileSync(AGY_MCP_CONFIG, JSON.stringify(config, null, 2) + '\n');
  agyRegistered = true;
}

function listAgyConversations() {
  try {
    return new Set(readdirSync(AGY_CONV_DIR).filter((f) => f.endsWith('.db')));
  } catch (err) {
    logWarn('agy conversation dir unreadable', err);
    return new Set();
  }
}

// --- preset table -----------------------------------------------------------
//
// Fields per preset:
//   bin           bare command name, resolved by resolveBin() at spawn time
//   stream        true: stdout is JSONL, parsed line by line via onLine()
//                 false: stdout is buffered and handed to parseOutput() on exit
//   sessionMode   'captured' (session id read from output; a missing id means
//                 the next turn starts fresh and gets an info note),
//                 'deterministic' (we pick the id), or 'agy' (conversation db
//                 diffing with -c fallback)
//   runInTempDir  spawn with cwd = state.tempDir so a generated project-scope
//                 config file is discovered
//   setup(state)          once per session: temp MCP config / registration
//   beforeTurn(state)     before each spawn
//   buildArgs(prompt, state)
//   onLine(msg, state, emit)        stream presets
//   parseOutput(text, state, emit)  buffered presets (text is ANSI-stripped)
//   afterExit(state)      after a successful exit

export const HARNESSES = {
  // OpenAI Codex CLI. codex exec --json; resume via `codex exec resume <id>`;
  // MCP attached per invocation with -c mcp_servers.browser.* overrides.
  codex: {
    bin: 'codex',
    stream: true,
    sessionMode: 'captured',
    buildArgs(prompt, state) {
      const args = ['exec'];
      if (state.sessionId) args.push('resume', state.sessionId);
      else args.push('--skip-git-repo-check');
      args.push('--json', '--dangerously-bypass-approvals-and-sandbox');
      args.push('-c', 'mcp_servers.browser.command="node"');
      args.push('-c', `mcp_servers.browser.args=[${JSON.stringify(MCP_PROXY_PATH)}]`);
      if (state.port) args.push('-c', `mcp_servers.browser.env.AGENTCHAT_PORT="${state.port}"`);
      args.push(prompt);
      return args;
    },
    onLine(msg, state, emit) {
      if (msg.type === 'thread.started') {
        const id = msg.thread_id || msg.threadId || msg.session_id ||
          (msg.thread && msg.thread.id) || msg.id;
        if (id) state.sessionId = id;
        return;
      }
      // turn.completed carries {usage}. Field names verified against the codex
      // binary's serde table (TokenUsage: input_tokens, cached_input_tokens,
      // cache_write_input_tokens, output_tokens, reasoning_output_tokens,
      // total_tokens). input_tokens is inclusive of the cached bucket — the
      // binary carries a separate derived non_cached_input_tokens metric, which
      // only makes sense if the plain field is the total.
      if (msg.type === 'turn.completed') {
        const u = msg.usage || {};
        setUsage(state, {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cached_input_tokens),
          cacheWriteTokens: num(u.cache_write_input_tokens)
        });
        return;
      }
      if (msg.type === 'error' && msg.message) {
        emit({ kind: 'error', message: truncate(String(msg.message)) });
        return;
      }
      const item = msg.item;
      if (!item || typeof item !== 'object') return;
      const itemType = item.item_type || item.type;
      const toolName = itemType === 'command_execution'
        ? 'bash'
        : shortToolName(item.tool || item.name || 'mcp');
      if (msg.type === 'item.started') {
        if (itemType === 'command_execution') {
          emit({ kind: 'tool_use', tool: toolName, args: { command: truncate(item.command || '') } });
        } else if (itemType === 'mcp_tool_call') {
          emit({ kind: 'tool_use', tool: toolName, args: item.arguments || item.input || {} });
        }
        return;
      }
      if (msg.type === 'item.completed') {
        if (itemType === 'agent_message') {
          if (item.text) emit({ kind: 'token', text: item.text });
        } else if (itemType === 'command_execution' || itemType === 'mcp_tool_call') {
          const ok = item.status ? !['failed', 'error'].includes(item.status) : true;
          emit({
            kind: 'tool_result',
            tool: toolName,
            ok,
            summary: summarize(item.aggregated_output ?? item.output ?? item.result ?? item.status ?? 'ok')
          });
        }
      }
    }
  },

  // opencode. NDJSON via --format json; resume via -s <sessionID>; MCP via a
  // generated opencode.json in a temp dir used as cwd (project scope).
  opencode: {
    bin: 'opencode',
    stream: true,
    sessionMode: 'captured',
    runInTempDir: true,
    setup(state) {
      state.tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentchat-opencode-'));
      const server = { type: 'local', command: ['node', MCP_PROXY_PATH], enabled: true };
      if (state.port) server.environment = { AGENTCHAT_PORT: state.port };
      writeFileSync(
        path.join(state.tempDir, 'opencode.json'),
        JSON.stringify({ mcp: { browser: server } }, null, 2) + '\n'
      );
    },
    buildArgs(prompt, state) {
      const args = ['run', '--format', 'json', '--dangerously-skip-permissions'];
      if (state.sessionId) args.push('-s', state.sessionId);
      args.push(prompt);
      return args;
    },
    onLine(msg, state, emit) {
      if (msg.sessionID && !state.sessionId) state.sessionId = msg.sessionID;
      const part = msg.part || {};
      // One step_finish per assistant step, several per turn — so these are
      // summed, not replaced. StepFinishPart's schema in the opencode binary is
      // {reason, cost, tokens:{total?, input, output, reasoning, cache:{read,
      // write}}}.
      //
      // Two notes on the numbers: opencode's `input` is INCLUSIVE of cache read
      // and cache write (its provider adapters build it with sumTokens(input,
      // cacheRead, cacheCreation)), unlike every other source here. And
      // `reasoning` is counted into output, matching opencode's own per-model
      // cost aggregation and how providers bill reasoning tokens.
      if (msg.type === 'step_finish') {
        const t = part.tokens || {};
        const cache = t.cache || {};
        const output = num(t.output);
        const reasoning = num(t.reasoning);
        addUsage(state, {
          inputTokens: num(t.input),
          outputTokens: addField(output, reasoning),
          cacheReadTokens: num(cache.read),
          cacheWriteTokens: num(cache.write)
        });
        return;
      }
      if (msg.type === 'text') {
        if (part.text) emit({ kind: 'token', text: part.text });
        return;
      }
      if (msg.type === 'tool_use') {
        const tool = shortToolName(part.tool || part.name);
        const st = part.state || {};
        if (st.status === 'completed' || st.status === 'error') {
          emit({
            kind: 'tool_result',
            tool,
            ok: st.status !== 'error',
            summary: summarize(st.output ?? st.error ?? 'ok')
          });
        } else {
          emit({ kind: 'tool_use', tool, args: st.input || part.input || {} });
        }
        return;
      }
      if (msg.type === 'error') {
        emit({ kind: 'error', message: summarize(msg.error || msg.message || 'error') });
      }
    }
  },

  // GitHub Copilot CLI. Plain stdout with -s; deterministic session id via
  // --session-id <uuid> reused every turn; MCP via --additional-mcp-config.
  copilot: {
    bin: 'copilot',
    stream: false,
    sessionMode: 'deterministic',
    setup(state) {
      state.copilotSession = randomUUID();
      const server = { type: 'local', command: 'node', args: [MCP_PROXY_PATH], tools: ['*'] };
      if (state.port) server.env = { AGENTCHAT_PORT: state.port };
      state.mcpFile = path.join(os.tmpdir(), `agentchat-copilot-mcp-${randomUUID()}.json`);
      writeFileSync(state.mcpFile, JSON.stringify({ mcpServers: { browser: server } }, null, 2) + '\n');
      state.tempFiles.push(state.mcpFile);
    },
    buildArgs(prompt, state) {
      return [
        '-p', prompt,
        '--allow-all-tools', '--allow-all-paths', '--no-ask-user',
        '-s', '--no-color', '--no-auto-update',
        '--additional-mcp-config', `@${state.mcpFile}`,
        '--session-id', state.copilotSession
      ];
    },
    parseOutput(text, state, emit) {
      emitPlainReply(text, emit);
    }
  },

  // Grok Build. Single JSON object via --output-format json (.text,
  // .sessionId); resume via --resume <id>; MCP via a generated project-scope
  // .grok/config.toml in a temp dir used as cwd.
  grok: {
    bin: 'grok',
    stream: false,
    sessionMode: 'captured',
    runInTempDir: true,
    setup(state) {
      state.tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentchat-grok-'));
      const dir = path.join(state.tempDir, '.grok');
      mkdirSync(dir, { recursive: true });
      let toml = '[mcp_servers.browser]\n' +
        'command = "node"\n' +
        `args = [${JSON.stringify(MCP_PROXY_PATH)}]\n` +
        'enabled = true\n';
      if (state.port) {
        toml += '\n[mcp_servers.browser.env]\n' + `AGENTCHAT_PORT = "${state.port}"\n`;
      }
      writeFileSync(path.join(dir, 'config.toml'), toml);
    },
    buildArgs(prompt, state) {
      const args = ['-p', prompt, '--output-format', 'json', '--always-approve'];
      if (state.sessionId) args.push('--resume', state.sessionId);
      return args;
    },
    parseOutput(text, state, emit) {
      const obj = parseLooseJson(text);
      if (!obj) {
        emitPlainReply(text, emit);
        return;
      }
      if (obj.sessionId) state.sessionId = obj.sessionId;
      // The final JSON object carries {usage} when the prompt reached the
      // model. Field names and semantics are documented inside the grok binary
      // itself: usage.input_tokens is UNCACHED ONLY, with cache_read_input_tokens
      // and cache_creation_input_tokens as the separate cache buckets — the same
      // convention Anthropic uses. grok also reports total_cost_usd, but grok
      // runs on the user's own plan here, so that figure is deliberately not
      // surfaced (see isMetered in pricing.mjs).
      if (obj.usage && typeof obj.usage === 'object') {
        setUsage(state, {
          inputTokens: num(obj.usage.input_tokens),
          outputTokens: num(obj.usage.output_tokens),
          cacheReadTokens: num(obj.usage.cache_read_input_tokens),
          cacheWriteTokens: num(obj.usage.cache_creation_input_tokens)
        });
      }
      if (obj.text) emit({ kind: 'token', text: obj.text });
    }
  },

  // antigravity CLI. Plain stdout from -p; conversation id discovered by
  // diffing ~/.gemini/antigravity-cli/conversations/*.db around turn 1, then
  // --conversation <id> (fallback -c); MCP via global config, merge-only.
  agy: {
    bin: 'agy',
    stream: false,
    sessionMode: 'agy',
    setup(state) {
      ensureAgyRegistered(state.port);
    },
    beforeTurn(state) {
      if (state.turnCount === 1) state.agyBefore = listAgyConversations();
    },
    buildArgs(prompt, state) {
      const args = ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '20m'];
      if (state.turnCount > 1) {
        if (state.sessionId) args.push('--conversation', state.sessionId);
        else args.push('-c');
      }
      return args;
    },
    afterExit(state) {
      if (state.sessionId || state.turnCount !== 1) return;
      const fresh = [...listAgyConversations()].filter((f) => !(state.agyBefore || new Set()).has(f));
      let best = null;
      let bestMtime = -1;
      for (const f of fresh) {
        const p = path.join(AGY_CONV_DIR, f);
        if (!existsSync(p)) continue;
        const m = statSync(p).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = f;
        }
      }
      if (best) state.sessionId = best.slice(0, -3);
    },
    parseOutput(text, state, emit) {
      emitPlainReply(text, emit);
    }
  },

  // Google Gemini CLI. JSONL via -o stream-json (init/message/tool_use/
  // tool_result/result); resume via -r <session_id> (sessions are cwd-scoped,
  // and the temp dir is stable for the session); MCP via a generated
  // .gemini/settings.json in that temp dir, other configured servers excluded
  // with --allowed-mcp-server-names.
  gemini: {
    bin: 'gemini',
    stream: true,
    sessionMode: 'captured',
    runInTempDir: true,
    setup(state) {
      state.tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentchat-gemini-'));
      const dir = path.join(state.tempDir, '.gemini');
      mkdirSync(dir, { recursive: true });
      const server = { command: 'node', args: [MCP_PROXY_PATH] };
      if (state.port) server.env = { AGENTCHAT_PORT: state.port };
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ mcpServers: { browser: server } }, null, 2) + '\n'
      );
    },
    buildArgs(prompt, state) {
      const args = [
        '-p', prompt,
        '-o', 'stream-json',
        '--approval-mode', 'yolo',
        '--allowed-mcp-server-names', 'browser'
      ];
      if (state.sessionId) args.push('-r', state.sessionId);
      return args;
    },
    onLine(msg, state, emit) {
      if (msg.type === 'init') {
        if (msg.session_id) state.sessionId = msg.session_id;
        if (state.turnCount === 1 && msg.model) {
          emit({ kind: 'info', message: `session started (model ${msg.model})` });
        }
        return;
      }
      if (msg.type === 'message') {
        if (msg.role === 'assistant' && msg.content) emit({ kind: 'token', text: msg.content });
        return;
      }
      if (msg.type === 'tool_use') {
        emit({
          kind: 'tool_use',
          tool: shortToolName(msg.name || msg.tool),
          args: msg.input || msg.args || {}
        });
        return;
      }
      if (msg.type === 'tool_result') {
        const ok = msg.status ? msg.status !== 'error' : !msg.is_error;
        emit({
          kind: 'tool_result',
          tool: shortToolName(msg.name || msg.tool),
          ok,
          summary: summarize(msg.output ?? msg.content ?? msg.result ?? 'ok')
        });
        return;
      }
      if (msg.type === 'result') {
        // StreamJsonFormatter.convertToStreamStats builds
        // {total_tokens, input_tokens, output_tokens, cached, input,
        //  duration_ms, tool_calls, models}. input_tokens is the prompt count
        // and INCLUDES the cached tokens (`cached` is a subset of it); `input`
        // is the derived prompt-minus-cached figure. Gemini reports no
        // cache-write bucket, so cacheWriteTokens stays null.
        //
        // The stats come from uiTelemetryService, which is cumulative for the
        // process — and this preset spawns one process per turn, so cumulative
        // and per-turn are the same thing here.
        const stats = msg.stats || {};
        setUsage(state, {
          inputTokens: num(stats.input_tokens),
          outputTokens: num(stats.output_tokens),
          cacheReadTokens: num(stats.cached),
          cacheWriteTokens: null
        });
        if (msg.status === 'error') {
          emit({ kind: 'error', message: summarize(msg.error || 'gemini error') });
        }
      }
    }
  }
};

export const GENERIC_CLI_NAMES = Object.keys(HARNESSES);

export function createGenericCliSession(name, ctx) {
  const preset = HARNESSES[name];
  if (!preset) throw new Error(`unknown generic CLI "${name}"`);

  const state = {
    port: process.env.AGENTCHAT_PORT || null,
    sessionId: null,
    turnCount: 0,
    tempDir: null,
    tempFiles: [],
    usage: { ...EMPTY_USAGE } // this turn's tokens; reset at the top of send()
  };
  let child = null;
  let turn = null; // { emit, resolve, startedAt }
  let closed = false;
  let aborted = false;
  let setupDone = false;
  let stdoutAll = '';
  let lineBuffer = '';
  let lastStderr = '';

  // Ends the current turn exactly once: optional error event, meta, then done.
  // Every termination path (clean exit, non-zero exit, spawn failure, abort,
  // dispose) goes through here, so exactly one meta lands per turn — nulls on
  // the paths where the CLI never got far enough to report usage, and always
  // nulls for copilot and agy, which never report it at all.
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
      ...(state.usage || EMPTY_USAGE)
    });
    state.usage = { ...EMPTY_USAGE };
    t.emit({ kind: 'done' });
    t.resolve();
  }

  function safeEmit(event) {
    if (turn) turn.emit(event);
  }

  function handleLine(line) {
    const clean = stripAnsi(line).trim();
    if (!clean) return;
    let msg;
    if (clean.startsWith('{') || clean.startsWith('[')) {
      try {
        msg = JSON.parse(clean);
      } catch (err) {
        logWarn('dropping malformed JSON line', err);
        return;
      }
    } else {
      return; // non-JSON noise on stdout
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      preset.onLine(msg, state, safeEmit);
    } catch (err) {
      // a malformed event must not kill the turn
      logWarn('onLine handler threw, event skipped', err);
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
      // Below the concurrency guard (so an in-flight turn's tally is never
      // clobbered) but above the setup/buildArgs paths that can bail out
      // without reaching endTurn — this turn starts from a clean slate no
      // matter how the previous one ended.
      state.usage = { ...EMPTY_USAGE };
      if (!setupDone) {
        try {
          if (preset.setup) await preset.setup(state);
          setupDone = true;
        } catch (err) {
          emit({ kind: 'error', message: `${name} setup failed: ${err && err.message ? err.message : String(err)}` });
          emit({ kind: 'done' });
          return;
        }
      }
      state.turnCount += 1;
      if (preset.sessionMode === 'captured' && state.turnCount > 1 && !state.sessionId) {
        emit({ kind: 'info', message: '(no session id captured; this turn starts a fresh conversation)' });
      }
      if (preset.beforeTurn) {
        try {
          preset.beforeTurn(state);
        } catch (err) {
          logWarn('beforeTurn hook threw, continuing turn', err);
        }
      }
      let args;
      try {
        args = preset.buildArgs(text, state);
      } catch (err) {
        emit({ kind: 'error', message: err && err.message ? err.message : String(err) });
        emit({ kind: 'done' });
        return;
      }
      stdoutAll = '';
      lineBuffer = '';
      lastStderr = '';
      aborted = false;
      await new Promise((resolve) => {
        turn = { emit, resolve, startedAt: Date.now() };
        let proc;
        const binPath = resolveBin(preset.bin);
        try {
          proc = spawn(binPath, args, {
            cwd: preset.runInTempDir ? state.tempDir : undefined,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (err) {
          endTurn(`${name} failed to start: ${err && err.message ? err.message : String(err)}`);
          return;
        }
        child = proc;
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
          if (preset.stream) {
            lineBuffer += chunk;
            let idx;
            while ((idx = lineBuffer.indexOf('\n')) !== -1) {
              handleLine(lineBuffer.slice(0, idx));
              lineBuffer = lineBuffer.slice(idx + 1);
            }
          } else {
            stdoutAll += chunk;
          }
        });
        proc.stderr.on('data', (chunk) => {
          lastStderr = (lastStderr + chunk).slice(-2000);
        });
        proc.on('error', (err) => {
          if (child === proc) child = null;
          const message = err && err.code === 'ENOENT'
            ? `${name} binary not found (looked for "${preset.bin}" on PATH; set AGENTCHAT_BIN_${preset.bin.toUpperCase()} to override)`
            : `${name} failed to start: ${err && err.message ? err.message : String(err)}`;
          endTurn(message);
        });
        proc.on('exit', (code, signal) => {
          if (child === proc) child = null;
          if (!turn) return;
          if (preset.stream && lineBuffer) {
            handleLine(lineBuffer);
            lineBuffer = '';
          }
          if (aborted) {
            safeEmit({ kind: 'info', message: 'turn aborted' });
            endTurn(null);
            return;
          }
          if (code !== 0) {
            const detail = stripAnsi(lastStderr).trim().split('\n').pop() || '';
            endTurn(`${name} exited (${signal || `code ${code}`})${detail ? `: ${detail}` : ''}`);
            return;
          }
          if (!preset.stream && preset.parseOutput) {
            try {
              preset.parseOutput(stripAnsi(stdoutAll), state, safeEmit);
            } catch (err) {
              endTurn(`could not parse ${name} output: ${err && err.message ? err.message : String(err)}`);
              return;
            }
          }
          if (preset.afterExit) {
            try {
              preset.afterExit(state);
            } catch (err) {
              logWarn('afterExit hook threw, ending turn anyway', err);
            }
          }
          endTurn(null);
        });
      });
    },

    abort() {
      // Kill only the current turn's child; its exit handler ends the turn
      // with done. Session state survives, so the next send resumes.
      if (child) {
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch (err) {
          logWarn('abort kill failed', err);
        }
      }
    },

    dispose() {
      closed = true;
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch (err) {
          logWarn('dispose kill failed', err);
        }
        child = null;
      }
      endTurn(null);
      if (state.tempDir) {
        try {
          rmSync(state.tempDir, { recursive: true, force: true });
        } catch (err) {
          logWarn('tempDir cleanup failed', err);
        }
        state.tempDir = null;
      }
      for (const f of state.tempFiles) {
        try {
          rmSync(f, { force: true });
        } catch (err) {
          logWarn('tempFile cleanup failed', err);
        }
      }
      state.tempFiles = [];
    }
  };
}
