---
name: agentbrowser
description: "Drive the user's real Chrome browser — read pages, inspect DOM/console/network, click, type, annotate — through the AgentBrowser extension. Use when a task needs the browser the user is already logged into. No MCP required: call the `agentbrowser` CLI via Bash."
---

# AgentBrowser

AgentBrowser is a Chrome extension + local hub that lets you operate the
user's actual browser — their logged-in tabs, their real page state — with
trusted input. Everything runs locally; nothing is sent anywhere except the
hub on 127.0.0.1:9010.

## Prerequisites

- The `agentbrowser` CLI is installed (this file's install step handles it).
- The AgentBrowser extension is loaded in the user's Chrome and its hub is
  running (`node server/hub/hub.mjs`, or the user's autostart setup).
- If a call fails with "no extension connected", tell the user the extension
  isn't connected to the hub — the CLI cannot fix that from here.

## Usage

Every browser tool is a subcommand:

```bash
agentbrowser <tool> '<json-args>'
agentbrowser tools                 # list all tools
agentbrowser <tool> --help         # one tool's arg schema
agentbrowser screenshot '{}' --output /tmp/shot.png   # save base64 results to a file
agentbrowser session               # REPL: one tool call per line, connection reused
```

Every call also accepts `"label":"<short intent>"` — always set it; the
user sees your label in the panel instead of the raw command (see
"Naming your actions" below).

The result is JSON on stdout; exit code is non-zero on tool errors. Default
hub is `ws://127.0.0.1:9010` (override with `AGENTBROWSER_HUB` or `--hub`).
`--output <path>` decodes a base64-bearing result (screenshot, print_pdf)
into that file and prints only `{saved,mimeType,bytes}` — without it the
raw payload would flood stdout (a screenshot is ~30k tokens as JSON).

## Interactive sessions

When each step depends on the previous result, `agentbrowser session` keeps
one process and one hub connection open — no per-call setup cost:

```bash
agentbrowser session
```

One line per call: `<tool> [json-args] [--output <path>] [--timeout <ms>]`.
Built-ins: `tools`, `backends`, `help`, `exit`. Failures print
`{"ok":false,"error":...}` and the loop continues. Piped lines work too, so
scripted flows skip the per-call process + handshake:

```bash
printf 'tabs_list {}\nscreenshot {} --output /tmp/shot.png\nexit\n' | agentbrowser session
```

## Multiple browsers on one hub

Several Chrome-family browsers (or profiles) can share one hub. See who is
connected and which browser your calls go to:

```bash
agentbrowser browsers_list '{}'   # -> {browsers:[{id,name,default,current}], using}
```

Calls without a `browser` arg go to the `using` browser — the one with the
most recent panel chat, else the first connected. Any tool accepts
`"browser":"<id-or-name>"` to act on a different connected browser:

```bash
agentbrowser navigate '{"url":"https://example.com","browser":"Edge","label":"在 Edge 打开示例站"}'
```

tabIds only mean something inside their own browser — when you combine
`browser` + `tabId`, the tabId must belong to that browser.

## Common flows

Read the current page the user is looking at:

```bash
agentbrowser read_page '{"label":"读当前页面"}'
```

Find and click a button — either click the selector directly, or inspect
first and click by coordinates:

```bash
agentbrowser click_element '{"selector":"button.primary","label":"点击主按钮"}'
agentbrowser dom_inspect '{"selector":"button.primary","styles":["display"]}'
agentbrowser click '{"x":512,"y":340,"label":"点击确定位置"}'
```

`click_element` verifies the target before clicking (so a wrong element is
never silently hit): a selector matching several elements fails until
`index` picks one, and an invisible or covered element fails until
`force:true`. `timeoutMs` waits for the element to appear, folding
`wait_for` + click into one call:

```bash
agentbrowser element_check '{"selector":".item"}'                        # -> {count, matches:[{index,tag,text,path,visible,occluded,...}]}
agentbrowser click_element '{"selector":".item","index":2,"label":"点第三个条目"}'
agentbrowser click_element '{"selector":"#save","timeoutMs":5000,"label":"等保存按钮出现再点"}'
```

Every match report carries `path` — a stable CSS selector you can reuse
across navigations (unlike `nodeId`, which dies on navigation).

Check why a page misbehaves:

```bash
agentbrowser console_log '{"level":"error","label":"检查控制台报错"}'
agentbrowser network_log '{"filter":"api","limit":50,"label":"抓异常接口"}'
agentbrowser network_log '{"har":true}' > page.har.json   # sanitized HAR
```

Type into a focused field, press keys, navigate:

```bash
agentbrowser type_text '{"text":"hello","selector":"input[name=q]","label":"输入搜索词"}'  # selector click-focuses first
agentbrowser press_key '{"key":"Enter","label":"回车提交"}'
agentbrowser navigate '{"url":"https://example.com","label":"打开示例站"}'
agentbrowser navigate '{"url":"https://spa.example.com","settleMs":2000}'  # SPA: wait for network silence too
```

Planned sequences run as ONE `batch` call — plan the whole flow up front,
execute it in one request, and put an observation tool last so you see the
result:

```bash
agentbrowser batch '{"steps":[
  {"tool":"click_element","args":{"selector":"#search","label":"点搜索框"}},
  {"tool":"type_text","args":{"text":"关键词","label":"输入关键词"}},
  {"tool":"press_key","args":{"key":"Enter","label":"回车搜索"}},
  {"tool":"wait_for","args":{"selector":".results","label":"等结果加载"}},
  {"tool":"page_snapshot","args":{"label":"读结果页"}}
]}'
```

Each step names its tool + args + label; the top-level `tabId` is inherited
by steps that omit it. Steps stop at the first failure unless
`stopOnError:false`, and every step's result comes back in `results[]`.
Use batch for predictable flows (login, search, form fills) — keep
exploratory steps separate when the next move depends on what you find.

Wait for dynamic content instead of polling reads (cheap — no page text
moves per retry):

```bash
agentbrowser wait_for '{"selector":".results","label":"等结果渲染"}'
agentbrowser wait_for '{"selector":".results","visible":true}'           # rendered, not just in the DOM
agentbrowser wait_for '{"text":"Checkout complete","label":"等支付完成"}'   # innerText match
```

`wait_for` times out gracefully — check `found` in the result rather than
treating a miss as an error.

Emulate a device viewport without resizing the window (responsive/mobile checks):

```bash
agentbrowser viewport_emulate '{"width":390,"height":844,"mobile":true}'   # iPhone-ish, touch on
agentbrowser viewport_emulate '{"clear":true}'                            # back to the real window size
```

Debug page JavaScript with breakpoints (the page's JS freezes while paused):

```bash
agentbrowser breakpoint_set '{"urlRegex":"app\\.js","lineNumber":42,"autoResumeMs":2000}'
agentbrowser breakpoint_list '{}'                    # -> {breakpoints:[{id,url,lineNumber}]}
agentbrowser debug_wait '{"timeoutMs":15000}'        # -> {paused:true, callFrames, topCallFrameId}
agentbrowser debug_eval '{"expression":"JSON.stringify(state.filters)}"'   # eval in the paused frame
agentbrowser debug_resume '{"action":"resume"}'     # or stepOver / stepInto / stepOut
agentbrowser breakpoint_remove '{"id":"<breakpointId>"}'
```

`autoResumeMs` is yours to choose per breakpoint: pass it when you only need
to snapshot state and move on, so a missed `debug_resume` can't leave the
page frozen. `timeoutMs` on `debug_wait` is likewise your call — how long to
keep listening for the hit.

Pointer gestures beyond plain clicks — right-click menus, hover states,
scrolls (including nested containers and lazy loaders), drags and text
selection:

```bash
agentbrowser click '{"x":100,"y":50,"button":"right"}'        # context menu
agentbrowser click_element '{"selector":"tr","clickCount":2}' # double-click
agentbrowser hover '{"selector":".menu-item"}'                # open hover menu
agentbrowser scroll '{"yDistance":-800,"repeatCount":3}'      # scroll down
agentbrowser drag '{"from":{"x":10,"y":10},"to":{"x":300,"y":10}}'          # slider
agentbrowser drag '{"from":{"x":10,"y":10},"to":{"x":300,"y":10},"mode":"html5"}'  # HTML5 drop
agentbrowser select_text '{"selector":"article"}'             # real selection, lands as chat context
```


Files and downloads — set a file input without an OS picker, auto-accept
downloads into a directory, or print the page to PDF:

```bash
agentbrowser set_file_input '{"selector":"input[type=file]","files":["/path/report.pdf"]}'
agentbrowser download_configure '{"directory":"/home/user/dl"}'   # call before clicking the link
agentbrowser downloads_list '{}'
agentbrowser print_pdf '{"printBackground":true}' --output page.pdf   # decoded PDF, stdout = metadata
```

Cross-origin iframes (payment widgets, embedded editors) need their own
tools — normal selectors can't reach inside an OOPIF:

```bash
agentbrowser frames_list '{}'                                  # -> sessionId + url
agentbrowser frame_dom_inspect '{"frame":"pay.stripe","selector":"input"}'
agentbrowser frame_eval '{"frame":"pay.stripe","expression":"document.title"}'
agentbrowser frame_click_element '{"frame":"pay.stripe","selector":"button.pay"}'
```

`frame` accepts a sessionId or a URL substring (unique match required).
Same-origin iframes don't need these — plain selectors already reach them.
`eval_js`, `dom_inspect`, `read_elements`, `click_element` and `type_text`
also take `frame` — you don't need the frame_* variants unless you prefer them.

Get the whole clickable map in one call instead of probing with dom_inspect:

```bash
agentbrowser page_snapshot '{}'                     # -> nodes:[{node,tag,role,name,text,path,href,value,x,y,w,h}]
agentbrowser page_snapshot '{"full":true}'          # whole document, not just the viewport
agentbrowser click_element '{"nodeId":"n12"}'       # click a snapshot node, no selector needed
```

Mark up the page for the user (co-reading):

```bash
agentbrowser annotate '{"quote":"exact text from the page","style":"highlight","comment":"why this is flagged"}'
agentbrowser annotate_batch '{"annotations":[{"quote":"one phrase","style":"highlight"},{"quote":"another","style":"circle","comment":"why"}]}'
agentbrowser annotations_list '{}'                   # marks + comment threads on the tab
agentbrowser annotate_reply '{"id":"ann-...","text":"跟进说明"}'        # reply on a mark's thread
agentbrowser annotate_clear '{"id":"ann-..."}'       # remove one mark; omit id to clear all
```

Patch the page to prove a fix, then roll it back:

```bash
agentbrowser patch_apply '{"patches":[{"selector":"h1","styles":{"outline":"3px solid red"}}]}'
agentbrowser patch_revert '{"patchId":"patch-..."}'
```

Record a tab while you work on it (v2.7):

Chrome requires the tab to be "invoked" first — the user must have clicked
the AgentBrowser icon or chosen "Ask AgentBrowser" from the right-click menu
on that tab since its last navigation. If `record_start` errors with
"needs an invocation", ask the user for that one click, then retry.

```bash
agentbrowser record_start '{}'        # needs consent; starts tabCapture
# ... keep calling tools — every click/hover/scroll/drag lands a
#     {t,x,y,kind} marker on the zoom track automatically ...
agentbrowser record_pause '{}'        # pause mid-recording
agentbrowser record_resume '{}'       # resume it
agentbrowser record_marker '{"label":"关键时刻"}'  # bookmark a beat on the track
agentbrowser record_stop '{}'         # -> <Downloads>/agentbrowser/record-*.webm
                                      #    + record-*.track.json (markers)
```

`record_start` records the tab's content only — no system cursor, no audio.
The `.track.json` beside the video is what a zoom/pan edit tool needs: each
marker is a timestamped coordinate from your own tool calls.

## Stealth preloads (`inject_preload`)

`inject_preload` runs a script at document start — before any page JS — on
every document created afterwards in the tab. Inject BEFORE `navigate` (or
reload); the already-loaded page is untouched.

```bash
agentbrowser inject_preload '{"preset":"antidetect","label":"disable anti-bot probes"}'
agentbrowser navigate '{"url":"https://zhipin.com"}'
```

`preset:"antidetect"` ships the bundled stealth script for sites that fight
automation with anti-debug probes (disable-devtool-style: console timing
tables, `performance.now` hooks, `toString` source checks — the recipe used
against BOSS-class sites). Custom payloads work too:
`inject_preload '{"script":"(function(){ /* document-start JS */ })()"}'`.
Manage with `preloads_list` / `preload_remove '{"all":true}'`. Side effect
of the antidetect preset: `console_log` goes quiet on that page — neutered
console methods stop emitting events.

## Naming your actions (`label`)

Every tool accepts an optional `label` — a short human-readable name for the
call that the side panel shows instead of the raw tool name and arguments.
Always pass it: the user reads the label on the chip and on consent cards,
so make it describe intent, not mechanics.

```bash
# chip shows "搜索订单接口" instead of "network_log {filter:...}"
agentbrowser network_log '{"filter":"/api/orders","label":"搜索订单接口"}'

# consent card shows "填写登录表单" instead of "fill {...}"
agentbrowser fill '{"selector":"#email","text":"a@b.c","label":"填写登录表单"}'
```

Rules of thumb:

- Keep it under ~8 words, in the user's language (the panel UI language).
- Describe the goal ("check why checkout 500s"), not the tool
  (`console_log`), not the raw command.
- `batch` steps each take their own label — name each step so the user can
  follow the plan.
- Omitting `label` just falls back to the tool name — nothing breaks, but
  the user sees "eval_js {…}" again.

## Conventions

- `tabId` is optional everywhere — omit it to act on the active tab; list
  tabs with `agentbrowser tabs_list '{}'`, open/close with
  `tab_new`/`tab_close`.
- Prefer structured reads (`dom_inspect`, `a11y_tree`, `console_log`,
  `network_log`) over `eval_js`; reach for `eval_js` only when no tool covers
  what you need.
- `network_log`/`console_log` buffers start filling on first use and reset
  on navigation — call them early if you're reproducing a bug.
- JS dialogs are auto-dismissed after ~5s while you're driving a tab; list
  pending ones with `dialog_list`, answer with `dialog_respond` if you need
  a specific outcome.
- If the user enabled the consent gate (`permissions` in server/hub/config.json),
  sensitive tools may return `denied by user` — that's the user declining,
  not a bug: explain what you wanted to do and ask before retrying.
