// Side panel chat UI. Talks to sw.js over a chrome.runtime Port named
// "sidepanel" per PROTOCOL.md. Nothing here uses innerHTML: user text, tab
// titles, file names, tool chips and status lines go in with textContent, and
// assistant replies go through markdown.js, which builds DOM nodes with
// createElement/textContent.
//
// The top of this file is pure helpers with no DOM and no chrome API, so node
// can import and test them. Everything that touches the document lives inside
// init(), which only runs in a page.

import { renderMarkdown } from "./markdown.js";

// ---------------------------------------------------------------------------
// Pure helpers (tested in node)
// ---------------------------------------------------------------------------

// Total decoded attachment bytes accepted per message. The hub enforces the
// same cap and answers with an error event if it is exceeded.
export const MAX_ATTACH_BYTES = 8 * 1024 * 1024;

// Longest "@<short title>" token inserted into the textarea.
export const MENTION_TITLE_CHARS = 28;

// Schemes the panel refuses to describe as current-tab context: extension
// pages (including this panel) and browser-internal pages.
const BLOCKED_CONTEXT_SCHEME = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|moz-extension|view-source):/i;

export function isContextUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  return !BLOCKED_CONTEXT_SCHEME.test(url);
}

// Only http(s) tabs can be @-tagged. That drops chrome:// pages and the
// extension's own pages (chrome-extension://) in one test.
export function isTaggableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// chrome.Tab[] -> [{tabId,url,title}] keeping http(s) only, filtered by a
// case-insensitive substring of title or url.
export function filterTabs(tabs, query) {
  const q = String(query == null ? "" : query).trim().toLowerCase();
  const out = [];
  for (const t of tabs || []) {
    if (!t || t.id == null) continue;
    if (!isTaggableUrl(t.url)) continue;
    const title = t.title || t.url;
    if (q && !(title + " " + t.url).toLowerCase().includes(q)) continue;
    out.push({ tabId: t.id, url: t.url, title });
  }
  return out;
}

// Is the caret sitting in an "@query" token? Returns {start,end,query} or null.
// The "@" must start the text or follow whitespace, and the query itself must
// hold no whitespace, so "a@b" and "@foo bar" do not open the popup.
export function findMention(text, caret) {
  if (typeof text !== "string") return null;
  const max = text.length;
  let pos = Number.isFinite(caret) ? Math.floor(caret) : max;
  if (pos < 0) pos = 0;
  if (pos > max) pos = max;
  const before = text.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  if (query.length > 40) return null;
  return { start: at, end: pos, query };
}

// Title squeezed onto one line for the "@..." token in the textarea.
export function shortTitle(title, max = MENTION_TITLE_CHARS) {
  const flat = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  if (!flat) return "tab";
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// Replace the mention token with "@<short title> " and report the new caret.
export function applyMention(text, mention, title) {
  const token = "@" + shortTitle(title) + " ";
  const next = text.slice(0, mention.start) + token + text.slice(mention.end);
  return { text: next, caret: mention.start + token.length };
}

export function attachmentsTotalBytes(list) {
  let n = 0;
  for (const a of list || []) n += Number(a && a.size) || 0;
  return n;
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  const unit = b < 1024 * 1024 ? "KB" : "MB";
  const value = unit === "KB" ? b / 1024 : b / (1024 * 1024);
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return shown + " " + unit;
}

// Decide which incoming files fit under the decoded-size cap. Sizes are
// File.size (decoded bytes), never base64 length.
export function planAttachments(existing, incoming, max = MAX_ATTACH_BYTES) {
  let total = attachmentsTotalBytes(existing);
  const accepted = [];
  const rejected = [];
  for (const f of incoming || []) {
    const size = Number(f && f.size) || 0;
    if (total + size > max) {
      rejected.push(f);
      continue;
    }
    total += size;
    accepted.push(f);
  }
  const error = rejected.length
    ? rejected.length +
      " file(s) skipped: attachments would pass the " +
      formatBytes(max) +
      " limit"
    : "";
  return { accepted, rejected, total, error };
}

// "data:image/png;base64,AAAA" -> "AAAA"
export function stripDataUrlPrefix(dataUrl) {
  const s = String(dataUrl == null ? "" : dataUrl);
  const i = s.indexOf(",");
  return i === -1 ? "" : s.slice(i + 1);
}

// context per PROTOCOL.md, or null when there is nothing to send. Tagged tabs
// are deduped by tabId and never repeat currentTab; selection carries the
// clipped page-selection payload from the floating Ask button / context menu.
export function buildContext(currentTab, taggedTabs, selection) {
  const cur = currentTab
    ? { tabId: currentTab.tabId, url: currentTab.url, title: currentTab.title }
    : null;
  const seen = new Set();
  if (cur) seen.add(cur.tabId);
  const tabs = [];
  for (const t of taggedTabs || []) {
    if (!t || t.tabId == null || seen.has(t.tabId)) continue;
    seen.add(t.tabId);
    tabs.push({ tabId: t.tabId, url: t.url, title: t.title });
  }
  const sel = normalizeSelection(selection);
  if (!cur && tabs.length === 0 && !sel) return null;
  const ctx = { currentTab: cur, tabs };
  if (sel) ctx.selection = sel;
  return ctx;
}

// Field clamps for the selection context. The content script already caps the
// surrounding window at 800 chars; these bounds are what goes on the wire.
export const SELECTION_LIMITS = {
  text: 4000,
  surrounding: 800,
  heading: 200,
  path: 300,
  code: 8000,
  table: 4000,
};

function clipField(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) : t;
}

// Normalize a content-script payload into the wire shape, or null when it has
// no text at all (right-clicks on blank space carry nothing worth sending).
export function normalizeSelection(sel) {
  if (!sel || typeof sel !== "object") return null;
  const text = clipField(sel.text, SELECTION_LIMITS.text).trim();
  if (!text) return null;
  const contentType = ["text", "code", "table"].includes(sel.contentType)
    ? sel.contentType
    : "text";
  const out = {
    text,
    contentType,
    surroundingBefore: clipField(sel.surroundingBefore, SELECTION_LIMITS.surrounding).trim(),
    surroundingAfter: clipField(sel.surroundingAfter, SELECTION_LIMITS.surrounding).trim(),
    parentHeading: clipField(sel.parentHeading, SELECTION_LIMITS.heading).trim(),
    semanticPath: clipField(sel.semanticPath, SELECTION_LIMITS.path).trim(),
    pageUrl: clipField(sel.pageUrl, 2000).trim(),
    pageTitle: clipField(sel.pageTitle, 300).trim(),
  };
  if (contentType === "code" && sel.codeBlock && typeof sel.codeBlock === "object") {
    out.codeBlock = {
      language: clipField(sel.codeBlock.language, 40).trim() || "code",
      fullCode: clipField(sel.codeBlock.fullCode, SELECTION_LIMITS.code),
    };
  }
  if (contentType === "table" && typeof sel.tableBlock === "string" && sel.tableBlock) {
    out.tableBlock = clipField(sel.tableBlock, SELECTION_LIMITS.table);
  }
  return out;
}

// The wire message. context, attachments and model keys are absent (not
// undefined) when empty: the Port structure-clones this object, which would
// otherwise carry present-but-undefined keys to the hub and break the "plain
// text prompt" backward-compatible path.
export function buildChatMessage(opts) {
  const msg = {
    type: "chat",
    chatId: opts.chatId,
    text: opts.text,
    adapter: opts.adapter,
  };
  // No model = adapter default. Only a non-empty id goes on the wire.
  if (opts.model) msg.model = String(opts.model);
  const context = buildContext(opts.currentTab, opts.taggedTabs, opts.selection);
  if (context) msg.context = context;
  const files = [];
  for (const a of opts.attachments || []) {
    if (!a || typeof a.base64 !== "string") continue; // still being read
    files.push({ name: a.name, mimeType: a.mimeType, base64: a.base64 });
  }
  if (files.length) msg.attachments = files;
  return msg;
}

// Fallback when File.type is empty (Chrome leaves it blank for many files).
const EXT_MIME = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  html: "text/html",
  css: "text/css",
  py: "text/x-python",
  sh: "text/x-shellscript",
  yml: "text/yaml",
  yaml: "text/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function guessMimeType(name, type) {
  if (type) return type;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  const ext = m ? m[1].toLowerCase() : "";
  return EXT_MIME[ext] || "application/octet-stream";
}

// The last chat payload handed to the Port, kept verbatim so a retry re-sends
// the same object: same chatId, same context, same attachments. Cleared by
// newChat, because the payload's chatId belongs to the conversation that was
// just thrown away and the hub would drop every event for it.
let lastSentPayload = null;

// A stored payload can be re-sent only on a live Port with no turn in flight.
export function canRetry(connected, streaming, payload) {
  return !!connected && !streaming && !!payload && typeof payload === "object";
}

// ----- work block, meta line -----

// The live block's label when the adapter sends no label of its own. It walks
// the list so a long turn does not look stuck on one word.
export const WORK_LABELS = ["Thinking", "Cooking", "Working"];

export function rotatingLabel(i) {
  const n = Number(i);
  if (!Number.isFinite(n)) return WORK_LABELS[0];
  const idx = Math.floor(n) % WORK_LABELS.length;
  return WORK_LABELS[idx < 0 ? idx + WORK_LABELS.length : idx];
}

// 12432 -> "12.4s". One decimal below 100s, whole seconds above.
export function formatDuration(ms) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n) || n < 0) return "";
  const s = n / 1000;
  const shown =
    s < 100 ? (Math.round(s * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(s));
  return shown + "s";
}

// 1200 -> "1.2k", 24100 -> "24.1k", 240000 -> "240k". null for "no count
// reported", which the meta line and the session readout both omit. The decimal
// is kept up to 100k because a conversation's running total sits in that range
// and rounding it to whole thousands would leave it looking stuck.
export function formatTokenCount(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return (k < 100 ? (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(k))) + "k";
}

// 0.021 -> "$0.021", 0.14 -> "$0.14". Two decimals minimum so a round number
// still reads as money; three when the third digit carries the value. null for
// "no price known", which every caller omits rather than printing "$0.00".
export function formatCostUsd(usd) {
  if (usd == null || usd === "") return null;
  const v = Number(usd);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v > 0 && v < 0.001) return "<$0.001"; // a real charge, too small to print
  let s = v.toFixed(3);
  if (s.endsWith("0")) s = s.slice(0, -1); // 0.140 -> 0.14; 0.021 is left alone
  return "$" + s;
}

