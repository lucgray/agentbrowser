// AgentBrowser service worker: message routing + the browser tool executor.
// The worker can be killed at any time; all top-level code runs again on each
// wakeup and re-derives state (offscreen doc, hub connection). Chat streams
// survive via the offscreen document, which owns the WebSocket.

import * as cdp from './cdp.js';
import * as inspect from './inspect.js';
import { CSS_PATH_FN } from './inspect-core.js';
import * as consent from './consent.js';
import { createPanelRouter, windowIdFromPortName } from './panel-router.js';
import { PRELOAD_PRESETS } from './stealth.js';
import * as translate from './translate.js';
import * as subtitle from './subtitle.js';
import * as direct from './direct.js';

const DEFAULT_HUB_URL = 'ws://127.0.0.1:9010';
// HTTP origin of the same hub server — media files finished by yt-dlp are
// served under /dl/<id> so chrome.downloads can pick them up.
let hubHttpBase = 'http://127.0.0.1:9010';

// Stable per-profile id + a display name for the hub's browser table (v2.13:
// several browsers can share one hub — this is how it tells them apart).
// browserName in chrome.storage.local overrides the detected name.
let browserIdentityPromise = null;

function detectBrowserName() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const brand = brands.find((b) => b && b.brand && !/chromium|not.?a.?brand/i.test(b.brand));
  return (brand && brand.brand) || 'browser';
}

function browserIdentity() {
  if (!browserIdentityPromise) {
    browserIdentityPromise = chrome.storage.local
      .get(['agentbrowserBrowserId', 'browserName'])
      .then((data) => {
        let id = data.agentbrowserBrowserId;
        if (!id) {
          id = crypto.randomUUID();
          chrome.storage.local.set({ agentbrowserBrowserId: id }).catch((err) => {
            console.warn('[agentbrowser] browser id persist failed', err);
          });
        }
        return { id, name: data.browserName || detectBrowserName() };
      });
  }
  return browserIdentityPromise;
}

// One panel Port per browser window, keyed by windowId (v2.1 — the single
// panelPort this replaced let the last-opened window steal every chat event).
const panelRouter = createPanelRouter();
let hubConnected = false;
const hubConnectWaiters = new Set(); // resolved when ws_status reports connected
// MV3 wakes the SW with hubConnected=false; the offscreen re-report lands a
// few hundred ms later. Commands arriving in that window wait for it instead
// of failing 'hub not connected' on a live socket.
function waitForHubConnected(timeoutMs = 4000) {
  if (hubConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      hubConnectWaiters.delete(done);
      resolve(hubConnected);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    hubConnectWaiters.add(done);
  });
}
let lastCapabilities = null; // last {type:'capabilities'} from the hub, replayed on panel connect
let lastPanelAdapter = null; // adapter of the panel's most recent chat; default for annotation threads

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.warn('[agentbrowser] setPanelBehavior failed', err);
});

// Packaged-app windows (e.g. Edge "install this site as an app") have no
// extensions rail, so sidePanel.open rejects there. Fall back to a floating
// popup window running the same panel page; ?bind= tells the panel which tab
// it serves instead of its own window's active tab.
function openPanel(tabId) {
  const popup = () => {
    const url = `${chrome.runtime.getURL('panel/sidepanel.html')}?bind=${tabId}`;
    chrome.windows.create({ url, type: 'popup', width: 420, height: 720 }).catch((err) => {
      console.warn('[agentbrowser] popup panel open failed', err);
    });
  };
  try {
    chrome.sidePanel.open({ tabId }).catch((err) => {
      console.warn('[agentbrowser] sidePanel.open failed, opening popup panel', err);
      popup();
    });
  } catch (err) {
    console.warn('[agentbrowser] sidePanel.open threw, opening popup panel', err);
    popup();
  }
}

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
const NOTES_MENU_ID = 'notes-sidebar';
const NOTES_HANDLE_TOGGLE_ID = 'notes-handle-toggle';
const NOTES_HANDLE_KEY = 'notesEdgeHandle'; // chrome.storage.local, default false
const SELECTION_CACHE_MS = 5000;
const TOOLBAR_MENU_PARENT = 'sel-toolbar-slots';
// Selection-toolbar slot toggles (v2.24): each checkbox flips one entry in the
// pluginToolbar map; content side renders only enabled actions — ASK included,
// nothing on the bar is mandatory.
const TOOLBAR_SLOTS = [
  ['core:ask', '问 AI'],
  ['core:translate', '翻译'],
  ['core:copy', '复制'],
  ['core:speak', '朗读'],
  ['core:dict', '词典'],
  ['core:parse', '长难句'],
  ['notes:hl', '🖌 高亮 (notes)'],
  ['notes:annotate', '📝 批注 (notes)'],
  ['notes:color', '🎨 高亮色 (notes)'],
];
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
  chrome.contextMenus.create(
    {
      id: NOTES_MENU_ID,
      title: '笔记侧边栏 AgentBrowser',
      contexts: ['all'],
    },
    () => void chrome.runtime.lastError
  );
  // Edge handle is opt-in (standing rule: nothing persistent on the page
  // unless the user asked for it) — same checkbox pattern as floating-ask.
  chrome.storage.local
    .get({ [NOTES_HANDLE_KEY]: false })
    .then((r) => {
      chrome.contextMenus.create(
        {
          id: NOTES_HANDLE_TOGGLE_ID,
          title: 'Notes edge handle on page',
          contexts: ['all'],
          type: 'checkbox',
          checked: r[NOTES_HANDLE_KEY],
        },
        () => void chrome.runtime.lastError
      );
    })
    .catch((err) => {
      console.warn('[agentbrowser] notes-handle setting read failed', err);
    });
  chrome.contextMenus.create(
    {
      id: TOOLBAR_MENU_PARENT,
      title: '划词条显示',
      contexts: ['all'],
    },
    () => void chrome.runtime.lastError
  );
  chrome.storage.local
    .get({ pluginToolbar: {} })
    .then((r) => {
      const cfg = r.pluginToolbar || {};
      for (const [id, label] of TOOLBAR_SLOTS) {
        chrome.contextMenus.create(
          {
            id: `pt-${id}`,
            parentId: TOOLBAR_MENU_PARENT,
            title: label,
            contexts: ['all'],
            type: 'checkbox',
            checked: cfg[id] !== false,
          },
          () => void chrome.runtime.lastError
        );
      }
    })
    .catch((err) => {
      console.warn('[agentbrowser] pluginToolbar setting read failed', err);
    });
}

// Alt+Shift+N toggles the sidebar too (manifest commands).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-notes-sidebar' || !tab || tab.id == null) return;
  chrome.tabs
    .sendMessage(tab.id, { target: 'notes', cmd: 'toggle' })
    .catch((err) => console.warn('[agentbrowser] notes toggle delivery failed', err));
});

registerContextMenu();
chrome.runtime.onInstalled.addListener(() => {
  // Registrations survive worker restarts; rebuild only on install so a second
  // copy of the item is never created.
  chrome.contextMenus.removeAll(() => registerContextMenu());
});

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

