# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project layout

- `extension/` — Chrome MV3 extension, plain JS, **no build step**. Load unpacked from `chrome://extensions`.
  - `sw.js` — service worker: connects to the hub over `ws://127.0.0.1:9010`, dispatches browser tools, owns the context menu and selection delivery via `chrome.storage.session`.
  - `sidepanel.js` / `sidepanel.html` / `sidepanel.css` — chat UI. No `innerHTML` on untrusted content (enforced by test).
  - `cdp.js` — executes browser tools through `chrome.debugger` (trusted CDP input).
  - `overlay.js` — in-page overlay. Its code is a string evaluated inside the page via `Runtime.evaluate` — console output lands on the **page** console.
  - `selection.js` / `selection.css` — content script: floating "Ask" button on text selection and rich context extraction (semantic path, headings, ±800 chars, code block + language, table header + row as markdown).
  - `annotation.js` / `annotation.css` — content script: quote-anchored underline/highlight/circle marks plus per-mark comment cards; comments run as `ann-<id>-<tabId>` chat turns routed back to the page by sw.js.
  - `inspect.js` / `inspect-core.js` — BBX-style observe-first tools: lazy CDP domain enablement, per-tab console/network/dialog ring buffers, a11y tree with DOM-outline fallback, reversible live patches. inspect-core.js is pure (page-side expression builders + HAR builder) and node-testable.
  - `agentbrowser-cli.mjs` / `install-skill.mjs` / `skill/SKILL.md` — MCP-free access (v1.6): the CLI is a one-shot WS harness client (`agentbrowser <tool> '<json>'`), the installer writes a shim + copies the skill doc for agents that don't load MCP servers.
  - `offscreen.js` — offscreen document that holds the WebSocket when MV3 suspends the worker.
  - `*.test.mjs` — `node:test` suites; DOM and `chrome.*` are stubbed.
- `server/` — local hub and agent adapters.
  - `hub.mjs` — WebSocket broker on `127.0.0.1:9010`, adapter registry, prompt composition (page context + selection). `log()` writes `[hub]`-tagged stderr with secret scrubbing.
  - `adapters/` — one module per backend: `claude-cli.mjs`, `generic-cli.mjs` (preconfigured presets incl. codex/opencode/gemini/devin), `claude-agent-sdk.mjs`, `api-anthropic.mjs`, `api-openai.mjs`. Shared plumbing in `base.mjs`; credentials via `keystore.mjs` (macOS Keychain / file fallback).
  - `mcp-proxy.mjs` — stdio MCP server exposing browser tools to external harnesses. **stderr only** — stdout is the protocol channel.
  - `tools.mjs` — tool schema definitions shared with the extension.
- `docs/index.html` — static landing page.
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

- Node 20+: `node --test extension/sidepanel.test.mjs extension/sidepanel.dom.test.mjs extension/markdown.test.mjs server/pricing.test.mjs server/api-adapters.test.mjs server/protocol-v13.test.mjs`
- `overlay.test.mjs` is a pre-existing upstream failure (hardcoded absolute path) — ignore it unless you're fixing it.

### Protocol changes

Add a `## protocol vX.Y` section to `PROTOCOL.md` whenever the wire shape changes (e.g. v1.4 added `context.selection`).

### Branch management (adopted 2026-09)

- One branch per PR, named `devin/<unix-ts>-<slug>` for agent sessions (the timestamp sorts chronologically; the slug names the change). Human work uses short `<topic>` names.
- Delete the branch right after its PR merges — locally and on the remote. Turn on GitHub's "Automatically delete head branches" repo setting so the remote side is automatic.
- Periodic sweep: `git fetch -p && git branch --merged origin/main` — delete anything listed that isn't the current branch.

## Working style

- Minimal focused edits; match the surrounding terse comment style (default: no comments).
- Never commit secrets; reference env vars in docs.