// "<model> via <adapter> · 12.4s · 1.2k in / 340 out · $0.021". Missing pieces
// drop out rather than printing "undefined"; an empty string means "render
// nothing". Cache token counts are carried on the event but stay off this line:
// they are a detail of how the input was billed, not of what the turn did.
export function formatMetaLine(meta) {
  if (!meta || typeof meta !== "object") return "";
  const model = typeof meta.model === "string" ? meta.model.trim() : "";
  const adapter = typeof meta.adapter === "string" ? meta.adapter.trim() : "";
  const parts = [];
  if (model && adapter) parts.push(model + " via " + adapter);
  else if (model || adapter) parts.push(model || adapter);
  const dur = formatDuration(meta.elapsedMs);
  if (dur) parts.push(dur);
  const inTok = formatTokenCount(meta.inputTokens);
  const outTok = formatTokenCount(meta.outputTokens);
  if (inTok !== null && outTok !== null) parts.push(inTok + " in / " + outTok + " out");
  else if (inTok !== null) parts.push(inTok + " in");
  else if (outTok !== null) parts.push(outTok + " out");
  const cost = formatCostUsd(meta.costUsd);
  // "~" marks a figure derived from rates we guessed rather than published
  // ones, so an estimate never reads as a billed amount.
  if (cost !== null) parts.push(meta.costEstimated ? "~" + cost : cost);
  return parts.join(" · ");
}

// ----- session usage -----

// Running totals for one conversation. costUsd is summed in the panel: the
// meta event carries a per-turn price and session token counts, but no session
// price. hasCost stays false for subscription adapters so the readout shows no
// "$0.00" for turns nobody was billed for.
export function emptySession() {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false, turns: 0 };
}