// media "@" ask: stage the media's context as the composer's selection chip
// plus an image attachment — a cropped screenshot of a paused video (or of
// an image that can't be fetched, e.g. a page-local blob: URL), the fetched
// source for ordinary <img>. Both land via chrome.storage.session; the
// panel picks them up.
async function handleVideoAsk(tabId, media, windowId) {
  const isImage = media && media.kind === 'image';
  const transcript = isImage ? null : subtitle.transcriptWindow(tabId, media.currentTime);
  const head = isImage
    ? `[image] ${media.alt || media.title || 'image'}\n` +
      `${media.url || ''}\n` +
      `src ${media.src || ''}` +
      (media.naturalWidth ? `\n${media.naturalWidth}x${media.naturalHeight}px` : '')
    : `[video] ${media.title || 'untitled'}\n` +
      `${media.url || ''}\n` +
      `playhead ${fmtClock(media.currentTime)}` +
      (media.duration ? ` / ${fmtClock(media.duration)}` : '') +
      (media.paused ? ' (paused)' : ' (playing)');
  const selection = {
    text: transcript ? `${head}\n\ntranscript around playhead:\n${transcript}` : head,
    contentType: 'text',
    parentHeading: isImage ? 'image reference' : 'video reference',
    pageUrl: String(media.url || ''),
    pageTitle: String(media.title || ''),
  };

  let img = null;
  if (isImage) {
    try {
      img = await fetchImage(media.src);
    } catch (err) {
      console.warn('[agentbrowser] image fetch failed, falling back to crop', err);
    }
  }
  let shot = null;
  const wantCrop = isImage ? !img : media.paused;
  if (wantCrop && media.rect && media.rect.width > 10) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      shot = await cropShot(dataUrl, media.rect, media.viewport);
    } catch (err) {
      console.warn('[agentbrowser] media frame capture failed', err);
    }
  }

  const cropName = isImage
    ? 'image-crop.png'
    : `video-frame-${fmtClock(media.currentTime).replace(/:/g, '-')}.png`;
  const attachment = img || (shot && {
    base64: shot.base64,
    size: shot.size,
    mimeType: 'image/png',
    name: cropName,
  });

  const writes = [deliverSelection(tabId, selection)];
  if (attachment) {
    writes.push(
      chrome.storage.session
        .set({
          pendingAttachment: {
            tabId,
            attachment,
            timestamp: Date.now(),
          },
        })
        .catch((err) => {
          console.warn('[agentbrowser] pendingAttachment write failed', err);
        })
    );
  }
  const [selOk] = await Promise.all(writes);
  return selOk;
}

const MAX_ASK_IMAGE_BYTES = 8 * 1024 * 1024;

// Fetch an <img>'s source through the extension host permissions — CORS does
// not apply here, so cross-origin images resolve at full fidelity. data: URLs
// decode in place; anything else (blob:, chrome:, file:, failures) returns
// null and the caller falls back to a tab-screenshot crop.
async function fetchImage(src) {
  if (!src || typeof src !== 'string') return null;
  let blob;
  if (src.startsWith('data:')) {
    const res = await fetch(src);
    blob = await res.blob();
  } else {
    if (!/^https?:\/\//.test(src)) return null;
    const res = await fetch(src);
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ASK_IMAGE_BYTES) return null;
    blob = await res.blob();
  }
  if (!blob || blob.size === 0 || blob.size > MAX_ASK_IMAGE_BYTES) return null;
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
  const mimeType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
  const name = imageName(src, mimeType);
  return { base64, size: blob.size, mimeType, name };
}

function imageName(src, mimeType) {
  try {
    if (src.startsWith('data:')) {
      return `image.${mimeType.split('/')[1] || 'png'}`;
    }
    const last = new URL(src).pathname.split('/').pop() || '';
    const clean = last.split(/[?#]/)[0];
    if (clean && clean.length <= 80 && /\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  } catch (err) {
    console.warn('[agentbrowser] image name parse failed', err);
  }
  return `image.${mimeType.split('/')[1] || 'png'}`;
}

// Crop a captureVisibleTab PNG to the video element's rect. The image is in
// device pixels while rect/viewport are CSS px — scale derives from the
// viewport ratio. OffscreenCanvas keeps this worker-side (no DOM).
async function cropShot(dataUrl, rect, viewport) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = viewport && viewport.w > 0 ? bmp.width / viewport.w : 1;
  const sx = Math.max(0, Math.floor(rect.left * scale));
  const sy = Math.max(0, Math.floor(rect.top * scale));
  const sw = Math.min(bmp.width - sx, Math.ceil(rect.width * scale));
  const sh = Math.min(bmp.height - sy, Math.ceil(rect.height * scale));
  if (sw <= 0 || sh <= 0) return null;
  const canvas = new OffscreenCanvas(sw, sh);
  const g = canvas.getContext('2d');
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(out);
  });
  bmp.close();
  return { base64, size: out.size };
}

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
  if (info.menuItemId === NOTES_HANDLE_TOGGLE_ID) {
    chrome.storage.local
      .set({ [NOTES_HANDLE_KEY]: info.checked === true })
      .catch((err) => {
        console.warn('[agentbrowser] notes-handle setting write failed', err);
      });
    return;
  }
  if (String(info.menuItemId || '').startsWith('pt-')) {
    const slot = info.menuItemId.slice(3);
    chrome.storage.local
      .get({ pluginToolbar: {} })
      .then((r) => {
        const cfg = { ...(r.pluginToolbar || {}) };
        cfg[slot] = info.checked === true;
        return chrome.storage.local.set({ pluginToolbar: cfg });
      })
      .catch((err) => {
        console.warn('[agentbrowser] pluginToolbar write failed', err);
      });
    return;
  }
  if (info.menuItemId === NOTES_MENU_ID) {
    if (!tab || tab.id == null) return;
    chrome.tabs
      .sendMessage(tab.id, { target: 'notes', cmd: 'toggle' })
      .catch((err) => console.warn('[agentbrowser] notes toggle delivery failed', err));
    return;
  }
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || tab.id == null) return;
  // Open synchronously: sidePanel.open only works inside the user gesture.
  openPanel(tab.id);
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
// Learn popup chats (chatId 'learn-<tabId>'): 汇总/弹幕热议 generations
// stream back to the page dialog, same pattern as annChats.
// Page-ask chats (v2.25): pg-<tabId>-<n> streams back to the tab's margin
// cards instead of the side panel — same prefix route as ann-/learn-.
const pgChats = new Map(); // chatId -> {tabId}
let pgSeq = 0;

const learnChats = new Map(); // chatId -> { tabId }
let learnChatSeq = 0; // nonce so each generation is a fresh chat, not a turn

// --- tab recording (v2.7) ---------------------------------------------------
// recordings: tabId -> { startedAt, markers: [{t,x,y,kind}] }. Markers are
// pushed by coordinate-bearing tool dispatchers, so a zoom/pan edit track can
// be derived from the agent's own actions without any video analysis.
// The MediaRecorder itself lives in the offscreen document — it never
// suspends, so a recording survives service-worker restarts.
const recordings = new Map();
const recordWaiters = new Map(); // 'started'|'result'|'error' -> {resolve, reject, timer}
const preloadsByTab = new Map(); // tabId -> [{id, preset, chars, ts}]

function mark(tabId, x, y, kind, label, extra) {
  const r = recordings.get(tabId);
  if (!r || !r.startedAt || r.pausedAt) return; // before ack, stopped, or paused
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const m = { t: Date.now() - r.startedAt, x: Math.round(x), y: Math.round(y), kind };
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (extra && typeof extra === 'object') {
    for (const k of ['w', 'h']) {
      if (Number.isFinite(extra[k])) m[k] = Math.round(extra[k]);
    }
    if (typeof extra.key === 'string' && extra.key) m.key = extra.key.slice(0, 24);
    if (typeof extra.text === 'string' && extra.text) m.text = extra.text.slice(0, 60);
  }
  r.markers.push(m);
}

// fallback anchor for tools with no coordinates (nav, key presses). type/key/
// note happen wherever the pointer already is — anchor them to the last
// positional marker so the rendered pointer doesn't dart to screen center.
function markCenter(tabId, kind, label, extra) {
  const r = recordings.get(tabId);
  if (r && (kind === 'type' || kind === 'key' || kind === 'note')) {
    const last = [...r.markers].reverse()
      .find(m => Number.isFinite(m.x) && Number.isFinite(m.y));
    if (last) { mark(tabId, last.x, last.y, kind, label, extra); return; }
  }
  const vw = r && r.viewport ? r.viewport.w / 2 : NaN;
  const vh = r && r.viewport ? r.viewport.h / 2 : NaN;
  mark(tabId, vw, vh, kind, label, extra);
}

function awaitRecorderAck(op, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      recordWaiters.delete(op);
      reject(new Error(`record ${op} timed out`));
    }, timeoutMs);
    recordWaiters.set(op, { resolve, reject, timer });
  });
}

