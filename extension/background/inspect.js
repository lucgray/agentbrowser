// Inspection toolkit state: per-tab console/network/dialog ring buffers fed by
// chrome.debugger.onEvent once the matching CDP domains are enabled. Domains are
// enabled lazily on first use of a tool that needs them; capture continues for
// as long as the debugger stays attached. Buffers reset on main-frame
// navigation and are dropped when the tab closes.

import * as cdp from './cdp.js';
import {
  CONSOLE_CAP,
  NETWORK_CAP,
  DIALOG_HOLD_MS,
  consoleArgsToText,
  buildHar,
  domInspectExpression,
  outlineExpression,
  patchApplyExpression,
  patchRevertExpression,
} from './inspect-core.js';

const tabs = new Map(); // tabId -> {enabled:Set, console:[], requests:Map, finished:[], dialogs:[], url, patches:Map, patchSeq}

function state(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = {
      enabled: new Set(),
      console: [],
      requests: new Map(), // requestId -> entry (in-flight and recent finished)
      dialogs: [],         // {type,message,url,ts,status:'pending'|'auto-dismissed'|'handled'}
      patches: new Map(),  // patchId -> {label, url, items:[{path,outerHTML}]}
      patchSeq: 0,
      url: '',
    };
    tabs.set(tabId, s);
  }
  return s;
}

function dropTab(tabId) {
  tabs.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (!source || source.tabId == null) return;
  const s = tabs.get(source.tabId);
  if (!s) return;
  // Attachments are re-derivable: next tool call re-enables its domains and
  // capture resumes. Pending dialogs are gone with the session.
  s.enabled.clear();
  for (const d of s.dialogs) {
    if (d.status === 'pending') d.status = 'lost-detach';
  }
});

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const s = tabs.get(tabId);
  if (!s || !changeInfo.url) return;
  // Main-frame navigation: the page's console/network context is gone.
  s.console = [];
  s.requests = new Map();
  s.dialogs = [];
  s.url = changeInfo.url;
});

