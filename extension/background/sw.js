// AgentBrowser service worker: message routing + the browser tool executor.
// The worker can be killed at any time; all top-level code runs again on each
// wakeup and re-derives state (offscreen doc, hub connection). Chat streams
// survive via the offscreen document, which owns the WebSocket.

import * as cdp from './cdp.js';
import * as inspect from './inspect.js';
import * as consent from './consent.js';
import { createPanelRouter, windowIdFromPortName } from './panel-router.js';

const DEFAULT_HUB_URL = 'ws://127.0.0.1:9010';

// One panel Port per browser window, keyed by windowId (v2.1 — the single
// panelPort this replaced let the last-opened window steal every chat event).
const panelRouter = createPanelRouter();
let hubConnected = false;
let lastCapabilities = null; // last {type:'capabilities'} from the hub, replayed on panel connect
let lastPanelAdapter = null; // adapter of the panel's most recent chat; default for annotation threads

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.warn('[agentbrowser] setPanelBehavior failed', err);
});

// --- selection -> side panel -------------------------------------------------
//
// The content script reports two things: a completed text selection the user
// clicked "Ask" on (selection_ask), and the context of whatever was
// right-clicked (selection_context_cache). The context-menu item uses the
// cache when it is fresh and falls back to asking the frame directly. Either
// way the payload lands in chrome.storage.session.pendingSelection, which the
// panel reads on open and watches live via storage.onChanged.

const CONTEXT_MENU_ID = 'ask-agentbrowser';
const FLOAT_ASK_TOGGLE_ID = 'ask-floating-toggle';
const FLOAT_ASK_KEY = 'floatingAskEnabled'; // chrome.storage.local, default true
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
  // The floating Ask button can clash with other overlays, so it is a
  // persistent user setting toggled from the context menu. The checkbox
  // state mirrors chrome.storage.local; the content script reads the same
  // key and reacts via storage.onChanged.
  chrome.storage.local
    .get({ [FLOAT_ASK_KEY]: true })
    .then((r) => {
      chrome.contextMenus.create(
        {
          id: FLOAT_ASK_TOGGLE_ID,
          title: 'Floating Ask button on selection',
          contexts: ['all'],
          type: 'checkbox',
          checked: r[FLOAT_ASK_KEY],
        },
        () => void chrome.runtime.lastError
      );
    })
    .catch((err) => {
      console.warn('[agentbrowser] floating-ask setting read failed', err);
    });
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
    .catch((err) => {
      console.warn('[agentbrowser] pendingSelection write failed', err);
      return false;
    });
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
    } catch (err) {
      if (attempt > 0) break;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          files: ['content/selection.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, frameIds: [frameId] },
          files: ['content/selection.css'],
        });
      } catch (injectErr) {
        console.warn(
          '[agentbrowser] selection script injection failed',
          injectErr,
          'after message error:',
          err
        );
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
  if (info.menuItemId === FLOAT_ASK_TOGGLE_ID) {
    chrome.storage.local
      .set({ [FLOAT_ASK_KEY]: info.checked === true })
      .catch((err) => {
        console.warn('[agentbrowser] floating-ask setting write failed', err);
      });
    return;
  }
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || tab.id == null) return;
  // Open synchronously: sidePanel.open only works inside the user gesture.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
    console.warn('[agentbrowser] sidePanel.open failed', err);
  });
  resolveMenuSelection(info, tab)
    .then((selection) => {
      if (selection) return deliverSelection(tab.id, selection);
      return false;
    })
    .catch((err) => {
      console.warn('[agentbrowser] menu selection resolution failed', err);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  rightClickContexts.delete(tabId);
});

// --- annotations -------------------------------------------------------------
//
// The annotate* tools and annotation comments ride the content script in
// annotation.js. Comments become chat turns whose chatId starts with "ann-";
// annChats maps them back to their tab so the streamed reply is delivered to
// the card on the page instead of the panel.

const annChats = new Map(); // chatId -> { tabId, annId }

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [chatId, ann] of annChats) {
    if (ann.tabId === tabId) annChats.delete(chatId);
  }
});

