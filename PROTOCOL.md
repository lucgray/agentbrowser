# AgentBrowser protocol v1.9

AgentBrowser is a Chrome MV3 extension with a side-panel chat UI, plus a local hub
server. The chat is backed by a pluggable "harness" (Claude Agent SDK, Claude
Code CLI, or any MCP-capable agent). The harness gets browser tools; the
extension executes them via `chrome.debugger` (CDP), which produces
`isTrusted: true` input in the user's already-logged-in profile. Validated
2026-08-01: CDP clicks and `Input.insertText` are trusted and accepted by
Lexical/React editors (Threads composer).

This file is the single source of truth for every message shape, tool name,
and file path. Builders: implement exactly this; if something here is
impossible, note the deviation in your report rather than silently changing a
name.

## Components and file layout

```
agentchat/
  PROTOCOL.md              (this file)
  README.md                (docs agent)
  extension/
    manifest.json          (ext-core agent)
    background/
      sw.js                (ext-core)  service worker: routing + CDP executor
      cdp.js               (ext-core)  ES module with CDP helpers, imported by sw.js
      inspect.js           (ext-core)  per-tab console/network/dialog buffers + patch state (v1.6)
      inspect-core.js      (ext-core)  pure helpers: page-side expressions, HAR builder (v1.6)
      consent.js           (ext-core)  consent gate side effects: page card, notification fallback (v1.7)
      consent-core.js      (ext-core)  pure policy: tool classification, domain lists, session memory (v1.7)
    content/
      selection.js/css     (ext-core)  content script: selection Ask + right-click context (v1.4)
      annotation.js/css    (ext-core)  content script: underline/highlight/circle marks + comment card (v1.5)
    page/
      overlay.js           (ext-core)  in-page read/highlight overlay (v1.2 F)
    panel/
      sidepanel.html       (ext-ui agent)
      sidepanel.css        (ext-ui)
      sidepanel.js         (ext-ui)
      markdown.js          (ext-ui)
    offscreen/
      offscreen.html       (ext-core)  hosts the persistent WebSocket
      offscreen.js         (ext-core)
  server/
    package.json           (pre-written; deps already installed)
    hub/
      hub.mjs              (server-hub agent)  WebSocket hub on 127.0.0.1:9010
      tools.mjs            (server-hub)        tool name/schema/description table
      commands.mjs         (server-hub)        v1.3 slash command registry + dispatch
      config.json          (server-hub)        {"adapter":"claude-agent-sdk","model":"claude-opus-5"}
      stub-adapter.mjs     (server-hub)        token-free adapter for the e2e suite
    proxy/
      mcp-proxy.mjs        (server-adapters)   stdio MCP server for external harnesses
      agentbrowser-cli.mjs (server-hub)        MCP-free CLI: one WS harness call per invocation (v1.6)
      install-skill.mjs    (server-hub)        installs the agentbrowser shim + SKILL.md for skill agents
      smoke.mjs            (server-hub)        hub routing round trip
    skill/SKILL.md         (server-hub)        the skill doc the installer copies (v1.6)
    adapters/
      base.mjs             (server-adapters)   adapter interface + registry + DESCRIPTORS
      pricing.mjs          (server-adapters)   v1.3 PRICES table, costFor(), isMetered()
      keystore.mjs         (server-adapters)   ~/.agentchat/keys.json reader/writer
      claude-agent-sdk.mjs (server-adapters)
      claude-cli.mjs       (server-adapters)
      generic-cli.mjs      (server-adapters)   per-turn spawn adapters: codex, opencode, copilot, grok, agy, gemini, devin
      api-anthropic.mjs    (server-adapters)   direct API adapter, needs an anthropic key
      api-openai.mjs       (server-adapters)   direct API adapter, needs an openai key
  tests/
    extension/*.test.mjs   node --test for extension files (DOM/chrome.* stubbed)
    server/*.test.mjs      node --test for hub + adapters (hub-e2e spawns the real hub)
```

## Ports

- Hub WebSocket: `ws://127.0.0.1:9010` (env `AGENTCHAT_PORT` overrides, both
  sides read it — the extension can't read env, so it stores the URL in
  `chrome.storage.local.hubUrl`, default `ws://127.0.0.1:9010`).
- The hub owns 9010 and nothing else. Pick a free port for any new listener
  rather than assuming one, and honour `AGENTCHAT_PORT` when it is set.
- `AGENTCHAT_ADAPTER_MODULE` and `AGENTCHAT_PRICING_MODULE` (v1.3, optional)
  point the hub at modules with the same exports as `adapters/base.mjs` and
  `adapters/pricing.mjs`. They exist so the command tests can run against a stub
  adapter that spends no tokens and a stub price table. Unset in normal use.

## Transport map

```
sidepanel.js  <-- chrome.runtime Port "sidepanel" -->  sw.js
sw.js         <-- chrome.runtime messages -->          offscreen.js
offscreen.js  <-- WebSocket -->                        hub.mjs
hub.mjs       <-- in-process -->                       adapters/*
mcp-proxy.mjs <-- WebSocket (role harness) -->         hub.mjs
```

All WebSocket and runtime messages are JSON objects with a `type` field.

## WebSocket messages (client <-> hub)

Every client sends a hello first:

- `{type:"hello", role:"extension", version:"1.0.0"}` — exactly one extension
  at a time; a second extension hello displaces the first (hub closes the old
  socket, fails its pending tool calls with error "displaced").
- `{type:"hello", role:"harness", name:"<free text>"}` — any number.

Tool calls (hub -> extension, and harness -> hub which forwards to extension):

- request: `{type:"tool_call", id:"<uuid>", tool:"<name>", args:{...}, permissions:<obj|null>}`
  — `permissions` is config.json's `permissions` block attached by the hub
  (v1.7 consent gate); absent or null means the gate is off
