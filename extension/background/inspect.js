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
  summarizeCallFrames,
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
      breakpoints: new Map(), // breakpointId -> {id,url,lineNumber,columnNumber,condition,autoResumeMs}
      scripts: new Map(),  // scriptId -> url (Debugger.scriptParsed)
      paused: null,        // {reason,hitBreakpoints,ts,frames,rawFrames}
      waiters: [],         // debug_wait pending {resolve,timer}
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
  // Breakpoints die with the session; wake any debug_wait callers so they
  // don't sit on a dead debugger.
  s.breakpoints.clear();
  s.scripts.clear();
  s.paused = null;
  for (const w of s.waiters.splice(0)) {
    clearTimeout(w.timer);
    w.resolve({ paused: false, reason: 'detached' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const s = tabs.get(tabId);
  if (!s || !changeInfo.url) return;
  // Main-frame navigation: the page's console/network context is gone.
  // Breakpoints survive (they are URL-based); scripts and any live pause
  // state belong to the old document.
  s.console = [];
  s.requests = new Map();
  s.dialogs = [];
  s.scripts.clear();
  s.paused = null;
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
    case 'Page.downloadWillBegin': {
      const list = downloads.get(source.tabId) || [];
      list.push({
        guid: params.guid,
        url: String(params.url || ''),
        suggestedFilename: String(params.suggestedFilename || ''),
        state: 'inProgress',
        ts: Date.now(),
      });
      if (list.length > 50) list.splice(0, list.length - 50);
      downloads.set(source.tabId, list);
      break;
    }
    case 'Page.downloadProgress': {
      const list = downloads.get(source.tabId);
      if (!list) break;
      const d = list.find((e) => e.guid === params.guid);
      if (!d) break;
      d.state = String(params.state || d.state);
      d.receivedBytes = params.receivedBytes;
      d.totalBytes = params.totalBytes;
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
    case 'Debugger.scriptParsed': {
      if (params.scriptId && params.url) s.scripts.set(params.scriptId, params.url);
      break;
    }
    case 'Debugger.paused': {
      const frames = summarizeCallFrames(params.callFrames, s.scripts);
      s.paused = {
        reason: String(params.reason || 'other'),
        hitBreakpoints: params.hitBreakpoints || [],
        ts: Date.now(),
        frames,
        rawFrames: params.callFrames || [],
      };
      // The hitting breakpoint may have asked for a timed auto-resume; the
      // agent sets it per breakpoint so a forgotten resume can't wedge the tab.
      const auto = s.paused.hitBreakpoints
        .map((id) => s.breakpoints.get(id))
        .find((b) => b && b.autoResumeMs > 0);
      if (auto) {
        setTimeout(() => {
          if (!s.paused) return;
          sendUnqueued(source.tabId, 'Debugger.resume', {}).catch((err) => {
            console.warn('[agentbrowser] auto-resume failed', err);
          });
        }, auto.autoResumeMs);
      }
      for (const w of s.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(pausedPayload(s));
      }
      break;
    }
    case 'Debugger.resumed': {
      s.paused = null;
      break;
    }
    default:
      break;
  }
});

function pausedPayload(s) {
  if (!s.paused) return { paused: false, reason: 'not paused' };
  return {
    paused: true,
    reason: s.paused.reason,
    hitBreakpoints: s.paused.hitBreakpoints,
    callFrames: s.paused.frames.map(({ callFrameId, ...rest }) => rest),
    topCallFrameId: s.paused.frames[0] && s.paused.frames[0].callFrameId,
  };
}

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

// --- Debugger domain ---------------------------------------------------------

// Debugger commands go through sendUnqueued: while the page is paused the
// renderer does not run queued work, and Debugger.* itself is delivered fine —
// but keeping the paused-path commands unqueued mirrors the dialog case and
// never risks stalling behind page-side state.
export async function breakpointSet(tabId, args) {
  await ensureDomains(tabId, ['Debugger']);
  const params = {
    lineNumber: Math.max(0, Math.trunc(Number(args.lineNumber) || 0)),
  };
  if (args.urlRegex) params.urlRegex = String(args.urlRegex);
  else if (args.url) params.url = String(args.url);
  else throw new Error('breakpoint_set requires url or urlRegex');
  if (args.columnNumber != null) {
    params.columnNumber = Math.max(0, Math.trunc(Number(args.columnNumber) || 0));
  }
  if (args.condition) params.condition = String(args.condition);
  const res = await sendUnqueued(tabId, 'Debugger.setBreakpointByUrl', params);
  const s = state(tabId);
  const rec = {
    id: res.breakpointId,
    url: params.url || params.urlRegex,
    lineNumber: params.lineNumber,
    columnNumber: params.columnNumber ?? null,
    condition: params.condition || '',
    autoResumeMs: Math.max(0, Number(args.autoResumeMs) || 0),
    locations: (res.locations || []).map((l) => ({
      scriptId: l.scriptId,
      url: s.scripts.get(l.scriptId) || '',
      lineNumber: l.lineNumber,
      columnNumber: l.columnNumber,
    })),
  };
  s.breakpoints.set(res.breakpointId, rec);
  return { breakpoint: rec };
}

export async function breakpointList(tabId) {
  const s = state(tabId);
  return {
    breakpoints: [...s.breakpoints.values()].map((b) => ({ ...b })),
    paused: s.paused ? pausedPayload(s) : null,
  };
}

export async function breakpointRemove(tabId, args) {
  const s = state(tabId);
  const id = String(args.id || '');
  if (!id) throw new Error('breakpoint_remove requires id');
  if (!s.breakpoints.delete(id)) return { removed: false, reason: 'unknown id' };
  await sendUnqueued(tabId, 'Debugger.removeBreakpoint', { breakpointId: id });
  return { removed: true, id };
}

export async function debugWait(tabId, args) {
  await ensureDomains(tabId, ['Debugger']);
  const s = state(tabId);
  if (s.paused) return pausedPayload(s);
  const timeoutMs = Math.max(0, Math.min(Number(args.timeoutMs) || 30000, 300000));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = s.waiters.findIndex((w) => w.timer === timer);
      if (i >= 0) s.waiters.splice(i, 1);
      resolve({ paused: false, reason: 'timeout' });
    }, timeoutMs);
    s.waiters.push({ resolve, timer });
  });
}

