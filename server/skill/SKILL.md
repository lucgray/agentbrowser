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
  running (`node server/hub.mjs`, or the user's autostart setup).
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

Mark up the page for the user (co-reading):

```bash
agentbrowser annotate '{"quote":"exact text from the page","style":"highlight","comment":"why this is flagged"}'
```

Patch the page to prove a fix, then roll it back:

```bash
agentbrowser patch_apply '{"patches":[{"selector":"h1","styles":{"outline":"3px solid red"}}]}'
agentbrowser patch_revert '{"patchId":"patch-..."}'
```

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
- If the user enabled the consent gate (`permissions` in server/config.json),
  sensitive tools may return `denied by user` — that's the user declining,
  not a bug: explain what you wanted to do and ask before retrying.