- response: `{type:"tool_result", id, ok:true, result:{...}}`
  or `{type:"tool_result", id, ok:false, error:"<message>"}`

The hub owns id correlation for its own calls; for harness calls it forwards
the harness's id unchanged and routes the result back to the harness socket
that sent it. If no extension is connected, the hub answers immediately with
`ok:false, error:"no extension connected"`. Tool call timeout at the hub:
60s (screenshot/navigate can be slow), then `ok:false, error:"timeout"`.

Chat (extension -> hub, streamed events back):

- ```js
  {type:"chat", chatId:"<uuid>", text:"<user message>", adapter:"<name from ADAPTERS>",
   model:"<id>" | undefined,               // v1.2, see "Capabilities, keys, models"
   context: {
     currentTab: {tabId:<number>, url:<string>, title:<string>} | null,
     tabs: [{tabId, url, title}, ...],       // tabs the user @-tagged, may be empty
     selection: {                             // v1.4, page text the user asked about
       text:<string>,                         //   the highlighted text (<=4000 chars)
       contentType:"text"|"code"|"table",     //   what the selection sits inside
       surroundingBefore:<string>,            //   <=800 chars before it
       surroundingAfter:<string>,             //   <=800 chars after it
       parentHeading:<string>,                //   "H2: Intro" — nearest preceding heading
       semanticPath:<string>,                 //   "main > article > section"
       codeBlock:{language:<string>, fullCode:<string>} | undefined,  // contentType code
       tableBlock:<string> | undefined,       //   markdown of headers + row (contentType table)
       pageUrl:<string>, pageTitle:<string>
     } | undefined
   } | undefined,
   attachments: [{name:<string>, mimeType:<string>, base64:<string>}, ...] | undefined}
  ```
  `adapter` optional; default from config.json; names: claude-agent-sdk,
  claude-cli, codex, opencode, copilot, grok, agy, gemini, devin, anthropic-api,
  openai-api. `model` is optional (v1.2). `context` and `attachments` are
  optional (v1.1); a v1 chat with none of the three behaves exactly as before.
  See "Chat message, v1.1" below for the file and prompt rules.
- `{type:"chat_abort", chatId}` — best-effort cancel. Since v1.3 it also aborts
  a running slash command on that chatId (see "Slash commands").
- `{type:"command", chatId, name, args, adapter, model, context}` — v1.3, a
  server-scope slash command. Answered on the same `chat_event` stream.
- panel -> hub: `{type:"set_key", provider, key}` and
  `{type:"get_capabilities"}` (v1.2, see below).
- panel -> hub, v1.8: `{type:"chat_list"}` ->
  `{type:"chat_list", chats:[{chatId,title,adapter,model,updatedAt,msgs,live}, ...]}`
  and `{type:"chat_resume", chatId}` ->
  `{type:"chat_resumed", chatId, found, live, adapter, model, title, msgs:[{role,text}, ...]}`.
  See "Chat history, v1.8".
- hub -> extension, once per extension hello and after every key change:
  `{type:"capabilities", adapters:[...], commands:[...]}` (v1.2, `commands` v1.3,
  see below).
- hub -> extension, many per chat:
  `{type:"chat_event", chatId, event:{kind, ...}}` where event is one of
  - `{kind:"token", text}` — assistant text (may be whole blocks, not char-level)
  - `{kind:"tool_use", tool, args}` — args may be truncated for display
  - `{kind:"tool_result", tool, ok, summary}` — summary is a short string
  - `{kind:"info", message}` — adapter lifecycle notes (session started, model)
  - `{kind:"error", message}`
  - `{kind:"status", state, label}` — v1.2, drives the cooking indicator
  - `{kind:"thinking", text}` — v1.2, optional reasoning text
  - `{kind:"meta", model, adapter, elapsedMs, inputTokens, outputTokens,
    cacheReadTokens, cacheWriteTokens, sessionInputTokens, sessionOutputTokens,
    costUsd}` — v1.2, extended in v1.3 (see "Usage, tokens and cost"), once per
    chat message or command, immediately before `done`
  - `{kind:"done"}` — terminal, exactly once per chat message or command

Since v1.3 any event may carry an extra `lane:{index, tabId, title}` field when
it was produced by one lane of a `/parallel` command. Clients that do not know
about lanes can ignore it and the event still reads correctly.

A `chat` with the same `chatId` as a previous one continues that conversation
(same adapter session). A new chatId starts a fresh session.

The `chat_event` shapes are the same in v1.1. The only v1.1 error that is new
is the attachment size rejection below, which arrives as an ordinary
`{kind:"error"}` followed by `{kind:"done"}`.

## Chat message, v1.1

`context` and `attachments` are what the side panel adds to a chat: the tab the
user is looking at, tabs they @-tagged in the composer, and files they picked or
dropped. Both are optional, and both are consumed by the hub, not by the
adapters — adapters still receive a single prompt string through `session.send`.

Attachment size: the total DECODED size of `attachments` is capped at 8 MB
(8 * 1024 * 1024 bytes). The panel enforces this before sending; the hub
enforces it again. Over the cap, the hub writes nothing, creates no session,
and answers with `{kind:"error", message:"attachments total <n> MB, over the
8 MB limit"}` then `{kind:"done"}`. The whole batch is checked before any file
is written, so a rejected batch never leaves partial files behind.

Upload dir: the hub writes each attachment to

```
<os.tmpdir()>/agentchat-uploads/<chatId>/<sanitized name>
```

