# AgentBrowser

A Chrome side panel that chats with a coding harness while the harness drives
your real browser. The extension executes browser actions through
`chrome.debugger` (CDP) in your normal, logged-in profile. The chat backend is
pluggable: the Claude Agent SDK runs in-process, the Claude Code CLI runs
headless, and any MCP-capable harness (Codex, Gemini CLI, Cursor, another
Claude Code) can attach through a small stdio proxy.

Message shapes, tool names, and file paths are specified in
[PROTOCOL.md](PROTOCOL.md). That file is the source of truth; this one is the
tour. [DESIGN.md](DESIGN.md) covers why the pieces are shaped the way they are.

## Why CDP

Synthetic events from content scripts carry `isTrusted: false` and modern
editors (Lexical, React composers) ignore them. Input dispatched via
`chrome.debugger` is trusted: CDP clicks and `Input.insertText` land exactly
like a human's, verified against the Threads composer on 2026-08-01. Because
the extension attaches to your existing profile, there is no separate
automation profile, and no re-login. The agent loop itself never touches page
DOM — everything it does goes through `chrome.debugger`. One small content
script (`extension/selection.js`) does exist, but it only watches text
selections for the floating Ask button and the context-menu item; it never
drives the page. For it the manifest adds `contextMenus, scripting` and
`*://*/*` host access on top of `debugger, tabs, storage, offscreen,
sidePanel`.

## Architecture

```
side panel  <-- runtime Port -->  service worker  <-- offscreen doc / WebSocket -->  hub (127.0.0.1:9010)
                                        |                                              |
                                  chrome.debugger                              adapters (SDK, CLI)
                                   (CDP executor)                              mcp-proxy.mjs (external harnesses)
```

The hub (`server/hub.mjs`) relays chat between the panel and the active
adapter, and relays tool calls from any harness to the extension, which
executes them via CDP and returns the result.

## Requirements

- Chrome (or any Chromium with `chrome.debugger` and `sidePanel`)
- Node.js 20.11 or newer
- At least one backend: a coding CLI on your PATH, or an Anthropic/OpenAI API key

## Install

```bash
git clone https://github.com/VasiHemanth/agentbrowser.git
cd agentbrowser/server
npm install
npm start          # listens on ws://127.0.0.1:9010
```

Then load the extension:

1. Open `chrome://extensions` and enable Developer mode.
2. Load unpacked, and select the `extension/` directory of this repo.
3. Click the AgentBrowser toolbar icon. The side panel opens; the status dot
   turns green when the hub is reachable.

Type a message, pick an adapter from the dropdown if you don't want the
default from `server/config.json`, and send. Tool activity shows up as
compact chips in the transcript.

Override the port with `AGENTCHAT_PORT`. To keep the hub running across
logins, [server/autostart.md](server/autostart.md) has a launchd recipe for
macOS; the plist lives outside the repo. Logs go to `/tmp/agentchat-hub.log`.
If the hub reports the port is in use, an autostarted copy is already running.

## Picking a model

The adapter dropdown is filled from the hub, not hardcoded: on connect the hub
tells the panel which adapters exist, what each one is called, which models it
can run, and which model it uses by default. Adapters with no model switch
(most of the CLIs, which read their own config) show an empty model list.

Changing the model mid-chat restarts that chat's session, because the model is
fixed when the session is created. You get a "session restarted with model X"
line in the transcript and the next turn starts with no history. Leaving the
model alone never restarts anything.

## Using an API key instead of a CLI

Two adapters, `anthropic-api` and `openai-api`, call the provider's API
directly instead of shelling out to a CLI. They are useful when you don't have
that vendor's CLI installed or logged in, or when you want to pin a specific
model without touching a CLI config.

They need a key. Paste it into the panel; the hub writes it to
`~/.agentchat/keys.json` with mode 0600 in a directory with mode 0700, and that
is the only place it goes. The key never leaves the machine except in the
request to the provider you gave it for, never comes back to the panel (the
panel only ever learns whether a key is set), and never appears in the hub's
log, in a chat message, or in an error. Clearing the field deletes the key.

API adapters get the same ten browser tools the CLI adapters get, so
"summarize this page" or "fill this form" works the same way. What they don't
get is a CLI's file and shell tools, so attachments arrive as paths they can't
open. Use a CLI adapter when a turn needs to read files off disk.

Send a chat to an API adapter with no key and nothing is spawned: the
transcript gets an error naming the missing key and the turn ends.

## Tabs, files, and voice

The panel sends more than your text with each message.

- Tab context: the tab you are looking at goes along with every message, so
  "summarize this page" or "fill this form" works without you pasting a URL.
  The harness gets its tabId and uses it for `read_page`, `screenshot`, and
  `eval_js`.