function settleRecorder(op, message) {
  const w = recordWaiters.get(op);
  if (w) {
    clearTimeout(w.timer);
    recordWaiters.delete(op);
    w.resolve(message);
    return;
  }
  // An error ack matches whichever op is in flight.
  if (op === 'error') {
    const [first] = recordWaiters.values();
    if (first) {
      const [key, pending] = recordWaiters.entries().next().value;
      clearTimeout(pending.timer);
      recordWaiters.delete(key);
      pending.reject(new Error(message.message || 'recording failed'));
      return;
    }
  }
  console.warn('[agentbrowser] unexpected record ack', op);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [chatId, ann] of annChats) {
    if (ann.tabId === tabId) annChats.delete(chatId);
  }
  for (const [chatId, learn] of learnChats) {
    if (learn.tabId === tabId) learnChats.delete(chatId);
  }
  for (const [chatId, pg] of pgChats) {
    if (pg.tabId === tabId) pgChats.delete(chatId);
  }
  recordings.delete(tabId);
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

// The native host (installed via server/native/install.mjs) starts the hub
// on demand, so the browser doesn't need a manually launched hub. Absent
// host → a warn and the usual "hub not connected" state; nothing breaks.
let nativeEnsureAt = 0;
function ensureHubViaNative() {
  if (Date.now() - nativeEnsureAt < 60_000) return;
  nativeEnsureAt = Date.now();
  chrome.runtime
    .sendNativeMessage('com.agentbrowser.hub', { type: 'ensure' })
    .then((res) => {
      // Hub came up just now (this keeper spawned it or a sibling did) —
      // retry the ws connect once it settles.
      if (res && res.ok && !res.already) {
        setTimeout(() => {
          connectHub().catch((err) => {
            console.warn('[agentbrowser] hub reconnect after autostart failed', err);
          });
        }, 1500);
      }
    })
    .catch((err) => {
      console.warn('[agentbrowser] native hub keeper unavailable', err);
    });
}

async function connectHub() {
  ensureHubViaNative();
  await ensureOffscreen();
  const { hubUrl } = await chrome.storage.local.get('hubUrl');
  hubHttpBase = String(hubUrl || DEFAULT_HUB_URL)
    .replace(/^ws(s?):\/\//, 'http$1://')
    .replace(/\/+$/, '');
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
  // Direct-mode toggle: flip the reported status + capabilities live.
  if (area === 'local' && changes.abDirect) {
    direct.config().then((cfg) => {
      const on = direct.isEnabled(cfg);
      postToPanel({ type: 'status', connected: hubConnected || on });
      if (on) postToPanel(direct.capabilitiesFor(cfg));
    });
  }
});

// --- hub <-> panel routing --------------------------------------------------

// Wires the translate coordinator once sendToOffscreen/postToPanel exist.
translate.wireHub({
  sendToHub: (payload) => sendToOffscreen({ target: 'offscreen', cmd: 'send', payload }),
  postToPanel: (message) => postToPanel(message),
});
subtitle.wireHub({
  sendToHub: (payload) => sendToOffscreen({ target: 'offscreen', cmd: 'send', payload }),
});

// Selection toolbar's 翻译 item: a one-shot translate_request whose result
// goes back to the content script's sendMessage response, not into the page
// engine. Map reqId -> settle(sendResponse); ids are "ts-<tab>-<n>".
const translateAsks = new Map();
let translateAskSeq = 0;

// Learn popup's bilingual cue list: same translate_request path but many
// items (chunked per content-script call); ids are "lc-<tab>-<n>" and the
// whole results map goes back, not just results['0'].
const learnTrAsks = new Map();
let learnTrAskSeq = 0;

// Selection popup's 词典/长难句: one-shot analyze_request (ids "an-"), same
// settle-map pattern as translate_ask.
const analyzeAsks = new Map();
let analyzeAskSeq = 0;

// Media menu 下载视频: reqId -> tabId so the hub's media_download_result
// can be pushed back to the tab that asked (minutes-long; no response held).
const mediaDlTabs = new Map();

// Notes plugin (v2.23): note_op calls from the page sidebar are relayed to
// the hub over the offscreen socket; results go back to the asking tab via
// chrome.tabs.sendMessage (target 'notes'), not the message response, so
// nothing is held open across the network hop.
const noteOpTabs = new Map(); // reqId -> {tabId, timer}

function pluginEnabled(id) {
  const ps = (lastCapabilities && lastCapabilities.plugins) || [];
  const p = ps.find((pl) => pl && pl.id === id);
  return !!(p && p.enabled);
}

function notesPluginEnabled() {
  return pluginEnabled('notes');
}

// plugin_state/notes_state with cold capabilities (v2.25): after an MV3
// restart lastCapabilities is null and the offscreen's hello guard means
// no fresh broadcast is coming — a false 'disabled' answer here disables
// the plugin for the page's whole lifetime. Fetch plugins_list from the
// hub once and answer every waiter when it lands; timeout answers false.
const pluginStateWaits = []; // {id, respond}
let pluginStateTimer = null;

function pluginStateResponse(id, sendResponse) {
  if (lastCapabilities) {
    sendResponse({ enabled: pluginEnabled(id) });
    return;
  }
  // Queue even before hubConnected: a page loading while the SW sleeps
  // makes this query the wake trigger — answering false here disables the
  // plugin for that page's lifetime. Wait for the re-report, then fetch.
  pluginStateWaits.push({ id, respond: sendResponse });
  if (pluginStateTimer) return; // one fetch covers the whole queue
  pluginStateTimer = setTimeout(() => {
    pluginStateTimer = null;
    const waits = pluginStateWaits.splice(0);
    for (const w of waits) w.respond({ enabled: false });
  }, 6000);
  waitForHubConnected().then((ok) => {
    if (!ok) return; // the wait timer flushes waiters to false
    sendToOffscreen({
      target: 'offscreen',
      cmd: 'send',
      payload: { type: 'plugins_list' },
    });
  });
}

function handlePluginsList(payload) {
  const list = Array.isArray(payload.plugins) ? payload.plugins : [];
  // Merge into the capabilities view so later queries answer immediately.
  lastCapabilities = { ...(lastCapabilities || {}), plugins: list };
  if (pluginStateTimer) {
    clearTimeout(pluginStateTimer);
    pluginStateTimer = null;
  }
  const waits = pluginStateWaits.splice(0);
  for (const w of waits) w.respond({ enabled: pluginEnabled(w.id) });
}

function handleNoteOpMessage(tabId, message) {
  const reqId = String(message.reqId || '');
  if (!reqId || tabId == null) return;
  const timer = setTimeout(() => {
    if (noteOpTabs.delete(reqId)) {
      chrome.tabs
        .sendMessage(tabId, {
          target: 'notes',
          cmd: 'op_result',
          reqId,
          ok: false,
          error: 'note_op timeout',
        })
        .catch((err) => console.warn('[agentbrowser] note_op timeout delivery failed', err));
    }
  }, 30000);
  noteOpTabs.set(reqId, { tabId, timer });
  const payload = { type: 'note_op', reqId, op: message.op };
  for (const k of [
    'id', 'q', 'tag', 'domain', 'url', 'limit', 'title', 'content', 'text',
    'tags', 'name', 'data', 'prefix', 'suffix', 'anchor', 'color', 'markId', 'scope',
  ]) {
    if (message[k] !== undefined) payload[k] = message[k];
  }
  sendToOffscreen({ target: 'offscreen', cmd: 'send', payload });
}

