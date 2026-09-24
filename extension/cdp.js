// CDP helpers for the AgentBrowser tool executor. Imported by sw.js.
// Attach-on-demand per tab, protocol "1.3", commands serialized per tab.
// State here is re-derivable: if the service worker is killed the attached
// set is rebuilt lazily (an "already attached" error on re-attach is treated
// as attached, since debugger attachments outlive the worker).

import { buildOverlayScript } from './overlay.js';

const PROTOCOL_VERSION = '1.3';

const attached = new Set();
const attaching = new Map(); // tabId -> in-flight attach, so concurrent callers share one
const queues = new Map(); // tabId -> tail promise of the per-tab command chain

function forget(tabId) {
  attached.delete(tabId);
  queues.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) forget(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attached.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch((err) => {
      console.warn('[agentbrowser] debugger detach on tab close failed', err);
    });
  }
  forget(tabId);
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  // The overlay runs off the per-tab queue, so two callers can land here at
  // once. Share one attach rather than racing two chrome.debugger.attach calls.
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } catch (err) {
        const message = String((err && err.message) || err);
        // Our own attachment can survive a worker restart while the set is empty.
        if (!/already attached/i.test(message)) throw err;
      }
      attached.add(tabId);
      // Page.enable goes on every attachment, outside the per-tab queue:
      // JS dialogs are routed to the debugger while the domain is on, and
      // enabling it only after a dialog opened would deadlock the session
      // (the command itself queues behind the modal). inspect.js listens
      // for Page.javascriptDialogOpening and auto-dismisses after a hold.
      chrome.debugger
        .sendCommand({ tabId }, 'Page.enable')
        .catch((err) => {
          console.warn('[agentbrowser] Page.enable on attach failed', err);
        });
    })();
    attaching.set(tabId, pending);
    pending.catch((err) => {
      console.warn('[agentbrowser] debugger attach rejected', err);
    }).then(() => {
      if (attaching.get(tabId) === pending) attaching.delete(tabId);
    });
  }
  return pending;
}

/** True when this module believes it holds a debugger session for the tab. */
export function isAttached(tabId) {
  return attached.has(tabId);
}

export function sendCommand(tabId, method, params = {}) {
  const tail = queues.get(tabId) || Promise.resolve();
  const run = tail.then(async () => {
    await ensureAttached(tabId);
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (err) {
      const message = String((err && err.message) || err);
      // "already attached" swallowed in ensureAttached may have belonged to
      // another client (DevTools); the set then lies. Re-attach for real once.
      if (!/not attached/i.test(message)) throw err;
      forget(tabId);
      await ensureAttached(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
  });
  // Keep the chain usable after a failed command.
  queues.set(
    tabId,
    run.catch((err) => {
      console.warn('[agentbrowser] CDP command failed:', method, err);
    })
  );
  return run;
}

// --- on-page overlay --------------------------------------------------------
//
// The overlay is cosmetic and must never fail or delay a tool. Three rules
// follow from that:
//   1. It skips the per-tab queue. Going through sendCommand would put the real
//      Input event behind a Runtime.evaluate that can hang forever on a page
//      with a blocked main thread or an open modal dialog.
//   2. Every call is bounded by OVERLAY_TIMEOUT_MS and resolves, never rejects.
//   3. Tool functions fire it and drop the promise on the floor.

const OVERLAY_TIMEOUT_MS = 250;

// Pages where Runtime.evaluate cannot run or the debugger cannot attach.
// The try/catch is the real defense; this just avoids pointless work.
const OVERLAY_BLOCKED_URL = /^(chrome|chrome-extension|chrome-untrusted|devtools|view-source|about|edge|brave|opera|vivaldi):/i;
const OVERLAY_BLOCKED_HOST = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

// chrome.storage.local.overlayEnabled, default true. Only an explicit false
// disables the overlay, so an unset key behaves as on.
let overlayEnabled = null;
let overlayPref = null;

function overlayAllowed() {
  if (overlayEnabled !== null) return Promise.resolve(overlayEnabled);
  if (!overlayPref) {
    overlayPref = chrome.storage.local
      .get('overlayEnabled')
      .then((stored) => {
        // An onChanged that landed while this read was in flight wins: it is
        // newer than what we just read.
        if (overlayEnabled === null) {
          overlayEnabled = !(stored && stored.overlayEnabled === false);
        }
        return overlayEnabled;
      })
      .catch((err) => {
        console.warn('[agentbrowser] overlay preference read failed', err);
        return true;
      });
  }
  return overlayPref;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.overlayEnabled) return;
  overlayEnabled = changes.overlayEnabled.newValue !== false;
});

async function sendUnqueued(tabId, method, params) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function injectOverlay(tabId, action, detail) {
  if (!(await overlayAllowed())) return false;
  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = String((tab && tab.url) || '');
  } catch (err) {
    console.warn('[agentbrowser] overlay tab lookup failed', err);
    return false;
  }
  if (!url || OVERLAY_BLOCKED_URL.test(url) || OVERLAY_BLOCKED_HOST.test(url)) return false;
  await sendUnqueued(tabId, 'Runtime.evaluate', {
    expression: buildOverlayScript(action, detail),
    returnByValue: true,
    // Never let a page's own promise machinery hold the call open.
    awaitPromise: false,
    userGesture: false,
  });
  return true;
}

