---
name: testing-agentbrowser
description: How to run and test the AgentBrowser Chrome extension end-to-end — stub hub, headed Chrome with real side panels, fake-CLI shims for real adapters, and CDP automation for side-panel windows.
---

# Testing the AgentBrowser extension end-to-end

## Stub hub (no API keys needed)

```
export PATH=~/node20/bin:$PATH
AGENTCHAT_ADAPTER_MODULE=$PWD/server/hub/stub-adapter.mjs STUB_SEND_MS=2500 \
  node server/hub/hub.mjs   # ws://127.0.0.1:9010
```

The stub emits `status → (~STUB_SEND_MS delay) → token "stub reply N" → meta → done`.
Set STUB_SEND_MS≈2500 when you need to act mid-stream (close panels, reload docs).
The hub journals chats to ~/.agentchat/chats/, so chat titles = first user message.
NOTE: the stub module replaces the WHOLE adapter registry (no real adapters exist
in that hub) and exports no probeAdapter, so every picker row reports status
'unknown' → the backend button is disabled, but sends still run on the first
adapter (claude-agent-sdk → stub). To have a stub row alongside real adapters,
write an adapter module that re-exports base.mjs plus your extra session.

## Fake-CLI shims for REAL adapters (AGENTCHAT_BIN_<NAME>)

resolveBin() checks `$AGENTCHAT_BIN_<NAME>` first for every CLI probe and spawn —
one shim makes both the generic-CLI and ACP adapters for that CLI "ready" and
scriptable. Example: drive the real `acp-devin` transport end-to-end with the
test fixture:

```sh
#!/bin/sh   # /tmp/fake-devin.sh
if [ "$1" = "models" ]; then          # feeds probeDevinModels()
  printf 'SWE-2 (swe-2)\n  swe-2-high  SWE-2 High\n  swe-2  SWE-2\n'
  exit 0
fi
export FAKE_ACP_MODEL_ENV="$DEVIN_MODEL"   # echo adapter's modelEnv channel
export FAKE_ACP_NO_SET_MODEL=1 FAKE_ACP_ECHO=1
exec node $REPO/tests/server/fake-acp-agent.mjs "$@"   # ignores 'acp' arg
```
`AGENTCHAT_BIN_DEVIN=/tmp/fake-devin.sh node server/hub/hub.mjs`

- Model-catalog cache gotcha: ~/.agentchat/model-catalog.json (TTL 6h) can mask a
  fresh probe — delete it before hub start when you need new `models list` output.
  Indented rows parse as "id␣␣label"; non-indented lines are skipped.
- FAKE_ACP_ECHO=1 prepends a turn token `env=<FAKE_ACP_MODEL_ENV> cfg=<configId>=<value>`
  — UI-visible proof that ctx.model reached the agent through both channels.

## Headed Chrome with REAL side panels (works on this VM's DISPLAY :0)

```
DISPLAY=:0 google-chrome --user-data-dir=/tmp/abt-profile \
  --load-extension=$PWD/extension --remote-debugging-port=29333 \
  --no-first-run --no-default-browser-check https://example.com &
```

Do NOT reuse the user's profile/`:29229` browser. Use a dedicated port (e.g. 29333)
and a throwaway `--user-data-dir`. Never `pkill -f chrome` — kill by PID from
`ss -ltnp | grep :29333`. Likewise `pkill -f hub.mjs` matches your own shell's
cmdline — use `pkill -f "node server/hub"` carefully or kill by PID.

Opening a real side panel needs a user gesture. Two reliable ways:
- GUI: extensions puzzle menu → click the "AgentBrowser" row (openPanelOnActionClick is set).
- CDP: `Runtime.evaluate` with `userGesture:true` in ANY extension page
  (e.g. an already-open panel target): `chrome.sidePanel.open({windowId})`.
  The service worker target does NOT work for this (no user activation in workers).

## CDP automation notes

- Side-panel documents appear in `/json/list` as `page` targets whose URL is
  `.../panel/sidepanel.html` — attach for DOM asserts (#messages, #chips,
  #chat-switcher, #status-dot). A tiny ws client script (uses the `ws` package
  in server/node_modules) that finds that target and Runtime.evaluates is the
  fastest way to dump rows/labels/rects.
- `Page.reload` on the panel target forces a clean reconnect after restarting
  the hub (e.g. swapping AGENTCHAT_ADAPTER_MODULE for a regression check).
- `Page.captureScreenshot` on a panel target yields a clean panel-only image.
- ws-attach errors happen when iterating targets that just died — tolerate them.

## Observing transient streaming states (auto-open, mid-turn toggles)

The stock fixture finishes a turn in ms — too fast to see mid-stream UI. Copy
the fixture and space its `notify()` calls with setTimeout (expose a PACE_MS
env; 1500-6000ms/beat → 8-30s turns). Coordinate clicks race the turn end and
miss small targets; for deterministic assertions drive real input through CDP
`Input.dispatchMouseEvent` on the panel target (compute the head's
getBoundingClientRect center in-page — no coordinate scaling needed) and poll
element state (`body.hidden`, `.open` class, children count) each ~500ms. A
state timeline (kids grew while hidden stayed true) is hard evidence for
toggle/ordering claims screenshots keep missing.

## Coordinate-space pitfall on this VM

The display is 1600x1200 but computer-tool coords are 1024x768 (scale 0.64).
`getBoundingClientRect()` returns REAL px — multiply by 0.64 and add the
browser chrome offset (~188 real px top ≈ 120 scaled) to hit small targets.
In the two-pane backend picker, hover the adapter row then move horizontally
RIGHT into the flyout before going up/down — a diagonal path clips sibling
adapter rows, whose mouseover repaints the flyout with a different (often
empty) model list and eats your click.