Sanitization: basename only, then every character outside `[A-Za-z0-9._-]` is
stripped; a name that ends up empty, `.` or `..` becomes `file`. On collision
the hub appends `-1`, `-2` and so on before the extension (`report.pdf` ->
`report-1.pdf` -> `report-2.pdf`); collisions are checked against the
filesystem, so a name reused on a later turn of the same chat does not
overwrite the earlier file. The hub deletes a chat's upload dir when its
session is disposed (30min idle sweep, or displacement when the panel sends a
different `adapter` for a live chatId), and also when a turn fails before a
session exists, since nothing would dispose those files later. The hub logs the
attachment count and byte total to stderr, never names or contents.

Composed prompt: the hub builds the string it passes to `session.send` as

```
<context>
Current tab: "<title>" <url> (tabId <id>)
Tagged tabs:
- "<title>" <url> (tabId <id>)
Text selected on the page — "<title>" <url> (type: code):
"""
<selected text>
"""
Section heading: H2: Intro
DOM path: main > article > section
Surrounding text:
... <before> [SELECTED TEXT] <after> ...
Enclosing code block (<lang>):     // or: Enclosing table (markdown):
```<lang>
<full block text>
```
Attached files (saved on this machine; read them with your file tools):
- /abs/path/name
</context>

<user text>
```

One line per tagged tab, one per attachment, in the order they were sent.
The selection block is emitted only when `context.selection` carries a
non-empty `text`; its subsections follow the same omit-when-empty rule
(no codeBlock drops the code block, empty surrounding text drops the
"Surrounding text" pair, and so on). Sections that are absent are omitted
entirely: no `currentTab` drops the "Current tab" line, an empty `tabs` drops
the "Tagged tabs" block, no attachments drops the "Attached files" block. If
none are present the prompt is exactly the user text with no `<context>`
wrapper, which is what keeps v1 clients working. The composer is exported
from hub.mjs as `composePrompt(text, context, attachmentPaths)` so it can be
unit-tested without a socket.

## Capabilities, keys, and models, v1.2

v1.2 adds three things: the panel learns what the hub can run instead of
hardcoding a list, adapters that talk to an API directly get a key, and a chat
can name a model.

### A. Capabilities

Right after the extension hello, and again whenever a key is set or cleared,
the hub sends:

```js
{type:"capabilities", adapters:[{
   name:"claude-agent-sdk"|"claude-cli"|"codex"|"opencode"|"copilot"|"grok"|"agy"|"gemini"|"anthropic-api"|"openai-api",
   label:"<human label>",
   models:[{id:"claude-opus-5", label:"Opus 5"}, ...],   // may be [] for adapters with no model switch
   defaultModel:"<id or null>",
   provider:"anthropic"|"openai"|null,                    // non-null = needs an API key
   keyConfigured:<bool>                                   // true when the hub holds a key for that provider
}],
commands:[{name, args, summary, scope:"client"|"server"}, ...]}   // v1.3, see "Slash commands"
```

The hub builds the list from the ten names above unioned with whatever
`adapters/base.mjs` exports as `DESCRIPTORS`; per-adapter fields come from the
descriptor, and `keyConfigured` from the key store. `commands` is the registry
from `server/hub/commands.mjs` (v1.3).

sw.js relays the whole capabilities message to the panel Port VERBATIM, every
field. It must not pick fields out of it or the panel loses `commands` and its
autocomplete goes empty, the same rule (and the same reason) as the `chat`
message below.

### B. Keys

```js
{type:"set_key", provider:"anthropic"|"openai", key:"<string>"|null}   // panel -> hub, null clears
{type:"get_capabilities"}                                              // panel -> hub, re-request
```

Keys live in `~/.agentchat/keys.json`, file mode 0600, directory mode 0700.
The hub delegates to `adapters/keystore.mjs`; if that module is not loadable it
writes the same file itself with the same modes. After a `set_key` the hub
replies with a fresh `capabilities` message, which is also how the panel learns
whether the write succeeded.

The hub never sends a key back, never logs one, and never puts one in an error
message; `capabilities` only ever carries `keyConfigured:<bool>`. hub.mjs
exports `scrub(value)` and routes every stderr write through it: it strips any
key the process has held this run by substring, then anything key-shaped
(`sk-ant-…`, `sk-proj-…`, `sk-…`, `xai-…`, `ghp_…`) by pattern.

### C. Model on a chat

`{type:"chat", ..., model:"<id>"|undefined}`. The hub passes it to the adapter
session as `ctx.model`; CLI adapters turn it into their `--model`/`-m` flag. An
unknown or absent model means the adapter's own default.

A chat that names a different `model` for a live chatId disposes the session and
creates a new one, the same rule an adapter switch already follows, so the new
model actually takes effect. The hub emits
`{kind:"info", message:"session restarted with model <id>"}` when it does. A
chat that omits `model` is never treated as a change: the hub compares against
the model the session resolved to, not against the raw field.

### D. Adapter interface

```js
createSession(name, ctx)
// ctx = { callBrowserTool, config, model, getApiKey, tools }
//   ctx.model            requested model id, or null
//   ctx.getApiKey(provider)  stored key string or null (synchronous)
//   ctx.tools            the TOOLS array from tools.mjs
```

Each adapter module MAY export a descriptor:

```js
export const DESCRIPTOR = { label, models, defaultModel, provider };
```

`adapters/base.mjs` exports `DESCRIPTORS` (name -> descriptor) built from them,
and the hub uses that to build `capabilities`. A missing descriptor is not an
error: the hub falls back to a built-in table so the picker is never empty.

### E. New chat_event kinds

```js
{kind:"status", state:"thinking"|"working"|"idle", label:"<short verb phrase>"}
{kind:"thinking", text:"<reasoning text>"}    // optional, only if the model exposes it
{kind:"meta", model:"<id>", adapter:"<name>", elapsedMs:<number>,
              inputTokens:<n|null>, outputTokens:<n|null>}
```