// Dialog-related commands must bypass the per-tab queue: while a JS dialog
// is open the renderer holds queued commands, so Page.handleJavaScriptDialog
// sent through sendCommand would deadlock behind the very modal it dismisses.
function sendUnqueued(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureDomains(tabId, domains) {
  const s = state(tabId);
  for (const domain of domains) {
    if (s.enabled.has(domain)) continue;
    try {
      await cdp.sendCommand(tabId, `${domain}.enable`);
      s.enabled.add(domain);
    } catch (err) {
      console.warn(`[agentbrowser] ${domain}.enable failed on tab ${tabId}`, err);
      throw new Error(`${domain}.enable failed: ${String((err && err.message) || err)}`);
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || source.tabId == null) return;
  const s = state(source.tabId);
  if (!params) return;

  switch (method) {
    case 'Runtime.consoleAPICalled': {
      s.console.push({
        ts: params.timestamp || Date.now(),
        level: String(params.type || 'log'),
        source: 'console',
        text: consoleArgsToText(params.args),
      });
      if (s.console.length > CONSOLE_CAP) s.console.splice(0, s.console.length - CONSOLE_CAP);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      const text =
        (d.exception && d.exception.description) || d.text || 'uncaught exception';
      s.console.push({
        ts: params.timestamp || Date.now(),
        level: 'exception',
        source: 'exception',
        text: String(text),
        url: String(d.url || ''),
      });
      if (s.console.length > CONSOLE_CAP) s.console.splice(0, s.console.length - CONSOLE_CAP);
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      s.console.push({
        ts: e.timestamp || Date.now(),
        level: String(e.level || 'info'),
        source: String(e.source || 'log'),
        text: String(e.text || ''),
        url: String(e.url || ''),
      });
      if (s.console.length > CONSOLE_CAP) s.console.splice(0, s.console.length - CONSOLE_CAP);
      break;
    }
    case 'Network.requestWillBeSent': {
      s.requests.set(params.requestId, {
        id: params.requestId,
        url: (params.request && params.request.url) || '',
        method: (params.request && params.request.method) || '',
        requestHeaders: (params.request && params.request.headers) || {},
        type: params.type || '',
        startTime: (params.timestamp || 0) * 1000,
        pending: true,
      });
      if (s.requests.size > NETWORK_CAP) {
        // Drop the oldest finished entry first, then oldest in-flight.
        const entries = [...s.requests.entries()];
        const old = entries.find(([, v]) => !v.pending) || entries[0];
        if (old) s.requests.delete(old[0]);
      }
      break;
    }
    case 'Network.responseReceived': {
      const e = s.requests.get(params.requestId);
      if (!e || !params.response) break;
      e.status = params.response.status;
      e.mimeType = params.response.mimeType || '';
      e.responseHeaders = params.response.headers || {};
      break;
    }
    case 'Network.loadingFinished': {
      const e = s.requests.get(params.requestId);
      if (!e) break;
      e.pending = false;
      e.size = params.encodedDataLength || 0;
      if (e.startTime) e.duration = params.timestamp * 1000 - e.startTime;
      break;
    }
    case 'Network.loadingFailed': {
      const e = s.requests.get(params.requestId);
      if (!e) break;
      e.pending = false;
      e.failed = true;
      e.errorText = String(params.errorText || 'failed');
      if (e.startTime) e.duration = params.timestamp * 1000 - e.startTime;
      break;
    }
    case 'Page.javascriptDialogOpening': {
      const entry = {
        type: String(params.type || 'alert'),
        message: String(params.message || ''),
        url: String(params.url || ''),
        ts: Date.now(),
        status: 'pending',
      };
      s.dialogs.push(entry);
      if (s.dialogs.length > 20) s.dialogs.splice(0, s.dialogs.length - 20);
      // An unhandled JS dialog hangs the page while a debugger session is
      // attached, so pending dialogs auto-dismiss after a short hold — long
      // enough for a polling agent to answer with dialog_respond, short
      // enough to not wedge the tab.
      entry.timer = setTimeout(() => {
        if (entry.status !== 'pending') return;
        entry.status = 'auto-dismissed';
        // alert/confirm/prompt dismiss (cancel); beforeunload accepts so an
        // agent-driven navigation is not silently blocked by the leave prompt.
        const autoAccept = entry.type === 'beforeunload';
        sendUnqueued(source.tabId, 'Page.handleJavaScriptDialog', {
          accept: autoAccept,
        }).catch((err) => {
          console.warn('[agentbrowser] auto-dismiss of JS dialog failed', err);
        });
      }, DIALOG_HOLD_MS);
      break;
    }
    default:
      break;
  }
});

async function evaluate(tabId, expression) {
  const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(
      (d.exception && d.exception.description) || d.text || 'evaluation failed'
    );
  }
  return res.result ? res.result.value : undefined;
}

// --- tool implementations ----------------------------------------------------

export async function domInspect(tabId, args) {
  // sendCommand attaches on demand; no domains needed for Runtime.evaluate.
  const expr = domInspectExpression({
    selector: args.selector,
    all: args.all !== false,
    styles: args.styles,
    max: args.max,
  });
  return evaluate(tabId, expr);
}

export async function consoleLog(tabId, args) {
  await ensureDomains(tabId, ['Runtime', 'Log']);
  const s = state(tabId);
  const level = args.level ? String(args.level) : null;
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, CONSOLE_CAP));
  let entries = s.console;
  if (level) entries = entries.filter((e) => e.level === level);
  entries = entries.slice(-limit).map(({ ts, level: l, source, text, url }) => ({
    ts,
    level: l,
    source,
    text,
    url,
  }));
  if (args.clear) s.console = [];
  return { tabId, entries };
}

