// Consent gate for sensitive browser tools (PROTOCOL v1.7).
//
// The hub attaches config.json's `permissions` object to every tool_call it
// forwards. sw asks authorize() before executing; authorize either returns
// (allowed) or throws "denied by user". The human-facing part is a card
// injected into the target tab that reuses the annotation card styling, with
// a chrome.notifications fallback for pages content scripts cannot reach
// (chrome://, the Web Store, PDFs).
//
// The decision logic and policy parsing live in consent-core.js (pure, unit
// tested); this file owns the side effects: the page card, the notification
// fallback, and the bounded element-describe evaluation.

import * as cdp from './cdp.js';
import {
  needsConsent,
  rememberSessionAllow,
  hydrateSessionAllows,
  sessionAllowsKeys,
  summarizeArgs,
  hostOf,
  originOf,
} from './consent-core.js';

export { requiredTools, shouldCheck } from './consent-core.js';

// "Always on this domain" grants persist in chrome.storage.session so a
// suspended service worker does not lose them; the in-memory set in
// consent-core is hydrated lazily on the first gated call after wakeup.
const GRANTS_KEY = 'consentSessionAllows';
let grantsPromise = null;

function grantsReady() {
  if (!grantsPromise) {
    grantsPromise = chrome.storage.session
      .get(GRANTS_KEY)
      .then((r) => {
        hydrateSessionAllows(Array.isArray(r && r[GRANTS_KEY]) ? r[GRANTS_KEY] : []);
      })
      .catch((err) => {
        console.warn('[agentbrowser] consent grants read failed', err);
      });
  }
  return grantsPromise;
}

function persistGrants() {
  chrome.storage.session
    .set({ [GRANTS_KEY]: sessionAllowsKeys() })
    .catch((err) => {
      console.warn('[agentbrowser] consent grants write failed', err);
    });
}

export const CONSENT_TIMEOUT_MS = 30000;
const NOTIFICATION_TIMEOUT_MS = 15000;
const DESCRIBE_TIMEOUT_MS = 1500;

// Short human-readable line for the card / notification, e.g.
// click 'button.buy' → <button> "Buy now". Element lookups use a bounded
// evaluate; a hung main thread or modal dialog must not stall the gate.
export async function describeTarget(tabId, tool, args) {
  const a = args || {};
  const fallback = summarizeArgs(tool, a);
  try {
    const extra = await withTimeout(describeElement(tabId, tool, a), DESCRIBE_TIMEOUT_MS, '');
    return extra ? `${fallback} → ${extra}` : fallback;
  } catch (err) {
    console.warn('[agentbrowser] consent target describe failed', tool, err);
    return fallback;
  }
}

// Element label behind a coordinate or selector, e.g. 'button "Checkout"'.
async function describeElement(tabId, tool, a) {
  let expression = null;
  if (tool === 'click') {
    expression = `(() => {
      const el = document.elementFromPoint(${Number(a.x) || 0}, ${Number(a.y) || 0});
      return el ? el.tagName.toLowerCase() + ' "' + (el.innerText || el.value || '').trim().slice(0, 40) + '"' : '';
    })()`;
  } else if (tool === 'click_element' || (tool === 'type_text' && a.selector)) {
    const sel = JSON.stringify(String(a.selector || ''));
    expression = `(() => {
      const el = document.querySelector(${sel});
      return el ? el.tagName.toLowerCase() + ' "' + (el.innerText || el.value || el.placeholder || '').trim().slice(0, 40) + '"' : 'not found';
    })()`;
  }
  if (!expression) return '';
  const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  return (res && res.result && res.result.value) || '';
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

// The annotation content script hosts the consent card (it already owns the
// card styling and on-demand injection path).
async function askPage(tabId, request) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        target: 'annotation',
        cmd: 'consent',
        ...request,
      });
    } catch (err) {
      lastErr = err;
      if (attempt > 0) break;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['annotation.js'] });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['annotation.css'] });
      } catch (injectErr) {
        console.warn('[agentbrowser] consent card injection failed', injectErr);
        break;
      }
    }
  }
  throw lastErr || new Error('consent card unreachable');
}

// Pages the content script cannot reach (chrome://, Web Store, PDFs) get a
// system notification instead — two buttons only, no domain grant.
function askViaNotification(request) {
  return new Promise((resolve) => {
    const id = `ab-consent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const finish = (decision) => {
      chrome.notifications.onButtonClicked.removeListener(onClick);
      chrome.notifications.onClosed.removeListener(onClose);
      chrome.notifications.clear(id, () => {
        if (chrome.runtime.lastError) {
          console.warn('[agentbrowser] consent notification clear failed', chrome.runtime.lastError.message);
        }
      });
      resolve(decision);
    };
    const onClick = (nid, buttonIndex) => {
      if (nid !== id) return;
      finish(buttonIndex === 0 ? 'once' : 'deny');
    };
    const onClose = (nid) => {
      if (nid !== id) return;
      finish('deny');
    };
    chrome.notifications.onButtonClicked.addListener(onClick);
    chrome.notifications.onClosed.addListener(onClose);
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: `AgentBrowser: allow ${request.tool}?`,
      message: `${request.summary}\non ${request.domain}`,
      buttons: [{ title: 'Allow once' }, { title: 'Deny' }],
      requireInteraction: true,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[agentbrowser] consent notification failed', chrome.runtime.lastError.message);
        finish('deny');
      }
    });
  });
}

// Throws Error("denied by user: <tool>") when the user declines or the prompt
// times out. Otherwise returns; 'domain' decisions are remembered for the
// session (never for sensitiveDomains — needsConsent re-asks there anyway).
export async function authorize(tool, args, tabId, tabUrl, policy) {
  await grantsReady();
  if (!needsConsent(tool, tabUrl, policy)) return;
  const summary = await describeTarget(tabId, tool, args);
  const request = { tool, summary, domain: hostOf(tabUrl) };

  let decision = 'deny';
  let res;
  try {
    res = await withTimeout(askPage(tabId, request), CONSENT_TIMEOUT_MS, null);
  } catch (err) {
    console.warn('[agentbrowser] consent card unreachable, using notification fallback', err);
    res = null;
  }
  if (res && (res.decision === 'once' || res.decision === 'domain' || res.decision === 'deny')) {
    decision = res.decision;
  } else {
    // null = card threw (unreachable page) or hit the 30s timeout; the page
    // card self-dismisses on the same timeout, so no stale card remains.
    decision = await withTimeout(askViaNotification(request), NOTIFICATION_TIMEOUT_MS, 'deny');
  }

  if (decision === 'domain') {
    rememberSessionAllow(originOf(tabUrl), tool);
    persistGrants();
  }
  if (decision !== 'once' && decision !== 'domain') {
    throw new Error(`denied by user: ${tool}`);
  }
}
