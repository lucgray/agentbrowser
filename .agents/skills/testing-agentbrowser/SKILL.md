---
name: testing-agentbrowser
description: How to run and test the AgentBrowser Chrome extension end-to-end — stub hub, headed Chrome with real side panels, and CDP automation for side-panel windows.
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

## Headed Chrome with REAL side panels (works on this VM's DISPLAY :0)

```
DISPLAY=:0 chrome --user-data-dir=/tmp/abt-profile \
  --load-extension=$PWD/extension --remote-debugging-port=29333 \
  --no-first-run --no-default-browser-check https://example.com &
```

Do NOT reuse the user's profile/`:29229` browser. Use a dedicated port (e.g. 29333)
and a throwaway `--user-data-dir`. Never `pkill -f chrome` — kill by PID from
`ss -ltnp | grep :29333`.

Opening a real side panel needs a user gesture. Two reliable ways:
- GUI: extensions puzzle menu → click the "AgentBrowser" row (openPanelOnActionClick is set).
- CDP: `Runtime.evaluate` with `userGesture:true` in ANY extension page
  (e.g. an already-open panel target): `chrome.sidePanel.open({windowId})`.
  The service worker target does NOT work for this (no user activation in workers).

## CDP automation notes

- Side-panel documents appear in `/json/list` as `page` targets whose URL is
  `.../panel/sidepanel.html` — attach for DOM asserts (#messages, #chips,
  #chat-switcher, #status-dot). Identify a panel's window via
  `chrome.windows.getCurrent().id` evaluated inside it.
- Create extra windows: `Target.createTarget {url, newWindow:true}` on the
  browser websocket; `Browser.getWindowForTarget` maps a page → windowId;
  `Browser.setWindowBounds` positions windows for screenshots.
- Close a panel: `Target.closeTarget` on its target. NOTE: closing + reopening
  within ~0.5s can revive the SAME document (same targetId, port intact). For a
  guaranteed port disconnect/reconnect use `Page.reload` on the panel target, or
  sleep ~1s between close and open.
- `Page.captureScreenshot` on a panel target yields a clean panel-only image —
  better evidence than desktop screenshots.
- ws-attach errors (`Unexpected server response: 500`) happen when iterating
  targets that just died — always tolerate failures when listing/attaching.

## Panel internals useful for assertions

- Send a chat via DOM: set `#input` value → dispatch `input` → click `#send`
  (or keydown Enter on #input). Status dot class = `dot up` when hub-connected.
- Selections delivered via chrome.storage.session.pendingSelection land as
  chips in `#chips` (`✂ sel: "..."`), gated to the owning window by tabId.
- `#chat-switcher` options list hub chats; `"Title (live)"` = live session.
  Panels auto-send `chat_list` on connect and on switcher mousedown/focus.

## Devin Secrets Needed

None for the stub-hub path. Real adapters need their provider keys/CLIs.
