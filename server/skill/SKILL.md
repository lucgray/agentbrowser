---
name: agentbrowser
description: Drive the user's real Chrome browser — read pages, inspect DOM/console/network, click, type, annotate — through the AgentBrowser extension. Use when a task needs the browser the user is already logged into. No MCP required: call the `agentbrowser` CLI via Bash.
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
```

The result is JSON on stdout; exit code is non-zero on tool errors. Default
hub is `ws://127.0.0.1:9010` (override with `AGENTBROWSER_HUB` or `--hub`).

## Common flows

Read the current page the user is looking at:

```bash
agentbrowser read_page '{}'
```

Find and click a button — either click the selector directly, or inspect
first and click by coordinates:

```bash
agentbrowser click_element '{"selector":"button.primary"}'
agentbrowser dom_inspect '{"selector":"button.primary","styles":["display"]}'
agentbrowser click '{"x":512,"y":340}'
```

Check why a page misbehaves:

```bash
agentbrowser console_log '{"level":"error"}'
agentbrowser network_log '{"filter":"api","limit":50}'
agentbrowser network_log '{"har":true}' > page.har.json   # sanitized HAR
```

Type into a focused field, press keys, navigate:

```bash
agentbrowser type_text '{"text":"hello","selector":"input[name=q]"}'  # selector click-focuses first
agentbrowser press_key '{"key":"Enter"}'
agentbrowser navigate '{"url":"https://example.com"}'
```

Debug page JavaScript with breakpoints (the page's JS freezes while paused):

```bash
agentbrowser breakpoint_set '{"urlRegex":"app\\.js","lineNumber":42,"autoResumeMs":2000}'
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
agentbrowser print_pdf '{"printBackground":true}' > out.json      # .base64 -> decode to file
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

Mark up the page for the user (co-reading):

```bash
agentbrowser annotate '{"quote":"exact text from the page","style":"highlight","comment":"why this is flagged"}'
agentbrowser annotate_batch '{"annotations":[{"quote":"one phrase","style":"highlight"},{"quote":"another","style":"circle","comment":"why"}]}'
```

Patch the page to prove a fix, then roll it back:

```bash
agentbrowser patch_apply '{"patches":[{"selector":"h1","styles":{"outline":"3px solid red"}}]}'
agentbrowser patch_revert '{"patchId":"patch-..."}'
```

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
  tabs with `agentbrowser tabs_list '{}'`.
- Prefer structured reads (`dom_inspect`, `a11y_tree`, `console_log`,
  `network_log`) over `eval_js`; reach for `eval_js` only when no tool covers
  what you need.
- `network_log`/`console_log` buffers start filling on first use and reset
  on navigation — call them early if you're reproducing a bug.
- JS dialogs are auto-dismissed after ~5s while you're driving a tab; answer
  them yourself with `dialog_respond` if you need a specific outcome.
- If the user enabled the consent gate (`permissions` in server/hub/config.json),
  sensitive tools may return `denied by user` — that's the user declining,
  not a bug: explain what you wanted to do and ask before retrying.
