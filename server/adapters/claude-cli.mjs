// Claude Code CLI adapter (PROTOCOL.md "Adapter interface").
//
// Spawns `claude -p` once per chat session with stream-json input and output.
// User turns are written as stream-json lines on stdin; stdout lines are
// parsed into chat events. Browser tools reach the CLI through a generated
// MCP config that points at mcp-proxy.mjs, which relays to the hub over WS.

import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_PROXY_PATH = path.resolve(__dirname, '..', 'mcp-proxy.mjs');
const MCP_SERVER_NAME = 'browser';
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function logWarn(context, err) {
  console.error('[claude-cli]', context + ':', (err && err.message) || err);
}

function shortToolName(name) {
  return name && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function summarizeToolResult(content) {
  if (content == null) return 'ok';
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && block.text) parts.push(block.text);
      else if (block && block.type === 'image') parts.push('[image]');
    }
    return truncate(parts.join(' ')) || 'ok';
  }
  return truncate(JSON.stringify(content));
}

function truncate(s, max = 200) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// --- usage ------------------------------------------------------------------
//
// The CLI's stream-json `result` line carries the same usage object the Agent
// SDK's SDKResultMessage does (both come from the same claude binary): the
// Anthropic API wire names input_tokens / output_tokens /
// cache_read_input_tokens / cache_creation_input_tokens.
//
// Per turn, not cumulative: in stream-json input mode the CLI runs its turn
// generator once per user message with a fresh usage accumulator, so each
// result line covers only that turn.
const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null
};

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Exported so the parser can be tested against a canned result line without
// spawning the claude CLI.
export function usageFromApi(usage) {
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE };
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens)
  };
}

function writeMcpConfig() {
  const configPath = path.join(os.tmpdir(), `agentchat-mcp-${randomUUID()}.json`);
  const server = {
    command: 'node',
    args: [MCP_PROXY_PATH]
  };
  if (process.env.AGENTCHAT_PORT) {
    server.env = { AGENTCHAT_PORT: process.env.AGENTCHAT_PORT };
  }
  writeFileSync(configPath, JSON.stringify({
    mcpServers: { [MCP_SERVER_NAME]: server }
  }));
  return configPath;
}