export async function debugEval(tabId, args) {
  const s = state(tabId);
  if (!s.paused || !s.paused.rawFrames.length) {
    throw new Error('debug_eval requires a paused page (hit a breakpoint first)');
  }
  const frameId =
    args.callFrameId ||
    (s.paused.frames[0] && s.paused.frames[0].callFrameId);
  const res = await sendUnqueued(tabId, 'Debugger.evaluateOnCallFrame', {
    callFrameId: frameId,
    expression: String(args.expression || ''),
    returnByValue: true,
    silent: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    return {
      error:
        (d.exception && d.exception.description) || d.text || 'evaluation failed',
    };
  }
  return {
    callFrameId: frameId,
    result: res.result ? res.result.value : undefined,
  };
}

const RESUME_ACTIONS = new Set(['resume', 'stepOver', 'stepInto', 'stepOut']);

export async function debugResume(tabId, args) {
  const s = state(tabId);
  if (!s.paused) return { resumed: false, reason: 'not paused' };
  const action = RESUME_ACTIONS.has(args.action) ? args.action : 'resume';
  await sendUnqueued(tabId, `Debugger.${action}`, {});
  return { resumed: true, action };
}


// --- files, downloads, print (v2.6) -----------------------------------------

// set_file_input: assign local file paths to an <input type=file>. CDP never
// opens the OS picker — DOM.setFileInputFiles writes the file list directly.
export async function setFileInput(tabId, args) {
  const files = (Array.isArray(args.files) ? args.files : []).map(String);
  if (!files.length) throw new Error('set_file_input needs files:[]');
  await ensureDomains(tabId, ['DOM']);
  const { root } = await sendUnqueued(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await sendUnqueued(tabId, 'DOM.querySelector', {
    nodeId: root.nodeId,
    selector: String(args.selector || 'input[type=file]'),
  });
  if (!nodeId) throw new Error(`no file input matches: ${args.selector}`);
  await sendUnqueued(tabId, 'DOM.setFileInputFiles', { files, nodeId });
  return { set: true, selector: args.selector, files };
}

// downloads: Page.setDownloadBehavior opts the tab into auto-accept downloads
// (default dir <os-downloads>/agentbrowser) and Page.downloadWillBegin /
// downloadProgress events fill the buffer. downloads_list reads it.
const downloads = new Map(); // tabId -> [{guid,url,suggestedFilename,state,receivedBytes,totalBytes,ts}]

export async function downloadConfigure(tabId, args) {
  await ensureDomains(tabId, ['Page']);
  const s = state(tabId);
  if (!downloads.has(tabId)) downloads.set(tabId, []);
  const params = { behavior: 'allow' };
  if (args.directory) {
    params.behavior = 'allowAndName';
    params.downloadPath = String(args.directory);
  }
  try {
    await sendUnqueued(tabId, 'Page.setDownloadBehavior', params);
  } catch (err) {
    console.warn('[agentbrowser] Page.setDownloadBehavior failed, trying Browser domain', err);
    // Newer Chrome moved this to Browser.setDownloadBehavior; try that too
    // before giving up — which one works depends on the debug target.
    const bp = { behavior: params.downloadPath ? 'allowAndName' : 'allow' };
    if (params.downloadPath) bp.downloadPath = params.downloadPath;
    await sendUnqueued(tabId, 'Browser.setDownloadBehavior', bp);
  }
  s.downloadDir = params.downloadPath || null;
  return { configured: true, directory: s.downloadDir || '(browser default)' };
}

export async function downloadsList(tabId) {
  return { downloads: downloads.get(tabId) || [] };
}

// print_pdf: Page.printToPDF returns base64. landscape/scale are optional;
// defaults keep Chrome's print defaults.
export async function printPdf(tabId, args) {
  await ensureDomains(tabId, ['Page']);
  const params = {};
  if (args.landscape != null) params.landscape = !!args.landscape;
  if (args.scale != null) {
    params.scale = Math.max(0.1, Math.min(Number(args.scale), 2));
  }
  if (args.printBackground != null) params.printBackground = !!args.printBackground;
  const res = await sendUnqueued(tabId, 'Page.printToPDF', params);
  return { base64: res.data, mimeType: 'application/pdf' };
}