// The annotation script is declared in the manifest, but a page that predates
// the extension (or a frame that missed injection) has no listener; inject it
// and retry once, same pattern as the context-menu path.
async function sendToAnnotationScript(tabId, payload) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (err) {
      lastErr = err;
      if (attempt > 0) break;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/annotation.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content/annotation.css'],
        });
      } catch (injectErr) {
        console.warn(
          '[agentbrowser] annotation script injection failed',
          injectErr
        );
        break;
      }
    }
  }
  throw lastErr || new Error('annotation script unreachable');
}

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
        url: 'offscreen/offscreen.html',
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
  return chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[agentbrowser] sw -> offscreen message failed', err);
  });
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

connectHub().catch((err) => {
  console.warn('[agentbrowser] initial hub connect failed', err);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.hubUrl) {
    connectHub().catch((err) => {
      console.warn('[agentbrowser] hub reconnect failed', err);
    });
  }
});

// --- hub <-> panel routing --------------------------------------------------

function postToPanel(message) {
  for (const windowId of panelRouter.route(message)) {
    const port = panelRouter.ports.get(windowId);
    if (!port) continue;
    try {
      port.postMessage(message);
    } catch (err) {
      console.warn('[agentbrowser] postToPanel failed, dropping port', err);
      panelRouter.disconnect(windowId, port);
    }
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
    chrome.sidePanel.open({ tabId }).catch((err) => {
      console.warn('[agentbrowser] sidePanel.open failed', err);
    });
    deliverSelection(tabId, message.selection).then(
      (ok) => sendResponse({ success: ok }),
      () => sendResponse({ success: false })
    );
    return true;
  }
  if (message.cmd === 'annotation_comment') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.annId || !message.text) {
      sendResponse({ success: false, error: 'missing tabId/annId/text' });
      return true;
    }
    // Same annotation, same chatId — a second comment continues the thread.
    const chatId = `ann-${message.annId}-${tabId}`;
    annChats.set(chatId, { tabId, annId: message.annId });
    const ann = message.annotation || {};
    const text =
      'The user commented on an annotation on the page you are reading together.\n' +
      `Mark: ${ann.style || 'annotation'} on """${ann.quote || ''}"""\n` +
      (ann.comment ? `The mark's note: ${ann.comment}\n` : '') +
      `User's comment: ${message.text}\n` +
      'Reply conversationally — your answer streams back onto the annotation card on the page. ' +
      'Use annotate_reply for a short targeted reply, or just answer directly.';
    sendToOffscreen({
      target: 'offscreen',
      cmd: 'send',
      payload: {
        type: 'chat',
        chatId,
        text,
        adapter: lastPanelAdapter || undefined,
        context: {
          currentTab: {
            tabId,
            url: sender.tab.url || '',
            title: sender.tab.title || '',
          },
        },
      },
    });
    sendResponse({ success: true });
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
    // Annotation threads (chatId 'ann-*') stream to the page card, not the
    // panel. Events for chatIds the current panel did not start are dropped.
    const ann = annChats.get(payload.chatId);
    if (ann) {
      chrome.tabs
        .sendMessage(ann.tabId, {
          target: 'annotation',
          cmd: 'event',
          annId: ann.annId,
          event: payload.event,
        })
        .catch((err) => {
          console.warn('[agentbrowser] annotation event delivery failed', err);
        });
      return;
    }
    postToPanel({ type: 'chat_event', chatId: payload.chatId, event: payload.event });
  } else if (payload.type === 'capabilities') {
    // Relayed verbatim. Cached so a panel that reconnects gets its picker back
    // without waiting for the round trip its own get_capabilities makes.
    lastCapabilities = payload;
    postToPanel(payload);
  } else if (payload.type === 'chat_list' || payload.type === 'chat_resumed') {
    postToPanel(payload);
  }
}

// Consent gate (PROTOCOL v1.7): the hub attaches config.json's `permissions`
// to each forwarded call. Only gated tools pay the tab lookup; an absent
// policy or allowAll:true means the gate is off. Extracted so `batch` can gate
// every inner step individually.
async function gateToolCall(tool, args, permissions) {
  if (!consent.shouldCheck(tool, permissions)) return;
  const tabId = await resolveTabId(args && args.tabId);
  const tab = await chrome.tabs.get(tabId).catch((err) => {
    console.warn('[agentbrowser] consent tab lookup failed', err);
    return null;
  });
  // navigate is judged by where it is going, not where the tab is now.
  const gateUrl =
    tool === 'navigate' && args && args.url
      ? String(args.url)
      : (tab && tab.url) || '';
  await consent.authorize(tool, args, tabId, gateUrl, permissions);
}