function handleTranslateAsk(tabId, text, sendResponse) {
  const reqId = `ts-${tabId}-${++translateAskSeq}`;
  const timer = setTimeout(() => {
    if (translateAsks.delete(reqId)) {
      sendResponse({ success: false, error: 'translate timeout' });
    }
  }, 20000);
  translateAsks.set(reqId, (res) => {
    clearTimeout(timer);
    sendResponse(res);
  });
  sendToOffscreen({
    target: 'offscreen',
    cmd: 'send',
    payload: {
      type: 'translate_request',
      id: reqId,
      tabId,
      items: [{ tid: '0', text: String(text).slice(0, 4000) }],
    },
  });
}

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
    openPanel(tabId);
    deliverSelection(tabId, message.selection).then(
      (ok) => sendResponse({ success: ok }),
      () => sendResponse({ success: false })
    );
    return true;
  }
  if (message.cmd === 'selection_auto') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.selection) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    // Auto-captured selections land in the same pendingSelection slot the
    // panel already watches, but without opening it and without the Ask
    // click: selecting text is enough to append it to the chat context.
    // The slot is single — the latest selection wins.
    deliverSelection(tabId, message.selection).then(
      (ok) => sendResponse({ success: ok }),
      () => sendResponse({ success: false })
    );
    return true;
  }
  if (message.cmd === 'note_op') {
    handleNoteOpMessage(sender && sender.tab && sender.tab.id, message);
    sendResponse({ success: true });
    return true;
  }
  if (message.cmd === 'notes_state') {
    pluginStateResponse('notes', sendResponse);
    return true;
  }
  if (message.cmd === 'plugin_state') {
    // Generic per-plugin gate (v2.25): any content plugin resolves its
    // hub-side enabled flag the same way notes does.
    pluginStateResponse(String(message.id || ''), sendResponse);
    return true;
  }
  if (message.cmd === 'analyze_ask') {
    const tabId = sender && sender.tab && sender.tab.id;
    const mode = message.mode === 'dict' || message.mode === 'parse' ? message.mode : null;
    if (tabId == null || !mode || !message.text) {
      sendResponse({ success: false, error: 'bad analyze_ask' });
      return true;
    }
    waitForHubConnected().then((ok) => {
      if (!ok) {
        sendResponse({ success: false, error: 'hub not connected' });
        return;
      }
      const reqId = `an-${tabId}-${++analyzeAskSeq}`;
      const timer = setTimeout(() => {
        if (analyzeAsks.delete(reqId)) {
          sendResponse({ success: false, error: 'analyze timeout' });
        }
      }, 30000);
      analyzeAsks.set(reqId, (res) => {
        clearTimeout(timer);
        sendResponse(res);
      });
      sendToOffscreen({
        target: 'offscreen',
        cmd: 'send',
        payload: {
          type: 'analyze_request',
          id: reqId,
          tabId,
          mode,
          text: String(message.text).slice(0, 4000),
        },
      });
    });
    return true;
  }
  if (message.cmd === 'selection_clear') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    // Only collapse chips that staged a live page selection — media "@" asks
    // (video/image reference) and context-menu element contexts stay put,
    // they are not tied to the text selection that just collapsed.
    chrome.storage.session
      .get('pendingSelection')
      .then((data) => {
        const rec = data && data.pendingSelection;
        if (
          rec &&
          rec.tabId === tabId &&
          rec.selection &&
          rec.selection.isSelection === true
        ) {
          return chrome.storage.session.remove('pendingSelection');
        }
      })
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.warn('[agentbrowser] pendingSelection clear failed', err);
        sendResponse({ success: false });
      });
    return true;
  }
  if (message.cmd === 'translate_ask') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.text) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    waitForHubConnected().then((ok) => {
      if (!ok) {
        sendResponse({ success: false, error: 'hub not connected' });
        return;
      }
      handleTranslateAsk(tabId, message.text, sendResponse);
    });
    return true;
  }
  if (message.cmd === 'video_ask') {
    const tabId = sender && sender.tab && sender.tab.id;
    const video = message.video;
    if (tabId == null || !video) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    openPanel(tabId);
    handleVideoAsk(tabId, video, sender.tab.windowId).then(
      (ok) => sendResponse({ success: ok }),
      () => sendResponse({ success: false })
    );
    return true;
  }
  if (message.cmd === 'video_download') {
    // Media menu's 下载视频: fire-and-forget to the hub (yt-dlp), the result
    // returns later as a 'media_download_result' hub message — downloads can
    // take minutes, so we do not hold sendResponse.
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.url || !/^https?:\/\//.test(message.url)) {
      sendResponse({ success: false, error: 'no tab/url' });
      return true;
    }
    waitForHubConnected().then((ok) => {
      if (!ok) {
        sendResponse({ success: false, error: 'hub not connected' });
        return;
      }
      const id = String(message.id || `dl-${tabId}-${Date.now()}`);
      const timer = setTimeout(() => {
        if (mediaDlTabs.delete(id)) {
          chrome.tabs
            .sendMessage(tabId, {
              target: 'video-ask',
              cmd: 'download_result',
              ok: false,
              error: 'download timed out',
            })
            .catch((err) => console.warn('[agentbrowser] download timeout notify failed', err));
        }
      }, 11 * 60 * 1000); // just past the hub's 10min yt-dlp cap
      mediaDlTabs.set(id, { tabId, timer });
      sendToOffscreen({
        target: 'offscreen',
        cmd: 'send',
        payload: { type: 'media_download', id, url: String(message.url) },
      });
      sendResponse({ success: true, started: true });
    });
    return true;
  }
  if (message.cmd === 'subtitle_fetch') {
    // Media menu's 获取字幕/弹幕: probe + fetch + build the file body, then
    // hand it to chrome.downloads — quick enough to hold sendResponse.
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    subtitle
      .fetchDownload(tabId, String(message.kind || 'subs'))
      .then(async (r) => {
        // octet-stream keeps the intended .srt/.xml extension — a text/plain
        // data URL makes Chrome rewrite the download to .txt.
        const url = 'data:application/octet-stream;charset=utf-8,' + encodeURIComponent(r.text);
        await chrome.downloads.download({
          url,
          filename: r.filename,
          saveAs: false,
        });
        sendResponse({ success: true, name: r.filename });
      })
      .catch((err) =>
        sendResponse({
          success: false,
          error: String((err && err.message) || err),
        })
      );
    return true;
  }
  if (message.cmd === 'learn_ask') {
    // Learn popup: 'cues' returns the track for the 字幕 tab; 'summary' and
    // 'danmaku' gather the transcript/danmaku here and start a hub chat
    // whose streamed reply lands back in the popup via learn_event.
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ success: false, error: 'no tab' });
      return true;
    }
    const kind = String(message.kind || 'cues');
    if (kind === 'cues') {
      subtitle.fetchSubs(tabId).then(
        (r) =>
          sendResponse({ success: true, site: r.site, track: r.track, cues: r.cues }),
        (err) =>
          sendResponse({ success: false, error: String((err && err.message) || err) })
      );
      return true;
    }
    if (kind === 'cues_translate') {
      // Bilingual cue rows: relay the content script's text chunk to the
      // hub translate service; results map tid -> translated text.
      const items = Array.isArray(message.items) ? message.items.slice(0, 64) : [];
      if (!items.length) {
        sendResponse({ success: false, error: 'no items' });
        return true;
      }
      if (!hubConnected) {
        sendResponse({ success: false, error: 'hub not connected' });
        return true;
      }
      const reqId = `lc-${tabId}-${++learnTrAskSeq}`;
      const timer = setTimeout(() => {
        if (learnTrAsks.delete(reqId)) {
          sendResponse({ success: false, error: 'translate timeout' });
        }
      }, 30000);
      learnTrAsks.set(reqId, (res) => {
        clearTimeout(timer);
        sendResponse(res);
      });
      sendToOffscreen({
        target: 'offscreen',
        cmd: 'send',
        payload: {
          type: 'translate_request',
          id: reqId,
          tabId,
          items: items.map((t, i) => ({ tid: String(i), text: String(t).slice(0, 2000) })),
        },
      });
      return true;
    }
    if (!hubConnected) {
      sendResponse({ success: false, error: 'hub not connected' });
      return true;
    }
    const title = String(message.title || (sender.tab && sender.tab.title) || 'this video');
    const gather =
      kind === 'danmaku'
        ? subtitle.fetchDanmaku(tabId).then((r) => {
            const step = Math.max(1, Math.floor(r.entries.length / 350));
            const lines = r.entries
              .filter((_, i) => i % step === 0)
              .map((e) => `${Math.round(e.t)}s: ${e.text}`)
              .join('\n');
            return (
              `你是弹幕舆情助手。这是视频「${title}」的弹幕（时间:内容，等距抽样 ${r.entries.length} 条）。` +
              '用中文回答：观众在激烈讨论什么？归纳 3-5 个热议话题、各自观点倾向和出现的大致时间段。\n\n' +
              lines
            );
          })
        : subtitle.transcriptExcerpt(tabId).then((r) =>
            `你是视频学习助手。这是视频「${title}」的字幕转写（时间线对齐节选）。` +
            '用中文汇总：1) 主题概述 2) 分节要点 3) 三个值得记住的结论。\n\n' +
            r.text
          );
    gather
      .then((prompt) => {
        const chatId = `learn-${tabId}-${++learnChatSeq}`;
        learnChats.set(chatId, { tabId });
        dispatchChat({
          type: 'chat',
          chatId,
          text: prompt,
          adapter: lastPanelAdapter || undefined,
          context: {
            currentTab: {
              tabId,
              url: (sender.tab && sender.tab.url) || '',
              title,
            },
          },
        });
        sendResponse({ success: true, started: true });
      })
      .catch((err) =>
        sendResponse({ success: false, error: String((err && err.message) || err) })
      );
    return true;
  }
  if (message.cmd === 'page_ask') {
    // In-page ask (v2.25): the margin host (or any page plugin) starts a
    // chat whose events stream back to the tab as {target:'page-ask'}
    // instead of opening the side panel.
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null || !message.text) {
      sendResponse({ success: false, error: 'missing tabId/text' });
      return true;
    }
    // Follow-up turns reuse the same pg- chatId so the card's thread
    // continues in the hub; only fresh asks mint a new id.
    let chatId = String(message.chatId || "");
    if (!/^pg-\d+-\d+$/.test(chatId) || (pgChats.get(chatId) || {}).tabId !== tabId) {
      chatId = `pg-${tabId}-${++pgSeq}`;
      pgChats.set(chatId, { tabId });
    }
    dispatchChat({
      type: 'chat',
      chatId,
      text: String(message.text),
      adapter: message.adapter || lastPanelAdapter || undefined,
      context: {
        currentTab: {
          tabId,
          url: (sender.tab && sender.tab.url) || '',
          title: (sender.tab && sender.tab.title) || '',
        },
        selection: message.selection || undefined,
      },
    });
    sendResponse({ success: true, chatId });
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
    dispatchChat({
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
    });
    sendResponse({ success: true });
    return true;
  }
  if (message.cmd === 'ws_status') {
    hubConnected = !!message.connected;
    if (hubConnected) {
      for (const done of hubConnectWaiters) done();
      hubConnectWaiters.clear();
      browserIdentity().then((browser) => {
        sendToOffscreen({
          target: 'offscreen',
          cmd: 'send',
          payload: { type: 'hello', role: 'extension', version: '1.0.0', browser },
        });
      });
    }
    // A hub socket flap must not drop a direct-mode panel to "未连接".
    direct.enabled().then((on) => {
      postToPanel({ type: 'status', connected: hubConnected || on });
    });
  } else if (message.cmd === 'ws_message') {
    handleHubMessage(message.payload);
  } else if (
    message.cmd === 'record_started' ||
    message.cmd === 'record_result' ||
    message.cmd === 'record_error'
  ) {
    settleRecorder(message.cmd.replace('record_', ''), message);
  }
});

