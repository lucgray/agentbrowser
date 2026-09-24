// AgentBrowser service worker: message routing + the browser tool executor.
// The worker can be killed at any time; all top-level code runs again on each
// wakeup and re-derives state (offscreen doc, hub connection). Chat streams
// survive via the offscreen document, which owns the WebSocket.

import * as cdp from './cdp.js';

const DEFAULT_HUB_URL = 'ws://127.0.0.1:9010';

let panelPort = null;
let panelChatIds = new Set(); // chatIds started by the current panel Port
let hubConnected = false;
let lastCapabilities = null; // last {type:'capabilities'} from the hub, replayed on panel connect

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// --- selection -> side panel -------------------------------------------------
//
// The content script reports two things: a completed text selection the user
// clicked "Ask" on (selection_ask), and the context of whatever was
// right-clicked (selection_context_cache). The context-menu item uses the
// cache when it is fresh and falls back to asking the frame directly. Either
// way the payload lands in chrome.storage.session.pendingSelection, which the
// panel reads on open and watches live via storage.onChanged.

const CONTEXT_MENU_ID = 'ask-agentbrowser';
const SELECTION_CACHE_MS = 5000;
const rightClickContexts = new Map(); // tabId -> {selection, timestamp}

function registerContextMenu() {
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: 'Ask AgentBrowser',
      contexts: ['all'],
    },
    () => void chrome.runtime.lastError
  );
}

registerContextMenu();
chrome.runtime.onInstalled.addListener(() => {
  // Registrations survive worker restarts; rebuild only on install so a second
  // copy of the item is never created.
  chrome.contextMenus.removeAll(() => registerContextMenu());
});

// Writes only; opening the panel happens in the caller while the user gesture
// is still live (sidePanel.open rejects outside a gesture).
function deliverSelection(tabId, selection) {
  return chrome.storage.session
    .set({
      pendingSelection: {
        tabId,
        selection,
        timestamp: Date.now(),
      },
    })
    .then(() => true)
    .catch(() => false);
}

async function resolveMenuSelection(info, tab) {
  const cached = rightClickContexts.get(tab.id);
  if (cached && Date.now() - cached.timestamp < SELECTION_CACHE_MS) {
    return cached.selection;
  }

  // Ask the frame that was clicked; when it has no listener yet (page predates
  // the extension), inject the content script and retry once.
  const frameId = info.frameId || 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'agentbrowser_get_selection_context' },
        { frameId }
      );
      if (response && response.success && response.selection) {
        return response.selection;
      }
      if (attempt > 0) break;
    } catch {
      if (attempt > 0) break;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          files: ['selection.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, frameIds: [frameId] },
          files: ['selection.css'],
        });
      } catch {
        break; // chrome:// and friends reject injection entirely
      }
    }
  }

  // Last resort: whatever the context menu event itself carried.
  if (info.selectionText) {
    return {
      text: info.selectionText.trim(),
      contentType: 'text',
      surroundingBefore: '',
      surroundingAfter: '',
      parentHeading: '',
      semanticPath: '',
      codeBlock: null,
      tableBlock: null,
      pageUrl: info.pageUrl || tab.url || '',
      pageTitle: tab.title || '',
      isSelection: true,
    };
  }
  return null;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || tab.id == null) return;
  // Open synchronously: sidePanel.open only works inside the user gesture.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  resolveMenuSelection(info, tab)
    .then((selection) => {
      if (selection) return deliverSelection(tab.id, selection);
      return false;
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  rightClickContexts.delete(tabId);
});

// --- offscreen document -----------------------------------------------------

let creatingOffscreen = null;

async function offscreenExists() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return contexts.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'persistent WebSocket to local agent hub',
      })
      .catch((err) => {
        // A concurrent create makes this a no-op.
        const message = String((err && err.message) || err);
        if (!/single offscreen|already exists/i.test(message)) throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  return creatingOffscreen;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage(message).catch(() => {});
}

async function connectHub() {
  await ensureOffscreen();
  const { hubUrl } = await chrome.storage.local.get('hubUrl');
  await sendToOffscreen({
    target: 'offscreen',
    cmd: 'connect',
    url: hubUrl || DEFAULT_HUB_URL,
  });
}

connectHub().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.hubUrl) {
    connectHub().catch(() => {});
  }
});

// --- hub <-> panel routing --------------------------------------------------