- Ask about a selection: highlight text on a page and a floating Ask button
  appears at the caret, or right-click and pick "Ask AgentBrowser". Either way
  the side panel opens with the selection staged as a chip; the next message
  carries it as `context.selection` with the surrounding paragraphs, the
  nearest section heading, the DOM path, and — when the selection sits inside
  a code block or a table — the whole enclosing block (code with its detected
  language, or the table's headers + active row as markdown). The agent sees
  all of it, so "explain this" or "what does this regex do" works on exactly
  what you highlighted.
- `@` tagging: type `@` in the composer to pick other open tabs by title. Each
  tagged tab is sent with the message and the harness can read any of them.
  Tag two tabs to ask for a comparison.
- Attachments: pick or drop files into the composer. The panel base64-encodes
  them and the hub writes them to
  `<tmpdir>/agentchat-uploads/<chatId>/<name>`, then tells the harness the
  absolute paths so it can open them with its file tools. Total decoded size
  per message is capped at 8 MB; over that the message is rejected with an
  error in the transcript and nothing is written. The upload directory for a
  chat is deleted when its session is disposed.
- Mic: the mic button dictates into the composer. It fills the text box, it
  does not send; you still read it and hit send.

## Taking control of a form

Ask the harness to fill a form on the page you have open and it reads the
form first (labels, names, types, current values), then clicks each field and
types into it with trusted CDP input, then reads the values back so you can
check them.

It will not click submit, send, post, or buy unless you asked for that in the
chat. Filling is not permission to submit. If you want it to go through, say
so: "fill it and submit".

## Adapters

Selected per chat or via `server/config.json`:

- `claude-agent-sdk`: runs `@anthropic-ai/claude-agent-sdk` inside the hub
  process. The ten browser tools are exposed to the model as an in-process
  MCP server; screenshots come back as images the model can see. One SDK
  session per chat, so context carries across turns.
- `claude-cli`: spawns `claude -p` in stream-json mode with a generated MCP
  config pointing at `mcp-proxy.mjs`. The child process stays alive for the
  whole session. Useful if you want the full Claude Code toolset (files,
  bash) alongside the browser tools.

Six more CLIs are wrapped by `server/adapters/generic-cli.mjs`. These spawn
one process per turn and resume the CLI's own session between turns; browser
tools attach through `mcp-proxy.mjs`:

- `codex`: `codex exec --json`, resumes via `codex exec resume <thread id>`,
  MCP attached per invocation with `-c mcp_servers.browser.*` overrides.
- `opencode`: `opencode run --format json`, resumes via `-s <sessionID>`,
  MCP via a generated `opencode.json` in a temp dir used as cwd.
- `copilot`: `copilot -p ... -s`, plain-text reply, deterministic session via
  `--session-id <uuid>` reused every turn, MCP via `--additional-mcp-config`.
- `grok`: `grok -p ... --output-format json`, resumes via `--resume
  <sessionId>`, MCP via a generated `.grok/config.toml` in a temp cwd.
- `agy`: `agy -p ...`, plain-text reply, resumes via `--conversation <id>`
  (id found by diffing the conversations dir after turn 1, `-c` fallback),
  MCP registered once in the global `~/.gemini/config/mcp_config.json`
  (merge-only; existing entries are kept).
- `gemini`: `gemini -p ... -o stream-json`, resumes via `-r <session_id>`,
  MCP via a generated `.gemini/settings.json` in a temp cwd, other configured
  servers excluded with `--allowed-mcp-server-names browser`.

Each CLI is looked up on your `PATH`. If yours lives somewhere unusual, set
`AGENTCHAT_BIN_<NAME>` to an absolute path, e.g.
`AGENTCHAT_BIN_CODEX=/opt/homebrew/bin/codex`.

Two more talk to a provider API directly and need a key rather than a CLI:

- `anthropic-api`: Anthropic's API, key stored under the `anthropic` provider.
- `openai-api`: OpenAI's API, key stored under the `openai` provider.

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

Start the hub, keep the extension loaded, and the harness gets the same ten
tools the built-in adapters use, with no adapter of its own. Cursor, Cline,
Qwen CLI, Codex, Gemini CLI and Claude Code all take a config in this shape;
only the file name differs (`config.toml` for Codex, `settings.json` for
Gemini, `.mcp.json` for Claude Code).

Three more take the same server definition under a different key:

| client | where the server goes |
|---|---|
| [OpenClaw](https://docs.openclaw.ai/cli/mcp) | `mcp.servers` in `openclaw.json`, or `openclaw mcp add browser --command node --arg <path>` |
| [Muse Code](https://dev.meta.ai/docs/muse-code/extending) | `mcp_servers` in the settings file, with `"transport": "stdio"` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) | `mcp_servers` in `~/.hermes/config.yaml`, or `hermes mcp add browser --command node --args <path>` |

The one requirement is **stdio** transport, since `mcp-proxy.mjs` is a stdio
server. A client that only speaks HTTP to MCP servers cannot reach it as
things stand. Prime Agent is the case in point: it is an MCP client, but its
host "drops non-HTTP entries", so stdio servers never reach the kernel.

Python agent frameworks reach it the same way. LangGraph and DeepAgents both
load stdio MCP servers through
[`langchain-mcp-adapters`](https://github.com/langchain-ai/langchain-mcp-adapters):

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

No test spends model tokens or spawns a CLI. The end-to-end suite points the
hub at `server/stub-adapter.mjs` via `AGENTCHAT_ADAPTER_MODULE`.

## Known constraints

- Chrome allows one debugger client per tab. If DevTools is open on a tab, or
  another CDP client is attached to it, tool calls on that tab fail until
  the other client detaches. Use different tabs or close DevTools.
- Chrome shows an "is being debugged" infobar while the debugger is attached.
  Dismissing it detaches the debugger; the next tool call re-attaches.
- The hub accepts one extension connection. Loading the extension in a second
  Chrome profile or window displaces the first: the old socket is closed and
  its in-flight tool calls fail with "displaced".
- Tool calls time out at the hub after 60 seconds.
- Adapter sessions are kept per chat and disposed after 30 minutes idle;
  sending to an old chatId after that starts a fresh session. Switching the
  adapter or the model dropdown mid-chat also ends the old session, so that
  turn starts with no history.
- API keys are per provider, not per adapter: one Anthropic key serves every
  adapter that talks to Anthropic. They are stored in plain text in
  `~/.agentchat/keys.json`, protected by file permissions, not encrypted.

## License

MIT. See [LICENSE](LICENSE).