function handleHubMessage(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'tool_call') {
    handleToolCall(payload);
  } else if (payload.type === 'chat_event') {
    emitChatEvent(payload.chatId, payload.event, payload.browser);
  } else if (payload.type === 'plugins') {
    handlePluginsList(payload);
  } else if (payload.type === 'capabilities') {
    // Relayed verbatim — except in direct mode, where the panel keeps the
    // synthetic adapter its chats actually run through.
    lastCapabilities = payload;
    direct.enabled().then((on) => {
      if (!on) postToPanel(payload);
    });
  } else if (payload.type === 'superseded') {
    // Another extension holds this browser's id — the hub kept it and cut us.
    postToPanel({ type: 'superseded', reason: payload.reason });
  } else if (payload.type === 'chat_list' || payload.type === 'chat_resumed') {
    postToPanel(payload);
  } else if (payload.type === 'translate_result') {
    const id = String(payload.id || '');
    if (id.startsWith('ts-')) {
      const settle = translateAsks.get(id);
      translateAsks.delete(id);
      if (settle) {
        if (payload.error) {
          settle({ success: false, error: String(payload.error) });
        } else {
          const results = payload.results || {};
          const text = results['0'] || Object.values(results)[0] || '';
          // An empty or sentinel result is a failure for a one-shot ask —
          // report it instead of settling success with no text to show.
          if (text === '{{NO_TRANSLATION_NEEDED}}') {
            settle({ success: false, error: 'text is already in the target language' });
          } else if (!text) {
            settle({ success: false, error: 'provider returned nothing' });
          } else {
            settle({ success: true, text });
          }
        }
      }
    } else if (id.startsWith('lc-')) {
      const settle = learnTrAsks.get(id);
      learnTrAsks.delete(id);
      if (settle) {
        if (payload.error) {
          settle({ success: false, error: String(payload.error) });
        } else {
          settle({ success: true, results: payload.results || {} });
        }
      }
    } else if (!subtitle.onResult(payload)) {
      translate.onResult(payload);
    }
  } else if (payload.type === 'note_op_result') {
    const rec = noteOpTabs.get(String(payload.reqId || ''));
    noteOpTabs.delete(String(payload.reqId || ''));
    if (rec) {
      clearTimeout(rec.timer);
      chrome.tabs
        .sendMessage(rec.tabId, {
          target: 'notes',
          cmd: 'op_result',
          reqId: payload.reqId,
          ok: payload.ok === true,
          result: payload.result,
          error: payload.error,
        })
        .catch((err) => console.warn('[agentbrowser] note_op_result delivery failed', err));
    }
  } else if (payload.type === 'analyze_result') {
    const settle = analyzeAsks.get(String(payload.id || ''));
    analyzeAsks.delete(String(payload.id || ''));
    if (settle) {
      if (payload.error) {
        settle({ success: false, error: String(payload.error) });
      } else {
        settle({ success: true, text: payload.text, segments: payload.segments });
      }
    }
  } else if (payload.type === 'media_download_result') {
    const rec = mediaDlTabs.get(String(payload.id || ''));
    mediaDlTabs.delete(String(payload.id || ''));
    if (rec) {
      clearTimeout(rec.timer);
      const notify = (ok, extra) =>
        chrome.tabs
          .sendMessage(rec.tabId, { target: 'video-ask', cmd: 'download_result', ok, ...extra })
          .catch((err) => console.warn('[agentbrowser] download_result delivery failed', err));
      if (payload.ok && payload.dl) {
        // Hand the hub-served file to the browser's own download manager so
        // it lands in Downloads and shows in the download history.
        const name = String(payload.file || '').split(/[\\/]/).pop() || 'video';
        chrome.downloads
          .download({ url: hubHttpBase + payload.dl, filename: name, saveAs: false })
          .then(() => notify(true, { file: name }))
          .catch((err) =>
            notify(false, {
              error: `browser download failed: ${(err && err.message) || err}`,
            })
          );
      } else {
        notify(!!payload.ok, { file: payload.file, error: payload.error });
      }
    }
  } else if (payload.type === 'summary_result') {
    subtitle.onSummary(payload);
  } else if (payload.type === 'translate_config') {
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
  direct.enabled().then((directOn) => {
    if (directOn) {
      // Hubless mode: report connected and hand the panel the synthetic
      // adapter instead of touching the hub at all.
      port.postMessage({ type: 'status', connected: true });
      direct.config().then((cfg) => port.postMessage(direct.capabilitiesFor(cfg)));
      return;
    }
    port.postMessage({ type: 'status', connected: hubConnected });
    if (lastCapabilities) port.postMessage(lastCapabilities);
    connectHub().catch((err) => {
      console.warn('[agentbrowser] hub connect on panel open failed', err);
    });
  });
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    // Binds chat/command/chat_resume chatIds to this window for reply routing.
    panelRouter.noteInbound(windowId, msg);
    if (msg.type === 'chat') {
      // Annotation comments default to whatever backend the panel is using.
      if (typeof msg.adapter === 'string' && msg.adapter) {
        lastPanelAdapter = msg.adapter;
      }
      // Verbatim, every field: picking fields out would drop model, context
      // and attachments. Direct mode runs the turn in this worker instead.
      dispatchChat(msg);
    } else if (msg.type === 'command') {
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    } else if (msg.type === 'chat_abort') {
      direct.enabled().then((on) => {
        if (on) direct.abort(msg.chatId);
        else sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
      });
    } else if (msg.type === 'get_capabilities') {
      direct.config().then((cfg) => {
        if (direct.isEnabled(cfg)) postToPanel(direct.capabilitiesFor(cfg));
        else sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
      });
    } else if (msg.type === 'chat_list') {
      direct.enabled().then((on) => {
        if (on) postToPanel({ type: 'chat_list', chats: [] });
        else sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
      });
    } else if (msg.type === 'chat_resume') {
      // Direct mode keeps no transcripts — resume always reports not-found
      // so the panel falls back to a fresh chat.
      direct.enabled().then((on) => {
        if (on) postToPanel({ type: 'chat_resumed', chatId: msg.chatId, found: false });
        else sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
      });
    } else if (
      msg.type === 'set_key' ||
      msg.type === 'set_proactive_config' ||
      msg.type === 'set_translate_config' ||
      msg.type === 'get_translate_config'
    ) {
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload: msg });
    } else if (msg.type === 'ui_translate') {
      (async () => {
        try {
          const tabId = await resolveTabId(null);
          if (msg.action === 'stop') {
            await translate.stop(tabId);
          } else if (msg.action === 'status') {
            postToPanel({ type: 'translate_progress', tabId, ...(await translate.status(tabId)) });
            return;
          } else {
            if (msg.cfg && typeof msg.cfg === 'object') {
              chrome.storage.local
                .set({ abTranslate: msg.cfg })
                .catch((err) => console.warn('[agentbrowser] translate prefs save failed', err));
            }
            await translate.start(tabId, msg.cfg || {});
          }
        } catch (err) {
          console.warn('[agentbrowser] ui_translate failed', err);
          postToPanel({
            type: 'translate_progress',
            error: String((err && err.message) || err),
          });
        }
      })();
    }
  });
  port.onDisconnect.addListener(() => {
    panelRouter.disconnect(windowId, port);
  });
});

