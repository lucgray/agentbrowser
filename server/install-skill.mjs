#!/usr/bin/env node
// install-skill.mjs — put the AgentBrowser skill + CLI on disk for agents
// that don't use MCP (Claude Code skills, generic `.agents` layouts).
//
// What it does:
//   1. Installs an `agentbrowser` shim into --bin-dir (default ~/.local/bin)
//      that execs `node <repo>/server/agentbrowser-cli.mjs "$@"`.
//   2. Copies skill/SKILL.md into each chosen target dir:
//        --target claude  -> ~/.claude/skills/agentbrowser/SKILL.md
//        --target agents  -> ~/.agents/skills/agentbrowser/SKILL.md
//        --target <dir>   -> <dir>/agentbrowser/SKILL.md (any explicit path)
//      With no --target it installs to every known location.
//
// Nothing is global except the shim in --bin-dir; uninstall by deleting the
// shim and the skill dirs.

import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'agentbrowser-cli.mjs');
const SKILL_SRC = join(HERE, 'skill', 'SKILL.md');

const DEFAULT_TARGETS = [
  ['claude', join(homedir(), '.claude', 'skills')],
  ['agents', join(homedir(), '.agents', 'skills')],
];

function parseArgs(argv) {
  const opts = { targets: [], binDir: join(homedir(), '.local', 'bin'), node: process.execPath };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.targets.push(argv[++i]);
    else if (a === '--bin-dir') opts.binDir = resolve(argv[++i]);
    else if (a === '--node') opts.node = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node install-skill.mjs [--target claude|agents|<dir>]... [--bin-dir <dir>] [--node <path>]`);
    process.exit(0);
  }
  if (!existsSync(CLI) || !existsSync(SKILL_SRC)) {
    console.error('run this from the repo: server/install-skill.mjs needs agentbrowser-cli.mjs and skill/SKILL.md next to it');
    process.exit(1);
  }

  // 1. CLI shim
  mkdirSync(opts.binDir, { recursive: true });
  const shim = join(opts.binDir, 'agentbrowser');
  writeFileSync(shim, `#!/bin/sh\nexec "${opts.node}" "${CLI}" "$@"\n`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  console.log(`cli: ${shim} -> node ${CLI}`);

  // 2. SKILL.md targets
  const targets =
    opts.targets.length === 0
      ? DEFAULT_TARGETS
      : opts.targets.map((t) => {
          if (t === 'claude') return ['claude', join(homedir(), '.claude', 'skills')];
          if (t === 'agents') return ['agents', join(homedir(), '.agents', 'skills')];
          const dir = isAbsolute(t) ? t : resolve(process.cwd(), t);
          return [dir, dir];
        });

  for (const [name, dir] of targets) {
    const dest = join(dir, 'agentbrowser');
    mkdirSync(dest, { recursive: true });
    cpSync(SKILL_SRC, join(dest, 'SKILL.md'));
    console.log(`skill(${name}): ${join(dest, 'SKILL.md')}`);
  }

  console.log('\nDone. Make sure the AgentBrowser extension is loaded and the hub is running (node server/hub.mjs).');
}

main();
