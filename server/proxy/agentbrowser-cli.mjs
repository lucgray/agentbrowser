#!/usr/bin/env node
// agentbrowser CLI — drive a real Chrome tab without MCP.
// Usage:
//   agentbrowser <tool> [json-args]   call a browser tool, print JSON result
//   agentbrowser <tool> --output <path>  save base64 results (screenshot,
//                                     print_pdf) to a file, print metadata
//   agentbrowser tools                list available tools + arg schemas
//   agentbrowser backends             list adapters with readiness + models
//   agentbrowser <tool> --help        show one tool's schema
//
// The CLI is a thin WebSocket client of the hub (ws://127.0.0.1:9010 by
// default, override with AGENTBROWSER_HUB or --hub): it registers as a
// harness, sends one tool_call, prints the tool_result, exits. Buffers and
// debugger attachments live in the extension, not here — nothing is kept
// between invocations. The connection plumbing lives in cli-lib.mjs, shared
// with `agentbrowser session`.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS } from '../hub/tools.mjs';
import { createHubClient, saveBase64 } from './cli-lib.mjs';

const DEFAULT_HUB = 'ws://127.0.0.1:9010';
const DEFAULT_TIMEOUT_MS = 30000;

function usage(exitCode) {
  console.log(`Usage:
  agentbrowser <tool> [json-args] [--hub <url>] [--timeout <ms>] [--output <path>]
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
      const caps = await client.capabilities(opts.timeout);
      for (const a of caps.adapters || []) {
        const status =
          a.status === 'ready' ? 'ready'
          : a.status === 'missing-cli' ? `missing CLI${a.detail ? ` (${a.detail})` : ''}`
          : a.status === 'missing-key' ? `missing key${a.detail ? ` (${a.detail})` : ''}`
          : a.status || 'unknown';
        const models = (a.models || []).map((m) => m.id).join(', ');
        console.log(`${a.name}\n  ${status}${models ? `\n  models: ${models}` : ''}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(String((err && err.message) || err));
      process.exit(1);
    } finally {
      client.close();
    }
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
