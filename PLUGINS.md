# Plugins

Plugins are feature packs the hub loads at session creation. Each plugin can:

- inject a **prompt fragment** into every agent session (usage instructions the
  model sees after the system prompt), and
- **gate tools**: either hide existing hub tools while disabled
  (`exposeTools`), or add entirely new tool schemas (`extraTools`).

No code changes are needed to install one: drop a directory with a
`plugin.json` into `~/.agentchat/plugins/` and start a new chat. Built-in
plugins ship under `server/plugins/`; a user plugin with the same `id`
overrides the built-in. `AGENTCHAT_PLUGINS_DIR` points the user dir elsewhere
(useful for tests or a second hub instance).

## plugin.json

```json
{
  "id": "translate",
  "name": "Translation assistant",
  "version": "1.0.0",
  "description": "What this plugin does, shown in the panel/admin surfaces.",
  "enabled": true,
  "prompt": "Markdown injected into the system prompt while enabled.",
  "exposeTools": ["page_translate", "translate_status"],
  "extraTools": [
    {
      "name": "my_tool",
      "description": "What the agent should use it for.",
      "parameters": { "type": "object", "properties": {} }
    }
  ]
}
```

| Field         | Type     | Required | Meaning |
|---------------|----------|----------|---------|
| `id`          | string   | no       | Defaults to the directory name. Unique key used in `config.plugins` and wire messages. |
| `name`        | string   | no       | Display name (defaults to `id`). Shown in `## Plugin: <name>` prompt headers and UIs. |
| `version`     | string   | no       | Free-form version string, surfaced in plugin listings. |
| `description` | string   | no       | Human-readable summary for management UIs. |
| `enabled`     | boolean  | no       | Default state when `config.plugins.<id>.enabled` is unset (default `true`). |
| `prompt`      | string   | no       | Fragment appended to every session's system prompt while enabled. Write it as agent-facing instructions: what the tools do, when to use them, common pitfalls. |
| `exposeTools` | string[] | no       | Names of tools in `server/hub/tools.mjs` this plugin owns. Disabling the plugin hides them from agents **and** stops hub-answered tools from responding. Unknown names are warned and skipped. |
| `extraTools`  | object[] | no       | Additional tool schemas appended to the table while enabled. Same `{name, description, parameters}` JSON-schema shape as `tools.mjs`. |

## Enabling and disabling

Three equivalent switches, all persistent:

- **`config.json`** — `"plugins": { "translate": { "enabled": false } }`
- **Wire message** — `{type:"plugin_set", id:"translate", enabled:false}`
  (replies `{type:"plugins", plugins:[…]}` and re-broadcasts capabilities)
- **Admin page** — `http://127.0.0.1:9010/admin` → Plugins section

A change takes effect on the **next** session/tool lookup — the registry
re-scans plugin directories on every call, so editing a manifest does not
require a hub restart either.

## What "on" and "off" mean

When a plugin is **enabled**:

- its `prompt` fragment is appended to the system prompt of every new chat
  session (after `systemPromptExtra`, as `## Plugin: <name>`);
- every name in `exposeTools` stays visible to agents;
- every schema in `extraTools` is appended to the agent's tool table.

When **disabled**:

- the prompt fragment is omitted;
- every name in `exposeTools` is filtered out of the tool table, and calls to
  them fail with `tool hidden by disabled plugin: <name>` — including
  hub-answered tools and the direct-wire admin messages;
- `extraTools` are not registered.

## How extraTools execute

`extraTools` schemas reach agents through the normal tool table, so a call to
one arrives as an ordinary `tool_call` on the wire. Route it where it belongs:

- **Browser-side work** — name it in the extension's tool executor
  (`extension/background/`): the hub forwards unknown tools to the extension
  unchanged, so a plugin schema plus an executor branch is a complete
  feature. This is the standard path for anything that touches a tab.
- **Hub-side work** — intercept it in `hub.mjs` next to `HUB_TRANSLATE_TOOLS`
  and answer without an extension round trip (read PROTOCOL.md's translation
  admin section for the pattern).

Either way the plugin manifest is the only user-facing artifact: the
execution code can ship in the repo while the plugin stays independently
toggleable.

## Writing a good prompt fragment

The fragment is the plugin's user manual for the model — keep it under ~40
lines and follow the built-in `translate` plugin's shape:

1. **When to use** — the user intents that should trigger the tools.
2. **What NOT to do** — the naive approach the tools replace (e.g. "do NOT
   translate by reading the DOM and writing text back").
3. **Tool map** — one line per tool with its key argument.
4. **Failure handling** — what error means what, and what to tell the user.

## Example: a minimal plugin

`~/.agentchat/plugins/reading-mode/plugin.json`

```json
{
  "id": "reading-mode",
  "name": "Reading mode",
  "description": "Distill articles and queue them for later.",
  "prompt": "You have a reading plugin. When the user asks to save or summarize an article for later, call read_later_add with the page URL. Prefer it over copy-pasting text into chat.",
  "extraTools": [
    {
      "name": "read_later_add",
      "description": "Save the current page to the read-later queue.",
      "parameters": {
        "type": "object",
        "properties": {
          "note": { "type": "string", "description": "Optional user note" }
        }
      }
    }
  ]
}
```

Then implement `read_later_add` in the extension tool executor (or ask an
agent to) — enable/disable from `config.json`, `plugin_set`, or the admin
page without touching code again.

## Discovering plugins

- `{type:"plugins_list"}` → `{type:"plugins", plugins:[{id,name,version,description,enabled,builtin,tools}]}`
- The same array rides on `capabilities.plugins` for every panel.
- `GET /admin/api/plugins` returns it over HTTP for non-extension clients.

## Page-side tools (v2.25)

An `extraTools` schema normally needs matching executor code in the
extension. Page plugins skip that: the content module registers the
function once —

```js
__abPlugins.registerPageTool('page_reader', (args) => ({ mode }));
```

and any `tool_call` the built-in table doesn't own is relayed to the tab's
plugin bus (`{target:'plugins', cmd:'op'}`), where `callPageTool` answers
with `{ok, result|error}`. No hub or service-worker changes per plugin;
a disabled plugin's extraTools never reach the agent, so its handlers
never run. Tools that don't need a live page (like the notes_* set) are
still better answered on the hub — see `HUB_NOTES_TOOLS` for that pattern.

## Margin card host

`server/plugins/margin/` declares the opt-in `margin` plugin (default
disabled). Its content module `extension/content/margin.js` provides the
`margin` service — `mount()/type()/setText()/close()/focusCard()/
hoverCard()/focusInput()/addCtx()/collapseAll()/ask()/setMode()` — a shared
card surface other plugins stream answers into, styled after the demo's
margin host: pill badge head + quote chip, skeleton→streamed body, foot
actions (copy/retry/pin/delete), a per-card follow-up input, mini collapse
rows (title + 2-line excerpt), and colored threads drawn from each card's
anchors to the active card. `mount()` opts include `plugin`, `quote`,
`anchor` (Element | Range | {x,y} | markId resolving `[data-mid]`), `para`,
`src`, `markColor`. Display degrades by available space: `reader` (the
`page_reader` tool hid non-main content), `compat` (fixed right-edge rail),
`strip` (collapsed color markers on a thin right-edge strip, click expands
the card leftward). In-page asks ride the `pg-<tabId>-<n>` chat channel;
replies stream onto the card, not the side panel, and a card's follow-up
input continues the same pg- chat so the hub keeps thread context.
