// MCP bridge for the in-process API adapters (api-anthropic, api-openai).
//
// config.json `mcpServers` follows the harness convention — {name: {command,
// args, env}} — and each entry is spawned as a stdio JSON-RPC MCP server.
// Its tools are exposed to the model namespaced as `mcp__<server>__<tool>`
// (the same shape the Claude Agent SDK uses) and calls route here instead of
// ctx.callBrowserTool. A server that fails to spawn or answer is logged and
// skipped; the chat still gets the rest.
//
// Stdio transport is newline-delimited JSON-RPC 2.0 (no Content-Length
// headers). Anything the child writes to stdout that is not a JSON object is
// logged and dropped — MCP servers print startup noise there.

import { spawn } from 'node:child_process';
import { resolveBin } from './generic-cli.mjs';

const TAG = '[mcp-bridge]';
const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 30000;

// log(message): a single ready-to-print string — the caller composes
// context and error text so info lines don't render a trailing ': undefined'.
function defaultLog(message) {
  console.error(TAG, message);
}

function errText(err) {
  return (err && err.message) || String(err);
}

class StdioMcpClient {
  constructor(name, spec, log) {
    this.name = name;
    this.spec = spec;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = '';
    this.child = null;
  }

  async connect() {
    const { command, args = [], env, cwd } = this.spec;
    if (!command || typeof command !== 'string') {
      throw new Error(`mcp server "${this.name}" has no command`);
    }
    // resolveBin knows the Windows shims (npx is npx.cmd); spawning a .cmd
    // needs shell:true (EINVAL since the 2024 Node security patch).
    const binPath = resolveBin(command);
    const cliShell =
      process.platform === 'win32' &&
      (binPath === command || /\.(cmd|bat)$/i.test(binPath));
    this.child = spawn(binPath, args, {
      cwd: typeof cwd === 'string' ? cwd : undefined,
      env: { ...process.env, ...(env && typeof env === 'object' ? env : {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: cliShell,
      windowsHide: true
    });
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('exit', (code) => {
      this.failAll(new Error(`mcp server "${this.name}" exited (${code})`));
    });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stdin.on('error', (err) => {
      // EPIPE when the child dies mid-write; the exit handler reports it.
      this.log(`stdin write failed for "${this.name}": ${errText(err)}`);
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agentbrowser', version: '1' }
    });
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {});
    this.tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
    return this;
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.log(`non-JSON stdout line from "${this.name}", dropped: ${errText(err)}`);
        continue;
      }
      if (msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'id')
          && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // Notifications and server->client requests are ignored: this bridge
      // only needs tools/list + tools/call.
    }
  }

  send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}" ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  callTool(toolName, args) {
    return this.request('tools/call', { name: toolName, arguments: args || {} });
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.failAll(new Error(`mcp server "${this.name}" closed`));
    if (this.child) {
      try {
        this.child.kill();
      } catch (err) {
        this.log(`kill failed for "${this.name}": ${errText(err)}`);
      }
      this.child = null;
    }
  }
}

// connectMcpServers(config, {log}) -> {tools, has(name), call(name, args), close()}
// tools entries are {name:"mcp__server__tool", description, inputSchema}.
export async function connectMcpServers(mcpServers, { log } = {}) {
  const warn = typeof log === 'function' ? log : defaultLog;
  const clients = new Map(); // namespaced tool name -> {client, tool}
  const tools = [];

  const specs = mcpServers && typeof mcpServers === 'object' ? mcpServers : {};
  const live = new Set();
  await Promise.all(Object.entries(specs).map(async ([serverName, spec]) => {
    if (!spec || typeof spec !== 'object') {
      warn(`mcp server "${serverName}" skipped: spec is not an object`);
      return;
    }
    const client = new StdioMcpClient(serverName, spec, warn);
    try {
      await client.connect();
    } catch (err) {
      warn(`mcp server "${serverName}" skipped: ${errText(err)}`);
      client.close();
      return;
    }
    live.add(client);
    for (const t of client.tools) {
      if (!t || typeof t.name !== 'string') continue;
      const namespaced = `mcp__${serverName}__${t.name}`;
      clients.set(namespaced, { client, tool: t.name });
      tools.push({
        name: namespaced,
        description: t.description || `MCP tool ${t.name} (${serverName})`,
        args: t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} }
      });
    }
    warn(`mcp server "${serverName}" connected, ${client.tools.length} tools`);
  }));

  return {
    tools,
    has: (name) => clients.has(name),
    async call(name, args) {
      const entry = clients.get(name);
      if (!entry) throw new Error(`unknown mcp tool ${name}`);
      const result = await entry.client.callTool(entry.tool, args);
      return result;
    },
    close() {
      for (const client of live) client.close();
      live.clear();
      clients.clear();
    }
  };
}