// --- tool executor ----------------------------------------------------------

async function resolveTabId(tabId) {
  if (tabId != null) {
    // Callers (CLI, MCP) frequently send the id as a string; chrome.debugger
    // and chrome.tabs require a real integer.
    const n = Number(tabId);
    if (!Number.isInteger(n)) throw new Error(`invalid tabId: ${tabId}`);
    return n;
  }
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
    await chrome.tabs.remove(Number(args.tabId));
    return { closed: true };
  },

  async navigate(args) {
    const tabId = await resolveTabId(args.tabId);
    // nav marker: the renderer cross-fades here — the recorded content cuts
    // hard to the new page, so a dip keeps it from reading as a glitch.
    markCenter(tabId, 'nav', args.label);
    const loaded = waitForLoad(tabId, 20000);
    await chrome.tabs.update(tabId, { url: args.url });
    await loaded;
    // settleMs: SPA navigations fire `load` long before XHRs quiet down. When
    // the caller asks, also wait for readyState=complete and settleMs of
    // network silence (15s hard cap inside waitForSettle).
    const settleMs = Number(args.settleMs) || 0;
    const settle = settleMs > 0 ? await inspect.waitForSettle(tabId, settleMs) : null;
    if (settle && !settle.settled) {
      console.warn('[agentbrowser] navigate settle wait timed out', { tabId, settleMs });
    }
    // After the load: navigation wipes anything injected before it. navigate is
    // the one tool that does not go through CDP, so it is the one place the
    // overlay has to be fired by hand. showOverlay never rejects and is bounded
    // at 250ms, so it is safe to leave unawaited here.
    cdp.showOverlay(tabId, 'navigate');
    const tab = await chrome.tabs.get(tabId);
    const out = { url: tab.url, title: tab.title };
    if (settle) out.settled = settle.settled;
    return out;
  },

  async read_page(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.readPage(tabId, args.maxChars);
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.screenshot(tabId, args);
  },

  async click(args) {
    const tabId = await resolveTabId(args.tabId);
    mark(tabId, Number(args.x), Number(args.y), 'click', args.label);
    return cdp.click(tabId, args.x, args.y, args);
  },

  async click_element(args) {
    const tabId = await resolveTabId(args.tabId);
    // nodeId comes from page_snapshot's data-ab-node stamp; keep it to a safe
    // charset since it lands inside a selector.
    let selector = args.selector;
    if (args.nodeId != null) {
      const n = String(args.nodeId);
      if (!/^[0-9A-Za-z_-]+$/.test(n)) throw new Error('invalid nodeId');
      selector = `[data-ab-node="${n}"]`;
    }
    if (args.frame) {
      return inspect.frameClickElement(tabId, { ...args, selector });
    }
    const res = await cdp.clickElement(tabId, selector, args.dx || 0, args.dy || 0, args);
    if (res && Number.isFinite(res.x)) mark(tabId, res.x, res.y, 'click', args.label, res);
    return res;
  },

  async element_check(args) {
    const tabId = await resolveTabId(args.tabId);
    if (!args.selector) throw new Error('element_check needs selector');
    return inspect.elementCheck(tabId, args);
  },

  async page_snapshot(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.pageSnapshot(tabId, args);
  },


  async hover(args) {
    const tabId = await resolveTabId(args.tabId);
    if (args.selector) {
      const res = await cdp.hoverElement(tabId, String(args.selector), args);
      if (res && Number.isFinite(res.x)) mark(tabId, res.x, res.y, 'hover', args.label, res);
      return res;
    }
    mark(tabId, Number(args.x), Number(args.y), 'hover', args.label);
    return cdp.hover(tabId, Number(args.x), Number(args.y));
  },

  async scroll(args) {
    const tabId = await resolveTabId(args.tabId);
    // Mark the gesture anchor at dispatch time: explicit x/y, else the
    // recording's viewport center (what cdp.scroll resolves to anyway).
    const r = recordings.get(tabId);
    const mx = Number.isFinite(Number(args.x)) ? Number(args.x) : r && r.viewport ? r.viewport.w / 2 : NaN;
    const my = Number.isFinite(Number(args.y)) ? Number(args.y) : r && r.viewport ? r.viewport.h / 2 : NaN;
    mark(tabId, mx, my, 'scroll', args.label);
    return cdp.scroll(tabId, args);
  },

  async drag(args) {
    const tabId = await resolveTabId(args.tabId);
    const from = args.from || {};
    mark(tabId, Number(from.x), Number(from.y), 'drag', args.label);
    const res = await cdp.drag(tabId, args);
    if (res && res.to) mark(tabId, res.to.x, res.to.y, 'dragend');
    return res;
  },

  async select_text(args) {
    const tabId = await resolveTabId(args.tabId);
    // coords mode is a physical click-drag — mark both ends so the render
    // draws the sweep; selector mode marks the element's center afterward.
    if (args.from) mark(tabId, Number(args.from.x), Number(args.from.y), 'drag', args.label);
    const res = await cdp.selectText(tabId, args);
    if (args.to && Number.isFinite(Number(args.to.x))) {
      mark(tabId, Number(args.to.x), Number(args.to.y), 'dragend');
    } else if (res && Number.isFinite(res.x)) {
      mark(tabId, res.x, res.y, 'select', args.label, res);
    }
    return res;
  },

  async type_text(args) {
    const tabId = await resolveTabId(args.tabId);
    if (args.frame) {
      // Focus via a frame-aware click first (selector required), then the
      // root session's insertText lands in whichever frame holds focus.
      await inspect.frameClickElement(tabId, args);
      const text = String(args.text ?? '');
      await cdp.sendCommand(tabId, 'Input.insertText', { text });
      return { typed: text.length };
    }
    const res = await cdp.typeText(tabId, args.text, args.selector, args);
    // kind 'type': a selector focus is a real click AND drives the key HUD.
    // No selector = typing into whatever has focus — still show the HUD at
    // the viewport center (the pointer stays where the last marker put it).
    if (res && Number.isFinite(res.x)) {
      mark(tabId, res.x, res.y, 'type', args.label, { ...res, text: args.text });
    } else {
      markCenter(tabId, 'type', args.label, { text: args.text });
    }
    return res;
  },


  async press_key(args) {
    const tabId = await resolveTabId(args.tabId);
    markCenter(tabId, 'key', args.label, { key: args.key });
    return cdp.pressKey(tabId, args.key);
  },

  async eval_js(args) {
    const tabId = await resolveTabId(args.tabId);
    if (args.frame) return inspect.frameEval(tabId, args);
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
    if (args.frame) return inspect.frameDomInspect(tabId, args);
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

  // --- debugger tools (v2.6): breakpoints + paused-state inspection.

  async breakpoint_set(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.breakpointSet(tabId, args);
  },

  async breakpoint_list(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.breakpointList(tabId);
  },

  async breakpoint_remove(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.breakpointRemove(tabId, args);
  },

  async debug_wait(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.debugWait(tabId, args);
  },

  async debug_eval(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.debugEval(tabId, args);
  },

  async debug_resume(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.debugResume(tabId, args);
  },


  // --- files, downloads, print (v2.6)

  async set_file_input(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.setFileInput(tabId, args);
  },

  async download_configure(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.downloadConfigure(tabId, args);
  },

  async downloads_list(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.downloadsList(tabId);
  },

  async print_pdf(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.printPdf(tabId, args);
  },

  // --- OOPIF frame tools (v2.6)

  async frames_list(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.framesList(tabId);
  },

  async frame_eval(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.frameEval(tabId, args);
  },

  async frame_dom_inspect(args) {
    const tabId = await resolveTabId(args.tabId);
    return inspect.frameDomInspect(tabId, args);
  },

  async frame_click_element(args) {
    const tabId = await resolveTabId(args.tabId);
    const res = await inspect.frameClickElement(tabId, args);
    if (res && Number.isFinite(res.x)) mark(tabId, res.x, res.y, 'click', args.label);
    return res;
  },

  async record_start(args) {
    const tabId = await resolveTabId(args.tabId);
    if (recordings.get(tabId)?.startedAt) throw new Error('this tab is already recording');
    const audio = args.audio === true;
    const bitrate = Math.max(1_000_000, Math.min(Number(args.bitrate) || 8_000_000, 20_000_000));
    let streamId;
    try {
      // Resolves to the stream id string, not an object.
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      // tabCapture ignores host_permissions — the tab must be "invoked"
      // (action-icon click, context menu, or command) since last navigation.
      throw new Error(
        `tabCapture needs an invocation on this tab: click the AgentBrowser icon (or its context-menu item) once, then retry. (${err.message || err})`
      );
    }
    if (!streamId) throw new Error('tabCapture returned no streamId');
    // Markers are recorded in CSS px; the captured video is in device px, so
    // the viewer needs the visual viewport size to map between them.
    // window.innerWidth includes the scrollbar, which is part of the captured
    // image — clientWidth would be ~15px short and skew the mapping.
    let viewport = null;
    try {
      const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
        expression: '({ w: window.innerWidth, h: window.innerHeight })',
        returnByValue: true,
      });
      const v = res.result && res.result.value;
      if (v && v.w && v.h) viewport = { w: Math.round(v.w), h: Math.round(v.h) };
    } catch (err) {
      console.warn('[agentbrowser] record_start viewport probe failed', err);
    }
    if (!viewport) {
      try {
        const metrics = await cdp.sendCommand(tabId, 'Page.getLayoutMetrics');
        const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
        const w = vp && (vp.clientWidth || vp.width), h = vp && (vp.clientHeight || vp.height);
        if (w && h) viewport = { w: Math.round(w), h: Math.round(h) };
      } catch (err) {
        console.warn('[agentbrowser] record_start metrics fallback failed', err);
      }
    }
    recordings.set(tabId, { startedAt: 0, markers: [], viewport, pausedAt: 0, pauses: [] });
    // Hide the overlay chrome (border/pill/ripples) for the capture — it is
    // page content and would otherwise be recorded. The rec cursor stays.
    cdp.sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'window.__agentchatRecQuiet = true; var n = document.getElementById("agentchat-overlay-root"); if (n && n.parentNode) n.parentNode.removeChild(n); true;',
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    }).catch((err) => console.warn('[agentbrowser] record overlay-mute failed', err));
    const ack = awaitRecorderAck('started');
    await sendToOffscreen({ target: 'offscreen', cmd: 'record_start', streamId, audio, bitrate });
    let res;
    try {
      res = await ack;
    } catch (err) {
      recordings.delete(tabId);
      throw err;
    }
    recordings.get(tabId).startedAt = res.startedAt || Date.now();
    return { recording: true, tabId, startedAt: recordings.get(tabId).startedAt };
  },

  async record_stop(args) {
    const tabId = await resolveTabId(args.tabId);
    const rec = recordings.get(tabId);
    if (!rec) throw new Error('no recording on this tab');
    const stamp = new Date(rec.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `agentbrowser/record-${stamp}-tab${tabId}.webm`;
    const trackJson = JSON.stringify({ tabId, startedAt: rec.startedAt, stoppedAt: Date.now(), viewport: rec.viewport || null, pauses: rec.pauses, markers: rec.markers });
    const ack = awaitRecorderAck('result');
    await sendToOffscreen({ target: 'offscreen', cmd: 'record_stop', filename, trackJson });
    const res = await ack;
    // blob: URL minted in the offscreen doc; chrome.downloads lives here
    // (same extension origin) — offscreen documents don't get that API.
    await chrome.downloads.download({
      url: res.blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await chrome.downloads.download({
      url: `data:application/json,${encodeURIComponent(trackJson)}`,
      filename: filename.replace(/\.webm$/, '.track.json'),
      saveAs: false,
      conflictAction: 'uniquify',
    });
    recordings.delete(tabId);
    cdp.sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'window.__agentchatRecQuiet = false; true;',
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    }).catch((err) => console.warn('[agentbrowser] record overlay-unmute failed', err));
    return { file: filename, bytes: res.bytes, durationMs: res.durationMs, markers: rec.markers.length };
  },

  async viewport_emulate(args) {
    const tabId = await resolveTabId(args.tabId);
    return cdp.viewportEmulate(tabId, args);
  },


  async record_pause(args) {
    const tabId = await resolveTabId(args.tabId);
    const rec = recordings.get(tabId);
    if (!rec || !rec.startedAt) throw new Error('no recording on this tab');
    if (rec.pausedAt) throw new Error('recording is already paused');
    rec.pausedAt = Date.now();
    await sendToOffscreen({ target: 'offscreen', cmd: 'record_pause' });
    return { paused: true, at: rec.pausedAt - rec.startedAt };
  },

  async record_resume(args) {
    const tabId = await resolveTabId(args.tabId);
    const rec = recordings.get(tabId);
    if (!rec || !rec.startedAt) throw new Error('no recording on this tab');
    if (!rec.pausedAt) throw new Error('recording is not paused');
    rec.pauses.push({ from: rec.pausedAt - rec.startedAt, to: Date.now() - rec.startedAt });
    rec.pausedAt = 0;
    await sendToOffscreen({ target: 'offscreen', cmd: 'record_resume' });
    return { paused: false };
  },

  async record_marker(args) {
    const tabId = await resolveTabId(args.tabId);
    const rec = recordings.get(tabId);
    if (!rec || !rec.startedAt) throw new Error('no recording on this tab');
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
      mark(tabId, Number(args.x), Number(args.y), args.kind || 'note', args.label);
    } else {
      markCenter(tabId, args.kind || 'note', args.label);
    }
    return { marked: true, markers: rec.markers.length };
  },

  // --- document-start preloads (v2.11) -------------------------------------

  async inject_preload(args) {
    const tabId = await resolveTabId(args.tabId);
    const source = args.preset ? PRELOAD_PRESETS[String(args.preset)] : args.script;
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error(args.preset
        ? `unknown preset: ${args.preset} (known: ${Object.keys(PRELOAD_PRESETS).join(', ')})`
        : 'inject_preload needs script or preset');
    }
    const id = await cdp.addPreload(tabId, source);
    const rec = { id, preset: args.preset ? String(args.preset) : null, chars: source.length, ts: Date.now() };
    const list = preloadsByTab.get(tabId) || [];
    list.push(rec);
    preloadsByTab.set(tabId, list);
    return { id, injected: true, appliesTo: 'documents created after this call — navigate or reload to activate' };
  },

  async preloads_list(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, preloads: preloadsByTab.get(tabId) || [] };
  },

  async preload_remove(args) {
    const tabId = await resolveTabId(args.tabId);
    const list = preloadsByTab.get(tabId) || [];
    const keep = args.all ? [] : list.filter((p) => p.id !== args.id);
    const removed = list.length - keep.length;
    if (!removed) {
      throw new Error(args.id ? `no preload ${args.id} on this tab` : 'no preloads on this tab');
    }
    for (const p of list) {
      if (!keep.includes(p)) await cdp.removePreload(tabId, p.id);
    }
    if (keep.length) preloadsByTab.set(tabId, keep); else preloadsByTab.delete(tabId);
    return { removed };
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
    const wantVisible = args.visible === true;
    if (!sel && !text) throw new Error('wait_for needs selector or text');
    const t0 = Date.now();
    let sawInvisible = false;
    while (Date.now() - t0 < timeoutMs) {
      if (sel) {
        // One eval reports existence AND visibility so `visible:true` never
        // green-lights a display:none element.
        const expr = `(function () {
          var el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { exists: false, visible: false };
          var cs = getComputedStyle(el);
          var r = el.getBoundingClientRect();
          return { exists: true, visible: cs.display !== 'none' && cs.visibility === 'visible' && r.width > 0 && r.height > 0 };
        })()`;
        const r = await cdp.evalJs(tabId, expr);
        const v = r && r.value;
        if (v && v.exists && (!wantVisible || v.visible)) {
          return { found: true, waited: Date.now() - t0, visible: v.visible };
        }
        if (v && v.exists && !v.visible) sawInvisible = true;
      } else {
        const expr = `!!(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`;
        const r = await cdp.evalJs(tabId, expr);
        if (r && r.value) return { found: true, waited: Date.now() - t0 };
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    const out = { found: false, waited: Date.now() - t0 };
    if (sawInvisible) out.exists = true;
    return out;
  },

  async read_elements(args) {
    const tabId = await resolveTabId(args.tabId);
    const sel = String(args.selector || '');
    if (!sel) throw new Error('read_elements needs selector');
    const max = Math.min(Math.max(Number(args.max) || 50, 1), 200);
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 300, 1), 2000);
    const attr = args.attr ? String(args.attr) : '';
    const expr =
      `(function () {${CSS_PATH_FN}
      return [...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, ${max})` +
      `.map((el) => ({ text: String(el.innerText || el.textContent || '').trim().slice(0, ${maxChars}), path: abCssPath(el)` +
      (attr ? `, value: el.getAttribute(${JSON.stringify(attr)})` : '') +
      ' }))})()';
    const r = args.frame
      ? await inspect.frameEval(tabId, { frame: args.frame, expression: expr })
      : await cdp.evalJs(tabId, expr);
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

  // --- page translation (v2.14) --------------------------------------------
  // page_translate only ignites the engine: walking, batching, provider calls
  // and rendering then run in the background pipeline, outside the tool loop.

  async page_translate(args) {
    const tabId = await resolveTabId(args.tabId);
    const r = await translate.start(tabId, args);
    return { tabId, running: true, ...(r || {}) };
  },

  async page_translate_stop(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, ...(await translate.stop(tabId)) };
  },

  async translate_para(args) {
    const tabId = await resolveTabId(args.tabId);
    if (args.tid == null) throw new Error('translate_para needs tid');
    return { tabId, ...(await translate.translatePara(tabId, args.tid)) };
  },

  async translate_status(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, ...(await translate.status(tabId)) };
  },

  // --- video subtitles (v2.16) ----------------------------------------------

  async subtitle_translate(args) {
    const tabId = await resolveTabId(args.tabId);
    const r = await subtitle.start(tabId, args);
    return { tabId, ...(r || {}) };
  },

  async subtitle_stop(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, ...(await subtitle.stop(tabId)) };
  },

  async subtitle_status(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, ...(await subtitle.status(tabId)) };
  },

  async transcript_get(args) {
    const tabId = await resolveTabId(args.tabId);
    return { tabId, ...(await subtitle.transcript(tabId, args)) };
  },
};

