# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project layout

- `extension/` — Chrome MV3 extension, plain JS, **no build step**. Load unpacked from `chrome://extensions`. Files are grouped by where they run:
  - `background/` — service-worker side: `sw.js` (hub connection, tool dispatch, context menu, selection delivery via `chrome.storage.session`), `cdp.js` (executes browser tools through `chrome.debugger` — trusted CDP input), `consent.js` / `consent-core.js` (consent gate, v1.7 — core is pure and node-testable), `inspect.js` / `inspect-core.js` (BBX-style observe-first tools — core is pure: page-side expression builders + HAR builder).
  - `content/` — content scripts: `selection.js` / `selection.css` (floating Ask button + rich context extraction) and `annotation.js` / `annotation.css` (quote-anchored underline/highlight/circle marks, per-mark comment cards, consent card host). Comments run as `ann-<id>-<tabId>` chat turns routed back by sw.js.
  - `page/` — `overlay.js`, evaluated inside the page via `Runtime.evaluate` — its console output lands on the **page** console.
  - `panel/` — `sidepanel.html` / `sidepanel.js` / `sidepanel.css` + `markdown.js`. Chat UI; no `innerHTML` on untrusted content (enforced by test).
  - `offscreen/` — `offscreen.html` / `offscreen.js`, holds the WebSocket when MV3 suspends the worker.
- `server/` — local hub and agent adapters.
  - `hub/` — `hub.mjs` (WebSocket broker on `127.0.0.1:9010`, adapter registry, prompt composition; `log()` writes `[hub]`-tagged stderr with secret scrubbing), `commands.mjs` (slash-command registry), `tools.mjs` (tool schema table shared with the extension), `config.json` (adapter + permissions config), `stub-adapter.mjs` (token-free adapter for the e2e suite).
  - `adapters/` — one module per backend: `claude-cli.mjs`, `generic-cli.mjs` (preconfigured presets incl. codex/opencode/gemini/devin), `claude-agent-sdk.mjs`, `api-anthropic.mjs`, `api-openai.mjs`. Shared plumbing in `base.mjs`; credentials via `keystore.mjs` (macOS Keychain / file fallback).
  - `proxy/` — external access: `mcp-proxy.mjs` (stdio MCP server — **stderr only**, stdout is the protocol channel), `agentbrowser-cli.mjs` + `install-skill.mjs` (MCP-free access, v1.6 — one-shot WS harness client + shim/skill installer), `smoke.mjs` (hub routing round trip).
  - `skill/` — the SKILL.md the installer copies.
- `docs/index.html` — static landing page.
- `tests/` — `node:test` suites: `extension/` covers extension files, `server/` covers hub + adapters.
- `PROTOCOL.md` — the hub↔extension wire protocol. Document new message/context shapes here with a version bump.
- `DESIGN.md` — longer design narrative.

## Conventions

Conventions are introduced in layers as they are decided; each is listed below with when it was adopted. New rules follow the same pattern.

### Logging and error handling (adopted 2026-09)

No silent catches. Every `catch` must do one of:

1. **Log** the error at a level matching its impact (see ladder below), or
2. **Propagate** — rethrow, emit an error event, or return a tool `errorResult` so the caller sees it.

A `catch` that also takes a fallback branch still logs first — logged fallback is observable, silent fallback is not. Empty `catch {}` blocks are forbidden outside test files.

**Level by impact — not everything is warn:**

- `console.error` — failures that break a user-visible feature or lose work: hub connect, tool execution, write/persist failures, aborted sessions.
- `console.warn` — recoverable anomalies where work continues or a fallback engages: malformed message dropped, probe/tentative step failed, cleanup (detach, rm, chmod) failed.
- **No catch at all** — probe-style existence/shape checks should avoid throwing APIs entirely rather than catch-and-log on hot paths: `existsSync` instead of `statSync`-as-probe, a `{`/`[` shape guard before `JSON.parse` on untrusted stream lines.

**Tagging and safety:**

- Extension files: `console.warn|error("[agentbrowser]", context, err)`.
- Server adapters: a per-file `logWarn(context, err)` helper writing `console.error("[<file>]", ...)`.
- `hub.mjs` uses its existing `log()` (adds `[hub]` tag + secret scrubbing). Code *on the log path itself* (e.g. `stringify()` feeding `log()`) must not call `log()` — use bare `console.error` to avoid recursion.
- `keystore.mjs` logs `err.message` only — never store contents.
- `overlay.js` logs land on the page console; keep them tagged.
- `mcp-proxy.mjs` logs to stderr only — stdout is the MCP channel.

### Tests

- `node:test` suites live in `tests/` — `tests/extension/` for extension code, `tests/server/` for hub/adapters. DOM and `chrome.*` are stubbed.
- Node 20+: `node --test tests/extension/*.test.mjs tests/server/*.test.mjs`
- Server tests resolve `ws` through `server/node_modules` via `createRequire`; import new server test files' deps the same way (or with `../../server/...` relative paths).

### Protocol changes

Add a `## protocol vX.Y` section to `PROTOCOL.md` whenever the wire shape changes (e.g. v1.4 added `context.selection`).

### Chat state (adopted 2026-09)

- Transcripts live on the hub, journaled to `~/.agentchat/chats/<chatId>.json` on each turn's `done`. The panel never stores history; it lists and re-opens chats via `chat_list`/`chat_resume` (v1.8).
- A chat is "live" only while its adapter session is registered in the hub; dead chats render read-only in the panel and a send detaches into a fresh chatId.

### Branch management (adopted 2026-09)

- One branch per PR, named `devin/<unix-ts>-<slug>` for agent sessions (the timestamp sorts chronologically; the slug names the change). Human work uses short `<topic>` names.
- Delete the branch right after its PR merges — locally and on the remote. Turn on GitHub's "Automatically delete head branches" repo setting so the remote side is automatic.
- Periodic sweep: `git fetch -p && git branch --merged origin/main` — delete anything listed that isn't the current branch.

## Working style

- Minimal focused edits; match the surrounding terse comment style (default: no comments).
- Never commit secrets; reference env vars in docs.