/**
 * Show the "AgentBrowser is driving this tab" overlay. Always resolves, within
 * OVERLAY_TIMEOUT_MS. Callers do not await it.
 *
 * @param {number} tabId
 * @param {string} action  tool name, e.g. "click"
 * @param {{label?: string, x?: number, y?: number}} [detail]
 * @returns {Promise<boolean>} whether the overlay was injected
 */
export function showOverlay(tabId, action, detail) {
  const work = Promise.resolve()
    .then(() => injectOverlay(tabId, action, detail))
    .then(
      (ok) => !!ok,
      () => false,
    );
  const bail = new Promise((resolve) => setTimeout(() => resolve(false), OVERLAY_TIMEOUT_MS));
  return Promise.race([work, bail]);
}

// Fire-and-forget wrapper: no caller ever sees this promise.
function flashOverlay(tabId, action, detail) {
  try {
    showOverlay(tabId, action, detail).catch((err) => {
      console.warn('[agentbrowser] overlay flash failed (cosmetic)', err);
    });
  } catch (err) {
    console.warn('[agentbrowser] overlay flash failed (cosmetic)', err);
  }
}

function describeException(details) {
  if (details.exception && details.exception.description) {
    return details.exception.description;
  }
  return details.text || 'evaluation failed';
}

export async function readPage(tabId, maxChars = 60000) {
  // The overlay lives on <html>, not <body>, so it never lands in this text.
  flashOverlay(tabId, 'read_page');
  const res = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
  let text = String((res.result && res.result.value) || '');
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 60000;
  if (text.length > cap) text = text.slice(0, cap);
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, title: tab.title, text };
}

export async function screenshot(tabId) {
  // The capture will include the overlay. That is unavoidable: in a real loop
  // (screenshot, click, screenshot) the pill from the previous action is still
  // up anyway, so suppressing it here would buy only a clean first frame.
  flashOverlay(tabId, 'screenshot');
  const res = await sendCommand(tabId, 'Page.captureScreenshot', { format: 'png' });
  return { base64: res.data, mimeType: 'image/png' };
}

export async function click(tabId, x, y) {
  flashOverlay(tabId, 'click', { x, y });
  const base = { x, y, button: 'left', clickCount: 1 };
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return { clicked: true };
}

// Center of the first element matching `selector`, scrolled into view first so
// the point lands inside the visual viewport. Shared by click_element and
// type_text's optional selector focus. {dx,dy} offsets from the center.
async function elementCenter(tabId, selector, dx = 0, dy = 0) {
  const res = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2,
               tag: el.tagName.toLowerCase() };
    })()`,
    returnByValue: true,
  });
  const v = res.result && res.result.value;
  if (!v || !v.found) throw new Error(`no element matches selector: ${selector}`);
  return { x: v.x + dx, y: v.y + dy, tag: v.tag };
}

export async function clickElement(tabId, selector, dx = 0, dy = 0) {
  const center = await elementCenter(tabId, selector, dx, dy);
  flashOverlay(tabId, 'click', { x: Math.round(center.x), y: Math.round(center.y) });
  const base = { x: center.x, y: center.y, button: 'left', clickCount: 1 };
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return { clicked: true, selector, tag: center.tag };
}

export async function typeText(tabId, text, selector) {
  const value = String(text ?? '');
  flashOverlay(tabId, 'type_text');
  if (selector) {
    // Focus the target first — a real click, so page click handlers see it.
    await clickElement(tabId, selector);
    flashOverlay(tabId, 'type_text');
  }
  await sendCommand(tabId, 'Input.insertText', { text: value });
  return { typed: value.length };
}

export async function evalJs(tabId, expression) {
  flashOverlay(tabId, 'eval_js');
  const res = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
  return { value: res.result ? res.result.value : undefined };
}

// press_key: modifiers bitmask Alt=1, Ctrl=2, Meta=4, Shift=8.
const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

// macOS editing commands CDP needs on the keydown for Meta combos.
const MAC_EDIT_COMMANDS = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
};

function keyDef(token, modifiers) {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return named;
  if (token.length === 1) {
    if (/[a-zA-Z]/.test(token)) {
      const upper = token.toUpperCase();
      return {
        key: (modifiers & 8) ? upper : token.toLowerCase(),
        code: `Key${upper}`,
        keyCode: upper.charCodeAt(0),
      };
    }
    if (/[0-9]/.test(token)) {
      return { key: token, code: `Digit${token}`, keyCode: token.charCodeAt(0) };
    }
    return { key: token, code: '', keyCode: 0 };
  }
  throw new Error(`unsupported key: ${token}`);
}

export async function pressKey(tabId, spec) {
  const parts = String(spec).split('+');
  const keyToken = parts.pop();
  if (!keyToken) throw new Error(`unsupported key: ${spec}`);
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier: ${part}`);
    modifiers |= bit;
  }
  const def = keyDef(keyToken, modifiers);
  flashOverlay(tabId, 'press_key');
  const down = {
    type: 'rawKeyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  if (modifiers & MODIFIER_BITS.meta) {
    const command = MAC_EDIT_COMMANDS[def.key.toLowerCase()];
    if (command) down.commands = [command];
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', down);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  });
  return { pressed: spec };
}