function finiteCount(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// Fold one meta event into the running totals. The hub owns the token totals,
// so its sessionInputTokens / sessionOutputTokens win when it sends them; a
// turn that only reports its own numbers is added on instead.
export function accumulateSession(prev, meta) {
  const base = prev && typeof prev === "object" ? prev : emptySession();
  const out = {
    inputTokens: Number(base.inputTokens) || 0,
    outputTokens: Number(base.outputTokens) || 0,
    costUsd: Number(base.costUsd) || 0,
    hasCost: !!base.hasCost,
    turns: Number(base.turns) || 0,
  };
  if (!meta || typeof meta !== "object") return out;

  const sessionIn = finiteCount(meta.sessionInputTokens);
  const sessionOut = finiteCount(meta.sessionOutputTokens);
  const turnIn = finiteCount(meta.inputTokens);
  const turnOut = finiteCount(meta.outputTokens);
  out.inputTokens = sessionIn !== null ? sessionIn : out.inputTokens + (turnIn || 0);
  out.outputTokens = sessionOut !== null ? sessionOut : out.outputTokens + (turnOut || 0);

  const cost = finiteCount(meta.costUsd);
  if (cost !== null) {
    out.costUsd += cost;
    out.hasCost = true;
  }
  out.turns += 1;
  return out;
}

// "session: 24.1k in / 3.2k out · $0.14". Empty until a turn has reported
// something worth showing.
export function formatSessionLine(session) {
  if (!session || typeof session !== "object") return "";
  const inTok = Number(session.inputTokens) || 0;
  const outTok = Number(session.outputTokens) || 0;
  if (inTok === 0 && outTok === 0 && !session.hasCost) return "";
  const parts = [
    "session: " + (formatTokenCount(inTok) || "0") + " in / " + (formatTokenCount(outTok) || "0") + " out",
  ];
  if (session.hasCost) {
    const cost = formatCostUsd(session.costUsd);
    if (cost !== null) parts.push(cost);
  }
  return parts.join(" · ");
}

// ----- slash commands -----

// Commands the panel answers by itself. A handler cannot travel over the wire,
// so the hub's registry says which names are client-scope and this list says
// which of those the panel actually knows how to run.
export const CLIENT_COMMANDS = ["clear", "model", "adapter", "keys", "stop"];

// Is the caret inside the leading "/command" token? Only an input that starts
// with "/" qualifies, and only until the first space: once arguments begin the
// palette is out of the way. Returns {start,end,query} or null.
export function findCommandToken(text, caret) {
  if (typeof text !== "string" || text[0] !== "/") return null;
  const max = text.length;
  let pos = Number.isFinite(caret) ? Math.floor(caret) : max;
  if (pos < 1) return null; // caret sitting before the "/" is not in the token
  if (pos > max) pos = max;
  const before = text.slice(0, pos);
  if (/\s/.test(before)) return null;
  const query = before.slice(1);
  if (query.length > 40) return null;
  return { start: 0, end: pos, query };
}

function normalizeCommand(c) {
  if (!c || typeof c.name !== "string") return null;
  const name = c.name.replace(/^\//, "").trim();
  if (!name) return null;
  return {
    name,
    args: typeof c.args === "string" ? c.args : "",
    summary: typeof c.summary === "string" ? c.summary : "",
    scope: c.scope === "client" ? "client" : "server",
  };
}

// The registry, cleaned up. Anything the hub did not send is not a command:
// there is no built-in list to fall back to.
export function normalizeCommands(list) {
  const out = [];
  for (const c of list || []) {
    const entry = normalizeCommand(c);
    if (entry && !out.some((e) => e.name === entry.name)) out.push(entry);
  }
  return out;
}

export function commandEntry(commands, name) {
  const want = String(name == null ? "" : name).replace(/^\//, "").toLowerCase();
  for (const c of normalizeCommands(commands)) {
    if (c.name.toLowerCase() === want) return c;
  }
  return null;
}

// Rows for the palette: name-prefix matches first, then anything whose name or
// summary contains the query.
export function filterCommands(commands, query) {
  const q = String(query == null ? "" : query).trim().toLowerCase();
  const prefix = [];
  const rest = [];
  for (const c of normalizeCommands(commands)) {
    const name = c.name.toLowerCase();
    if (!q) {
      prefix.push(c);
      continue;
    }
    if (name.startsWith(q)) prefix.push(c);
    else if ((name + " " + c.summary.toLowerCase()).includes(q)) rest.push(c);
  }
  return prefix.concat(rest);
}

// Replace the "/query" token with "/<name> ", leaving whatever followed it.
export function applyCommand(text, token, name) {
  const src = typeof text === "string" ? text : "";
  const cmd = "/" + String(name == null ? "" : name).replace(/^\//, "") + " ";
  const end = token && Number.isFinite(token.end) ? token.end : src.length;
  const next = cmd + src.slice(end);
  return { text: next, caret: cmd.length };
}

// "/loop 3 refresh the page" -> {name:"loop", args:"3 refresh the page"}.
// null when the line is not a command at all.
export function parseCommandLine(text) {
  const s = String(text == null ? "" : text).trim();
  if (s[0] !== "/") return null;
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  return { name: m[1], args: (m[2] || "").trim() };
}

// What Send should do with this line.
//   {mode:"chat"}                      ordinary message, including "/nope"
//   {mode:"client", name, args}        the panel runs it, nothing goes on the wire
//   {mode:"server", name, args}        a {type:"command"} message goes to the hub
// An unknown "/foo" is chat, never swallowed. A client-scope command the panel
// has no handler for is chat too: better sent than silently dropped.
export function planSend(text, commands, handled = CLIENT_COMMANDS) {
  const parsed = parseCommandLine(text);
  if (!parsed) return { mode: "chat" };
  const entry = commandEntry(commands, parsed.name);
  if (!entry) return { mode: "chat" };
  if (entry.scope === "client") {
    if (!(handled || []).includes(entry.name)) return { mode: "chat" };
    return { mode: "client", name: entry.name, args: parsed.args };
  }
  return { mode: "server", name: entry.name, args: parsed.args };
}

// The wire message for a server command. Same omit-when-empty discipline as
// buildChatMessage: the Port structure-clones this, and a present-but-undefined
// model or context would reach the hub as a key it has to defend against.
export function buildCommandMessage(opts) {
  const msg = {
    type: "command",
    chatId: opts.chatId,
    name: String(opts.name || "").replace(/^\//, ""),
    args: typeof opts.args === "string" ? opts.args : "",
    adapter: opts.adapter,
  };
  if (opts.model) msg.model = String(opts.model);
  const context = buildContext(opts.currentTab, opts.taggedTabs);
  if (context) msg.context = context;
  return msg;
}

// ----- parallel lanes -----

// The {index,tabId,title} an event was tagged with, or null for the ordinary
// single-track transcript.
export function laneOf(event) {
  const lane = event && typeof event === "object" ? event.lane : null;
  if (!lane || typeof lane !== "object") return null;
  const index = Number(lane.index);
  if (!Number.isFinite(index) || index < 0) return null;
  return {
    index: Math.floor(index),
    tabId: lane.tabId == null ? null : lane.tabId,
    title: typeof lane.title === "string" ? lane.title : "",
  };
}

// "Lane 2 · Pricing page". index is 0-based on the wire and 1-based on screen,
// which is the only place that conversion happens.
export function laneLabel(lane) {
  if (!lane) return "";
  const head = "Lane " + (Number(lane.index) + 1);
  const title = String(lane.title == null ? "" : lane.title).replace(/\s+/g, " ").trim();
  return title ? head + " · " + title : head;
}

// Lane bookkeeping for a streaming turn: which bucket an event belongs to, in
// lane order, with a slot for the DOM the panel hangs off each lane. The panel
// and the tests route through this same object, so "grouped correctly" means
// the same thing in both.
export function makeLaneGrouper() {
  const lanes = new Map();
  return {
    lanes,
    // In lane order, which is arrival order of the first event per lane.
    list() {
      return [...lanes.values()].sort((a, b) => a.index - b.index);
    },
    route(event) {
      const lane = laneOf(event);
      if (!lane) return { target: "main", lane: null, event };
      let entry = lanes.get(lane.index);
      if (!entry) {
        entry = {
          index: lane.index,
          tabId: lane.tabId,
          title: lane.title,
          count: 0,
          view: null, // the panel's DOM for this lane
        };
        lanes.set(lane.index, entry);
      }
      if (!entry.title && lane.title) entry.title = lane.title;
      if (entry.tabId == null && lane.tabId != null) entry.tabId = lane.tabId;
      entry.count += 1;
      return { target: "lane", lane: entry, event };
    },
  };
}

// The static line the live block collapses to once the turn ends.
export function summarizeWork(elapsedMs, steps) {
  const n = Math.max(0, Math.floor(Number(steps) || 0));
  const secs = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000));
  const head = "Worked for " + secs + "s";
  if (n === 0) return head;
  return head + ", " + n + (n === 1 ? " step" : " steps");
}

export function stepLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return count === 1 ? "1 step" : count + " steps";
}

// ----- capabilities -----

export function adapterEntry(adapters, name) {
  for (const a of adapters || []) if (a && a.name === name) return a;
  return null;
}

// The model list for one adapter. [] means the adapter has no model switch and
// the picker stays hidden.
export function modelsFor(adapters, name) {
  const a = adapterEntry(adapters, name);
  const models = a && Array.isArray(a.models) ? a.models.filter((m) => m && typeof m.id === "string") : [];
  const defaultModel = a && typeof a.defaultModel === "string" ? a.defaultModel : null;
  return { models, defaultModel };
}

// Which model id to show: the remembered one when the adapter still offers it,
// then the adapter's default, then the first entry.
export function pickModel(adapters, name, wanted) {
  const { models, defaultModel } = modelsFor(adapters, name);
  if (models.length === 0) return null;
  if (wanted && models.some((m) => m.id === wanted)) return wanted;
  if (defaultModel && models.some((m) => m.id === defaultModel)) return defaultModel;
  return models[0].id;
}

// capabilities only ever carries keyConfigured, never a key.
export function keyStateFromCapabilities(adapters) {
  const out = { anthropic: false, openai: false };
  for (const a of adapters || []) {
    if (!a || !a.provider || !a.keyConfigured) continue;
    if (Object.prototype.hasOwnProperty.call(out, a.provider)) out[a.provider] = true;
  }
  return out;
}

// key null clears the stored key. Whitespace-only input counts as a clear.
export function buildSetKeyMessage(provider, key) {
  const value = typeof key === "string" ? key.trim() : "";
  return { type: "set_key", provider, key: value === "" ? null : value };
}

// ---------------------------------------------------------------------------
// Panel (browser only)
// ---------------------------------------------------------------------------

function init() {
  const statusDot = document.getElementById("status-dot");
  const backendSelect = document.getElementById("backend");
  const settingsBtn = document.getElementById("settings-btn");
  const settingsView = document.getElementById("settings-view");
  const settingsClose = document.getElementById("settings-close");
  const chatSwitcher = document.getElementById("chat-switcher");
  const banner = document.getElementById("banner");
  const messagesEl = document.getElementById("messages");
  const composerEl = document.getElementById("composer");
  const chipsEl = document.getElementById("chips");
  const attachmentsEl = document.getElementById("attachments");
  const composerErrorEl = document.getElementById("composer-error");
  const interimEl = document.getElementById("interim");
  const mentionEl = document.getElementById("mention-pop");
  const commandEl = document.getElementById("command-pop");
  const sessionEl = document.getElementById("session-usage");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const abortBtn = document.getElementById("abort");
  const attachBtn = document.getElementById("attach");
  const micBtn = document.getElementById("mic");
  const fileInput = document.getElementById("file-input");

  // Key rows: one entry per provider the hub can hold a key for.
  const KEY_FIELDS = [
    {
      provider: "anthropic",
      input: document.getElementById("key-anthropic"),
      state: document.getElementById("key-anthropic-state"),
      save: document.getElementById("key-anthropic-save"),
      clear: document.getElementById("key-anthropic-clear"),
    },
    {
      provider: "openai",
      input: document.getElementById("key-openai"),
      state: document.getElementById("key-openai-state"),
      save: document.getElementById("key-openai-save"),
      clear: document.getElementById("key-openai-clear"),
    },
  ];

  const BASE_PLACEHOLDER = inputEl.placeholder;

  let port = null;
  let connected = false;
  let chatId = crypto.randomUUID();
  let streaming = false;
  let archived = false; // viewing a dead transcript: a send starts a new chat
  let knownChats = []; // last chat_list the hub sent
  let assistantEl = null; // current streaming assistant block
  let pendingChips = []; // [{tool, statusEl, chipEl}] awaiting tool_result
  let retryBtn = null; // the one "Retry" button under a failed turn, if any

  let turnEl = null; // .turn wrapper holding the current assistant turn
  let workBlock = null; // the live thinking/cooking block for this turn
  let workTimer = null; // 1s tick driving the elapsed counter and the label
  let workTick = 0;
  let turnMeta = null; // last {kind:"meta"} event of this turn
  let actionsRow = null; // the finished turn's action row, if it has one

  let laneGrouper = null; // lane bookkeeping for the turn in flight, if any
  let laneGroupEl = null; // the stack of lane blocks inside this turn

  let session = emptySession(); // token/cost totals for this conversation

  let adapters = []; // capabilities: [{name,label,models,defaultModel,...}]
  let commands = []; // capabilities: [{name,args,summary,scope}] from the hub
  let prefAdapter = null; // remembered choices from chrome.storage.local
  let prefModel = null;
  let selAdapter = ""; // current adapter name
  let selModel = null; // current model id, or null when the adapter has none
  let keyState = { anthropic: false, openai: false };

  let currentTab = null; // {tabId,url,title} or null
  let currentTabOff = false; // user clicked X on the current-tab chip
  let taggedTabs = []; // [{tabId,url,title}] from @ mentions
  let selectionCtx = null; // normalized selection payload staged for next send
  let selectionAppliedTs = 0; // timestamp of the pendingSelection already taken
  let attachments = []; // [{name,mimeType,size,base64|null}]
  let reading = 0; // files still being read by FileReader

  let mention = null; // {start,end,query} while the popup is open
  let mentionRows = []; // [{tabId,url,title}] currently listed
  let mentionIndex = 0;
  let mentionSeq = 0; // drops results of stale chrome.tabs.query calls

  let palette = null; // {start,end,query} while the command palette is open
  let paletteRows = []; // [{name,args,summary,scope}] currently listed
  let paletteIndex = 0;

  let recognition = null;
  let listening = false;

  // ----- Port lifecycle -----

  function connectPort() {
    port = chrome.runtime.connect({ name: "sidepanel" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Service worker restarted or panel got cut off. Show red until the new
      // Port delivers a fresh status message. A restarted worker drops events
      // for chatIds it no longer knows, so a mid-chat stream cannot finish;
      // unwind it here or the panel stays locked in streaming forever.
      if (streaming) {
        failPendingChips("connection lost");
        addLine("error", "connection to background restarted; chat stream lost");
        finishTurn();
        endStreaming();
        showRetryButton();
      }
      setConnected(false);
      setTimeout(connectPort, 500);
    });
    postToHub({ type: "get_capabilities" });
    postToHub({ type: "chat_list" });
  }

  // One send path for everything that is not a chat turn, so a dead Port never
  // throws out of an event handler.
  function postToHub(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (err) {
      console.warn("[agentbrowser] postToHub failed", err);
      setConnected(false);
      return false;
    }
  }

  function onPortMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    // Careful: msg.type "status" is the hub connection; a chat_event of
    // kind "status" is the agent's own thinking/working state. Different
    // things at different levels.
    if (msg.type === "status") {
      setConnected(!!msg.connected);
    } else if (msg.type === "capabilities") {
      applyCapabilities(
        Array.isArray(msg.adapters) ? msg.adapters : [],
        Array.isArray(msg.commands) ? msg.commands : []
      );
    } else if (msg.type === "chat_event") {
      if (msg.chatId !== chatId) return; // stale conversation
      handleChatEvent(msg.event || {});
    } else if (msg.type === "chat_list") {
      knownChats = Array.isArray(msg.chats) ? msg.chats : [];
      renderSwitcher();
    } else if (msg.type === "chat_resumed") {
      if (msg.found) {
        loadChat(msg);
      } else {
        // Gone between list and resume — drop it and re-sync the dropdown.
        knownChats = knownChats.filter((c) => c.chatId !== msg.chatId);
        renderSwitcher();
        requestChatList();
        showComposerError("that conversation is gone from the hub");
      }
    }
  }

  function requestChatList() {
    postToHub({ type: "chat_list" });
  }

  // One dropdown for history + new chat, centered in the header. The current
  // conversation renders as "New chat" until the hub knows it.
  function renderSwitcher() {
    if (!chatSwitcher) return;
    const opts = [makeOption("__new__", "+ New chat")];
    const current = knownChats.find((c) => c.chatId === chatId);
    if (!current) opts.push(makeOption(chatId, "New chat"));
    for (const c of knownChats) {
      const title = String(c.title || "(untitled)").slice(0, 40);
      opts.push(makeOption(c.chatId, c.live ? title + " (live)" : title));
    }
    chatSwitcher.replaceChildren(...opts);
    chatSwitcher.value = chatId;
  }

  // Re-open a conversation the hub still has a transcript for. live === the
  // adapter session survived (hub uptime), so the chat continues where it left
  // off; dead sessions render read-only and a send detaches into a fresh chat.
  function loadChat(msg) {
    resetChatState(msg.chatId);
    archived = !msg.live;
    for (const m of msg.msgs || []) {
      if (m.role === "user") addUserMessage(String(m.text || ""), null, null);
      else if (m.role === "assistant") addArchiveAssistant(String(m.text || ""));
    }
    addLine(
      "system",
      archived
        ? "Archived conversation — sending a message starts a new chat."
        : "Resumed live conversation."
    );
    if (msg.adapter && adapters.some((a) => a.name === msg.adapter)) {
      selAdapter = msg.adapter;
    }
    renderBackendSelect(msg.model || undefined);
    renderSwitcher();
    inputEl.focus();
  }

  // Static assistant bubble for transcripts: markdown rendered once, no
  // streaming, no meta, no action row.
  function addArchiveAssistant(text) {
    const el = document.createElement("div");
    el.className = "msg assistant";
    try {
      el.appendChild(renderMarkdown(text));
    } catch (err) {
      console.warn("[agentbrowser] archive markdown render failed", err);
      el.classList.add("raw");
      el.textContent = text;
    }
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // ----- capabilities, model picker, stored preferences -----

  function makeOption(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  // The command list is whatever the hub sent, normalized. There is no built-in
  // fallback: a hub with no registry means the panel offers no commands, and
  // "/anything" goes out as ordinary chat text.
  function applyCapabilities(list, commandList) {
    adapters = list;
    commands = normalizeCommands(commandList);
    if (palette) updatePalette();
    renderBackendSelect();
    keyState = keyStateFromCapabilities(adapters);
    renderKeyState();
  }

  // The merged backend picker encodes "adapter::model" in each option value
  // ("adapter::" when the adapter has no model switch). Adapters with models
  // render as an optgroup of their models; adapters without render flat.
  function backendValue(adapter, model) {
    return adapter + "::" + (model || "");
  }

  function renderBackendSelect(preferredModel) {
    backendSelect.replaceChildren();
    const flat = [];
    for (const a of adapters) {
      const { models } = modelsFor(adapters, a.name);
      if (models.length === 0) {
        backendSelect.appendChild(makeOption(backendValue(a.name), a.label || a.name));
        flat.push({ adapter: a.name, model: null });
      } else {
        const group = document.createElement("optgroup");
        group.label = a.label || a.name;
        for (const m of models) {
          group.appendChild(makeOption(backendValue(a.name, m.id), m.label || m.id));
        }
        backendSelect.appendChild(group);
        for (const m of models) flat.push({ adapter: a.name, model: m.id });
      }
    }
    // Keep the current adapter when it still exists; otherwise the remembered
    // one, otherwise the first entry. A select silently keeps "" when the
    // value matches no option, so the fallback has to be explicit.
    const have = (n) => adapters.some((a) => a && a.name === n);
    selAdapter = have(selAdapter) ? selAdapter : have(prefAdapter) ? prefAdapter : (flat[0] ? flat[0].adapter : "");
    selModel = pickModel(adapters, selAdapter, preferredModel || selModel || prefModel);
    const want = backendValue(selAdapter, selModel);
    backendSelect.value = want;
    if (backendSelect.value !== want) backendSelect.value = flat[0] ? backendValue(flat[0].adapter, flat[0].model) : "";
    backendSelect.hidden = flat.length === 0;
    // The collapsed text shows only the short label; the tooltip carries the
    // full "adapter · model" identity.
    const selA = adapterEntry(adapters, selAdapter);
    backendSelect.title = (selA && (selA.label || selA.name) || selAdapter) + (selModel ? " · " + selModel : "");
  }

  // The model that rides on the next chat message, or undefined for "adapter
  // default" (selModel stays null when the adapter has no model switch).
  function currentModel() {
    return selModel || undefined;
  }

  function storage() {
    return chrome.storage && chrome.storage.local ? chrome.storage.local : null;
  }

  function loadPrefs() {
    const store = storage();
    if (!store) return;
    let got;
    try {
      got = store.get(["adapter", "model"]);
    } catch (err) {
      console.warn("[agentbrowser] prefs read failed", err);
      return;
    }
    Promise.resolve(got)
      .then((v) => {
        if (!v || typeof v !== "object") return;
        if (typeof v.adapter === "string" && v.adapter) prefAdapter = v.adapter;
        if (typeof v.model === "string" && v.model) prefModel = v.model;
        // renderBackendSelect restores only choices the list can still hold.
        renderBackendSelect(prefModel);
      })
      .catch((err) => console.warn("[agentbrowser] prefs restore failed", err));
  }

  function savePrefs() {
    const store = storage();
    if (!store) return;
    try {
      const out = { adapter: selAdapter };
      const model = currentModel();
      // An adapter with no model switch leaves the remembered model alone, so
      // a detour through one does not forget it.
      if (model !== undefined) out.model = model;
      Promise.resolve(store.set(out)).catch((err) =>
        console.warn("[agentbrowser] prefs write failed", err)
      );
    } catch (err) {
      // storage is best effort; the panel still works without it
      console.warn("[agentbrowser] prefs write failed", err);
    }
  }

  // ----- settings view -----

  function renderKeyState() {
    for (const field of KEY_FIELDS) {
      const on = !!keyState[field.provider];
      field.state.textContent = on ? "configured" : "not set";
      field.state.classList.toggle("on", on);
    }
  }

  function setSettingsOpen(open) {
    settingsView.hidden = !open;
    messagesEl.hidden = open;
    composerEl.hidden = open;
    settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderKeyState();
      postToHub({ type: "get_capabilities" });
    } else {
      for (const field of KEY_FIELDS) field.input.value = "";
      inputEl.focus();
    }
  }

  function sendKey(field, key) {
    // Save on an empty field is a slip, not a request to clear: Clear does
    // that, and only that, by passing null.
    if (typeof key === "string" && key.trim() === "") {
      field.state.textContent = "enter a key first";
      field.state.classList.remove("on");
      return;
    }
    // The hub answers with a fresh capabilities message, which is what flips
    // the row back to "configured" / "not set".
    if (!postToHub(buildSetKeyMessage(field.provider, key))) {
      field.state.textContent = "hub unreachable";
      return;
    }
    field.input.value = "";
    field.state.textContent = key === null ? "clearing…" : "saving…";
    field.state.classList.remove("on");
  }

  // ----- Status / banner -----

  function setConnected(up) {
    const wasConnected = connected;
    connected = up;
    // A hub that just came back may have a different adapter or key set.
    if (up && !wasConnected) postToHub({ type: "get_capabilities" });
    statusDot.classList.toggle("up", up);
    statusDot.classList.toggle("down", !up);
    statusDot.title = up ? "hub connected" : "hub disconnected";
    banner.hidden = up;
    updateControls();
  }

  function updateControls() {
    const canSend = connected && !streaming && reading === 0;
    sendBtn.disabled = !canSend;
    inputEl.disabled = !connected;
    attachBtn.disabled = !connected || streaming;
    micBtn.disabled = !connected;
    abortBtn.hidden = !streaming;
    statusDot.classList.toggle("working", connected && streaming);
    // The disconnect unwind renders Retry while the Port is down; it comes back
    // to life on its own once the reconnect delivers a fresh status.
    if (retryBtn) retryBtn.disabled = !canRetry(connected, streaming, lastSentPayload);
  }

  // The running total under the composer. Hidden until a turn reports usage,
  // so a conversation with a subscription adapter that reports nothing does not
  // carry an empty row.
  function renderSessionUsage() {
    const line = formatSessionLine(session);
    sessionEl.textContent = line;
    sessionEl.hidden = line === "";
  }

  // ----- Rendering helpers -----

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Refresh glyph (circular arrow). createElementNS, not createElement: an
  // <svg> built in the HTML namespace parses but renders nothing.
  function refreshIcon(size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    // Arc from (21,12) round to (12,3), carried into the arrowhead vertex at
    // (21,8) so the head sits on the stroke instead of floating beside it.
    path.setAttribute("d", "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5");
    svg.appendChild(path);
    return svg;
  }

  // payload is the exact object that went over the Port for this turn, so the
  // resend icon on this bubble can put the identical message back on the wire.
  function addUserMessage(text, meta, payload) {
    const el = document.createElement("div");
    el.className = "msg user";

    // A child span, not el.textContent: the resend button and the meta line are
    // siblings of the text, and textContent would drop them on the next write.
    const body = document.createElement("span");
    body.className = "msg-text";
    body.textContent = text;
    el.appendChild(body);

    if (meta) {
      const m = document.createElement("div");
      m.className = "msg-meta";
      m.textContent = meta;
      el.appendChild(m);
    }
    if (payload) {
      el.retryPayload = payload;
      const resend = document.createElement("button");
      resend.type = "button";
      resend.className = "resend-btn";
      resend.title = "Send this message again";
      resend.setAttribute("aria-label", "Send this message again");
      resend.appendChild(refreshIcon(14));
      resend.addEventListener("click", () => resendPayload(el.retryPayload));
      el.appendChild(resend);
    }

    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function clearRetryButton() {
    if (retryBtn) {
      const row = retryBtn.parentNode;
      retryBtn.remove();
      retryBtn = null;
      // The row it sat in was pinned open for it; let it go back to
      // hover-reveal once nothing in it needs to be seen at rest.
      if (row && row.classList && row.classList.contains("turn-actions")) {
        const stillPinned = [...row.children].some(
          (c) => c.classList && c.classList.contains("retry-btn")
        );
        if (!stillPinned) row.classList.remove("show");
      }
    }
  }

  // Ghost "Retry" under the failed turn. Survives until the turn is retried, a
  // new message is sent, or the chat is cleared.
  function showRetryButton() {
    clearRetryButton();
    if (!lastSentPayload) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retry-btn";
    btn.title = "Send the last message again";
    const label = document.createElement("span");
    label.textContent = "Retry";
    btn.append(refreshIcon(14), label);
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      // resendPayload removes this button on success; put it back in reach if
      // the send did not happen.
      if (!resendPayload(lastSentPayload)) btn.disabled = false;
    });
    // Same row as Copy when the failed turn produced one. A hover-revealed
    // Retry would be unreachable, so the row is pinned open while it is there.
    if (actionsRow) {
      actionsRow.classList.add("show");
      actionsRow.appendChild(btn);
    } else {
      messagesEl.appendChild(btn);
    }
    retryBtn = btn;
    updateControls();
    scrollToBottom();
  }

  // Re-send a stored payload verbatim. Reads `port` at call time: a reconnect
  // replaces the object, and a closure would hold the dead one.
  function resendPayload(payload) {
    if (!canRetry(connected, streaming, payload) || !port) return false;
    clearRetryButton();
    // Set before the send, as sendMessage does: if the Port throws, the offer
    // has to be re-rendered against the payload the user just tried, and
    // clearRetryButton has already detached the button that was clicked.
    lastSentPayload = payload;
    try {
      port.postMessage(payload);
    } catch (err) {
      console.warn("[agentbrowser] retry send failed", err);
      addLine("error", "failed to reach service worker, retrying connection");
      setConnected(false);
      showRetryButton();
      return false;
    }
    streaming = true;
    updateControls();
    scrollToBottom();
    return true;
  }

  // Copy glyph (two offset sheets).
  function copyIcon(size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "11");
    rect.setAttribute("height", "11");
    rect.setAttribute("rx", "2");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5");
    svg.append(rect, path);
    return svg;
  }

  // One wrapper per assistant turn: the work block, the reply, the action row
  // and the meta line are its children, which is what lets a hover on the reply
  // reveal the actions under it.
  function ensureTurnEl() {
    if (!turnEl) {
      turnEl = document.createElement("div");
      turnEl.className = "turn";
      messagesEl.appendChild(turnEl);
    }
    return turnEl;
  }

  function ensureAssistantEl() {
    if (!assistantEl) {
      assistantEl = document.createElement("div");
      assistantEl.className = "msg assistant streaming";
      // Raw markdown source for this block. Lives on the element so it resets
      // with the block instead of leaking into the next reply.
      assistantEl.mdSource = "";
      ensureTurnEl().appendChild(assistantEl);
    }
    return assistantEl;
  }

  // ----- the live thinking / cooking block -----

  // Takes the block, not the module-level one: a collapsed summary stays
  // expandable long after the turn that built it has ended.
  function setWorkExpanded(block, open) {
    if (!block) return;
    block.expanded = !!open;
    block.body.hidden = !open;
    block.head.setAttribute("aria-expanded", open ? "true" : "false");
    block.el.classList.toggle("open", !!open);
    scrollToBottom();
  }

  function renderWorkSteps() {
    if (!workBlock) return;
    workBlock.steps.textContent = workBlock.count > 0 ? stepLabel(workBlock.count) : "";
  }

  function startWorkTimer() {
    if (workTimer) return;
    workTimer = setInterval(() => {
      if (!workBlock) return;
      const ms = Date.now() - workBlock.startedAt;
      workBlock.elapsed.textContent = Math.round(ms / 1000) + "s";
      // Rotate the placeholder label every fourth second; a per-second swap
      // reads as a glitch, and an adapter-supplied label never rotates.
      if (workBlock.live && !workBlock.fixedLabel && ++workTick % 4 === 0) {
        workBlock.label.textContent = rotatingLabel(workTick / 4);
      }
    }, 1000);
  }

  function stopWorkTimer() {
    if (workTimer) clearInterval(workTimer);
    workTimer = null;
  }

  // The one live block for this turn. Created by the first status, thinking or
  // tool event, whichever arrives first.
  function ensureWorkBlock(label) {
    if (workBlock) {
      if (label) {
        workBlock.fixedLabel = true;
        workBlock.label.textContent = label;
      }
      return workBlock;
    }
    const el = document.createElement("div");
    el.className = "work-block live";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "work-head";
    head.setAttribute("aria-expanded", "false");
    head.setAttribute("aria-label", "Show the steps in this turn");

    const labelEl = document.createElement("span");
    labelEl.className = "work-label";
    labelEl.textContent = label || rotatingLabel(0);

    const elapsedEl = document.createElement("span");
    elapsedEl.className = "work-elapsed";
    elapsedEl.textContent = "0s";

    const stepsEl = document.createElement("span");
    stepsEl.className = "work-steps";

    const spacer = document.createElement("span");
    spacer.className = "grow";

    const caret = document.createElement("span");
    caret.className = "work-caret";
    caret.textContent = "›";

    head.append(labelEl, elapsedEl, stepsEl, spacer, caret);

    const body = document.createElement("div");
    body.className = "work-body";
    body.hidden = true;

    el.append(head, body);
    ensureTurnEl().appendChild(el);

    const block = {
      el,
      head,
      label: labelEl,
      elapsed: elapsedEl,
      steps: stepsEl,
      body,
      count: 0,
      startedAt: Date.now(),
      expanded: false,
      live: true,
      fixedLabel: !!label,
    };
    workBlock = block;
    // A <button> is keyboard-activated for free; Enter and Space both land
    // here as a click.
    head.addEventListener("click", () => setWorkExpanded(block, !block.expanded));
    workTick = 0;
    startWorkTimer();
    scrollToBottom();
    return workBlock;
  }

  // Turn over: freeze the block into "Worked for 12s, 4 steps", still
  // expandable. A block with nothing inside it is dropped; the meta line
  // already reports the duration.
  function closeWorkBlock() {
    stopWorkTimer();
    if (!workBlock) return;
    const block = workBlock;
    workBlock = null;
    const ms = Date.now() - block.startedAt;
    block.live = false;
    block.el.classList.remove("live");
    block.elapsed.textContent = "";
    block.steps.textContent = "";
    if (block.count === 0 && block.body.children.length === 0) {
      block.el.remove();
      return;
    }
    block.label.textContent = summarizeWork(ms, block.count);
    block.head.setAttribute("aria-label", "Show or hide the steps in this turn");
  }

  // Re-render the whole block from its accumulated source. Markdown is not
  // incremental (a fence or table only becomes one once later lines arrive), so
  // each token replaces the rendered children.
  function renderAssistantEl(el) {
    try {
      el.replaceChildren(renderMarkdown(el.mdSource));
      el.classList.remove("raw");
    } catch (err) {
      console.warn("[agentbrowser] markdown render failed, showing raw", err);
      // A parser fault must not take the panel down or swallow the reply. Show
      // the source verbatim; .raw restores pre-wrap so newlines survive.
      el.classList.add("raw");
      el.textContent = el.mdSource;
    }
  }

  function finalizeAssistantEl() {
    if (assistantEl) {
      assistantEl.classList.remove("streaming");
      if (assistantEl.mdSource.trim() === "") assistantEl.remove();
      assistantEl = null;
    }
  }

  // Copies the markdown source, not the rendered text: what the agent wrote is
  // what lands on the clipboard.
  function makeCopyButton(source) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "act-btn copy-btn";
    btn.title = "Copy this reply as markdown";
    btn.setAttribute("aria-label", "Copy this reply as markdown");
    const label = document.createElement("span");
    label.textContent = "Copy";
    btn.append(copyIcon(14), label);

    let restore = null;
    const flash = (text) => {
      label.textContent = text;
      if (restore) clearTimeout(restore);
      restore = setTimeout(() => {
        label.textContent = "Copy";
        restore = null;
      }, 1600);
    };
    btn.addEventListener("click", () => {
      // The clipboard rejects without focus, and the panel must not be left
      // showing a stuck "Copied".
      const nav = typeof navigator !== "undefined" ? navigator : null;
      const write =
        nav && nav.clipboard && nav.clipboard.writeText
          ? nav.clipboard.writeText(source)
          : Promise.reject(new Error("no clipboard"));
      Promise.resolve(write).then(
        () => flash("Copied"),
        () => flash("Copy failed")
      );
    });
    return btn;
  }

  // End of a turn: freeze the work block, close the reply, and hang the action
  // row and the meta line off the turn wrapper.
  function finishTurn() {
    closeWorkBlock();
    closeLanes();
    const wrap = turnEl;
    const source = assistantEl ? assistantEl.mdSource : "";
    finalizeAssistantEl();
    turnEl = null;
    actionsRow = null;
    if (!wrap) {
      turnMeta = null;
      return;
    }
    const row = document.createElement("div");
    row.className = "turn-actions";
    if (source.trim() !== "") row.appendChild(makeCopyButton(source));
    wrap.appendChild(row);
    actionsRow = row;

    const line = formatMetaLine(turnMeta);
    if (line) {
      const meta = document.createElement("div");
      meta.className = "turn-meta";
      meta.textContent = line;
      wrap.appendChild(meta);
    }
    turnMeta = null;
    scrollToBottom();
  }

  // Info and error lines belong to the turn that produced them when there is
  // one; a mic or permission error outside a turn goes straight to the list.
  function addLine(kind, text) {
    const el = document.createElement("div");
    el.className = "line " + kind;
    el.textContent = text;
    (turnEl || messagesEl).appendChild(el);
    scrollToBottom();
  }

  function summarizeArgs(args) {
    let s;
    try {
      s = JSON.stringify(args);
    } catch (err) {
      console.warn("[agentbrowser] arg stringify failed, using String()", err);
      s = String(args);
    }
    if (s === undefined || s === "{}" || s === "null") return "";
    if (s.length > 80) s = s.slice(0, 77) + "...";
    return s;
  }

  function makeChipNode(tool, args) {
    const chip = document.createElement("div");
    chip.className = "chip";

    const gear = document.createTextNode("⚙ ");
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = String(tool);
    const argsText = document.createTextNode(" " + summarizeArgs(args) + " ");
    const status = document.createElement("span");
    status.className = "chip-pending";
    status.textContent = "…";

    chip.append(gear, name, argsText, status);
    return { chip, status };
  }

  // Chips never sit in the transcript on their own: they nest inside the live
  // block for this turn (or inside their lane), which is collapsed to a step
  // count by default. A lane keeps its own pending list, so two lanes running
  // the same tool at the same time cannot resolve each other's chips.
  function addToolChip(tool, args, laneEntry, id) {
    const { chip, status } = makeChipNode(tool, args);
    const record = { tool: String(tool), id: id == null ? null : String(id), statusEl: status, chipEl: chip };
    if (laneEntry) {
      const view = ensureLaneView(laneEntry);
      view.body.appendChild(chip);
      view.count++;
      view.pending.push(record);
      renderLaneHead(laneEntry);
    } else {
      const block = ensureWorkBlock("");
      block.body.appendChild(chip);
      block.count++;
      pendingChips.push(record);
      renderWorkSteps();
    }
    scrollToBottom();
  }

  function pendingListFor(laneEntry) {
    if (!laneEntry) return pendingChips;
    return ensureLaneView(laneEntry).pending;
  }

  // A tool batch (PROTOCOL v1.3 D1) runs concurrently, so results can land out
  // of order. Pair on the id when the event carries one; otherwise fall back to
  // the oldest pending chip for that tool, which is all the event shape allows.
  function resolveToolChip(tool, ok, summary, laneEntry, id) {
    const list = pendingListFor(laneEntry);
    let idx = id == null ? -1 : list.findIndex((p) => p.id != null && p.id === String(id));
    if (idx === -1) idx = list.findIndex((p) => p.tool === String(tool));
    if (idx === -1 && list.length > 0) idx = 0;
    if (idx === -1) {
      // Result with no visible call: render a standalone chip.
      addToolChip(tool, {}, laneEntry, id);
      idx = list.length - 1;
    }
    const entry = list.splice(idx, 1)[0];
    entry.statusEl.className = ok ? "chip-ok" : "chip-err";
    entry.statusEl.textContent = ok ? "✓" : "✗";
    if (!ok && summary) {
      const err = document.createElement("span");
      err.className = "chip-err";
      err.textContent = " " + String(summary);
      entry.chipEl.appendChild(err);
    }
    scrollToBottom();
  }

  function failChipList(list, reason) {
    for (const entry of list) {
      entry.statusEl.className = "chip-err";
      entry.statusEl.textContent = "✗";
      if (reason) {
        const err = document.createElement("span");
        err.className = "chip-err";
        err.textContent = " " + reason;
        entry.chipEl.appendChild(err);
      }
    }
    list.length = 0;
  }

  function failPendingChips(reason) {
    failChipList(pendingChips, reason);
    if (laneGrouper) {
      for (const entry of laneGrouper.list()) {
        if (entry.view) failChipList(entry.view.pending, reason);
      }
    }
  }

  // ----- parallel lanes -----

  // Lanes are stacked, never side by side: the panel is about 360px wide and
  // can be dragged narrower. Each lane collapses to one status line while it
  // runs and opens on click.
  function ensureLaneGrouper() {
    if (!laneGrouper) laneGrouper = makeLaneGrouper();
    return laneGrouper;
  }

  function ensureLaneGroupEl() {
    if (!laneGroupEl) {
      laneGroupEl = document.createElement("div");
      laneGroupEl.className = "lane-group";
      ensureTurnEl().appendChild(laneGroupEl);
    }
    return laneGroupEl;
  }

  function setLaneExpanded(entry, open) {
    const view = entry && entry.view;
    if (!view) return;
    view.expanded = !!open;
    view.body.hidden = !open;
    view.head.setAttribute("aria-expanded", open ? "true" : "false");
    view.el.classList.toggle("open", !!open);
    scrollToBottom();
  }

  // Title and one-line status. The title can arrive with a later event, so it
  // is rewritten every time rather than only at creation.
  function renderLaneHead(entry) {
    const view = entry && entry.view;
    if (!view) return;
    const label = laneLabel(entry);
    view.title.textContent = label;
    view.head.setAttribute(
      "aria-label",
      (view.expanded ? "Hide" : "Show") + " what " + label + " did"
    );
    const bits = [];
    if (view.state === "failed") bits.push("failed");
    else if (view.state === "done") bits.push("done");
    else bits.push(view.label || "running");
    if (view.count > 0) bits.push(stepLabel(view.count));
    view.status.textContent = bits.join(" · ");
  }

  function ensureLaneView(entry) {
    if (entry.view) return entry.view;

    const el = document.createElement("div");
    el.className = "lane-block live";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "lane-head";
    head.setAttribute("aria-expanded", "false");

    const title = document.createElement("span");
    title.className = "lane-title";

    const status = document.createElement("span");
    status.className = "lane-status";

    const spacer = document.createElement("span");
    spacer.className = "grow";

    const caret = document.createElement("span");
    caret.className = "lane-caret";
    caret.textContent = "›";

    head.append(title, status, spacer, caret);

    const body = document.createElement("div");
    body.className = "lane-body";
    body.hidden = true;

    el.append(head, body);
    ensureLaneGroupEl().appendChild(el);

    entry.view = {
      el,
      head,
      title,
      status,
      body,
      count: 0,
      pending: [],
      assistantEl: null,
      state: "running",
      label: "",
      expanded: false,
    };
    head.addEventListener("click", () => {
      setLaneExpanded(entry, !entry.view.expanded);
      renderLaneHead(entry);
    });
    renderLaneHead(entry);
    scrollToBottom();
    return entry.view;
  }

  function ensureLaneAssistantEl(entry) {
    const view = ensureLaneView(entry);
    if (!view.assistantEl) {
      const el = document.createElement("div");
      el.className = "msg assistant streaming";
      el.mdSource = "";
      view.body.appendChild(el);
      view.assistantEl = el;
    }
    return view.assistantEl;
  }

  function addLaneLine(entry, kind, text) {
    const view = ensureLaneView(entry);
    const el = document.createElement("div");
    el.className = "line " + kind;
    el.textContent = text;
    view.body.appendChild(el);
    scrollToBottom();
  }

  // One lane's event. A lane that fails marks itself and stops; it never ends
  // the turn, because the other lanes are still running (PROTOCOL v1.3 D2).
  function handleLaneEvent(entry, event) {
    const view = ensureLaneView(entry);
    switch (event.kind) {
      case "token": {
        const el = ensureLaneAssistantEl(entry);
        el.mdSource += String(event.text ?? "");
        renderAssistantEl(el);
        scrollToBottom();
        break;
      }
      case "status": {
        const state = String(event.state ?? "");
        const label = typeof event.label === "string" ? event.label.trim() : "";
        if (label) view.label = label;
        if (state === "idle") {
          if (view.state !== "failed") view.state = "done";
          view.el.classList.remove("live");
        } else {
          if (view.state !== "failed") view.state = "running";
          view.el.classList.add("live");
        }
        renderLaneHead(entry);
        break;
      }
      case "thinking": {
        const text = String(event.text ?? "");
        if (text.trim() === "") break;
        const node = document.createElement("div");
        node.className = "work-thinking";
        node.textContent = text;
        view.body.appendChild(node);
        scrollToBottom();
        break;
      }
      case "tool_use":
        addToolChip(event.tool, event.args, entry, event.id);
        break;
      case "tool_result":
        resolveToolChip(event.tool, !!event.ok, event.summary, entry, event.id);
        break;
      case "info":
        addLaneLine(entry, "info", String(event.message ?? ""));
        break;
      case "error":
        failChipList(view.pending, "");
        addLaneLine(entry, "error", String(event.message ?? "error"));
        view.state = "failed";
        view.el.classList.remove("live");
        view.el.classList.add("failed");
        renderLaneHead(entry);
        break;
      case "done":
        closeLane(entry);
        break;
      default:
        // A lane-scoped meta is not part of the contract (the hub sends one
        // meta for the whole command); ignoring it keeps the session totals
        // from double counting.
        break;
    }
  }

  function closeLane(entry) {
    const view = entry && entry.view;
    if (!view) return;
    failChipList(view.pending, "");
    if (view.state !== "failed") view.state = "done";
    view.el.classList.remove("live");
    if (view.assistantEl) {
      view.assistantEl.classList.remove("streaming");
      if (view.assistantEl.mdSource.trim() === "") view.assistantEl.remove();
      view.assistantEl = null;
    }
    renderLaneHead(entry);
  }

  function closeLanes() {
    if (!laneGrouper) return;
    for (const entry of laneGrouper.list()) closeLane(entry);
    laneGrouper = null;
    laneGroupEl = null;
  }

  // ----- Chat events -----

  function handleChatEvent(event) {
    // A disconnect unwind ends the turn without the hub knowing. A late live
    // event must not open a fresh block with a running timer outside a turn.
    if (
      !streaming &&
      (event.kind === "status" ||
        event.kind === "thinking" ||
        event.kind === "tool_use" ||
        event.kind === "tool_result")
    ) {
      return;
    }
    // Events tagged with a lane belong to one track of a /parallel run and go
    // to that lane's block. Everything else renders as it always has.
    const routed = ensureLaneGrouper().route(event);
    if (routed.target === "lane") {
      handleLaneEvent(routed.lane, event);
      return;
    }
    switch (event.kind) {
      case "token": {
        const el = ensureAssistantEl();
        el.mdSource += String(event.text ?? "");
        renderAssistantEl(el);
        scrollToBottom();
        break;
      }
      case "status": {
        const state = String(event.state ?? "");
        const label = typeof event.label === "string" ? event.label.trim() : "";
        if (state === "idle") {
          // Still the same turn; it just stopped reporting work. Freeze the
          // shimmer, keep the block and its steps.
          if (workBlock) {
            workBlock.live = false;
            workBlock.el.classList.remove("live");
            if (label) {
              workBlock.fixedLabel = true;
              workBlock.label.textContent = label;
            }
          }
        } else {
          const block = ensureWorkBlock(label);
          block.live = true;
          block.el.classList.add("live");
        }
        break;
      }
      case "thinking": {
        const text = String(event.text ?? "");
        if (text.trim() === "") break;
        const block = ensureWorkBlock("");
        const node = document.createElement("div");
        node.className = "work-thinking";
        node.textContent = text;
        block.body.appendChild(node);
        scrollToBottom();
        break;
      }
      case "meta":
        // One per turn, just before done. The line is rendered by finishTurn;
        // the session readout updates now, because a long turn should not have
        // to end before the running total moves.
        turnMeta = {
          model: event.model,
          adapter: event.adapter,
          elapsedMs: event.elapsedMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          sessionInputTokens: event.sessionInputTokens,
          sessionOutputTokens: event.sessionOutputTokens,
          costUsd: event.costUsd,
        };
        session = accumulateSession(session, turnMeta);
        renderSessionUsage();
        break;
      case "tool_use":
        // The chip lands inside the work block, so the reply text keeps
        // streaming into the same block instead of being split by it.
        addToolChip(event.tool, event.args, null, event.id);
        break;
      case "tool_result":
        resolveToolChip(event.tool, !!event.ok, event.summary, null, event.id);
        break;
      case "info":
        addLine("info", String(event.message ?? ""));
        break;
      case "error":
        failPendingChips("");
        addLine("error", String(event.message ?? "error"));
        finishTurn();
        endStreaming();
        showRetryButton();
        break;
      case "done":
        failPendingChips("");
        finishTurn();
        endStreaming();
        requestChatList(); // the turn just journaled itself on the hub
        break;
      default:
        break;
    }
  }

  function endStreaming() {
    streaming = false;
    updateControls();
    inputEl.focus();
  }

  // ----- Current tab tracking -----

  async function refreshCurrentTab() {
    let next = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab && tab.id != null && isContextUrl(tab.url)) {
        next = { tabId: tab.id, url: tab.url, title: tab.title || tab.url };
      }
    } catch (err) {
      console.warn("[agentbrowser] active tab query failed", err);
      next = null;
    }
    const changedTab = !currentTab || !next || currentTab.tabId !== next.tabId;
    currentTab = next;
    // The X only silences the tab it was clicked for.
    if (changedTab) currentTabOff = false;
    renderChips();
  }

  function watchTabs() {
    chrome.tabs.onActivated.addListener(() => refreshCurrentTab());
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url === undefined && changeInfo.title === undefined) return;
      if (tab && tab.active) refreshCurrentTab();
      else if (currentTab && currentTab.tabId === tabId) refreshCurrentTab();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      const before = taggedTabs.length;
      taggedTabs = taggedTabs.filter((t) => t.tabId !== tabId);
      if (taggedTabs.length !== before) renderChips();
      if (currentTab && currentTab.tabId === tabId) refreshCurrentTab();
    });
    if (chrome.windows && chrome.windows.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener(() => refreshCurrentTab());
    }
  }

  // ----- Selection staging (Ask button / context menu) -----

  // sw.js parks each delivered selection in chrome.storage.session under
  // pendingSelection; timestamps keep a re-opened panel from applying a stale
  // one or re-applying the one it already has.
  function applyPendingSelection(record) {
    if (!record || typeof record !== "object") return;
    const ts = Number(record.timestamp) || 0;
    if (ts <= selectionAppliedTs) return;
    const sel = normalizeSelection(record.selection);
    if (!sel) return;
    selectionAppliedTs = ts;
    selectionCtx = sel;
    renderChips();
    inputEl.focus();
  }

  function watchSelections() {
    const store = chrome.storage && chrome.storage.session;
    if (!store || typeof store.get !== "function") return;
    store
      .get("pendingSelection")
      .then((data) => applyPendingSelection(data && data.pendingSelection))
      .catch((err) =>
        console.warn("[agentbrowser] pendingSelection read failed", err)
      );
    if (!chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes.pendingSelection) return;
      applyPendingSelection(changes.pendingSelection.newValue);
    });
  }

  // ----- Composer chips -----

  function makeChip(cls, mark, label, removeTitle, onRemove) {
    const chip = document.createElement("span");
    chip.className = "tab-chip " + cls;

    const m = document.createElement("span");
    m.className = "tab-chip-mark";
    m.textContent = mark;

    const l = document.createElement("span");
    l.className = "tab-chip-label";
    l.textContent = label;
    l.title = label;

    chip.append(m, l);

    if (onRemove) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.textContent = "×";
      x.title = removeTitle;
      x.setAttribute("aria-label", removeTitle);
      x.addEventListener("click", onRemove);
      chip.appendChild(x);
    }
    return chip;
  }

  function renderChips() {
    const nodes = [];
    if (selectionCtx) {
      const kind =
        selectionCtx.contentType === "code"
          ? "code"
          : selectionCtx.contentType === "table"
            ? "table"
            : "sel";
      nodes.push(
        makeChip(
          "sel",
          "\u2702",
          kind + ": \"" + shortTitle(selectionCtx.text, 36) + "\"",
          "Remove selection context",
          () => {
            selectionCtx = null;
            // Bump past the stored payload's timestamp so a panel reopen
            // does not resurrect a selection the user threw away.
            selectionAppliedTs = Date.now();
            renderChips();
          }
        )
      );
    }
    if (currentTab && !currentTabOff) {
      nodes.push(
        makeChip(
          "current",
          "●",
          currentTab.title || currentTab.url,
          "Do not send this tab with the next message",
          () => {
            currentTabOff = true;
            renderChips();
          }
        )
      );
    } else if (currentTab && currentTabOff) {
      const chip = makeChip("off", "○", "tab context off", "", null);
      chip.title = "Click to send the current tab again";
      chip.style.cursor = "pointer";
      chip.addEventListener("click", () => {
        currentTabOff = false;
        renderChips();
      });
      nodes.push(chip);
    }
    for (const t of taggedTabs) {
      nodes.push(
        makeChip("tag", "@", t.title || t.url, "Remove tag", () => {
          taggedTabs = taggedTabs.filter((x) => x.tabId !== t.tabId);
          renderChips();
        })
      );
    }
    chipsEl.replaceChildren(...nodes);
    chipsEl.hidden = nodes.length === 0;
  }

  function renderAttachments() {
    const nodes = attachments.map((a) => {
      const chip = makeChip("file-chip", "\u{1f4ce}", a.name, "Remove file", () => {
        attachments = attachments.filter((x) => x !== a);
        renderAttachments();
      });
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = a.base64 === null ? "reading…" : formatBytes(a.size);
      chip.insertBefore(size, chip.lastChild);
      return chip;
    });
    attachmentsEl.replaceChildren(...nodes);
    attachmentsEl.hidden = nodes.length === 0;
  }

  function showComposerError(text) {
    composerErrorEl.textContent = text || "";
    composerErrorEl.hidden = !text;
  }

  // ----- @ tab tagging -----

  function closeMention() {
    mention = null;
    mentionRows = [];
    mentionIndex = 0;
    mentionEl.replaceChildren();
    mentionEl.hidden = true;
  }

  function renderMention() {
    const nodes = [];
    if (mentionRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mention-empty";
      empty.textContent = "no matching tab";
      nodes.push(empty);
    }
    mentionRows.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "mention-row" + (i === mentionIndex ? " sel" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === mentionIndex ? "true" : "false");

      const title = document.createElement("span");
      title.className = "mention-title";
      title.textContent = t.title;

      const url = document.createElement("span");
      url.className = "mention-url";
      url.textContent = t.url;

      row.append(title, url);
      // mousedown, not click: click would land after the textarea blurs.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        chooseMention(i);
      });
      nodes.push(row);
    });
    mentionEl.replaceChildren(...nodes);
    mentionEl.hidden = false;
    const sel = mentionEl.querySelector(".mention-row.sel");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  async function updateMention() {
    const m = findMention(inputEl.value, inputEl.selectionStart);
    if (!m) {
      if (mention) closeMention();
      return;
    }
    mention = m;
    if (palette) closePalette(); // only one popup owns the composer at a time
    const seq = ++mentionSeq;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (err) {
      console.warn("[agentbrowser] tab list query failed", err);
      tabs = [];
    }
    if (seq !== mentionSeq || !mention) return; // a later keystroke won
    // Already-tagged tabs and the current tab are left out: buildContext would
    // dedupe them away, so offering them would show a pill that never ships.
    const taken = new Set(taggedTabs.map((t) => t.tabId));
    if (currentTab && !currentTabOff) taken.add(currentTab.tabId);
    mentionRows = filterTabs(tabs, mention.query)
      .filter((t) => !taken.has(t.tabId))
      .slice(0, 40);
    mentionIndex = 0;
    renderMention();
  }

  function chooseMention(i) {
    if (!mention || !mentionRows[i]) return;
    const tab = mentionRows[i];
    const applied = applyMention(inputEl.value, mention, tab.title);
    inputEl.value = applied.text;
    inputEl.setSelectionRange(applied.caret, applied.caret);
    if (!taggedTabs.some((t) => t.tabId === tab.tabId)) taggedTabs.push(tab);
    closeMention();
    renderChips();
    autoGrow();
    inputEl.focus();
  }

  // ----- / command palette -----

  function closePalette() {
    palette = null;
    paletteRows = [];
    paletteIndex = 0;
    commandEl.replaceChildren();
    commandEl.hidden = true;
    inputEl.setAttribute("aria-expanded", "false");
  }

  function renderPalette() {
    const nodes = [];
    if (paletteRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mention-empty";
      empty.textContent = "no matching command";
      nodes.push(empty);
    }
    paletteRows.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "mention-row cmd-row" + (i === paletteIndex ? " sel" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === paletteIndex ? "true" : "false");

      const head = document.createElement("div");
      head.className = "cmd-head";

      const name = document.createElement("span");
      name.className = "cmd-name";
      name.textContent = "/" + c.name;
      head.appendChild(name);

      if (c.args) {
        const args = document.createElement("span");
        args.className = "cmd-args";
        args.textContent = c.args;
        head.appendChild(args);
      }
      row.appendChild(head);

      if (c.summary) {
        const summary = document.createElement("span");
        summary.className = "cmd-summary";
        summary.textContent = c.summary;
        summary.title = c.summary;
        row.appendChild(summary);
      }

      // mousedown, not click: click would land after the textarea blurs.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choosePaletteRow(i);
      });
      nodes.push(row);
    });
    commandEl.replaceChildren(...nodes);
    commandEl.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
    const sel = commandEl.querySelector(".cmd-row.sel");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  function updatePalette() {
    const token = findCommandToken(inputEl.value, inputEl.selectionStart);
    // A hub that sent no registry has no commands to offer, and a hardcoded
    // list would go stale the moment the hub changes.
    if (!token || commands.length === 0) {
      if (palette) closePalette();
      return;
    }
    palette = token;
    paletteRows = filterCommands(commands, token.query);
    paletteIndex = 0;
    if (mention) closeMention();
    renderPalette();
  }

  function choosePaletteRow(i) {
    const cmd = paletteRows[i];
    if (!palette || !cmd) return;
    const applied = applyCommand(inputEl.value, palette, cmd.name);
    inputEl.value = applied.text;
    inputEl.setSelectionRange(applied.caret, applied.caret);
    closePalette();
    autoGrow();
    inputEl.focus();
  }

  // ----- attachments -----

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(stripDataUrlPrefix(fr.result));
      fr.onerror = () => reject(fr.error || new Error("read failed"));
      fr.readAsDataURL(file);
    });
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const plan = planAttachments(attachments, files);
    showComposerError(plan.error);
    for (const file of plan.accepted) {
      const entry = {
        name: file.name,
        mimeType: guessMimeType(file.name, file.type),
        size: file.size,
        base64: null,
      };
      attachments.push(entry);
      reading++;
      updateControls();
      readAsBase64(file)
        .then((b64) => {
          entry.base64 = b64;
        })
        .catch((err) => {
          console.warn("[agentbrowser] attachment read failed", err);
          attachments = attachments.filter((x) => x !== entry);
          showComposerError("could not read " + file.name);
        })
        .finally(() => {
          // Clamped: newChat/send can zero the counter while a read is still
          // in flight, and a negative counter would disable send forever.
          reading = Math.max(0, reading - 1);
          renderAttachments();
          updateControls();
        });
    }
    renderAttachments();
  }

  // ----- mic -----

  const SpeechRec =
    typeof window !== "undefined"
      ? window.webkitSpeechRecognition || window.SpeechRecognition
      : null;

  function insertAtCaret(text) {
    const value = inputEl.value;
    const start = inputEl.selectionStart ?? value.length;
    const end = inputEl.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s$/.test(value.slice(0, start));
    const chunk = (needsSpace ? " " : "") + text.trim() + " ";
    inputEl.value = value.slice(0, start) + chunk + value.slice(end);
    const caret = start + chunk.length;
    inputEl.setSelectionRange(caret, caret);
    autoGrow();
  }

  function showInterim(text) {
    interimEl.textContent = text;
    interimEl.hidden = !text;
  }

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle("listening", on);
    micBtn.setAttribute("aria-pressed", on ? "true" : "false");
    micBtn.title = on ? "Stop dictation" : "Dictate";
    inputEl.placeholder = on ? "Listening…" : BASE_PLACEHOLDER;
    if (!on) showInterim("");
  }

  function stopMic() {
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        console.warn("[agentbrowser] recognition.stop() threw", err);
      }
    }
    recognition = null;
    setListening(false);
  }

  function startMic() {
    if (!SpeechRec) return;
    let rec;
    try {
      rec = new SpeechRec();
    } catch (err) {
      console.warn("[agentbrowser] SpeechRecognition ctor failed", err);
      addLine("error", "speech recognition is not available in this browser");
      return;
    }
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = (result[0] && result[0].transcript) || "";
        if (result.isFinal) {
          if (text.trim()) insertAtCaret(text);
        } else {
          interim += text;
        }
      }
      showInterim(interim);
    };
    rec.onerror = (e) => {
      const kind = e && e.error;
      if (kind === "not-allowed" || kind === "service-not-allowed") {
        addLine(
          "error",
          "Chrome needs microphone permission for this extension. Open the panel's site settings (or chrome://settings/content/microphone) and allow the mic, then try again."
        );
      }
      // no-speech, network, aborted and the rest stop without a message.
      stopMic();
    };
    rec.onend = () => {
      // Chrome ends the session on its own after silence. Do not auto-restart:
      // the button stays a plain toggle.
      if (recognition === rec) stopMic();
    };
    recognition = rec;
    setListening(true);
    try {
      rec.start();
    } catch (err) {
      console.warn("[agentbrowser] recognition.start() threw", err);
      stopMic();
    }
  }

  // ----- Actions -----

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }

  // "tab: … · tagged: … · files: …" under the user bubble.
  function contextMetaParts(msg) {
    const parts = [];
    if (msg.context && msg.context.currentTab) {
      parts.push("tab: " + shortTitle(msg.context.currentTab.title, 40));
    }
    if (msg.context && msg.context.tabs.length) {
      parts.push("tagged: " + msg.context.tabs.map((t) => shortTitle(t.title, 24)).join(", "));
    }
    if (msg.context && msg.context.selection) {
      parts.push("sel: \"" + shortTitle(msg.context.selection.text, 24) + "\"");
    }
    if (msg.attachments) {
      parts.push("files: " + msg.attachments.map((a) => a.name).join(", "));
    }
    return parts;
  }

  // Put one message on the wire and open a turn for it. Returns false when the
  // Port threw, having already rendered the failure and the retry offer.
  function dispatch(msg, text) {
    finishTurn(); // close anything the previous turn left open
    addUserMessage(text, contextMetaParts(msg).join(" · "), msg);
    clearRetryButton(); // any send retires the pending retry offer
    lastSentPayload = msg;
    try {
      port.postMessage(msg);
    } catch (err) {
      console.warn("[agentbrowser] dispatch send failed", err);
      addLine("error", "failed to reach service worker, retrying connection");
      setConnected(false);
      showRetryButton();
      return false;
    }
    inputEl.value = "";
    autoGrow();
    taggedTabs = [];
    currentTabOff = false;
    selectionCtx = null; // one send carries the selection, then it is spent
    renderChips();
    showComposerError("");
    streaming = true;
    updateControls();
    return true;
  }

  // The shared match-and-apply core for /adapter and /model: resolve the
  // typed fragment against the option list, apply it, re-render the merged
  // picker, persist.
  function pickBackend(options, current, args, what, apply) {
    const want = String(args || "").trim();
    if (!want) {
      addLine("info", what + ": " + current + " (" + options.join(", ") + ")");
      backendSelect.focus();
      return;
    }
    const lower = want.toLowerCase();
    const hit =
      options.find((v) => v.toLowerCase() === lower) ||
      options.find((v) => v.toLowerCase().includes(lower));
    if (!hit) {
      addLine("error", 'no ' + what + ' matching "' + want + '"');
      return;
    }
    apply(hit);
    renderBackendSelect();
    savePrefs();
    addLine("info", what + " set to " + hit);
  }

  // Client-scope commands. The hub's registry decides which names exist and
  // which are client-scope; this map is only the panel's half, the part that
  // cannot travel over a wire.
  const CLIENT_HANDLERS = {
    clear: () => newChat(),
    stop: () => {
      if (streaming) abortChat();
      else addLine("info", "nothing is running");
    },
    keys: () => setSettingsOpen(true),
    model: (args) => {
      const { models } = modelsFor(adapters, selAdapter);
      if (models.length === 0) {
        addLine("info", "this adapter has no model switch");
        return;
      }
      pickBackend(models.map((m) => m.id), selModel || "", args, "model", (hit) => {
        selModel = hit;
      });
    },
    adapter: (args) =>
      pickBackend(adapters.map((a) => a.name), selAdapter, args, "adapter", (hit) => {
        selAdapter = hit;
      }),
  };

  function runClientCommand(plan) {
    inputEl.value = "";
    autoGrow();
    showComposerError("");
    const handler = CLIENT_HANDLERS[plan.name];
    if (handler) handler(plan.args);
    inputEl.focus();
  }

  // A server command rides the same chat_event stream as a chat turn, so the
  // transcript, the retry offer and the abort button all keep working.
  function sendCommand(plan, text) {
    const msg = buildCommandMessage({
      chatId,
      name: plan.name,
      args: plan.args,
      adapter: selAdapter,
      model: currentModel(),
      currentTab: currentTabOff ? null : currentTab,
      taggedTabs,
    });
    // Attachments stay staged: a command carries no files, and silently
    // dropping the pills the user can see would be worse than keeping them.
    dispatch(msg, text);
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    // "/foo" that no registry entry matches is ordinary text, not an error.
    const plan = planSend(text, commands);
    // Client commands run before the send guards: /stop is only useful while a
    // turn is streaming, and /clear has to work with the hub down.
    if (plan.mode === "client") {
      closeMention();
      closePalette();
      runClientCommand(plan);
      return;
    }

    if (!connected || streaming || !port || reading > 0) return;
    // buildChatMessage skips half-read files. Checking the list itself keeps a
    // visible pill from vanishing out of the payload if the counter drifts.
    if (attachments.some((a) => a.base64 === null)) return;
    closeMention();
    closePalette();

    if (plan.mode === "server") {
      sendCommand(plan, text);
      return;
    }

    if (archived) newChat(); // a dead transcript cannot take a reply

    const msg = buildChatMessage({
      chatId,
      text,
      adapter: selAdapter,
      model: currentModel(),
      currentTab: currentTabOff ? null : currentTab,
      taggedTabs,
      selection: selectionCtx,
      attachments,
    });

    if (!dispatch(msg, text)) return;
    attachments = [];
    renderAttachments();
  }

  function abortChat() {
    if (!port) return;
    try {
      port.postMessage({ type: "chat_abort", chatId });
    } catch (err) {
      // Port died between checks; onDisconnect will handle it.
      console.warn("[agentbrowser] abort postMessage failed", err);
    }
    // Keep the abort button until the hub confirms with done/error.
  }

  function resetChatState(id) {
    if (streaming) abortChat(); // best-effort cancel of the old conversation
    chatId = id;
    archived = false;
    messagesEl.textContent = "";
    assistantEl = null;
    pendingChips = [];
    // The block's node went with messagesEl's children, but its interval did
    // not: a live timer would keep ticking on a detached element.
    stopWorkTimer();
    workBlock = null;
    turnEl = null;
    turnMeta = null;
    actionsRow = null;
    laneGrouper = null; // the lane blocks went with messagesEl's children
    laneGroupEl = null;
    // The readout counts one conversation, which this call ends.
    session = emptySession();
    retryBtn = null; // the node went with messagesEl's children
    lastSentPayload = null; // belongs to the conversation just discarded
    streaming = false;
    attachments = [];
    taggedTabs = [];
    currentTabOff = false;
    selectionCtx = null;
    reading = 0;
    inputEl.value = "";
    if (listening) stopMic();
    closeMention();
    closePalette();
    showComposerError("");
    renderSessionUsage();
    renderAttachments();
    renderChips();
    autoGrow();
    updateControls();
  }

  function newChat() {
    resetChatState(crypto.randomUUID());
    renderSwitcher();
    inputEl.focus();
  }

  // ----- Wiring -----

  inputEl.addEventListener("keydown", (e) => {
    if (palette && !commandEl.hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (paletteRows.length) {
          paletteIndex = (paletteIndex + 1) % paletteRows.length;
          renderPalette();
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (paletteRows.length) {
          paletteIndex = (paletteIndex - 1 + paletteRows.length) % paletteRows.length;
          renderPalette();
        }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (paletteRows.length) {
          e.preventDefault();
          choosePaletteRow(paletteIndex);
          return;
        }
        closePalette();
        // fall through to the normal Enter handling below
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
        return;
      }
    }
    if (mention && !mentionEl.hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (mentionRows.length) {
          mentionIndex = (mentionIndex + 1) % mentionRows.length;
          renderMention();
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (mentionRows.length) {
          mentionIndex = (mentionIndex - 1 + mentionRows.length) % mentionRows.length;
          renderMention();
        }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (mentionRows.length) {
          e.preventDefault();
          chooseMention(mentionIndex);
          return;
        }
        closeMention();
        // fall through to the normal Enter handling below
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener("input", () => {
    autoGrow();
    updatePalette();
    updateMention();
  });
  inputEl.addEventListener("click", () => {
    updatePalette();
    updateMention();
  });
  inputEl.addEventListener("keyup", (e) => {
    // Caret moves that keydown did not consume can enter or leave a mention or
    // the command token. An open popup is skipped: its own arrow keys move the
    // selection, and re-filtering here would snap it back to the first row.
    if (!/^(Arrow|Home|End)/.test(e.key)) return;
    if (!palette) updatePalette();
    if (!mention) updateMention();
  });
  inputEl.addEventListener("blur", () => {
    // Let a mousedown on a row run first; chooseMention and choosePaletteRow
    // refocus the textarea, so an already-reopened popup must survive this
    // timer.
    setTimeout(() => {
      if (document.activeElement !== inputEl) {
        closeMention();
        closePalette();
      }
    }, 120);
  });

  sendBtn.addEventListener("click", sendMessage);
  abortBtn.addEventListener("click", abortChat);
  chatSwitcher.addEventListener("change", () => {
    const v = chatSwitcher.value;
    if (v === "__new__") {
      newChat();
    } else if (v && v !== chatId) {
      postToHub({ type: "chat_resume", chatId: v });
    }
  });
  // The list refreshes when the user reaches for it, not on every render:
  // opening the dropdown must not be stale, and a client command like /clear
  // stays off the wire entirely.
  chatSwitcher.addEventListener("mousedown", requestChatList);
  chatSwitcher.addEventListener("focus", requestChatList);

  backendSelect.addEventListener("change", () => {
    const v = String(backendSelect.value);
    const sep = v.indexOf("::");
    if (sep > 0) {
      selAdapter = v.slice(0, sep);
      selModel = v.slice(sep + 2) || null;
    }
    renderBackendSelect(); // refreshes the tooltip and normalizes the value
    savePrefs();
  });

  settingsBtn.addEventListener("click", () => setSettingsOpen(settingsView.hidden));
  settingsClose.addEventListener("click", () => setSettingsOpen(false));
  for (const field of KEY_FIELDS) {
    field.save.addEventListener("click", () => sendKey(field, field.input.value));
    field.clear.addEventListener("click", () => sendKey(field, null));
    field.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendKey(field, field.input.value);
      }
    });
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = ""; // same file twice in a row still fires change
  });

  composerEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    composerEl.classList.add("dragover");
  });
  composerEl.addEventListener("dragleave", (e) => {
    if (e.target === composerEl) composerEl.classList.remove("dragover");
  });
  composerEl.addEventListener("drop", (e) => {
    e.preventDefault();
    composerEl.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  if (SpeechRec) {
    micBtn.hidden = false;
    micBtn.addEventListener("click", () => {
      if (listening) stopMic();
      else startMic();
    });
  }

  setConnected(false);
  renderKeyState();
  loadPrefs();
  connectPort();
  watchTabs();
  watchSelections();
  refreshCurrentTab();
  renderChips();
  renderAttachments();
  renderSessionUsage();
  autoGrow();
  inputEl.focus();
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) {
  init();
}