Every adapter must emit at least one `status` (`{state:"thinking"}` right after
send) and one `meta` before `done`. The hub guarantees both for adapters that
forget: it injects `{kind:"status", state:"thinking"}` if the adapter emitted no
status within 300ms of send, injects `{kind:"status", state:"idle"}` at the end
if a turn finished without any status at all, and synthesizes a `meta` from the
model, adapter and elapsed time just before `done`. A turn never carries two
metas: the hub counts the adapter's own. `done` stays terminal and
exactly-once, and events emitted after it are dropped.

### F. Tool overlay

When the extension executes a CDP-backed tool it shows an on-page overlay in the
target tab, injected with CDP `Runtime.evaluate`. No new permission, no content
script. The overlay is entirely an extension concern: nothing about it appears
on the wire, and the hub is not involved.

## Usage, tokens and cost, v1.3 (section A)

The `meta` event gains cumulative fields:

```js
{kind:"meta", model, adapter, elapsedMs,
 inputTokens:<n|null>, outputTokens:<n|null>,
 cacheReadTokens:<n|null>, cacheWriteTokens:<n|null>,
 sessionInputTokens:<n>, sessionOutputTokens:<n>,   // running totals for this chatId
 costUsd:<number|null>}                             // null when pricing is unknown
```

Division of labour: every adapter reports the per-turn numbers its backend
exposes and sends `null` for the ones it cannot know. The hub owns the rest. It
normalizes every field to a number or `null`, keeps the running totals per
chatId (adding each turn's `inputTokens`/`outputTokens`, counting `null` as 0),
and computes `costUsd`. An adapter that knows nothing about usage still gets
correct session totals on the wire; they simply do not grow.

Pricing lives in `adapters/pricing.mjs`:

```js
export const PRICES;                       // model id -> per-token prices
export function costFor(model, usage);     // -> number (USD) or null
export function isMetered(adapterName);    // -> bool
// usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, each number|null
```

The hub calls `costUsd = isMetered(adapter) ? costFor(model, usage) : null`.
`isMetered` is what keeps a subscription-backed CLI adapter from being priced as
if it billed per token. The import is lazy and every call is wrapped: if
`pricing.mjs` is missing or throws, `costUsd` is `null` and the turn still runs.

Totals lifetime: the totals are keyed on chatId in their own map, not on the
adapter session, because an adapter or model switch disposes the session
mid-chat and the running totals have to survive that. They are dropped when the
chat's session is disposed for idleness (30 min), which is the point at which
the chat is really over, and swept for chats that only ever ran a session-less
command.

## Slash commands, v1.3 (section B)

Anything the user types in the composer starting with `/` is parsed by the
panel. Client-scope commands the panel handles itself. Server-scope commands go
to the hub as

```js
{type:"command", chatId, name:"<cmd>", args:"<rest of the line>",
 adapter:"<name>", model:"<id>"|undefined, context:{currentTab, tabs}|undefined}
```

`name` is without the leading `/` (the hub strips one anyway). `args` is the
rest of the line verbatim, the command parses it. The hub answers on the SAME
`chat_event` stream for that chatId, with the same kinds an ordinary chat turn
uses (`status`, `token`, `info`, `thinking`, `tool_use`, `tool_result`, `error`,
`meta`, `done`), `meta` and `done` exactly once each, `done` terminal. A command
therefore renders in the transcript like any other turn.

The registry lives in `server/hub/commands.mjs`:

```js
export const COMMANDS = [{name, args, summary, scope:"client"|"server"}, ...];
export async function dispatch(name, {args, session, emit, ctx, signal});
```

and the hub sends it inside the existing capabilities message as a top-level
array, so the panel's autocomplete cannot drift from what the hub implements:

```js
{type:"capabilities", adapters:[...], commands:[{name, args, summary, scope}, ...]}
```

| command | scope | notes |
|---|---|---|
| `/help` | server | info event listing every command from the registry. No model call. |
| `/tabs` | server | `tabs_list` through the extension, rendered as one info event. No model call. |
| `/loop <n> <instruction>` | server | see section C |
| `/goal <condition>` | server | see section C |
| `/parallel <instruction>` | server | see section D2 |
| `/clear` | client | new chatId |
| `/model <id>` | client | switch model |
| `/adapter <name>` | client | switch adapter |
| `/keys` | client | open key settings |
| `/stop` | client | sends `chat_abort` |

Client-scope entries exist in the registry so the panel can list them; the hub
never expects to see one, and answers with an error + `done` if it does, as it
does for an unknown name.

`/help` and `/tabs` never create an adapter session and never reach the API-key
check: they cost nothing, and creating a session can spawn a CLI child process.

One turn at a time per chatId. A `chat` that arrives while a command is running
on that chatId is refused with an error + `done`, and so is a second command,
because adapter sessions hold one turn's state and interleaved sends corrupt it.

## Looping commands, v1.3 (section C)

- `/loop <n> <instruction>` runs the instruction n times, `n <= 20`.
- `/goal <condition>` re-runs until the model reports the condition met.

Both share hard bounds, and they are not advisory:

- at most 20 iterations (`/loop` rejects a larger n outright, before iteration
  one, naming the cap; `/goal` stops at 20 and says so),
- at most 15 minutes of wall clock, enforced both between iterations and by a
  timer that aborts the whole command mid-iteration. `dispatch` accepts an
  optional shorter `maxMs` so the cap can be tested in seconds; it is clamped to
  the 15 minute bound, so it can only tighten, and nothing on the wire sets it,
- immediate stop on `{type:"chat_abort"}`. The abort is checked before each
  iteration starts and again after each one returns.

Each iteration emits `{kind:"info", message:"iteration k/n"}` and then its own
events. The hub swallows each iteration's `done` and `meta` (the command emits
one of each, at the end) and each iteration's `{kind:"status", state:"idle"}`,
so the panel's activity indicator does not flicker between iterations. Token
counts from the swallowed metas are summed into the command's single meta and
from there into the session totals. The command closes with an info event
naming the stop reason: finished, stopped by the user, the 15 minute cap, or
the goal being met.

