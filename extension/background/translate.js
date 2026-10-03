// Extension-side translation coordinator (PROTOCOL v2.14). Owns the page
// engine lifecycle per tab: injects translate-core + translate-engine through
// CDP, bridges the engine's __abTranslateBus binding onto hub
// translate_request messages, and relays progress to the panel.

import * as cdp from './cdp.js';

const BINDING = '__abTranslateBus';
const CORE_URL = 'page/translate-core.js';
const ENGINE_URL = 'page/translate-engine.js';
const STORAGE_KEY = 'abTranslate';

const sessions = new Map(); // tabId -> {cfg, running, startPromise}
const pendingReqs = new Map(); // reqId -> tabId

let boundTabs = new Set(); // tabs with the CDP binding installed
let sources = null;

export function wireHub({ sendToHub, postToPanel }) {
  hubSend = sendToHub;
  panelPost = postToPanel;
}
let hubSend = null;
let panelPost = null;

async function loadSources() {
  if (sources) return sources;
  const [core, engine] = await Promise.all([
    fetch(chrome.runtime.getURL(CORE_URL)).then((r) => r.text()),
    fetch(chrome.runtime.getURL(ENGINE_URL)).then((r) => r.text()),
  ]);
  // The core ships ES exports for node --test; the page evaluate is a classic
  // script, so they are stripped here before concatenation.
  const coreClassic = core.replace(/^export\s+/gm, '');
  sources = coreClassic + '\n' + engine;
  return sources;
}

// Runtime.evaluate without the action overlay flash — applyBatch runs on every
// provider reply and flashing per paragraph is noise, not signal.
async function evalRaw(tabId, expression) {
  const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(
      (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed'
    );
  }
  return res.result ? res.result.value : undefined;
}

async function ensureEngine(tabId) {
  if (!boundTabs.has(tabId)) {
    await cdp.sendCommand(tabId, 'Runtime.enable').catch((err) => {
      console.warn('[agentbrowser] Runtime.enable for translate failed', err);
    });
    await cdp.sendCommand(tabId, 'Runtime.addBinding', { name: BINDING }).catch((err) => {
      console.warn('[agentbrowser] addBinding failed', err);
      throw new Error('translate binding failed: ' + ((err && err.message) || err));
    });
    boundTabs.add(tabId);
  }
  // The core file's top-level consts persist for the document's lifetime, so a
  // second evaluate throws "already declared" — probe before re-injecting.
  const probe = await evalRaw(tabId, '!!window.__abTranslate');
  if (probe === true) return;
  const src = await loadSources();
  await evalRaw(tabId, src + '\nwindow.__abTranslate && __abTranslate.status()');
}

function session(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { cfg: null, running: false, startPromise: null };
    sessions.set(tabId, s);
  }
  return s;
}

export async function loadPrefs() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return (got && got[STORAGE_KEY]) || {};
  } catch (err) {
    console.warn('[agentbrowser] translate prefs load failed', err);
    return {};
  }
}

// tool_call: page_translate — start (or reconfigure+resume) the pipeline.
export async function start(tabId, cfg) {
  const s = session(tabId);
  s.cfg = { ...(s.cfg || {}), ...(await loadPrefs()), ...(cfg || {}) };
  if (s.startPromise) return s.startPromise;
  s.startPromise = (async () => {
    await ensureEngine(tabId);
    const r = await evalRaw(
      tabId,
      `__abTranslate && __abTranslate.start(${JSON.stringify(s.cfg)})`
    );
    s.running = true;
    return r || { paragraphs: 0 };
  })();
  try {
    return await s.startPromise;
  } finally {
    s.startPromise = null;
  }
}

// tool_call: page_translate_stop.
export async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.running) return { stopped: false };
  s.running = false;
  try {
    await evalRaw(tabId, '__abTranslate && __abTranslate.stop()');
  } catch (err) {
    console.warn('[agentbrowser] translate stop eval failed', err);
  }
  sessions.delete(tabId);
  return { stopped: true };
}

// tool_call: translate_para — force one paragraph through the pipeline.
export async function translatePara(tabId, tid) {
  const s = sessions.get(tabId);
  if (!s || !s.running) {
    throw new Error('translation engine not running on this tab — call page_translate first');
  }
  return evalRaw(tabId, `__abTranslate.translatePara(${Number(tid)})`);
}