export function createClaudeCliSession(ctx) {
  let child = null;
  let mcpConfigPath = null;
  let closed = false;
  let dead = false; // child failed to spawn or exited
  let stdoutBuffer = '';
  let lastStderr = '';
  let turn = null; // { emit, resolve, startedAt }
  let turnUsage = { ...EMPTY_USAGE }; // filled by the result line, if it arrives
  const toolNamesById = new Map();

  // Ends the current turn exactly once: optional error event, meta, then done.
  // Every termination path (result, child exit, spawn error, dispose) goes
  // through here, so exactly one meta lands per turn — with nulls on the paths
  // that never saw a result line, since a turn still owes a meta.
  function endTurn(errorMessage) {
    const t = turn;
    if (!t) return;
    turn = null;
    if (errorMessage) t.emit({ kind: 'error', message: errorMessage });
    t.emit({
      kind: 'meta',
      model: ctx.model || (ctx.config && ctx.config.model) || null,
      adapter: 'claude-cli',
      elapsedMs: Date.now() - t.startedAt,
      ...turnUsage
    });
    turnUsage = { ...EMPTY_USAGE };
    t.emit({ kind: 'done' });
    t.resolve();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (turn) turn.emit({ kind: 'info', message: `session started (model ${msg.model})` });
      return;
    }
    if (msg.type === 'assistant') {
      const content = msg.message && msg.message.content;
      if (!Array.isArray(content) || !turn) return;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          turn.emit({ kind: 'token', text: block.text });
        } else if (block.type === 'tool_use') {
          toolNamesById.set(block.id, block.name);
          turn.emit({ kind: 'tool_use', tool: shortToolName(block.name), args: block.input || {} });
        }
      }
      return;
    }
    if (msg.type === 'user') {
      const content = msg.message && msg.message.content;
      if (!Array.isArray(content) || !turn) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const name = toolNamesById.get(block.tool_use_id) || 'tool';
          toolNamesById.delete(block.tool_use_id);
          turn.emit({
            kind: 'tool_result',
            tool: shortToolName(name),
            ok: !block.is_error,
            summary: summarizeToolResult(block.content)
          });
        }
      }
      return;
    }
    if (msg.type === 'result') {
      // Read usage before endTurn — endTurn is what emits the meta event.
      turnUsage = usageFromApi(msg.usage);
      if (msg.is_error) {
        const message = Array.isArray(msg.errors) && msg.errors.length > 0
          ? msg.errors.join('; ')
          : (msg.result || msg.subtype || 'error');
        endTurn(message);
      } else {
        endTurn(null);
      }
    }
  }

  function handleStdout(chunk) {
    stdoutBuffer += chunk;
    let idx;
    while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      if (line.startsWith('{') || line.startsWith('[')) {
        try {
          msg = JSON.parse(line);
        } catch (err) {
          logWarn('dropping malformed JSON line', err);
          continue;
        }
      } else {
        continue; // non-JSON noise on stdout
      }
      handleMessage(msg);
    }
  }

  function ensureStarted() {
    if (child || dead) return;
    mcpConfigPath = writeMcpConfig();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', mcpConfigPath
    ];
    // ctx.model is the panel's per-message pick (already resolved against this
    // adapter's descriptor); config.model is only the fallback.
    const model = ctx.model || (ctx.config && ctx.config.model);
    if (model) {
      args.push('--model', model);
    }
    child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handleStdout);
    child.stderr.on('data', (chunk) => {
      lastStderr = (lastStderr + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      dead = true;
      const message = err && err.code === 'ENOENT'
        ? 'claude CLI not found on PATH'
        : `claude CLI failed to start: ${err.message}`;
      endTurn(message);
    });
    child.on('exit', (code, signal) => {
      dead = true;
      if (closed) {
        endTurn(null);
        return;
      }
      const detail = lastStderr.trim().split('\n').pop() || '';
      endTurn(`claude CLI exited (${signal || `code ${code}`})${detail ? `: ${detail}` : ''}`);
    });
  }

  return {
    async send(text, emit) {
      if (closed) {
        emit({ kind: 'error', message: 'session disposed' });
        emit({ kind: 'done' });
        return;
      }
      if (dead) {
        // A crashed CLI is recoverable: respawn fresh on the next message.
        // The conversation context is lost, but the chat keeps working.
        child = null;
        dead = false;
        stdoutBuffer = '';
        lastStderr = '';
        if (mcpConfigPath) {
          try {
            rmSync(mcpConfigPath, { force: true });
          } catch (err) {
            logWarn('mcp config cleanup failed', err);
          }
          mcpConfigPath = null;
        }
      }
      if (turn) {
        emit({ kind: 'error', message: 'a turn is already in progress for this chat' });
        emit({ kind: 'done' });
        return;
      }
      // Below the concurrency guard (so an in-flight turn's tally is never
      // clobbered) but above ensureStarted, which can bail out without
      // reaching endTurn.
      turnUsage = { ...EMPTY_USAGE };
      try {
        ensureStarted();
      } catch (err) {
        emit({ kind: 'error', message: err && err.message ? err.message : String(err) });
        emit({ kind: 'done' });
        return;
      }
      await new Promise((resolve) => {
        turn = { emit, resolve, startedAt: Date.now() };
        const line = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        }) + '\n';
        try {
          child.stdin.write(line);
        } catch (err) {
          endTurn(`could not write to claude CLI: ${err.message}`);
        }
      });
    },

    abort() {
      // Interrupt the turn without killing the child; SIGINT would exit the
      // CLI and lose the conversation. PROTOCOL.md kills only on dispose.
      if (child && !dead) {
        try {
          child.stdin.write(JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' }
          }) + '\n');
        } catch (err) {
          logWarn('interrupt write failed', err);
        }
      }
    },

    dispose() {
      closed = true;
      endTurn(null);
      if (child) {
        try {
          child.stdin.end();
        } catch (err) {
          logWarn('stdin close failed', err);
        }
        try {
          child.kill('SIGTERM');
        } catch (err) {
          logWarn('dispose kill failed', err);
        }
        child = null;
      }
      if (mcpConfigPath) {
        try {
          rmSync(mcpConfigPath, { force: true });
        } catch (err) {
          logWarn('mcp config cleanup failed', err);
        }
        mcpConfigPath = null;
      }
    }
  };
}