`/goal` appends to each iteration prompt a request to end the reply with a line
that is exactly `GOAL: MET` or `GOAL: NOT MET`, and stops on MET. The last
marker in the reply wins, and `GOAL: NOT MET` never reads as met.

A running loop is bound to the thing that started it. It is aborted when the
chat's session is disposed, and when the extension disconnects: a loop with no
browser to drive and nobody watching must stop, not keep spending. Iteration
counts go to stderr. The idle sweep never disposes a session with a command in
flight.

No new publish authority: every generated iteration and lane prompt carries the
line "do not publish, submit, post, purchase or send anything unless the
instruction above explicitly says to", and the operator system prompt's
no-submit rule still applies. Only what the user typed can authorise a submit.

## Parallel execution, v1.3 (section D)

Two independent levels.

### D1. Tool batch

When a model returns several `tool_use` blocks in ONE assistant turn, the
adapter executes them CONCURRENTLY (`Promise.all`) instead of sequentially,
preserving result order and `tool_use_id` pairing, with concurrency capped at 6.
All the `tool_use` events are emitted first, then the `tool_result` events as
they land. This lives in the adapters, since they own the tool loop.

### D2. Lanes

`/parallel <instruction>` runs the instruction against every @-tagged tab at
once, one adapter session per tab, at most 6 lanes (extra tabs are skipped with
an info event naming them). With no tagged tabs it is an error.

