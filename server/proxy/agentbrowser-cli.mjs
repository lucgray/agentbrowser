#!/usr/bin/env node
// agentbrowser CLI — drive a real Chrome tab without MCP.
// Usage:
//   agentbrowser <tool> [json-args]   call a browser tool, print JSON result
//   agentbrowser <tool> --output <path>  save base64 results (screenshot,
//                                     print_pdf) to a file, print metadata
//   agentbrowser session              persistent REPL: one call per line,
//                                     one hub connection for many calls
//   agentbrowser tools                list available tools + arg schemas
//   agentbrowser backends             list adapters with readiness + models
//   agentbrowser <tool> --help        show one tool's schema
//
// The CLI is a thin WebSocket client of the hub (ws://127.0.0.1:9010 by
// default, override with AGENTBROWSER_HUB or --hub): it registers as a
// harness, sends one tool_call, prints the tool_result, exits. Buffers and
// debugger attachments live in the extension, not here — nothing is kept
// between invocations. The connection plumbing lives in cli-lib.mjs, shared
// with `agentbrowser session`, which keeps one connection open across calls.

import { realpathSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { TOOLS } from '../hub/tools.mjs';
import { createHubClient, parseCommand, saveBase64 } from './cli-lib.mjs';

const DEFAULT_HUB = 'ws://127.0.0.1:9010';
const DEFAULT_TIMEOUT_MS = 30000;

function usage(exitCode) {
  console.log(`Usage:
  agentbrowser <tool> [json-args] [--hub <url>] [--timeout <ms>] [--output <path>]
  agentbrowser session
  agentbrowser tools
  agentbrowser backends
  agentbrowser <tool> --help`);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const opts = { hub: process.env.AGENTBROWSER_HUB || DEFAULT_HUB, timeout: DEFAULT_TIMEOUT_MS };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hub') opts.hub = argv[++i];
    else if (a === '--timeout') opts.timeout = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (a === '--output' || a === '-o') opts.output = argv[++i];
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

function printAdapters(caps) {
  for (const a of caps.adapters || []) {
    const status =
      a.status === 'ready' ? 'ready'
      : a.status === 'missing-cli' ? `missing CLI${a.detail ? ` (${a.detail})` : ''}`
      : a.status === 'missing-key' ? `missing key${a.detail ? ` (${a.detail})` : ''}`
      : a.status || 'unknown';
    const models = (a.models || []).map((m) => m.id).join(', ');
    console.log(`${a.name}\n  ${status}${models ? `\n  models: ${models}` : ''}`);
  }
}

// -----------------------------------------------------------------------
// session mode — one process, one hub connection, one line per call
// -----------------------------------------------------------------------

function printSessionHelp() {
  console.error(`session commands:
  <tool> [json-args] [--output <path>] [--timeout <ms>]   call a browser tool
  tools | backends | help | exit                          built-ins
Lines starting with # are comments; one connection is reused across calls.
Results print as JSON on stdout; failures print {"ok":false,"error":...} and the loop continues.`);
}

async function runSession(opts) {
  const client = createHubClient(opts.hub);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: process.stdin.isTTY ? 'ab> ' : '',
    terminal: process.stdin.isTTY === true
  });
  let closing = false;
  // Serialize: each call returns (result or error) before the next one starts.
  let queued = Promise.resolve();

  const shutdown = (code) => {
    if (closing) return;
    closing = true;
    client.close();
    rl.close();
    process.exit(code);
  };

  rl.on('line', (line) => {
    queued = queued
      .then(async () => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        if (trimmed === 'exit' || trimmed === 'quit') {
          shutdown(0);
          return;
        }
        if (trimmed === 'help' || trimmed === '?') {
          printSessionHelp();
          return;
        }
        if (trimmed === 'tools') {
          for (const t of TOOLS) console.log(`${t.name} — ${t.description.split('.')[0]}.`);
          return;
        }
        if (trimmed === 'backends') {
          try {
            printAdapters(await client.capabilities(opts.timeout));
          } catch (err) {
            console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
        }
        const parsed = parseCommand(trimmed);
        if (!parsed) return;
        if (!TOOLS.some((t) => t.name === parsed.tool)) {
          console.log(JSON.stringify({ ok: false, error: `unknown tool: ${parsed.tool} (run "tools")` }));
          return;
        }
        let args = {};
        if (parsed.argsJson) {
          try {
            args = JSON.parse(parsed.argsJson);
          } catch (err) {
            console.log(JSON.stringify({ ok: false, error: `args must be JSON: ${String((err && err.message) || err)}` }));
            return;
          }
        }
        try {
          const result = await client.call(parsed.tool, args, parsed.flags.timeout || opts.timeout);
          if (parsed.flags.output) {
            const meta = saveBase64(result, parsed.flags.output);
            if (meta) {
              console.log(JSON.stringify(meta));
              return;
            }
          }
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
        }
      })
      .catch(() => {})
      .then(() => {
        if (!closing) rl.prompt();
      });
  });
  rl.on('close', () => {
    queued.then(() => shutdown(0), () => shutdown(0));
  });
  rl.on('SIGINT', () => shutdown(130));
  if (process.stdin.isTTY !== true) {
    // Piped/scripted stdin: the readline SIGINT hook never fires.
    process.on('SIGINT', () => shutdown(130));
  }
  rl.prompt();
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
  if (toolName === 'backends') {
    const client = createHubClient(opts.hub);
    try {
      printAdapters(await client.capabilities(opts.timeout));
      process.exit(0);
    } catch (err) {
      console.error(String((err && err.message) || err));
      process.exit(1);
    } finally {
      client.close();
    }
  }
  if (toolName === 'session') {
    await runSession(opts);
    return;
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

  const client = createHubClient(opts.hub);
  let result;
  try {
    result = await client.call(toolName, args, opts.timeout);
  } catch (err) {
    client.close();
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
  client.close();

  if (opts.output) {
    const meta = saveBase64(result, opts.output);
    if (meta) {
      console.log(JSON.stringify(meta));
      process.exit(0);
    }
    // result carries no base64 payload — fall through to the normal print
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// Run only when invoked directly, so tests can import the helpers.
function invokedAsMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main().catch((err) => {
    console.error(String((err && err.message) || err));
    process.exit(1);
  });
}