async function handleToolCall({ id, tool, args, permissions }) {
  let reply;
  try {
    await gateToolCall(tool, args, permissions);
    const result = await executeTool(tool, args || {}, permissions);
    reply = { type: 'tool_result', id, ok: true, result };
  } catch (err) {
    console.warn('[agentbrowser] tool call failed:', tool, err);
    reply = { type: 'tool_result', id, ok: false, error: String((err && err.message) || err) };
  }
  sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: reply });
}

chrome.runtime.onConnect.addListener((port) => {
  const windowId = windowIdFromPortName(port.name);
  if (windowId === null) return;
  const stale = panelRouter.ports.get(windowId);
  if (stale && stale !== port) {
    try {
      stale.disconnect();
    } catch (err) {
      console.warn('[agentbrowser] stale panel port disconnect failed', err);
    }
  }
  panelRouter.connect(windowId, port);
  port.postMessage({ type: 'status', connected: hubConnected });
  if (lastCapabilities) port.postMessage(lastCapabilities);
  connectHub().catch((err) => {
    console.warn('[agentbrowser] hub connect on panel open failed', err);
  });
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    // Binds chat/command/chat_resume chatIds to this window for reply routing.
    panelRouter.noteInbound(windowId, msg);
    if (msg.type === 'chat' || msg.type === 'command') {
      // Annotation comments default to whatever backend the panel is using.
      if (typeof msg.adapter === 'string' && msg.adapter) {
        lastPanelAdapter = msg.adapter;
      }
      // Verbatim, every field: picking fields out would drop model, context
      // and attachments.
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    } else if (
      msg.type === 'chat_resume' ||
      msg.type === 'chat_abort' ||
      msg.type === 'set_key' ||
      msg.type === 'get_capabilities' ||
      msg.type === 'chat_list'
    ) {
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    }
  });
  port.onDisconnect.addListener(() => {
    panelRouter.disconnect(windowId, port);
  });
});

// --- tool executor ----------------------------------------------------------