Each lane gets its own instruction naming its tab explicitly ("work only in
browser tab `<tabId>` ... pass `tabId` to every browser tool call"), and every
event a lane emits carries

```js
lane: {index:<0-based>, tabId:<number>, title:"<tab title>"}
```

Lanes run under `Promise.allSettled`. A lane that throws becomes an
`{kind:"error", ..., lane}` event and never takes the other lanes down or
escapes as an unhandled rejection. When they have all settled the hub emits an
aggregate `{kind:"info"}` summarising per-lane success and failure, then one
`meta` (with the summed usage of every lane) and one `done` for the whole
command. Lane sessions live only for that command: they are aborted with it and
disposed however it ends.

## chrome.runtime messages (inside the extension)

offscreen <-> sw, via `chrome.runtime.sendMessage`:

- `{target:"offscreen", cmd:"send", payload:<object to send over WS>}`
- `{target:"offscreen", cmd:"connect", url}` — (re)connect to this URL
- `{target:"sw", cmd:"ws_message", payload:<parsed WS message>}`
- `{target:"sw", cmd:"ws_status", connected:<bool>}`

Every message carries `target`; receivers ignore messages not addressed to
them (both listeners are on the same bus). sw.js creates the offscreen
document on startup with reason `WORKERS` justification "persistent WebSocket
to local agent hub", guarded so a second create call is a no-op. offscreen.js
reconnects with 3s backoff forever and reports every status change.

sidepanel <-> sw via a long-lived `chrome.runtime.connect({name:"sidepanel"})` Port:

- panel -> sw: `{type:"chat", chatId, text, adapter, model?, context?, attachments?}` /
  `{type:"chat_abort", chatId}` — same shape as the hub message above
- panel -> sw: `{type:"set_key", provider, key}` / `{type:"get_capabilities"}`
  (v1.2, forwarded to the hub unchanged)
- panel -> sw: `{type:"command", chatId, name, args, adapter, model?, context?}`
  (v1.3, forwarded to the hub unchanged, same verbatim rule as `chat`)
- sw -> panel: `{type:"chat_event", chatId, event}` (relayed verbatim from hub)
- sw -> panel: `{type:"capabilities", adapters:[...], commands:[...]}` (relayed
  verbatim from hub, every field)
- sw -> panel: `{type:"status", connected:<bool>}` (sent on connect and on change)

annotation.js <-> sw (v1.5), regular `sendMessage`:

- content -> sw: `{target:"sw", cmd:"annotation_comment", annId, text,
  annotation:{style,quote,comment,author}}` — a comment the user left on a
  mark. sw turns it into a `chat` message with chatId `ann-<annId>-<tabId>`
  (same mark, same thread) on the adapter the panel last used
  (`lastPanelAdapter`, falling back to config.adapter), with
  `context.currentTab` pointing at the page.
- sw -> content: `{target:"annotation", cmd:"annotate"|"batch"|"list"|
  "reply"|"clear", ...}` — the annotate* tools; sw injects annotation.js/css
  and retries once when the frame has no listener.
- sw -> content: `{target:"annotation", cmd:"event", annId, event}` — every
  chat_event for an `ann-*` chatId is routed to the tab that owns it instead
  of the panel; `token` events accumulate into the reply bubble, `done` ends
  it. An `ann-*` chatId is therefore a page-bound thread: the panel never
  sees it and never claims it.

sw.js relays chat/command/chat_abort/set_key/get_capabilities to the hub and
chat_event/capabilities/status back. The chat object goes over VERBATIM, every
field: sw.js must not pick fields out of it or it will drop `model`, `context`
and `attachments`. It must also work when the panel reconnects (new Port)
mid-chat: events for unknown chatIds are dropped silently. A panel that
reconnects sends `get_capabilities` to repopulate its picker; sw.js may also
cache the last capabilities message and replay it on connect.

## Browser tools

Names, args, results. These exact names appear in tools.mjs, in the SW
executor, in the SDK adapter's MCP server, and in mcp-proxy.mjs.

| tool | args | result |
|---|---|---|
| `tabs_list` | `{}` | `{tabs:[{tabId,url,title,active}]}` |
| `tab_new` | `{url?}` | `{tabId}` |
| `tab_close` | `{tabId}` | `{closed:true}` |
| `navigate` | `{url, tabId?}` | `{url, title}` after load event (20s cap, then return current state) |
| `read_page` | `{tabId?, maxChars?}` | `{url, title, text}` — `document.body.innerText`, default cap 60000 chars |
| `screenshot` | `{tabId?}` | `{base64, mimeType:"image/png"}` |
| `click` | `{x, y, tabId?}` | `{clicked:true}` — CDP mousePressed+mouseReleased, button left, clickCount 1 |
| `click_element` | `{selector, dx?, dy?, tabId?}` | `{clicked:true, selector, tag}` — v1.7; scrolls the element into view, clicks its center (+offset) |
| `type_text` | `{text, selector?, tabId?}` | `{typed:<charcount>}` — CDP `Input.insertText`; optional `selector` click-focuses the target first (v1.7) |
| `press_key` | `{key, tabId?}` | `{pressed:key}` — e.g. "Enter", "Tab", "Escape", "Backspace", "ArrowDown", "Meta+A", "Meta+C", "Meta+V" |
| `eval_js` | `{expression, tabId?}` | `{value}` — `Runtime.evaluate` returnByValue+awaitPromise; errors -> ok:false |
| `annotate` | `{quote, style, comment?, color?, tabId?}` | `{id, style, quote}` — v1.5; style is `underline`/`highlight`/`circle`; error when the quote is not on the page |
| `annotate_batch` | `{annotations:[{quote, style, comment?, color?}], tabId?}` | `{results:[{ok,id,style,quote} | {ok:false,quote,error}]}` — v1.9; per-item results so one bad quote does not fail the batch |
| `annotations_list` | `{tabId?}` | `{annotations:[{id,style,quote,comment,author,replies}]}` — v1.5 |
| `annotate_reply` | `{id, text, tabId?}` | `{id, replied:true}` — v1.5, appends an agent reply to the mark's comment thread |
| `annotate_clear` | `{id?, tabId?}` | `{cleared:<n>}` — v1.5; no id clears all marks on the tab |
| `dom_inspect` | `{selector, all?, styles?, max?, tabId?}` | `{selector, matched, elements:[{tag,id,classes,attributes,text,rect,styles}]}` — v1.6 |
| `console_log` | `{level?, limit?, clear?, tabId?}` | `{entries:[{ts,level,source,text,url}]}` — v1.6; capture starts on first call |
| `network_log` | `{filter?, includeHeaders?, har?, limit?, clear?, tabId?}` | `{entries:[{id,url,method,status,type,mimeType,startTime,duration,size,pending,failed,headers?}], har?}` — v1.6 |
| `a11y_tree` | `{maxDepth?, tabId?}` | `{source:'axtree', nodes:[{nodeId,role,name,depth,ignored}]}` — v1.6; falls back to `{source:'outline', nodes:[...]}` |
| `dialog_list` | `{tabId?}` | `{dialogs:[{type,message,url,ts,status}]}` — v1.6 |
| `dialog_respond` | `{accept, promptText?, tabId?}` | `{handled:true,type,message}` or `{handled:false}` — v1.6 |
| `patch_apply` | `{patches:[{selector,styles?,attributes?,insertAdjacentHTML?,remove?}], label?, tabId?}` | `{patchId, applied, results:[{selector,matched,error?}]}` — v1.6 |
| `patch_revert` | `{patchId, tabId?}` | `{patchId, reverted, missing}` — v1.6 |

`tabId` omitted = active tab of the current window. All tools run in the SW;
CDP tools attach `chrome.debugger` (version "1.3") on demand, keep a set of

annotate* tools do not use the debugger: they message annotation.js, which
locates `quote` over the page's text nodes (literal match first, then a
whitespace-normalized one) and wraps the range segment by segment. Underline
and highlight render as styled spans; circle draws an ellipse on a full-page
SVG overlay (recomputed on resize). Each mark is clickable: it opens a
comment card whose submissions become `ann-*` chat turns, and its replies —
streamed tokens or explicit `annotate_reply` calls — render in the same card.
Agent marks default to a distinct color and carry a mandatory `comment`
saying why the passage was flagged.

## Page inspection, v1.6

inspect.js keeps per-tab ring buffers (console 500, network 500, dialogs 20)
fed by `chrome.debugger.onEvent`. Most CDP domains are enabled lazily — the
first `console_log` call enables Runtime+Log, `network_log` enables
Network — and stay enabled while the debugger is attached. The exception is
Page, which cdp.js enables on every attach: enabling it after a dialog had
already opened would deadlock the session, so dialogs are always
intercepted while AgentBrowser drives a tab. Buffers reset on main-frame
navigation and on tab close; they survive service-worker restarts only
insofar as the debugger session does (a worker restart clears in-memory
buffers).

Credentials never leave the extension: `cookie`, `set-cookie`,
`authorization`, `proxy-authorization`, `x-api-key` and `x-auth-token`
headers are stripped from `network_log` output and from HAR exports
regardless of `includeHeaders`.

Dialogs: with Page enabled at attach, JS dialogs on a driven tab are
intercepted rather than shown. A pending dialog auto-answers after ~5s so
the page cannot wedge: alert/confirm/prompt are dismissed (`accept:false`),
beforeunload is accepted (`accept:true`) so navigations aren't silently
blocked. An agent that wants a dialog answered differently must call
`dialog_respond` within that window. Entries report `status:
pending|accepted|dismissed|auto-dismissed`.