function postToPanel(message) {
  if (!panelPort) return;
  try {
    panelPort.postMessage(message);
  } catch {
    panelPort = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'sw') return;
  if (message.cmd === 'selection_context_cache') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null && message.selection) {
      rightClickContexts.set(tabId, {
        selection: message.selection,
        timestamp: Date.now(),
      });
    }
    sendResponse({ success: true });
    return true;
  }
  if (message.cmd === 'selection_ask') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.selection) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    // Open first, still inside the click's user gesture.
    chrome.sidePanel.open({ tabId }).catch(() => {});
    deliverSelection(tabId, message.selection).then(
      (ok) => sendResponse({ success: ok }),
      () => sendResponse({ success: false })
    );
    return true;
  }
  if (message.cmd === 'ws_status') {
    hubConnected = !!message.connected;
    if (hubConnected) {
      sendToOffscreen({
        target: 'offscreen',
        cmd: 'send',
        payload: { type: 'hello', role: 'extension', version: '1.0.0' },
      });
    }
    postToPanel({ type: 'status', connected: hubConnected });
  } else if (message.cmd === 'ws_message') {
    handleHubMessage(message.payload);
  }
});

function handleHubMessage(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'tool_call') {
    handleToolCall(payload);
  } else if (payload.type === 'chat_event') {
    // Events for chatIds the current panel did not start are dropped.
    if (panelPort && panelChatIds.has(payload.chatId)) {
      postToPanel({ type: 'chat_event', chatId: payload.chatId, event: payload.event });
    }
  } else if (payload.type === 'capabilities') {
    // Relayed verbatim. Cached so a panel that reconnects gets its picker back
    // without waiting for the round trip its own get_capabilities makes.
    lastCapabilities = payload;
    postToPanel(payload);
  }
}

async function handleToolCall({ id, tool, args }) {
  let reply;
  try {
    const result = await executeTool(tool, args || {});
    reply = { type: 'tool_result', id, ok: true, result };
  } catch (err) {
    reply = { type: 'tool_result', id, ok: false, error: String((err && err.message) || err) };
  }
  sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: reply });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPort = port;
  panelChatIds = new Set();
  port.postMessage({ type: 'status', connected: hubConnected });
  if (lastCapabilities) port.postMessage(lastCapabilities);
  connectHub().catch(() => {});
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'chat' || msg.type === 'command') {
      // A command answers on the same chat_event stream as a chat turn
      // (PROTOCOL v1.3 B), so its chatId has to be registered the same way or
      // every event it produces would be dropped on the way back.
      panelChatIds.add(msg.chatId);
      // Verbatim, every field: picking fields out would drop model, context
      // and attachments.
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    } else if (
      msg.type === 'chat_abort' ||
      msg.type === 'set_key' ||
      msg.type === 'get_capabilities'
    ) {
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    }
  });
  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
  });
});

// --- tool executor ----------------------------------------------------------

async function resolveTabId(tabId) {
  if (tabId != null) return tabId;
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab.id;
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish();
    };
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(finish, timeoutMs);
  });
}

const TOOLS = {
  async tabs_list() {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    };
  },

  async tab_new(args) {
    const tab = await chrome.tabs.create(args.url ? { url: args.url } : {});
    return { tabId: tab.id };
  },

  async tab_close(args) {
    await chrome.tabs.remove(args.tabId);
    return { closed: true };
  },

  async navigate(args) {
    const tabId = await resolveTabId(args.tabId);
    const loaded = waitForLoad(tabId, 20000);
    await chrome.tabs.update(tabId, { url: args.url });
    await loaded;
    // After the load: navigation wipes anything injected before it. navigate is
    // the one tool that does not go through CDP, so it is the one place the
    // overlay has to be fired by hand. showOverlay never rejects and is bounded
    // at 250ms, so it is safe to leave unawaited here.
    cdp.showOverlay(tabId, 'navigate');
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title };
  },

  async read_page(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.readPage(tabId, args.maxChars);
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.screenshot(tabId);
  },

  async click(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.click(tabId, args.x, args.y);
  },

  async type_text(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.typeText(tabId, args.text);
  },

  async press_key(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.pressKey(tabId, args.key);
  },

  async eval_js(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.evalJs(tabId, args.expression);
  },
};

async function executeTool(tool, args) {
  const fn = TOOLS[tool];
  if (!fn) throw new Error(`unknown tool: ${tool}`);
  return fn(args);
}