// tool_call: translate_status.
export async function status(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.running) return { active: false };
  try {
    return await evalRaw(tabId, '__abTranslate.status()');
  } catch (err) {
    console.warn('[agentbrowser] translate status eval failed', err);
    return { active: false };
  }
}

// Runtime.bindingCalled: the engine's outbound channel. Payload is a JSON
// string — parse failures are logged and dropped, never fatal.
export function onBindingCalled(tabId, payload) {
  let msg;
  try {
    msg = JSON.parse(String(payload || ''));
  } catch (err) {
    console.warn('[agentbrowser] translate bus payload not JSON', err);
    return;
  }
  const s = sessions.get(tabId);
  if (!s) return;
  if (msg.kind === 'batch') {
    if (!hubSend) return;
    const reqId = `tr-${tabId}-${msg.req}`;
    pendingReqs.set(reqId, tabId);
    hubSend({
      type: 'translate_request',
      id: reqId,
      tabId,
      items: Array.isArray(msg.items) ? msg.items : [],
      targetLang: s.cfg && s.cfg.targetLang,
      context: msg.ctx || {},
    });
  } else if (msg.kind === 'word') {
    if (!hubSend) return;
    const reqId = `tw-${tabId}-${msg.tid}-${Date.now()}`;
    pendingReqs.set(reqId, tabId);
    hubSend({
      type: 'translate_request',
      id: reqId,
      tabId,
      word: true,
      items: [{ tid: msg.tid, text: String(msg.text || '') }],
      targetLang: s.cfg && s.cfg.targetLang,
    });
  } else if (msg.kind === 'progress') {
    if (panelPost) {
      panelPost({
        type: 'translate_progress',
        tabId,
        total: msg.total,
        done: msg.done,
        translating: msg.translating,
      });
    }
  } else if (msg.kind === 'error') {
    console.warn('[agentbrowser] translate engine error:', msg.error);
  }
}

// translate_result from the hub — apply into the page engine. Batch ids are
// "tr-<tab>-<engine-req>"; word lookups are "tw-<tab>-<tid>-<ts>".
export function onResult(msg) {
  const tabId = pendingReqs.get(msg.id);
  pendingReqs.delete(msg.id);
  const s = sessions.get(tabId);
  if (tabId == null || !s || !s.running) return;
  if (msg.error) {
    console.warn('[agentbrowser] translate request failed:', msg.error);
    if (panelPost) {
      panelPost({ type: 'translate_progress', tabId, error: String(msg.error) });
    }
    return;
  }
  const results = msg.results || {};
  const id = String(msg.id || '');
  const expr = id.startsWith('tw-')
    ? (() => {
        const [tid, text] = Object.entries(results)[0] || [];
        return tid
          ? `__abTranslate && __abTranslate.applyWord(${Number(tid)}, ${JSON.stringify(text || '')})`
          : null;
      })()
    : `__abTranslate && __abTranslate.applyBatch(${Number(id.split('-').pop()) || 0}, ${JSON.stringify(results)})`;
  if (!expr) return;
  evalRaw(tabId, expr).catch((err) => {
    console.warn('[agentbrowser] translate apply failed', err);
  });
}

// The page engine dies on navigation; a running session re-arms itself.
export function onTabUpdated(tabId, info) {
  const s = sessions.get(tabId);
  if (!s || !s.running || !info || info.status !== 'complete') return;
  boundTabs.delete(tabId); // new document: binding must be re-installed
  start(tabId, s.cfg).catch((err) => {
    console.warn('[agentbrowser] translate re-start after navigation failed', err);
    s.running = false;
  });
}

export function onTabRemoved(tabId) {
  sessions.delete(tabId);
  boundTabs.delete(tabId);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || source.tabId == null || !params) return;
  if (method !== 'Runtime.bindingCalled' || params.name !== BINDING) return;
  onBindingCalled(source.tabId, params.payload);
});

chrome.tabs.onUpdated.addListener((tabId, info) => onTabUpdated(tabId, info));
chrome.tabs.onRemoved.addListener((tabId) => onTabRemoved(tabId));