Patches: `patch_apply` snapshots each matched element's `outerHTML` plus a
stable CSS path before mutating (style/attribute/HTML/remove). `patch_revert`
relocates elements by path and restores the snapshot — event listeners bound
after the patch are lost and DOM changes made since may leave entries
`missing`. Snapshots live in service-worker memory: a worker restart loses
the ability to revert (the mutations stay applied).

## Consent gate, v1.7

`config.permissions` in server/hub/config.json gates sensitive tools behind a
user confirmation:

```
{ "allowAll": true,                   // explicit opt-out: every tool passes
  "requireConsent": ["click", ...],   // default: the write-tool set
  "trustedDomains":  ["localhost"],     // never ask on these hosts
  "sensitiveDomains": ["bank.example"]  // always ask; session grants ignored }
```

`allowAll` is the explicit "trust the agent" switch: the block is present
but nothing is gated — use it for unattended automation, or leave the block
out entirely (same effect, but `allowAll` records the intent).

The hub attaches the object to every forwarded `tool_call` (absent = gate
off). sw.js checks the call against the *target* tab's URL — for `navigate`,
against the destination URL — before executing. A gated call first asks the
user through a card injected into that tab by annotation.js (fixed top-right;
the same card styling as annotation comments). The card shows the tool name
plus a concrete summary — click targets name the element via a bounded
`elementFromPoint`/`querySelector` evaluate, `navigate` shows the destination
URL, `type_text` previews the text. Three choices: Allow once, Always on this
domain (keyed origin+tool, persisted in `chrome.storage.session` so it
survives service-worker suspension and lasts the browser session), Deny. A
second request replaces a pending card and denies it; a 30s timeout
denies.

