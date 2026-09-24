#!/usr/bin/env node
// agentbrowser CLI — drive a real Chrome tab without MCP.
// Usage:
//   agentbrowser <tool> [json-args]   call a browser tool, print JSON result
//   agentbrowser tools                list available tools + arg schemas
//   agentbrowser <tool> --help        show one tool's schema
//
// The CLI is a thin WebSocket client of the hub (ws://127.0.0.1:9010 by
// default, override with AGENTBROWSER_HUB or --hub): it registers as a
// harness, sends one tool_call, prints the tool_result, exits. Buffers and
// debugger attachments live in the extension, not here — nothing is kept
// between invocations.

import { WebSocket } from 'ws';
import { TOOLS } from './tools.mjs';

const DEFAULT_HUB = 'ws://127.0.0.1:9010';
const DEFAULT_TIMEOUT_MS = 30000;

function usage(exitCode) {
  console.log(`Usage:
  agentbrowser <tool> [json-args] [--hub <url>] [--timeout <ms>]
  agentbrowser tools
  agentbrowser <tool> --help`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { hub: process.env.AGENTBROWSER_HUB || DEFAULT_HUB, timeout: DEFAULT_TIMEOUT_MS };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hub') opts.hub = argv[++i];
    else if (a === '--timeout') opts.timeout = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (a === '--help' || a === '-h') opts.help = true;
    else positional.push(a);
  }
  return { opts, positional };
}

function describeTool(name) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return null;
  return `${t.name}\n  ${t.description}\n  args: ${JSON.stringify(t.args.properties || {}, null, 2)}\n  required: ${JSON.stringify(t.args.required || [])}`;
}

async function callTool(hub, tool, args, timeoutMs) {
  const ws = new WebSocket(hub);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error(`cannot reach hub at ${hub}`)), 5000);
    });
    ws.send(JSON.stringify({ type: 'hello', role: 'harness', name: 'agentbrowser-cli' }));
    const id = 'cli-1';
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (err) {
          console.warn(`[agentbrowser-cli] non-JSON frame ignored: ${String(err && err.message)}`);
          return;
        }
        if (msg.type === 'tool_result' && msg.id === id) {
          clearTimeout(timer);
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error || 'tool failed'));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`hub socket error: ${String((err && err.message) || err)}`));
      });
      ws.send(JSON.stringify({ type: 'tool_call', id, tool, args }));
    });
    return result;
  } finally {
    try {
      ws.close();
    } catch (err) {
      console.warn(`[agentbrowser-cli] socket close failed: ${String(err && err.message)}`);
    }
  }
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const [toolName, argsJson] = positional;

  if (!toolName || opts.help) {
    if (toolName && opts.help) {
      const desc = describeTool(toolName);
      if (desc) {
        console.log(desc);
        process.exit(0);
      }
    }
    usage(toolName ? 0 : 1);
  }
  if (toolName === 'tools') {
    for (const t of TOOLS) console.log(`${t.name} — ${t.description.split('.')[0]}.`);
    process.exit(0);
  }
  if (!TOOLS.some((t) => t.name === toolName)) {
    console.error(`unknown tool: ${toolName} (run "agentbrowser tools")`);
    process.exit(2);
  }

  let args = {};
  if (argsJson) {
    try {
      args = JSON.parse(argsJson);
    } catch (err) {
      console.error(`args must be JSON: ${String((err && err.message) || err)}`);
      process.exit(2);
    }
  }

  try {
    const result = await callTool(opts.hub, toolName, args, opts.timeout);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
