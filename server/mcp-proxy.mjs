#!/usr/bin/env node
// Stdio MCP server exposing the AgentChat browser tools (PROTOCOL.md
// "mcp-proxy"). Any MCP-capable harness (claude CLI, Codex, Gemini CLI,
// Cursor, ...) adds this file to its MCP config:
//
//   { "mcpServers": { "browser": { "command": "node",
//     "args": ["/abs/path/to/mcp-proxy.mjs"] } } }
//
// Each tool call is relayed to the hub over a lazy WebSocket connection
// (role harness, name mcp-proxy); the hub forwards it to the extension.
// Run standalone: node mcp-proxy.mjs

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, TOOL_NAMES } from './tools.mjs';

const HUB_PORT = process.env.AGENTCHAT_PORT || '9010';
const HUB_URL = `ws://127.0.0.1:${HUB_PORT}`;
const CALL_TIMEOUT_MS = 60000;

let ws = null;
let connectPromise = null;
const pending = new Map(); // id -> { resolve, reject, timer }

function failAllPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
    pending.delete(id);
  }
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;
  connectPromise = new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(HUB_URL);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'mcp-proxy' }));
      ws = socket;
      connectPromise = null;
      settled = true;
      resolve();
    });

    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error('[mcp-proxy] dropping non-JSON hub message:', (err && err.message) || err);
        return;
      }
      if (msg && msg.type === 'tool_result' && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'tool call failed'));
      }
    });

    socket.on('error', () => {
      // close follows; handled there
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        connectPromise = null;
        reject(new Error(`cannot reach hub at ${HUB_URL}`));
      }
      // Only fail pending calls if this socket is still the current one; a
      // late close from a replaced socket must not kill calls in flight on
      // its successor.
      if (ws === socket) {
        ws = null;
        failAllPending('hub connection lost');
      }
    });
  });
  return connectPromise;
}

async function callBrowserTool(tool, args) {
  await ensureConnected();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'tool_call', id, tool, args }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

const server = new Server(
  { name: 'agentchat-browser', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.args
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments || {};
  if (!TOOL_NAMES.includes(name)) {
    return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
  }
  try {
    const result = await callBrowserTool(name, args);
    if (name === 'screenshot') {
      return {
        content: [{
          type: 'image',
          data: result.base64,
          mimeType: result.mimeType || 'image/png'
        }]
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[mcp-proxy] tool call failed:', message);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