Pages where the content script cannot run (chrome://, the Web Store, PDFs)
fall back to a system notification (Allow once / Deny only — no domain
grant). Denials and timeouts return `{ok:false, error:"denied by user: <tool>"}`
to the caller.

## Chat history, v1.8

The hub journals every chat to `~/.agentchat/chats/<chatId>.json` (dir 0700,
file 0600): `{chatId, title, adapter, model, createdAt, updatedAt,
msgs:[{role:"user"|"assistant", text}]}`. `title` is the first user message,
truncated. Assistant text is the turn's accumulated `token` events; tool
chips, status and meta lines are not journaled. Writes happen on each turn's
`done`, so a killed or aborted turn still records its partial reply.

`chat_list` returns summaries newest-first (capped at 50), merging the
on-disk archive with anything still in memory. `live` is true when the
chatId's adapter session is still registered — resuming a live chat
continues the same conversation (the extension re-registers the chatId and
its `chat_event` stream flows to whoever reopened it). Resuming a dead chat
returns the transcript for a read-only view.

## Proactive annotation, v1.5

`config.proactiveAnnotation` in server/hub/config.json:

```
{ "enabled": false, "adapter": "<adapter name>", "prompt": "<override>" }
```

When `enabled` is true, the first chat message that carries a new
`context.currentTab` (tabId + url pair) spawns one background turn with
chatId `pro-<tabId>-<ts>` on `adapter` (default: `config.adapter`) whose
prompt — default or `prompt` override — instructs the model to read the page
and mark confusing passages with `annotate`. The pass runs once per tab+url
for the life of the hub process; its chat_events are claimed by no page or
panel and are dropped in the SW. A failed pass logs to the hub console only.
attached tabs, serialize commands per tab, detach on tab close, and survive
`chrome.debugger.onDetach` (drop from set; next call re-attaches).

`press_key` implementation note: dispatch `rawKeyDown` + `keyUp` with correct
`key`, `code`, `windowsVirtualKeyCode`, and `modifiers` bitmask (Alt=1,
Ctrl=2, Meta=4, Shift=8). For editing combos on mac, CDP needs the `commands`
param on the keydown: Meta+A -> `["selectAll"]`, Meta+C -> `["copy"]`,
Meta+V -> `["paste"]`, Meta+X -> `["cut"]`, Meta+Z -> `["undo"]`. Support at
least: Enter, Tab, Escape, Backspace, Delete, arrows, and Meta/Ctrl/Alt/Shift
combos over single letters.

## Adapter interface (server/adapters/base.mjs)

```js
// registry: name -> factory(ctx)
//   ctx = { callBrowserTool, config, model, getApiKey, tools }   // model/getApiKey/tools are v1.2
// callBrowserTool(tool, argsObject) -> Promise<result object>; throws Error on ok:false
// factory returns an adapter session object:
// {
//   send(text, emit) -> Promise<void>   // emit(event) with the chat_event kinds above; must emit done exactly once
//   abort() -> void                      // best-effort
//   dispose() -> void
// }
// module-level, optional: export const DESCRIPTOR = {label, models, defaultModel, provider}
// base.mjs re-exports these as DESCRIPTORS (name -> descriptor) for capabilities.
```

hub.mjs keeps one adapter session per chatId, creates it lazily on first
`chat`, disposes on socket close of the extension? No — sessions outlive
panel reconnects; dispose after 30min idle. A `chat` that names a different
`adapter` for a live chatId also disposes the old session and creates the new
adapter's, and since v1.2 so does a `chat` that names a different `model`.
Disposal always deletes that chat's upload dir too.

A `chat` naming an adapter whose `provider` has no key never reaches the
adapter: the hub writes no attachments, creates no session, and answers with
`{kind:"error"}` naming the missing key followed by `{kind:"done"}`.

`claude-agent-sdk.mjs`: uses `@anthropic-ai/claude-agent-sdk` (installed in
node_modules — READ ITS README/TYPES, do not guess the API). Expose the ten
browser tools as an in-process MCP server (`createSdkMcpServer` + `tool()`
with zod schemas), handlers call `ctx.callBrowserTool`. `screenshot` handler
returns an MCP image content block so the model sees the image. Use streaming
input (async generator) so one SDK session carries the whole conversation.
Options: model from config, `permissionMode:"bypassPermissions"`, system
prompt: browser-operator instructions (short: you control the user's real
logged-in browser via trusted CDP input; read before acting; use the tabIds
from the `<context>` block when the user points at a tab; for form filling
read the form structure with eval_js, fill with click + type_text, read the
values back; never publish, submit or buy without the user saying so in chat).
`allowedTools` in this SDK pre-approves tools, it does not restrict them (the
`tools` option restricts), so `Read` is listed there alongside the browser
tools: attachments arrive as file paths the model has to open.

`claude-cli.mjs`: spawns `claude -p --input-format stream-json --output-format
stream-json --verbose --permission-mode bypassPermissions --mcp-config <generated file>`
once per session, writes user messages as stream-json lines, parses
stream-json output into chat events. The generated MCP config points at
`node <abs path>/mcp-proxy.mjs` so the CLI loads the browser tools. Keep the
child alive across turns; kill on dispose.

`generic-cli.mjs`: one factory driven by a HARNESSES preset table; spawns one
process per turn (no persistent child), strips ANSI, extracts the assistant
text per CLI, emits tool_use/tool_result when the output format exposes them,
and tracks the CLI's own session id for resume. abort() kills the current
turn's child only; dispose() also removes generated temp configs. Browser
tools always attach via mcp-proxy.mjs. Adapter names and mechanisms:

- `codex`: `codex exec --json --dangerously-bypass-approvals-and-sandbox`;
  resume `codex exec resume <thread id>`; MCP per invocation via
  `-c mcp_servers.browser.command/args/env` overrides.
- `opencode`: `opencode run --format json --dangerously-skip-permissions`;
  resume `-s <sessionID>`; MCP via generated `opencode.json` in a temp cwd.
- `copilot`: `copilot -p ... --allow-all-tools -s --no-color`; deterministic
  session via `--session-id <uuid>` reused each turn; MCP via
  `--additional-mcp-config @<temp file>`.
- `grok`: `grok -p ... --output-format json --always-approve`; resume
  `--resume <sessionId>`; MCP via generated `.grok/config.toml` in a temp cwd.
- `agy`: `agy -p ... --dangerously-skip-permissions --print-timeout 20m`;
  resume `--conversation <id>` (id from diffing
  `~/.gemini/antigravity-cli/conversations/`, `-c` fallback); MCP via a
  guarded merge-only insert into `~/.gemini/config/mcp_config.json`.
- `gemini`: `gemini -p ... -o stream-json --approval-mode yolo
  --allowed-mcp-server-names browser`; resume `-r <session_id>` (temp cwd is
  stable per session because gemini sessions are cwd-scoped); MCP via
  generated `.gemini/settings.json` in that temp cwd.

## mcp-proxy.mjs

Stdio MCP server (use `@modelcontextprotocol/sdk`, installed) exposing the ten
tools from tools.mjs. On each call: ensure a WS connection to the hub
(`role:"harness", name:"mcp-proxy"`), send tool_call, await tool_result, map
to MCP content (JSON text; screenshot -> image content). Reconnect if the hub
drops. This file is what makes ANY MCP-capable harness (Codex, Gemini CLI,
Cursor, another Claude Code) able to drive the browser: they just add it to
their MCP config.

## agentbrowser-cli.mjs + skill (v1.6)

MCP-free access path, for agents that can't (or shouldn't) load an MCP
server. `agentbrowser-cli.mjs` is a thin WS client: `agentbrowser <tool>
'<json-args>'` registers as `role:"harness", name:"agentbrowser-cli"`, sends
one tool_call, prints tool_result JSON, exits non-zero on tool errors.
`tools` lists the TOOLS table; `<tool> --help` shows one schema.
`AGENTBROWSER_HUB`/`--hub` overrides the default ws://127.0.0.1:9010;
`--timeout` the 30s call cap. Stateless by design: console/network/patch
state lives in the extension, so a fresh process per call loses nothing.
`install-skill.mjs` writes an `agentbrowser` shim (~/.local/bin) and copies
skill/SKILL.md to ~/.claude/skills and ~/.agents/skills (or --target dirs).

## Conventions

- Plain ES modules everywhere. No TypeScript, no bundler, no framework, no
  external CDN/network fetches in extension pages (MV3 CSP).
- Node >= 20. `ws` for WebSockets server-side. 2-space indent.
- Extension manifest permissions: `debugger, tabs, storage, offscreen,
  sidePanel, contextMenus, scripting` plus `host_permissions: <all_urls>` for
  the two declared content scripts (selection.js, annotation.js — v1.4/v1.5).
  Page reads and input still go through the debugger; the content scripts
  only handle selection context, annotation marks, and their comment cards.
  `action` click opens the side panel
  (`chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`).
- Side panel UI: dark, compact, readable. Status dot (hub connected), adapter
  dropdown (one option per entry in the `capabilities` message, not a
  hardcoded list), model dropdown filled from that adapter's `models`, a place
  to paste an API key for adapters whose `provider` is non-null, message list
  with distinct
  styling for user / assistant / tool chips (tool_use + tool_result render as
  one compact chip line, e.g. `⚙ click {x:707,y:771} ✓`), textarea + send on
  Enter (Shift+Enter newline), New chat button (fresh chatId), abort button
  while a chat is streaming.
- Errors surface, never vanish: WS down -> status dot red + banner in panel;
  tool failure -> tool chip shows ✗ + error text.
- Prose (README, comments): plain and specific, no marketing adjectives, no
  em dashes.