export async function networkLog(tabId, args) {
  await ensureDomains(tabId, ['Network']);
  const s = state(tabId);
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, NETWORK_CAP));
  const filter = args.filter ? String(args.filter) : null;
  let entries = [...s.requests.values()].sort((a, b) => a.startTime - b.startTime);
  if (filter) entries = entries.filter((e) => e.url.includes(filter));
  entries = entries.slice(-limit).map((e) => ({
    id: e.id,
    url: e.url,
    method: e.method,
    status: e.status ?? null,
    type: e.type || '',
    mimeType: e.mimeType || '',
    startTime: e.startTime,
    duration: e.duration ?? null,
    size: e.size ?? null,
    pending: !!e.pending,
    failed: !!e.failed,
    errorText: e.errorText,
    headers: args.includeHeaders
      ? { request: e.requestHeaders, response: e.responseHeaders }
      : undefined,
  }));
  const out = { tabId, entries };
  if (args.har) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    out.har = buildHar([...s.requests.values()], tab);
  }
  if (args.clear) s.requests = new Map();
  return out;
}

export async function a11yTree(tabId, args) {
  try {
    const res = await cdp.sendCommand(tabId, 'Accessibility.getFullAXTree', {});
    const nodes = (res.nodes || []).slice(0, 1000).map((n) => ({
      nodeId: n.nodeId,
      role: (n.role && (n.role.value || n.role.name)) || '',
      name: (n.name && (n.name.value || n.name.name)) || '',
      depth: n.depth ?? 0,
      ignored: !!n.ignored,
    }));
    return { source: 'axtree', nodes };
  } catch (err) {
    // Some debugger sessions reject the Accessibility domain; fall back to a
    // DOM-derived outline rather than failing the tool.
    console.warn('[agentbrowser] getFullAXTree unavailable, using DOM outline', err);
    return { source: 'outline', ...(await evaluate(tabId, outlineExpression(args.maxDepth))) };
  }
}

export async function dialogList(tabId) {
  // Page is enabled at attach (cdp.js) — this re-enable covers sessions
  // attached before that shipped; unqueued so a live dialog can't wedge it.
  sendUnqueued(tabId, 'Page.enable').catch((err) => {
    console.warn('[agentbrowser] Page.enable in dialog_list failed', err);
  });
  const s = state(tabId);
  return {
    dialogs: s.dialogs.map(({ type, message, url, ts, status }) => ({
      type,
      message,
      url,
      ts,
      status,
    })),
  };
}

export async function dialogRespond(tabId, args) {
  sendUnqueued(tabId, 'Page.enable').catch((err) => {
    console.warn('[agentbrowser] Page.enable in dialog_respond failed', err);
  });
  const s = state(tabId);
  const pending = s.dialogs.find((d) => d.status === 'pending');
  if (!pending) return { handled: false, reason: 'no pending dialog' };
  clearTimeout(pending.timer);
  const accept = args.accept === true;
  const params = { accept };
  if (accept && typeof args.promptText === 'string') params.promptText = args.promptText;
  try {
    await sendUnqueued(tabId, 'Page.handleJavaScriptDialog', params);
    pending.status = accept ? 'accepted' : 'dismissed';
    return { handled: true, type: pending.type, message: pending.message };
  } catch (err) {
    console.error('[agentbrowser] dialog_respond failed', err);
    throw new Error(`dialog_respond failed: ${String((err && err.message) || err)}`);
  }
}

export async function patchApply(tabId, args) {
  const s = state(tabId);
  const value = await evaluate(tabId, patchApplyExpression(args.patches));
  const patchId = `patch-${Date.now()}-${++s.patchSeq}`;
  const items = (value.results || []).flatMap((r) => r.items || []);
  s.patches.set(patchId, {
    label: String(args.label || ''),
    url: value.url,
    items,
  });
  return {
    patchId,
    url: value.url,
    applied: items.length,
    results: (value.results || []).map(({ selector, matched, error }) => ({
      selector,
      matched,
      error,
    })),
  };
}

export async function patchRevert(tabId, args) {
  const s = state(tabId);
  const rec = s.patches.get(String(args.patchId || ''));
  if (!rec) throw new Error(`unknown patchId: ${args.patchId}`);
  const value = await evaluate(tabId, patchRevertExpression(rec.items));
  if (value.missing === 0) s.patches.delete(String(args.patchId || ''));
  return { patchId: args.patchId, ...value };
}