async function executeTool(tool, args, permissions) {
  const fn = TOOLS[tool];
  if (fn) return fn(args, permissions);
  // plugin_op route (v2.25): tools no built-in owns may be page-side plugin
  // tools — the tab's plugin bus answers via {target:'plugins', cmd:'op'}.
  const tabId = await resolveTabId(args && args.tabId).catch(() => null);
  if (tabId != null) {
    const r = await chrome.tabs
      .sendMessage(tabId, { target: 'plugins', cmd: 'op', tool, args: args || {} }, { frameId: 0 })
      .catch(() => null);
    if (r && r.ok) return r.result;
    if (r && r.error && !String(r.error).startsWith('no page tool')) {
      throw new Error(r.error);
    }
  }
  throw new Error(`unknown tool: ${tool}`);
}

// Chat-event fan-out shared by hub replies and direct-mode turns: ann-*/
// learn-* chats stream back to the page that started them, the rest go to
// the panel that owns the chat.
function emitChatEvent(chatId, event, browser) {
  const ann = annChats.get(chatId);
  if (ann) {
    chrome.tabs
      .sendMessage(ann.tabId, {
        target: 'annotation',
        cmd: 'event',
        annId: ann.annId,
        event,
      })
      .catch((err) => {
        console.warn('[agentbrowser] annotation event delivery failed', err);
      });
    return;
  }
  const pg = pgChats.get(chatId);
  if (pg) {
    chrome.tabs
      .sendMessage(pg.tabId, {
        target: 'page-ask',
        cmd: 'event',
        chatId,
        event,
      })
      .catch((err) => {
        console.warn('[agentbrowser] page-ask event delivery failed', err);
      });
    return;
  }
  const learn = learnChats.get(chatId);
  if (learn) {
    chrome.tabs
      .sendMessage(learn.tabId, {
        target: 'video-ask',
        cmd: 'learn_event',
        event,
      })
      .catch((err) => {
        console.warn('[agentbrowser] learn event delivery failed', err);
      });
    return;
  }
  postToPanel({ type: 'chat_event', chatId, browser, event });
}

// A chat payload destined for the agent — hub when connected, the built-in
// provider loop when direct mode is on.
function dispatchChat(payload) {
  direct
    .enabled()
    .then((on) => {
      if (!on) {
        sendToOffscreen({ target: 'offscreen', cmd: 'send', payload });
        return;
      }
      direct
        .sendChat(payload, {
          emit: (event) => emitChatEvent(payload.chatId, event),
          execTool: (name, args) => executeTool(name, args, null),
          gate: (name, args) => gateToolCall(name, args, null),
        })
        .catch((err) => {
          console.warn('[agentbrowser] direct chat failed', err);
          emitChatEvent(payload.chatId, { kind: 'error', message: String((err && err.message) || err) });
          emitChatEvent(payload.chatId, { kind: 'done' });
        });
    })
    .catch((err) => {
      console.warn('[agentbrowser] direct-mode check failed, sending to hub', err);
      sendToOffscreen({ target: 'offscreen', cmd: 'send', payload });
    });
}