async function resolveTabId(tabId) {
  if (tabId != null) return tabId;
  // Prefer the window whose panel most recently talked — with several windows
  // open, 'currentWindow' inside a worker resolves to the focused one, which
  // is not necessarily the one that asked.
  const hint = panelRouter.lastWindow();
  if (typeof hint === 'number') {
    const [tab] = await chrome.tabs.query({ active: true, windowId: hint });
    if (tab) return tab.id;
  }
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

  async click_element(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.clickElement(tabId, args.selector, args.dx || 0, args.dy || 0);
  },

  async type_text(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.typeText(tabId, args.text, args.selector);
  },

  async press_key(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.pressKey(tabId, args.key);
  },

  async eval_js(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.evalJs(tabId, args.expression);
  },

  async annotate(args) {
    const tabId = await resolveTabId(args.tabId);
    const res = await sendToAnnotationScript(tabId, {
      target: 'annotation',
      cmd: 'annotate',
      quote: String(args.quote || ''),
      style: String(args.style || ''),
      comment: String(args.comment || ''),
      color: args.color ? String(args.color) : '',
      author: 'agent',
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'annotate failed');
    return { id: res.id, style: res.style, quote: res.quote };
  },

  async annotate_batch(args) {
    const tabId = await resolveTabId(args.tabId);
    const items = Array.isArray(args.annotations) ? args.annotations : [];
    const res = await sendToAnnotationScript(tabId, {
      target: 'annotation',
      cmd: 'batch',
      annotations: items.map((it) => ({
        quote: String((it && it.quote) || ''),
        style: String((it && it.style) || ''),
        comment: String((it && it.comment) || ''),
        color: it && it.color ? String(it.color) : '',
      })),
      author: 'agent',
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'annotate_batch failed');
    return { results: res.results || [] };
  },

  async annotations_list(args) {
    const tabId = await resolveTabId(args.tabId);
    const res = await sendToAnnotationScript(tabId, {
      target: 'annotation',
      cmd: 'list',
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'annotations_list failed');
    return { annotations: res.annotations || [] };
  },

  async annotate_reply(args) {
    const tabId = await resolveTabId(args.tabId);
    const res = await sendToAnnotationScript(tabId, {
      target: 'annotation',
      cmd: 'reply',
      id: String(args.id || ''),
      text: String(args.text || ''),
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'annotate_reply failed');
    return { id: res.id, replied: true };
  },

  async annotate_clear(args) {
    const tabId = await resolveTabId(args.tabId);
    const res = await sendToAnnotationScript(tabId, {
      target: 'annotation',
      cmd: 'clear',
      id: args.id ? String(args.id) : '',
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'annotate_clear failed');
    return { cleared: res.cleared || 0 };
  },

  // --- inspection tools (v1.6): BBX-style observe-first reads + live patches.

  async dom_inspect(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.domInspect(tabId, args);
  },

  async console_log(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.consoleLog(tabId, args);
  },

  async network_log(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.networkLog(tabId, args);
  },

  async a11y_tree(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.a11yTree(tabId, args);
  },

  async dialog_list(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.dialogList(tabId);
  },

  async dialog_respond(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.dialogRespond(tabId, args);
  },

  async patch_apply(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.patchApply(tabId, args);
  },

  async patch_revert(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.patchRevert(tabId, args);
  },

  // --- composite wrappers (v2.2) -----------------------------------------

  async fill(args) {
    const tabId = await resolveTabId(args.tabId);
    await cdp.clickElement(tabId, String(args.selector || ''));
    const res = await cdp.typeText(tabId, String(args.text || ''));
    let submitted = false;
    if (args.submit) {
      await cdp.pressKey(tabId, 'Enter');
      submitted = true;
    }
    return { filled: true, typed: res && res.typed, submitted };
  },

  // Polling here (one eval per 250ms inside the extension) replaces the
  // model's own read_page/screenshot loops, which cost a tool round trip and
  // a big payload each iteration.
  async wait_for(args) {
    const tabId = await resolveTabId(args.tabId);
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10000, 0), 60000);
    const sel = args.selector ? String(args.selector) : '';
    const text = args.text ? String(args.text) : '';
    if (!sel && !text) throw new Error('wait_for needs selector or text');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const expr = sel
        ? `!!document.querySelector(${JSON.stringify(sel)})`
        : `!!(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`;
      const r = await cdp.evalJs(tabId, expr);
      if (r && r.value) return { found: true, waited: Date.now() - t0 };
      await new Promise((res) => setTimeout(res, 250));
    }
    return { found: false, waited: Date.now() - t0 };
  },

  async read_elements(args) {
    const tabId = await resolveTabId(args.tabId);
    const sel = String(args.selector || '');
    if (!sel) throw new Error('read_elements needs selector');
    const max = Math.min(Math.max(Number(args.max) || 50, 1), 200);
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 300, 1), 2000);
    const attr = args.attr ? String(args.attr) : '';
    const expr =
      `[...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, ${max})` +
      `.map((el) => ({ text: String(el.innerText || el.textContent || '').trim().slice(0, ${maxChars})` +
      (attr ? `, value: el.getAttribute(${JSON.stringify(attr)})` : '') +
      ' }))';
    const r = await cdp.evalJs(tabId, expr);
    const elements = Array.isArray(r && r.value) ? r.value : [];
    return { count: elements.length, elements };
  },

  // Sequential steps in one call (v2.2). Each step gates under its own tool
  // name — batch itself is never in the gate list, so nothing double-asks.
  async batch(args, permissions) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw new Error('batch needs steps');
    const stopOnError = args.stopOnError !== false;
    const results = [];
    for (const step of steps) {
      const name = step && typeof step === 'object' ? String(step.tool || '') : '';
      if (name === 'batch') {
        results.push({ step: name, ok: false, error: 'nested batch not allowed' });
        if (stopOnError) break;
        continue;
      }
      const fn = TOOLS[name];
      if (!fn) {
        results.push({ step: name, ok: false, error: `unknown tool: ${name}` });
        if (stopOnError) break;
        continue;
      }
      const innerArgs = Object.assign({}, step.args);
      if (innerArgs.tabId == null && args.tabId != null) innerArgs.tabId = args.tabId;
      try {
        await gateToolCall(name, innerArgs, permissions);
        const result = await fn(innerArgs);
        results.push({ step: name, ok: true, result });
      } catch (err) {
        results.push({
          step: name,
          ok: false,
          error: String((err && err.message) || err),
        });
        if (stopOnError) break;
      }
    }
    return {
      results,
      completed: results.filter((r) => r.ok).length,
      total: steps.length,
    };
  },
};

async function executeTool(tool, args, permissions) {
  const fn = TOOLS[tool];
  if (!fn) throw new Error(`unknown tool: ${tool}`);
  return fn(args, permissions);
}