## Panel internals useful for assertions

- Send a chat via DOM: set `#input` value → dispatch `input` → click `#send`
  (or keydown Enter on #input). Status dot class = `dot up` when hub-connected.
- Backend picker: #backend-btn opens #backend-pop; left column #backend-adapters
  rows carry data-adapter (+ transport badge for non-CLI), hover/focus repaints
  #backend-models flyout; model-less adapters commit on click, model rows commit
  on click. Selection persists to chrome.storage.local {adapter, model}.
- Turn UI: streamed `thinking` events land as `.work-thinking` divs inside the
  collapsed `.work-block` (click `.work-head` to expand; `tool_use` becomes a
  titled chip, `tool_result` resolves it; label becomes "Thinking complete" on
  done). Meta line renders "<model> via <adapter> · Ns".
- `#chat-switcher` options list hub chats; `"Title (live)"` = live session.

## ACP adapter testing (scripted fake agent)

- `AGENTCHAT_ADAPTER_MODULE=tests/server/fake-acp-adapter.mjs node server/hub/hub.mjs`
  exposes `acp-fake` only (separate registry) — for Devin-family testing prefer
  the AGENTCHAT_BIN_DEVIN shim above, which keeps the real adapter registry.
- The fixture streams: text → thinking → tool_call → request_permission
  (auto-answered allow_once) → tool_call_update → text → done.

## In-process API adapters without a real key

`openai-api`/`anthropic-api` can be driven end-to-end with no provider
account: point `config.json`'s `openaiBaseUrl` at a local HTTP stub that
answers `/v1/chat/completions` with canned SSE (shapes in
`tests/server/mcp-bridge.test.mjs`), and write a dummy
`~/.agentchat/keys.json` (e.g. `{"openai":"test"}`) so `keyConfigured`
passes. The stub sees the real request body — tools table, system prompt,
follow-up tool messages — which is how `mcpServers`/`systemPromptExtra`
wiring was verified on PR #56.

## Devin Secrets Needed

None for the stub-hub or shim paths. Real adapters need their provider keys/CLIs.

## Multi-browser / multi-instance testing (v2.13+)

- Two profiles on one hub: launch two Chromes with `--user-data-dir=/tmp/chrome-a` / `-b`, separate `--remote-debugging-port`s (29333/29334), same `--load-extension` path. Both extensions connect to the same hub.
- Distinct browser names: after first connect, `chrome.storage.local.set({browserName:'alpha'})` in each SW, then get the extension to re-hello (see below). The UA-brand fallback often yields the literal name `browser` for both.
- **Developer mode gotcha:** after a relaunch, the unpacked extension can land disabled ("Turn on developer mode to use this extension") — the SW then never starts and the hub sees no connect. Deterministic fix: kill Chrome, edit `<profile>/Default/Preferences` → `extensions.ui.developer_mode=true` (+ `settings.<extid>.state=1`, `disable_reasons=0`), relaunch. Editing while Chrome runs gets clobbered on exit.
- Waking a dead SW: GUI only (puzzle → AgentBrowser opens the side panel). `location.href`/`Target.createTarget` navigations to `chrome-extension://` or `chrome://` are blocked from page context; `chrome.sidePanel.open` via CDP rejects without a real user gesture.
- Window↔Chrome mapping: `xdotool getwindowpid <win>` vs the listener pid (`ss -ltnp | grep :<debugport>`) — window titles are identical across instances.
- Extension id is path-derived (worktree ≠ main checkout): read it from `Preferences → extensions.settings` (the entry whose `path` matches your extension dir).
- ws sniffing: CDP `Network.enable` on the extension's **offscreen** target emits `Network.webSocketFrameReceived` — captures hub↔extension chat_event/tool_call envelopes verbatim.
- Same-id contention: clone a profile (`cp -r --reflink=auto`, delete `Singleton*`/lock files) → second Chrome helloes with the same browserId → hub closes the stale socket. Two live clients with the same id then auto-reconnect-ping-pong indefinitely.

## Page-translation pipeline testing (v2.14+)

- The provider path needs no real key: set `server/hub/config.json` `translate.provider="openai"` + `translate.baseUrl` to a local stub (`callOpenAI` honors `opts.baseUrl`). The stub only needs `POST /v1/chat/completions` → `{"choices":[{"message":{"content":...}}]}` (plain JSON, not SSE); the hub joins segments with `\n%%\n`, so echo each `%%`-split piece back. Scan `messages[]` for the content containing `Text to translate:` — word-hover requests use a different messages shape than batch ones.
- `page_translate` and friends need an **integer** `tabId` in CLI JSON (`"tabId":428669787`) — a quoted string hits `debugger.attach` with a type error (translate path doesn't coerce, unlike other tools).
- Engine probing: `!!window.__abTranslate` must return true before trusting injection; `applyBatch(req,{tid:''})` marks a para 'skipped' + `done++` — empty provider results still advance the done counter.
- Viewport batching means a **background tab never progresses** (IntersectionObserver stays quiet) — translate_status shows done<total, translating:0 until the tab is active.
- Panel settings save writes the WHOLE `translate` object to `server/hub/config.json` — fields absent from the form (e.g. `baseUrl`) are dropped on save; check config.json if the provider path dies right after a settings save.
- `chrome.tabs.create({url:chrome.runtime.getURL('panel/sidepanel.html')})` from the SW opens the panel as a normal tab when the real side panel can't be opened (it then resolves itself as "the active tab" for panel-triggered actions).
