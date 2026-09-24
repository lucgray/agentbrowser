<div align="center">

![AgentBrowser — Select it. Ask it. Let a coding agent drive your real browser.](docs/assets/hero.webp)

**Select it. Ask it.**

A Chrome side panel where an agent chats with you *and* controls your
logged-in browser through trusted CDP input — now with point-and-ask
on any page selection.

[![License: MIT](https://img.shields.io/badge/License-MIT-6C5CE7.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-6C5CE7.svg)](extension/manifest.json)
[![Node ≥ 20.11](https://img.shields.io/badge/Node-%E2%89%A5%2020.11-6C5CE7.svg)](server/package.json)
[![Protocol v1.6](https://img.shields.io/badge/Protocol-v1.6-6C5CE7.svg)](PROTOCOL.md)

**English** · [简体中文](README.zh-CN.md)

</div>

---

A fork of [VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser),
extended with ContextLens-style *select-and-ask* and a stricter
error-handling standard.

**[PROTOCOL.md](PROTOCOL.md)** is the wire-format source of truth ·
**[DESIGN.md](DESIGN.md)** explains the reasoning ·
**[AGENTS.md](AGENTS.md)** holds the repo conventions.

## Contents

- [This fork vs. upstream](#this-fork-vs-upstream)
- [Why CDP](#why-cdp)
- [Architecture](#architecture)
- [Install](#install)
- [Ask about a selection](#ask-about-a-selection)
- [Page annotations](#page-annotations)
- [Inspecting the page](#inspecting-the-page)
- [Tabs, files & voice](#tabs-files--voice)
- [Picking a model](#picking-a-model)
- [API keys](#using-an-api-key-instead-of-a-cli)
- [Adapters](#adapters)
- [Any other harness](#using-any-other-harness)
- [Browser tools](#browser-tools)
- [Tests](#tests)
- [Known constraints](#known-constraints)

## This fork vs. upstream

| | [VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser) | **this fork** |
|---|:---:|:---:|
| Side-panel chat + pluggable agent backends (SDK, CLIs, API adapters) | ✓ | ✓ |
| Trusted CDP input in your real profile — no automation profile, no re-login | ✓ | ✓ |
| Current-tab context, `@` tab tagging, attachments, dictation | ✓ | ✓ |
| `mcp-proxy.mjs` — any stdio-MCP harness drives the browser | ✓ | ✓ |
| **Select text → floating "Ask" button at the caret** | — | ✓ |
| **Right-click → "Ask AgentBrowser" context menu** | — | ✓ |
| **Rich selection context** — semantic DOM path, nearest heading, ±800 chars, enclosing `<pre>`/code block + language, table headers + active row as markdown → `context.selection` (protocol v1.4) | — | ✓ |
| **Page annotations** — `annotate`/`annotations_list`/`annotate_reply`/`annotate_clear` tools; underline, highlight, circle on quoted text; per-mark comment cards that run as their own chat turns (protocol v1.5) | — | ✓ |
| **Proactive co-reading pass** — opt-in `proactiveAnnotation` config: one background turn per page flags confusing passages with a why-note | — | ✓ |
| **Observe-first inspection** — BBX-style structured reads (`dom_inspect`, `console_log`, `network_log` + sanitized HAR, `a11y_tree`, dialog handling) and reversible live patches (`patch_apply`/`patch_revert`) — protocol v1.6 | — | ✓ |
| **MCP-free skill + CLI access** — `agentbrowser <tool> '<json>'` command + SKILL.md installer for agents that don't load MCP servers | — | ✓ |
| **No-silent-catch rule** — every catch logs or propagates, leveled by impact | — | ✓ |

> Upstream credit: the entire side-panel ↔ hub ↔ adapter architecture, the
> original ten browser tools, and all adapters are the work of the upstream
> project. This fork adds the selection-interaction and annotation layers
> and the conventions doc.
>
> Third-party credit: the selection-extraction code in
> `extension/selection.js` (heading/table/code-block capture, semantic path,
> floating Ask button) is adapted from
> [cola-sk/context-lens](https://github.com/cola-sk/context-lens) (MIT), noted
> in that file's header.

## Why CDP

Synthetic events from content scripts carry `isTrusted: false` and modern
editors (Lexical, React composers) ignore them. Input dispatched via
`chrome.debugger` is trusted: CDP clicks and `Input.insertText` land exactly
like a human's, verified against the Threads composer on 2026-08-01. Because
the extension attaches to your existing profile, there is no separate
automation profile and no re-login. The agent loop itself never touches page
DOM — everything it does goes through `chrome.debugger`. Two small content
scripts (`extension/selection.js`, `extension/annotation.js`) watch text
selections and render annotation marks plus their comment cards; neither
drives the page. For them the manifest adds `contextMenus, scripting` and
`*://*/*` host access on top of
`debugger, tabs, storage, offscreen, sidePanel`.

## Architecture

```
side panel  <-- runtime Port -->  service worker  <-- offscreen doc / WebSocket -->  hub (127.0.0.1:9010)
     ▲                                  |                                              |
     │                            chrome.debugger                              adapters (SDK, CLI, API)
selection.js                      (CDP executor)                              mcp-proxy.mjs (external harnesses)
(content script)
```

The hub (`server/hub.mjs`) relays chat between the panel and the active
adapter, and relays tool calls from any harness to the extension, which
executes them via CDP and returns the result. Selections captured by the
content script travel content-script → service worker →
`chrome.storage.session` → panel → `context.selection` in the next message.

## Install

**Requirements**

- Chrome (or any Chromium with `chrome.debugger` and `sidePanel`)
- Node.js 20.11 or newer
- At least one backend: a coding CLI on your `PATH`, or an Anthropic/OpenAI API key

**1 · Start the hub**

```bash
git clone https://github.com/lucgray/agentbrowser.git
cd agentbrowser/server
npm install
npm start          # listens on ws://127.0.0.1:9010
```

**2 · Load the extension**

1. Open `chrome://extensions` and enable Developer mode.
2. Load unpacked, and select the `extension/` directory of this repo.
3. Click the AgentBrowser toolbar icon. The side panel opens; the status dot
   turns green when the hub is reachable.

Type a message, pick an adapter from the dropdown if you don't want the
default from `server/config.json`, and send. Tool activity shows up as
compact chips in the transcript.

> **Tip** — override the port with `AGENTCHAT_PORT`. To keep the hub running
> across logins, [server/autostart.md](server/autostart.md) has a launchd
> recipe for macOS; the plist lives outside the repo. Logs go to
> `/tmp/agentchat-hub.log`. If the hub reports the port is in use, an
> autostarted copy is already running.

## Ask about a selection

*This fork's signature feature.*

- **Floating Ask** — highlight any text on a page and an **Ask** button
  appears at the caret. Click it: the side panel opens with the selection
  staged as a removable chip in the composer. It can clash with other
  overlays: uncheck **Floating Ask button on selection** in the right-click
  menu to turn it off (persisted in `chrome.storage.local`, applies
  instantly, Esc also dismisses it per selection).
- **Context menu** — right-click a selection and pick **Ask AgentBrowser**.
- **Rich context, automatically** — the next message carries
  `context.selection` (protocol v1.4): the selected text plus the semantic
  DOM path (`article > section > pre`), the nearest section heading, ±800
  characters of surrounding text, and, when the selection sits inside a code
  block or table, the whole enclosing block — code with its detected
  language, or the table's headers + active row rendered as markdown.

The agent sees all of it, so "explain this", "what does this regex do", or
"summarize this table" works on exactly what you highlighted.

## Page annotations

*The agent reads with you, not just for you.*

- **Three marks** — the agent can call `annotate` to leave an underline, a
  highlight, or a circle on any passage it can quote from the page
  (protocol v1.5). Marks render live: styled spans for underline and
  highlight, an SVG overlay ellipse for circle.
- **Comment threads on the page** — click a mark to open its comment card.
  Your comment becomes a chat turn on the adapter the panel is currently
  using; the reply streams back into the same card, so every mark grows
  its own thread. `annotate_reply` lets the agent post a targeted reply
  inside a thread instead of streaming a full turn.
- **Proactive marks, opt-in** — set `proactiveAnnotation` in
  `server/config.json` and the agent runs one background pass per page:
  it reads the tab and flags the passages it thinks are confusing — each
  mark carries a note saying why, in a color distinct from yours.

```jsonc
// server/config.json
{
  "adapter": "claude-agent-sdk",
  "proactiveAnnotation": {
    "enabled": true,
    "adapter": "devin",   // any adapter name; defaults to the chat's adapter
    "prompt": "..."       // optional override of the built-in co-reading prompt
  }
}
```

`annotations_list` returns every mark and thread on a tab — handy to ask
for a digest ("give me all the notes we left on this page") — and
`annotate_clear` removes one mark or all of them.

## Inspecting the page

*Observe first, then drive* — BBX-style structured reads so the agent works
from real state instead of screenshots, plus live reversible patches to
prove a change visually before touching source (protocol v1.6).

| tool | what you get |
|---|---|
| `dom_inspect` | Elements matching a CSS selector: tag, id, classes, every attribute, text, bounding rect, computed styles — no HTML dump |
| `console_log` | Ring buffer of console calls, uncaught exceptions and browser log entries, filterable by level |
| `network_log` | Recent requests with method/status/mimeType/timing/size; `har:true` exports a sanitized HAR 1.2 (credential headers always stripped) |
| `a11y_tree` | The page's accessibility tree (role + name + depth), with a DOM-derived outline fallback |
| `dialog_list` / `dialog_respond` | Alert/confirm/prompt dialogs are intercepted while the debugger is attached: listed, answerable, auto-dismissed after ~5s so pages never wedge |
| `patch_apply` / `patch_revert` | Live CSS/attribute/HTML/remove edits with an outerHTML snapshot, reverted element-by-element |

Capture is lazy: the first call enables the matching CDP domain on the
attached debugger session; buffers reset on navigation and never require
DevTools to be open.

## Tabs, files & voice

The panel sends more than your text with each message.

- **Tab context** — the tab you are looking at goes along with every
  message, so "summarize this page" or "fill this form" works without
  pasting a URL. The harness gets its tabId and uses it for `read_page`,
  `screenshot`, and `eval_js`.
- **`@` tagging** — type `@` in the composer to pick other open tabs by
  title. Tag two tabs to ask for a comparison.
- **Attachments** — pick or drop files into the composer. The panel
  base64-encodes them and the hub writes them to
  `<tmpdir>/agentchat-uploads/<chatId>/<name>`, then tells the harness the
  absolute paths so it can open them with its file tools. Total decoded size
  per message is capped at 8 MB. The upload directory for a chat is deleted
  when its session is disposed.
- **Mic** — the mic button dictates into the composer. It fills the text
  box — it does not send.

## Picking a model

The adapter dropdown is filled from the hub, not hardcoded: on connect the
hub tells the panel which adapters exist, what each one is called, which
models it can run, and which model it uses by default. Adapters with no
model switch (most CLIs, which read their own config) show an empty model
list.

Changing the model mid-chat restarts that chat's session, because the model
is fixed when the session is created. You get a "session restarted with
model X" line in the transcript and the next turn starts with no history.
Leaving the model alone never restarts anything.

## Using an API key instead of a CLI

Two adapters, `anthropic-api` and `openai-api`, call the provider's API
directly instead of shelling out to a CLI. They are useful when you don't
have that vendor's CLI installed or logged in, or when you want to pin a
specific model without touching a CLI config.

They need a key. Paste it into the panel; the hub writes it to
`~/.agentchat/keys.json` with mode 0600 in a directory with mode 0700, and
that is the only place it goes. The key never leaves the machine except in
the request to the provider you gave it for, never comes back to the panel
(the panel only ever learns whether a key is set), and never appears in the
hub's log, in a chat message, or in an error. Clearing the field deletes the
key.

API adapters get the same set of browser tools the CLI adapters get, so
"summarize this page" or "fill this form" works the same way. What they
don't get is a CLI's file and shell tools, so attachments arrive as paths
they can't open. Use a CLI adapter when a turn needs to read files off disk.

Send a chat to an API adapter with no key and nothing is spawned: the
transcript gets an error naming the missing key and the turn ends.

## Taking control of a form

Ask the harness to fill a form on the page you have open and it reads the
form first (labels, names, types, current values), then clicks each field
and types into it with trusted CDP input, then reads the values back so you
can check them.

It will not click submit, send, post, or buy unless you asked for that in
the chat. Filling is not permission to submit. If you want it to go through,
say so: "fill it and submit".

## Adapters

Selected per chat or via `server/config.json`:

| adapter | transport | session | notes |
|---|---|---|---|
| `claude-agent-sdk` | in-process (`@anthropic-ai/claude-agent-sdk`) | one SDK session per chat | browser tools exposed as an in-process MCP server; screenshots return as images |
| `claude-cli` | `claude -p`, stream-json | child process stays alive all session | full Claude Code toolset (files, bash) + browser tools via a generated MCP config |
| `anthropic-api` | Anthropic API | per chat | needs an API key, no CLI required |
| `openai-api` | OpenAI API | per chat | needs an API key, no CLI required |

<details>
<summary><b>Seven more CLIs</b> — wrapped by <code>server/adapters/generic-cli.mjs</code>: one process per turn, the CLI's own session resumed between turns, browser tools attached through <code>mcp-proxy.mjs</code></summary>

| adapter | spawn | resume | MCP wiring |
|---|---|---|---|
| `codex` | `codex exec --json` | `codex exec resume <thread id>` | `-c mcp_servers.browser.*` overrides per invocation |
| `opencode` | `opencode run --format json` | `-s <sessionID>` | generated `opencode.json` in a temp dir used as cwd |
| `copilot` | `copilot -p ... -s` | `--session-id <uuid>` reused every turn | `--additional-mcp-config` |
| `grok` | `grok -p ... --output-format json` | `--resume <sessionId>` | generated `.grok/config.toml` in a temp cwd |
| `agy` | `agy -p ...` | `--conversation <id>` (id found by diffing the conversations dir after turn 1, `-c` fallback) | registered once in global `~/.gemini/config/mcp_config.json` (merge-only) |
| `gemini` | `gemini -p ... -o stream-json` | `-r <session_id>` | generated `.gemini/settings.json` in a temp cwd; other servers excluded via `--allowed-mcp-server-names browser` |
| `devin` | `devin -p <prompt> --respect-workspace-trust false --permission-mode dangerous` | `-c` in the per-chat temp cwd (sessions are cwd-scoped) | generated `.devin/mcp_config.json` in the temp cwd |

Each CLI is looked up on your `PATH`. If yours lives somewhere unusual, set
`AGENTCHAT_BIN_<NAME>` to an absolute path, e.g.
`AGENTCHAT_BIN_CODEX=/opt/homebrew/bin/codex`.

</details>

## Using any other harness

`server/mcp-proxy.mjs` is a stdio MCP server that forwards tool calls to the
hub over WebSocket. Any harness that speaks MCP can drive the browser by
adding it to its MCP config:

```json
{
  "mcpServers": {
    "agentbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/agentbrowser/server/mcp-proxy.mjs"]
    }
  }
}
```

Start the hub, keep the extension loaded, and the harness gets the same tools
the built-in adapters use, with no adapter of its own. Cursor, Cline,
Qwen CLI, Codex, Gemini CLI and Claude Code all take a config in this
shape; only the file name differs (`config.toml` for Codex, `settings.json`
for Gemini, `.mcp.json` for Claude Code).

<details>
<summary><b>Clients that use a different key</b></summary>

| client | where the server goes |
|---|---|
| [OpenClaw](https://docs.openclaw.ai/cli/mcp) | `mcp.servers` in `openclaw.json`, or `openclaw mcp add browser --command node --arg <path>` |
| [Muse Code](https://dev.meta.ai/docs/muse-code/extending) | `mcp_servers` in the settings file, with `"transport": "stdio"` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) | `mcp_servers` in `~/.hermes/config.yaml`, or `hermes mcp add browser --command node --args <path>` |

</details>

The one requirement is **stdio** transport, since `mcp-proxy.mjs` is a
stdio server. A client that only speaks HTTP to MCP servers cannot reach it
as things stand.

## MCP-free access: skill + CLI

For agents that don't load MCP servers (or where you'd rather not wire a
config file), `server/agentbrowser-cli.mjs` exposes every browser tool as a
shell command — same tools, same hub, nothing long-lived:

```bash
node server/agentbrowser-cli.mjs read_page '{}'
node server/agentbrowser-cli.mjs dom_inspect '{"selector":"h1"}'
node server/agentbrowser-cli.mjs tools              # list tools
```

`npm run install-skill` (or `node server/install-skill.mjs`) writes an
`agentbrowser` shim into `~/.local/bin` and drops `server/skill/SKILL.md`
into `~/.claude/skills` and `~/.agents/skills` (`--target <dir>` for others),
so skill-based agents — Claude Code, anything reading `.agents` layouts —
get browser control with **no MCP config at all**. The CLI is stateless;
buffers and debugger attachments live in the extension, so a process per
call loses nothing.

<details>
<summary><b>Python agent frameworks</b> — LangGraph / DeepAgents via <code>langchain-mcp-adapters</code></summary>

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "agentbrowser": {
        "command": "node",
        "args": ["/absolute/path/to/agentbrowser/server/mcp-proxy.mjs"],
        "transport": "stdio",
    }
})
tools = await client.get_tools()
```

</details>

## Browser tools

| tool | args | result |
|---|---|---|
| `tabs_list` | `{}` | `{tabs:[{tabId,url,title,active}]}` |
| `tab_new` | `{url?}` | `{tabId}` |
| `tab_close` | `{tabId}` | `{closed:true}` |
| `navigate` | `{url, tabId?}` | `{url, title}` after load (20s cap) |
| `read_page` | `{tabId?, maxChars?}` | `{url, title, text}` (innerText, 60k char default cap) |
| `screenshot` | `{tabId?}` | `{base64, mimeType:"image/png"}` |
| `click` | `{x, y, tabId?}` | `{clicked:true}` |
| `type_text` | `{text, tabId?}` | `{typed:<charcount>}` (inserts into the focused element) |
| `press_key` | `{key, tabId?}` | `{pressed:key}` (e.g. "Enter", "Escape", "Meta+A") |
| `eval_js` | `{expression, tabId?}` | `{value}` |
| `dom_inspect` | `{selector, all?, styles?, max?, tabId?}` | `{selector, matched, elements:[...]}` |
| `console_log` | `{level?, limit?, clear?, tabId?}` | `{entries:[{ts,level,source,text,url}]}` |
| `network_log` | `{filter?, includeHeaders?, har?, limit?, clear?, tabId?}` | `{entries:[...], har?}` — credential headers always stripped |
| `a11y_tree` | `{maxDepth?, tabId?}` | `{source, nodes:[{role,name,depth,...}]}` |
| `dialog_list` | `{tabId?}` | `{dialogs:[{type,message,url,ts,status}]}` |
| `dialog_respond` | `{accept, promptText?, tabId?}` | `{handled, ...}` |
| `patch_apply` | `{patches:[{selector,styles?,attributes?,insertAdjacentHTML?,remove?}], label?, tabId?}` | `{patchId, applied, results}` |
| `patch_revert` | `{patchId, tabId?}` | `{patchId, reverted, missing}` |

`tabId` omitted means the active tab. The service worker attaches the
debugger on demand, serializes commands per tab, and re-attaches if Chrome
detaches it.

## Tests

```bash
cd server
npm test           # pricing, API adapters, protocol v1.3
npm run test:e2e   # end-to-end against a real hub over a real WebSocket
npm run smoke      # hub routing round trip; needs `npm start` in another shell

cd ../extension
node --test markdown.test.mjs overlay.test.mjs sidepanel.test.mjs sidepanel.dom.test.mjs
```

No test spends model tokens or spawns a CLI. The end-to-end suite points
the hub at `server/stub-adapter.mjs` via `AGENTCHAT_ADAPTER_MODULE`.

## Known constraints

- Chrome allows one debugger client per tab. If DevTools is open on a tab,
  or another CDP client is attached to it, tool calls on that tab fail
  until the other client detaches. Use different tabs or close DevTools.
- Chrome shows an "is being debugged" infobar while the debugger is
  attached. Dismissing it detaches the debugger; the next tool call
  re-attaches.
- The hub accepts one extension connection. Loading the extension in a
  second Chrome profile or window displaces the first: the old socket is
  closed and its in-flight tool calls fail with "displaced".
- Tool calls time out at the hub after 60 seconds.
- Adapter sessions are kept per chat and disposed after 30 minutes idle;
  sending to an old chatId after that starts a fresh session. Switching the
  adapter or the model dropdown mid-chat also ends the old session, so that
  turn starts with no history.
- API keys are per provider, not per adapter: one Anthropic key serves
  every adapter that talks to Anthropic. They are stored in plain text in
  `~/.agentchat/keys.json`, protected by file permissions, not encrypted.

---

<div align="center">

**License** — MIT · see [LICENSE](LICENSE) · upstream work ©
[VasiHemanth/agentbrowser](https://github.com/VasiHemanth/agentbrowser) (MIT)

</div>
