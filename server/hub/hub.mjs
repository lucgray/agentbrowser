// AgentChat hub: WebSocket relay between the Chrome extension, external
// harnesses (mcp-proxy), and in-process adapter sessions. See PROTOCOL.md.

import {
  readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, chmodSync,
  readdirSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { TOOLS } from "./tools.mjs";
import {
  COMMANDS,
  dispatch,
  commandByName,
  needsChatSession,
  needsLaneSessions,
  PARALLEL_MAX_LANES
} from "./commands.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENTCHAT_PORT) || 9010;
const TOOL_TIMEOUT_MS = 60000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const UPLOAD_ROOT = path.join(os.tmpdir(), "agentchat-uploads");
// How long the hub waits for the adapter's own status event before injecting one.
const STATUS_INJECT_MS = 300;

const PROVIDERS = ["anthropic", "openai"];

let config = { adapter: "claude-agent-sdk", model: "claude-opus-5" };
try {
  config = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (err) {
  log("could not read config.json, using defaults:", err.message);
}

// config.permissions rides on every forwarded tool_call so the extension can
// run the consent gate (PROTOCOL.md "Consent gate, v1.7"). Absent = gate off.
function consentPolicy() {
  const p = config && config.permissions;
  return p && typeof p === "object" ? p : null;
}

// ---------------------------------------------------------------------------
// Log scrubbing (PROTOCOL.md "API keys")
//
// Nothing that reaches stderr may carry an API key. Every log line goes through
// scrub(): it removes any key value the hub has held this run (substring match)
// and then anything that looks like a key by shape. log() is the single choke
// point, so every existing call site is covered.

const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:xai|gsk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}/g
];

const knownSecrets = new Set();

function rememberSecret(value) {
  if (typeof value === "string" && value.length >= 8) knownSecrets.add(value);
}

function stringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (err) {
      // Direct console.error: stringify sits on the log() path, and log()
      // would just hit this same branch again.
      console.error("[hub] stringify fell back for unserializable value:", err && err.message);
      return "[object]";
    }
  }
  return String(value);
}

// Exported for tests.
export function scrub(value) {
  let text = stringify(value);
  for (const secret of knownSecrets) {
    if (secret && text.includes(secret)) text = text.split(secret).join("[redacted]");
  }
  for (const shape of KEY_SHAPES) text = text.replace(shape, "[redacted]");
  return text;
}

function log(...args) {
  console.error("[hub]", ...args.map((a) => scrub(a)));
}

// ---------------------------------------------------------------------------
// Key store
//
// adapters/keystore.mjs owns the file; the hub delegates to it when it is
// present. Until it lands (and if it ever fails to load) the hub falls back to
// an equivalent implementation over the same file, so the contract holds either
// way: ~/.agentchat/keys.json, file mode 0600, dir mode 0700.

function keysDir() {
  return path.join(os.homedir(), ".agentchat");
}

function keysFile() {
  return path.join(keysDir(), "keys.json");
}

let keystoreModule = null;

async function loadKeystore() {
  if (keystoreModule) return keystoreModule;
  try {
    const mod = await import("../adapters/keystore.mjs");
    if (mod && typeof mod.setKey === "function") {
      keystoreModule = mod;
      return mod;
    }
  } catch (err) {
    // not written yet; the fallback below is used
    log("keystore module unavailable, using fallback:", err && err.message);
  }
  return null;
}

function fallbackRead() {
  try {
    const parsed = JSON.parse(readFileSync(keysFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    log("fallback key file unreadable, treating as empty:", err && err.message);
    return {};
  }
}

function fallbackWrite(data) {
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  try {
    chmodSync(keysDir(), 0o700);
  } catch (err) {
    // best effort: an existing dir may be owned differently
    log("keys dir chmod failed (continuing):", err && err.message);
  }
  writeFileSync(keysFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(keysFile(), 0o600);
  } catch (err) {
    // mode already applied at creation
    log("keys file chmod failed (continuing):", err && err.message);
  }
}

// Synchronous by contract: adapters call ctx.getApiKey(provider) inline.
function getApiKey(provider) {
  if (!PROVIDERS.includes(provider)) return null;
  const ks = keystoreModule;
  if (ks && typeof ks.getKey === "function") {
    try {
      const value = ks.getKey(provider);
      if (typeof value === "string" && value !== "") {
        rememberSecret(value);
        return value;
      }
      if (value === null || value === undefined) return null;
      // anything else (a Promise, say) is not usable here; read the file below
    } catch (err) {
      log("keystore getKey failed for provider " + provider + ":", err.message);
    }
  }
  const value = fallbackRead()[provider];
  if (typeof value === "string" && value !== "") {
    rememberSecret(value);
    return value;
  }
  return null;
}

function hasKey(provider) {
  const ks = keystoreModule;
  if (ks && typeof ks.hasKey === "function") {
    try {
      const value = ks.hasKey(provider);
      if (typeof value === "boolean") return value;
    } catch (err) {
      log("keystore hasKey failed for provider " + provider + ":", err.message);
    }
  }
  return getApiKey(provider) !== null;
}

async function storeKey(provider, key) {
  const ks = await loadKeystore();
  if (ks) {
    await ks.setKey(provider, key);
  } else {
    const data = fallbackRead();
    if (key === null) delete data[provider];
    else data[provider] = key;
    fallbackWrite(data);
  }
  rememberSecret(key);
}

// ---------------------------------------------------------------------------
// State

let extensionSocket = null;

// id -> { kind: "hub", resolve, reject, timer }
//     | { kind: "harness", ws, timer }
const pending = new Map();

// chatId -> { session, adapterName, model, lastUsed }
const sessions = new Map();

// chatId -> { input, output } running totals for the chat (PROTOCOL v1.3 A).
// Kept out of `sessions` on purpose: an adapter or model switch disposes the
// session mid-chat and the totals must survive that. Only an idle sweep (the
// point where the chat is really over) clears them.
const sessionTotals = new Map();
const MAX_TOTALS_ENTRIES = 2000;

// chatId -> { name, controller, laneSessions:Set } for a running slash command.
const runningCommands = new Map();

// chatIds with an ordinary chat turn in flight. One turn at a time per chat:
// adapter sessions are single-turn objects, so a chat and a command (or two
// commands) running at once on the same session would interleave their state.
const activeChats = new Set();

// ---------------------------------------------------------------------------
// Chat transcripts (v1.8). Every chat turn is journaled to
// ~/.agentchat/chats/<chatId>.json so the panel can list and re-open past
// conversations. A chat whose adapter session is still registered is "live"
// and resumes with context; dead sessions come back as read-only archives.

// chatId -> { chatId, title, adapter, model, createdAt, updatedAt, msgs }
const transcripts = new Map();
// chatId -> assistant text accumulated across the current turn.
const turnText = new Map();
const MAX_CHATS_LISTED = 50;

function chatsDir() {
  return path.join(os.homedir(), ".agentchat", "chats");
}

function transcriptFile(chatId) {
  return path.join(chatsDir(), String(chatId).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

function transcriptFor(chatId, adapterName) {
  let t = transcripts.get(chatId);
  if (!t) {
    t = {
      chatId, title: "", adapter: adapterName || null, model: null,
      createdAt: Date.now(), updatedAt: Date.now(), msgs: []
    };
    transcripts.set(chatId, t);
  }
  return t;
}

function recordUser(chatId, text, adapterName, model) {
  const t = transcriptFor(chatId, adapterName);
  if (adapterName) t.adapter = adapterName;
  if (model) t.model = model;
  if (!t.title) t.title = String(text).replace(/\s+/g, " ").trim().slice(0, 80) || "(untitled)";
  t.msgs.push({ role: "user", text: String(text).slice(0, 20000) });
  t.updatedAt = Date.now();
}

function recordToken(chatId, text) {
  if (!transcripts.has(chatId)) return;
  turnText.set(chatId, (turnText.get(chatId) || "") + String(text));
}

function recordDone(chatId, model) {
  const t = transcripts.get(chatId);
  const text = (turnText.get(chatId) || "").trim();
  turnText.delete(chatId);
  if (!t) return;
  if (model) t.model = model;
  if (text) t.msgs.push({ role: "assistant", text: text.slice(0, 60000) });
  t.updatedAt = Date.now();
  persistTranscript(t);
}

function persistTranscript(t) {
  try {
    mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(transcriptFile(t.chatId), JSON.stringify(t), { mode: 0o600 });
  } catch (err) {
    log("transcript write failed", t.chatId, err && err.message);
  }
}

function loadTranscript(chatId) {
  const mem = transcripts.get(chatId);
  if (mem) return mem;
  try {
    const t = JSON.parse(readFileSync(transcriptFile(chatId), "utf8"));
    if (t && t.chatId === chatId && Array.isArray(t.msgs)) {
      transcripts.set(chatId, t);
      return t;
    }
    log("transcript file malformed, skipped:", transcriptFile(chatId));
    return null;
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      log("transcript read failed", chatId, err && err.message);
    }
    return null;
  }
}

function chatIsLive(chatId) {
  return sessions.has(chatId) || activeChats.has(chatId) || runningCommands.has(chatId);
}

function chatSummary(t) {
  return {
    chatId: t.chatId, title: t.title || "(untitled)", adapter: t.adapter,
    model: t.model, updatedAt: t.updatedAt, msgs: t.msgs.length,
    live: chatIsLive(t.chatId)
  };
}

// All known chats: on-disk archives merged with anything held in memory,
// newest first, capped for the dropdown.
function listChats() {
  const byId = new Map();
  let files = [];
  try {
    files = readdirSync(chatsDir());
  } catch (err) {
    if (!err || err.code !== "ENOENT") log("chats dir read failed:", err && err.message);
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    // Filename was sanitized on write; ids the extension mints are UUIDs, so
    // sanitized == original in practice. loadTranscript tolerates a mismatch
    // by skipping malformed entries.
    const t = loadTranscript(id);
    if (t) byId.set(t.chatId, t);
  }
  for (const t of transcripts.values()) byId.set(t.chatId, t);
  return [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS_LISTED)
    .map(chatSummary);
}

function handleChatList(ws) {
  safeSend(ws, { type: "chat_list", chats: listChats() });
}

function handleChatResume(ws, msg) {
  const chatId = String(msg.chatId || "");
  const t = chatId ? loadTranscript(chatId) : null;
  if (!t) {
    safeSend(ws, { type: "chat_resumed", chatId, found: false, live: false, msgs: [] });
    return;
  }
  safeSend(ws, {
    type: "chat_resumed", chatId: t.chatId, found: true,
    live: chatIsLive(t.chatId), adapter: t.adapter, model: t.model,
    title: t.title, msgs: t.msgs
  });
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      log("send failed:", err.message);
    }
  }
}

function extensionAvailable() {
  return extensionSocket !== null && extensionSocket.readyState === extensionSocket.OPEN;
}

// Fail every call currently in flight to the extension.
function failPendingExtensionCalls(errorMessage) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    if (entry.kind === "hub") {
      entry.reject(new Error(errorMessage));
    } else {
      safeSend(entry.ws, { type: "tool_result", id, ok: false, error: errorMessage });
    }
  }
}

// ---------------------------------------------------------------------------
// Hub-originated tool calls (used by adapters via ctx.callBrowserTool)

function callBrowserTool(tool, args = {}) {
  return new Promise((resolve, reject) => {
    if (!extensionAvailable()) {
      reject(new Error("no extension connected"));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, TOOL_TIMEOUT_MS);
    pending.set(id, { kind: "hub", resolve, reject, timer });
    log("tool_call", tool);
    safeSend(extensionSocket, { type: "tool_call", id, tool, args, permissions: consentPolicy() });
  });
}

// ---------------------------------------------------------------------------
// Attachments and prompt composition (PROTOCOL.md "Chat message, v1.1")

// Basename first, then strip everything outside [A-Za-z0-9._-]. The strip is
// the backstop for separators basename() does not know about on this platform,
// but "." and "-" survive it, so "." and ".." need an explicit guard.
function sanitizeName(name) {
  const base = path.basename(String(name == null ? "" : name)).replace(/^.*[\\/]/, "");
  const stripped = base.replace(/[^A-Za-z0-9._-]/g, "");
  if (stripped === "" || stripped === "." || stripped === "..") return "file";
  return stripped;
}

// "report.pdf" -> "report-1.pdf" -> "report-2.pdf". Collisions are checked
// against the filesystem: the upload dir is per chat and lives across turns.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 0;
  while (existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

function uploadDir(chatId) {
  return path.join(UPLOAD_ROOT, sanitizeName(chatId));
}

function removeUploads(chatId) {
  try {
    rmSync(uploadDir(chatId), { recursive: true, force: true });
  } catch (err) {
    log("upload cleanup failed:", err.message);
  }
}

// Decoded byte length of a base64 string without decoding it.
function decodedSize(base64) {
  const s = String(base64 == null ? "" : base64).replace(/\s/g, "");
  if (s.length === 0) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

// Returns {ok:true, total} or {ok:false, error}. The whole batch is checked
// before anything is written so a rejected batch leaves no partial files.
function checkAttachments(attachments) {
  let total = 0;
  for (const att of attachments) {
    if (!att || typeof att.base64 !== "string") {
      return { ok: false, error: "attachment is missing base64 data" };
    }
    total += decodedSize(att.base64);
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    const mb = (total / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `attachments total ${mb} MB, over the 8 MB limit`
    };
  }
  return { ok: true, total };
}

// Writes each attachment under os.tmpdir()/agentchat-uploads/<chatId>/ and
// returns the absolute paths in the order they were sent.
function writeAttachments(chatId, attachments) {
  const dir = uploadDir(chatId);
  mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const att of attachments) {
    const target = uniquePath(dir, sanitizeName(att.name));
    writeFileSync(target, Buffer.from(att.base64, "base64"));
    paths.push(target);
  }
  return paths;
}

// Builds the prompt handed to the adapter. Absent sections are omitted; with
// no context and no attachments the result is the user text, unchanged.
// Exported for tests.
export function composePrompt(text, context, attachmentPaths) {
  const userText = typeof text === "string" ? text : "";
  const ctx = context && typeof context === "object" ? context : {};
  const current = ctx.currentTab && typeof ctx.currentTab === "object" ? ctx.currentTab : null;
  const tabs = Array.isArray(ctx.tabs) ? ctx.tabs.filter((t) => t && typeof t === "object") : [];
  const files = Array.isArray(attachmentPaths) ? attachmentPaths : [];
  const sel =
    ctx.selection && typeof ctx.selection === "object" ? ctx.selection : null;

  const lines = [];
  if (current) {
    lines.push(`Current tab: ${describeTab(current)}`);
  }
  if (tabs.length > 0) {
    lines.push("Tagged tabs:");
    for (const tab of tabs) lines.push(`- ${describeTab(tab)}`);
  }
  if (sel) {
    for (const line of describeSelection(sel)) lines.push(line);
  }
  if (files.length > 0) {
    lines.push("Attached files (saved on this machine; read them with your file tools):");
    for (const file of files) lines.push(`- ${file}`);
  }
  if (lines.length === 0) return userText;
  return `<context>\n${lines.join("\n")}\n</context>\n\n${userText}`;
}

// The page text the user highlighted and asked about: the clip itself plus the
// structural context the content script captured around it (enclosing code
// block or table, heading, DOM path, surrounding paragraphs). Fields are
// bounded here as well as in the panel, so a hand-crafted context cannot push
// an unbounded page into the prompt.
const SELECTION_LIMITS = {
  text: 4000,
  surrounding: 800,
  heading: 200,
  path: 300,
  code: 8000,
  table: 4000,
};

function selClip(value, max) {
  const s = String(value == null ? "" : value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function describeSelection(sel) {
  const text = selClip(sel.text, SELECTION_LIMITS.text);
  if (!text) return [];
  const kind = ["text", "code", "table"].includes(sel.contentType)
    ? sel.contentType
    : "text";

  const lines = [];
  const pageBits = [];
  if (sel.pageTitle) pageBits.push(`"${selClip(sel.pageTitle, 300)}"`);
  if (sel.pageUrl) pageBits.push(selClip(sel.pageUrl, 2000));
  lines.push(
    `Text selected on the page${pageBits.length ? " — " + pageBits.join(" ") : ""} (type: ${kind}):`
  );
  lines.push('"""');
  lines.push(text);
  lines.push('"""');

  const heading = selClip(sel.parentHeading, SELECTION_LIMITS.heading);
  if (heading) lines.push(`Section heading: ${heading}`);
  const path = selClip(sel.semanticPath, SELECTION_LIMITS.path);
  if (path) lines.push(`DOM path: ${path}`);

  const before = selClip(sel.surroundingBefore, SELECTION_LIMITS.surrounding);
  const after = selClip(sel.surroundingAfter, SELECTION_LIMITS.surrounding);
  if (before || after) {
    lines.push("Surrounding text:");
    lines.push(`... ${before} [SELECTED TEXT] ${after} ...`);
  }

  if (kind === "code" && sel.codeBlock && typeof sel.codeBlock === "object") {
    const code = selClip(sel.codeBlock.fullCode, SELECTION_LIMITS.code);
    if (code) {
      const lang = selClip(sel.codeBlock.language, 40) || "code";
      lines.push(`Enclosing code block (${lang}):`);
      lines.push("```" + lang);
      lines.push(code);
      lines.push("```");
    }
  }

  if (kind === "table" && typeof sel.tableBlock === "string" && sel.tableBlock) {
    lines.push("Enclosing table (markdown):");
    lines.push(selClip(sel.tableBlock, SELECTION_LIMITS.table));
  }

  return lines;
}

function describeTab(tab) {
  return `"${tab.title == null ? "" : tab.title}" ${tab.url == null ? "" : tab.url} (tabId ${tab.tabId})`;
}

// ---------------------------------------------------------------------------
// Usage, cost and the per-turn emitter (PROTOCOL.md v1.3 section A)
//
// Adapters report what their backend tells them for the turn. The hub owns the
// running per-chat totals and the price lookup, so every meta on the wire
// carries the same fields whatever the adapter did.

let pricingModule = null;
let pricingPromise = null;
let pricingWarned = false;

// A failed import is not cached, so the retry costs one failed resolve per turn
// and stops the moment adapters/pricing.mjs exists. The warning is logged once.
function pricingSpecifier() {
  const override = process.env.AGENTCHAT_PRICING_MODULE;
  return override ? pathToFileURL(path.resolve(override)).href : "../adapters/pricing.mjs";
}

function loadPricing() {
  if (!pricingPromise) {
    pricingPromise = import(pricingSpecifier())
      .then((mod) => {
        pricingModule = mod;
        return mod;
      })
      .catch((err) => {
        // Not written yet, or broken: costUsd stays null and turns still run.
        if (!pricingWarned) {
          pricingWarned = true;
          log("pricing table unavailable, costUsd will be null:", err.message);
        }
        pricingModule = null;
        pricingPromise = null;
        return null;
      });
  }
  return pricingPromise;
}
loadPricing();

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// usage is {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}.
function costUsdFor(adapterName, model, usage) {
  const pricing = pricingModule;
  if (!pricing || typeof pricing.costFor !== "function") return null;
  try {
    if (typeof pricing.isMetered === "function" && !pricing.isMetered(adapterName)) return null;
    return numberOrNull(pricing.costFor(model, usage));
  } catch (err) {
    log("costFor failed:", err.message);
    return null;
  }
}

// True when the cost above came from rates we guessed rather than published
// ones. The panel prefixes those with "~" so an estimate is never mistaken for
// a real charge.
function costEstimatedFor(adapterName, model) {
  const pricing = pricingModule;
  if (!pricing || typeof pricing.isEstimatedCost !== "function") return false;
  try {
    return pricing.isEstimatedCost(model, adapterName) === true;
  } catch (err) {
    log("isEstimatedCost failed, treating as not estimated:", err && err.message);
    return false;
  }
}

// Rewrites a meta event into the v1.3 shape: per-turn numbers normalized to
// numbers or null, running session totals added, cost computed.
function augmentMeta(chatId, adapterName, model, event, elapsedMs) {
  const usage = {
    inputTokens: numberOrNull(event.inputTokens),
    outputTokens: numberOrNull(event.outputTokens),
    cacheReadTokens: numberOrNull(event.cacheReadTokens),
    cacheWriteTokens: numberOrNull(event.cacheWriteTokens)
  };
  let totals = sessionTotals.get(chatId);
  if (!totals) {
    totals = { input: 0, output: 0 };
    sessionTotals.set(chatId, totals);
  }
  totals.input += usage.inputTokens || 0;
  totals.output += usage.outputTokens || 0;
  const metaModel = event.model == null ? model || null : event.model;
  return {
    ...event,
    kind: "meta",
    model: metaModel,
    adapter: event.adapter || adapterName,
    elapsedMs: numberOrNull(event.elapsedMs) === null ? elapsedMs : event.elapsedMs,
    ...usage,
    sessionInputTokens: totals.input,
    sessionOutputTokens: totals.output,
    costUsd: costUsdFor(adapterName, metaModel, usage),
    costEstimated: costEstimatedFor(adapterName, metaModel)
  };
}

// Shared by chat turns and commands. Guarantees, per turn: nothing after done,
// exactly one status, exactly one meta (augmented), done exactly once.
// `state.model` is read late, so a caller can fill it in once the session
// resolves its model.
function createTurnEmitter(chatId, adapterName, state) {
  const startedAt = Date.now();
  let done = false;
  let sawStatus = false;
  let sawMeta = false;

  function send(event) {
    safeSend(extensionSocket, { type: "chat_event", chatId, event });
  }

  const emit = (event) => {
    if (done) return;
    let outgoing = event;
    if (event && typeof event === "object") {
      if (event.kind === "token") recordToken(chatId, event.text);
      if (event.kind === "done") recordDone(chatId, state.model);
      if (event.kind === "status") sawStatus = true;
      if (event.kind === "meta") {
        if (sawMeta) return; // never two metas
        sawMeta = true;
        outgoing = augmentMeta(chatId, adapterName, state.model, event, Date.now() - startedAt);
      }
      if (event.kind === "done") {
        if (!sawStatus) {
          sawStatus = true;
          send({ kind: "status", state: "idle", label: "done" });
        }
        if (!sawMeta) {
          sawMeta = true;
          send(augmentMeta(chatId, adapterName, state.model, { kind: "meta" }, Date.now() - startedAt));
        }
        done = true;
      }
    }
    send(outgoing);
  };

  return {
    emit,
    startedAt,
    isDone: () => done,
    sawStatus: () => sawStatus
  };
}

// ---------------------------------------------------------------------------
// Capabilities (PROTOCOL.md "Capabilities")
//
// The adapter names in the protocol are the source of truth for what the panel
// may offer; adapters/base.mjs DESCRIPTORS supplies the label, models,
// defaultModel and provider for each. FALLBACK_DESCRIPTORS covers the case
// where a descriptor is missing so the picker is never empty.

const ADAPTER_NAMES = [
  "claude-agent-sdk",
  "claude-cli",
  "codex",
  "opencode",
  "copilot",
  "grok",
  "agy",
  "gemini",
  "anthropic-api",
  "openai-api"
];

const CLAUDE_MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" }
];

const FALLBACK_DESCRIPTORS = {
  "claude-agent-sdk": {
    label: "Claude Agent SDK",
    models: CLAUDE_MODELS,
    defaultModel: config.model || "claude-opus-5",
    provider: null
  },
  "claude-cli": {
    label: "Claude Code CLI",
    models: CLAUDE_MODELS,
    defaultModel: config.model || "claude-opus-5",
    provider: null
  },
  codex: {
    label: "Codex CLI",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }
    ],
    defaultModel: null,
    provider: null
  },
  opencode: { label: "OpenCode", models: [], defaultModel: null, provider: null },
  copilot: { label: "Copilot CLI", models: [], defaultModel: null, provider: null },
  grok: { label: "Grok CLI", models: [], defaultModel: null, provider: null },
  agy: { label: "Antigravity CLI", models: [], defaultModel: null, provider: null },
  gemini: { label: "Gemini CLI", models: [], defaultModel: null, provider: null },
  "anthropic-api": {
    label: "Anthropic API",
    models: CLAUDE_MODELS,
    defaultModel: "claude-opus-5",
    provider: "anthropic"
  },
  "openai-api": {
    label: "OpenAI API",
    models: [],
    defaultModel: null,
    provider: "openai"
  }
};

async function loadDescriptors() {
  try {
    const mod = await loadAdapterModule();
    if (mod && mod.DESCRIPTORS && typeof mod.DESCRIPTORS === "object") return mod.DESCRIPTORS;
  } catch (err) {
    log("adapter descriptors unavailable:", err.message);
  }
  return {};
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const m of models) {
    if (typeof m === "string") out.push({ id: m, label: m });
    else if (m && typeof m === "object" && m.id != null) {
      out.push({ id: String(m.id), label: String(m.label == null ? m.id : m.label) });
    }
  }
  return out;
}

function normalizeDescriptor(name, descriptor) {
  const d = descriptor && typeof descriptor === "object" ? descriptor : {};
  const fb = FALLBACK_DESCRIPTORS[name] || {};
  const provider =
    d.provider === "anthropic" || d.provider === "openai"
      ? d.provider
      : d.provider === null && "provider" in d
        ? null
        : fb.provider || null;
  const models = "models" in d ? normalizeModels(d.models) : normalizeModels(fb.models);
  const defaultModel =
    typeof d.defaultModel === "string"
      ? d.defaultModel
      : typeof fb.defaultModel === "string"
        ? fb.defaultModel
        : null;
  const label =
    typeof d.label === "string" && d.label !== ""
      ? d.label
      : typeof fb.label === "string"
        ? fb.label
        : name;
  // config.json `adapterModels` replaces the built-in list (same rule as
  // adapters/base.mjs) so deployments can name the ids their CLIs accept.
  const configured =
    config.adapterModels && Array.isArray(config.adapterModels[name])
      ? normalizeModels(config.adapterModels[name])
      : null;
  return { name, label, models: configured || models, defaultModel, provider };
}

async function descriptorFor(name) {
  const descriptors = await loadDescriptors();
  return normalizeDescriptor(name, descriptors[name]);
}

async function buildCapabilities() {
  const descriptors = await loadDescriptors();
  const names = [...new Set([...ADAPTER_NAMES, ...Object.keys(descriptors)])];
  let probe = null;
  try {
    const mod = await loadAdapterModule();
    if (mod && typeof mod.probeAdapter === "function") probe = mod.probeAdapter;
  } catch (err) {
    log("adapter probe unavailable:", err.message);
  }
  const adapters = names.map((name) => {
    const d = normalizeDescriptor(name, descriptors[name]);
    let status = { status: "unknown" };
    if (probe) {
      try {
        status = probe(name);
      } catch (err) {
        log(`adapter probe failed for ${name}:`, err.message);
      }
    }
    return {
      name: d.name,
      label: d.label,
      models: d.models,
      defaultModel: d.defaultModel,
      provider: d.provider,
      keyConfigured: d.provider ? hasKey(d.provider) : false,
      ...status
    };
  });
  // The command registry rides along so the panel's autocomplete can never
  // drift from what the hub actually implements (PROTOCOL v1.3 B).
  return { type: "capabilities", adapters, commands: COMMANDS };
}

async function sendCapabilities(ws) {
  const target = ws || extensionSocket;
  if (!target) return;
  try {
    safeSend(target, await buildCapabilities());
  } catch (err) {
    log("could not build capabilities:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Adapter sessions
//
// Interface with adapters/base.mjs (implemented by the adapters builder):
//   createSession(adapterName, ctx) -> session or Promise<session>
//     ctx = { callBrowserTool, config, model, getApiKey, tools }
//     session = { send(text, emit), abort(), dispose() }
//   ADAPTERS: list of adapter names (not used here beyond error messages).
//   DESCRIPTORS: name -> {label, models, defaultModel, provider}, used to build
//     the capabilities message.
// Imported lazily so the hub can serve tool traffic even before adapters exist.

let adapterModulePromise = null;

// AGENTCHAT_ADAPTER_MODULE points the hub at a different module with the same
// exports. It exists so the command tests can run against a stub adapter that
// spends no tokens; production leaves it unset.
function loadAdapterModule() {
  if (!adapterModulePromise) {
    const override = process.env.AGENTCHAT_ADAPTER_MODULE;
    if (override) {
      log("adapter module overridden by AGENTCHAT_ADAPTER_MODULE");
      adapterModulePromise = import(pathToFileURL(path.resolve(override)).href);
    } else {
      adapterModulePromise = import("../adapters/base.mjs");
    }
  }
  return adapterModulePromise;
}

// Aborts a running command for this chat, if there is one. A loop must never
// outlive the thing that started it: the same call serves chat_abort, session
// disposal, and the extension going away.
function abortCommand(chatId, reason) {
  const record = runningCommands.get(chatId);
  if (!record) return false;
  log("aborting /" + record.name + " (" + reason + ")", chatId);
  try {
    record.controller.abort();
  } catch (err) {
    log("command abort failed:", err.message);
  }
  for (const session of record.laneSessions) {
    try {
      session.abort();
    } catch (err) {
      log("lane abort failed:", err.message);
    }
  }
  // The controller only stops the command between iterations. The turn already
  // in flight has to be cut too, or the wall-clock cap and the disconnect path
  // keep burning tokens until the adapter returns on its own.
  const entry = sessions.get(chatId);
  if (entry) {
    try {
      entry.session.abort();
    } catch (err) {
      log("abort failed:", err.message);
    }
  }
  return true;
}

// Single dispose path: drops the session and its upload dir together. A running
// command on this chat is aborted first, so nothing keeps sending into a
// session that is about to be thrown away. abortRunning:false is for the one
// caller that is itself the command being started: a command that switches
// model or adapter disposes the old session on its way in and must not abort
// itself before its first iteration.
function disposeSession(chatId, reason, { abortRunning = true } = {}) {
  const entry = sessions.get(chatId);
  if (!entry) return;
  if (abortRunning) abortCommand(chatId, "session disposed: " + reason);
  sessions.delete(chatId);
  if (reason === "idle") sessionTotals.delete(chatId);
  try {
    entry.session.dispose();
  } catch (err) {
    log("dispose failed:", err.message);
  }
  removeUploads(chatId);
  log("session disposed (" + reason + ")", chatId);
}

// `model` is the requested model id or null. A session records the model it
// resolved to, so a chat that omits `model` never counts as a change.
async function getSessionEntry(chatId, adapterName, model, emit, { abortRunning = true } = {}) {
  let entry = sessions.get(chatId);
  if (entry && entry.adapterName !== adapterName) {
    // The panel switched adapter mid-chat; the old session cannot serve it.
    disposeSession(chatId, "adapter changed", { abortRunning });
    entry = undefined;
  } else if (entry && model && entry.model !== model) {
    // A model switch only takes effect in a fresh session.
    disposeSession(chatId, "model changed", { abortRunning });
    emit({ kind: "info", message: `session restarted with model ${model}` });
    entry = undefined;
  }
  if (entry) {
    entry.lastUsed = Date.now();
    return entry;
  }
  const descriptor = await descriptorFor(adapterName);
  // Mirror how base.mjs resolves ctx.model, so the recorded model is the one the
  // session really runs and the change check above compares like with like.
  // Adapters with no model switch stay null rather than inventing one for meta.
  const mod = await loadAdapterModule();
  const resolvedModel = typeof mod.resolveModel === "function"
    ? mod.resolveModel(adapterName, model, config)
    : model || descriptor.defaultModel || null;
  const session = await mod.createSession(adapterName, {
    callBrowserTool,
    config,
    model: model || null,
    getApiKey,
    tools: TOOLS
  });
  entry = { session, adapterName, model: resolvedModel, lastUsed: Date.now() };
  sessions.set(chatId, entry);
  log(
    "session created for chat", chatId,
    "adapter=" + adapterName,
    "model=" + (resolvedModel || "default")
  );
  return entry;
}

// Waits for the key store, then answers whether this adapter may run. An
// adapter whose provider has no key never reaches session creation: the caller
// gets an error + done and stops. Shared by chat turns and commands.
async function providerKeyReady(chatId, adapterName, emit) {
  await loadKeystore();
  await loadPricing();
  let descriptor;
  try {
    descriptor = await descriptorFor(adapterName);
  } catch (err) {
    descriptor = normalizeDescriptor(adapterName, null);
    log("descriptor lookup failed for", adapterName + ":", err.message);
  }
  if (descriptor.provider && !hasKey(descriptor.provider)) {
    const message =
      `no ${descriptor.provider} API key configured. ` +
      `Add one in the panel settings (it is stored on this machine in ` +
      `~/.agentchat/keys.json) or pick a CLI adapter.`;
    log("chat", chatId, "rejected: missing", descriptor.provider, "key");
    emit({ kind: "error", message });
    emit({ kind: "done" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Proactive annotation (config.proactiveAnnotation)
//
// When enabled, the first chat that carries a given tabId+url runs a second,
// independent turn on the configured adapter: read the page, mark the
// passages worth flagging with the annotate tool. The turn's events go to
// chatId "pro-<tabId>-<ts>", which no panel or annotation card claims, so it
// runs silently in the background. Off by default.

const proactiveAnnotated = new Set(); // `${tabId}|${url}` — once per page load

const PROACTIVE_DEFAULT_PROMPT =
  "You are co-reading this page with the user. Read it with read_page on the " +
  "given tabId, pick the 3-5 passages most likely to be confusing or worth " +
  "attention, and mark each with the annotate tool: quote the exact text, use " +
  "underline for key terms, highlight for important sentences, circle for " +
  "whole blocks. Always fill comment with WHY you marked it. Finish with a " +
  "one-paragraph summary of what you marked.";

function maybeRunProactiveAnnotation(context) {
  const cfg = config.proactiveAnnotation;
  if (!cfg || cfg.enabled !== true) return;
  const tab = context && context.currentTab;
  if (!tab || tab.tabId == null || !tab.url) return;
  const key = `${tab.tabId}|${tab.url}`;
  if (proactiveAnnotated.has(key)) return;
  proactiveAnnotated.add(key);
  runProactiveTurn(tab).catch((err) => {
    log("proactive annotation turn failed:", err && err.message ? err.message : String(err));
  });
}

async function runProactiveTurn(tab) {
  const cfg = config.proactiveAnnotation || {};
  const adapterName = cfg.adapter || config.adapter;
  const chatId = `pro-${tab.tabId}-${Date.now()}`;
  const state = { model: null };
  const turn = createTurnEmitter(chatId, adapterName, state);
  const emit = turn.emit;
  log("proactive annotation pass on tab", tab.tabId, "adapter=" + adapterName);
  activeChats.add(chatId);
  try {
    if (!(await providerKeyReady(chatId, adapterName, emit))) return;
    const entry = await getSessionEntry(chatId, adapterName, null, emit);
    state.model = entry.model;
    const prompt = composePrompt(
      typeof cfg.prompt === "string" && cfg.prompt ? cfg.prompt : PROACTIVE_DEFAULT_PROMPT,
      { currentTab: tab },
      []
    );
    await entry.session.send(prompt, emit);
  } catch (err) {
    emit({ kind: "error", message: scrub(String((err && err.message) || err)) });
  } finally {
    activeChats.delete(chatId);
    if (!turn.isDone()) emit({ kind: "done" });
  }
}

async function handleChat(msg) {
  const chatId = msg.chatId;
  const text = typeof msg.text === "string" ? msg.text : "";
  const adapterName = msg.adapter || config.adapter;
  const requestedModel = typeof msg.model === "string" && msg.model !== "" ? msg.model : null;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

  let statusTimer = null;
  // Read late by the emitter, so the meta reports the model the session really
  // resolved to rather than the one the panel asked for.
  const state = { model: requestedModel };
  const turn = createTurnEmitter(chatId, adapterName, state);
  const emit = turn.emit;

  if (runningCommands.has(chatId)) {
    const running = runningCommands.get(chatId);
    emit({
      kind: "error",
      message: `/${running.name} is still running in this chat. Stop it first, then send your message.`
    });
    emit({ kind: "done" });
    return;
  }
  if (activeChats.has(chatId)) {
    emit({ kind: "error", message: "this chat is already waiting on a reply." });
    emit({ kind: "done" });
    return;
  }

  // A new tab context kicks off the co-read pass when enabled; it runs on its
  // own chatId so it never blocks this turn.
  maybeRunProactiveAnnotation(msg.context);

  // Reserve the chat before the first await. Two frames can arrive in one read
  // and be dispatched synchronously; a guard that reads state written after an
  // await would let both through onto the same single-turn adapter session.
  activeChats.add(chatId);
  recordUser(chatId, text, adapterName, requestedModel);
  try {
    const check = checkAttachments(attachments);
    if (!check.ok) {
      log("chat", chatId, "rejected:", check.error);
      emit({ kind: "error", message: check.error });
      emit({ kind: "done" });
      return;
    }

    // Key check before anything is written: an adapter with no key creates no
    // session, so nothing would ever clean up its upload dir. Wait for the real
    // keystore first so hasKey() never answers from the fallback reader while
    // the module is still loading (the promise is cached, so this is free after
    // the first call).
    if (!(await providerKeyReady(chatId, adapterName, emit))) return;

    // Never log names or contents, only how much came in.
    log(
      "chat", chatId, "adapter=" + adapterName,
      "model=" + (requestedModel || "default"),
      "attachments=" + attachments.length, "bytes=" + check.total
    );

    const attachmentPaths = attachments.length > 0 ? writeAttachments(chatId, attachments) : [];
    const prompt = composePrompt(text, msg.context, attachmentPaths);
    const entry = await getSessionEntry(chatId, adapterName, requestedModel, emit);
    state.model = entry.model;

    // The contract wants a status event right after send. Adapters that emit
    // their own win the race; this fires only if none arrived in 300ms.
    statusTimer = setTimeout(() => {
      if (!turn.sawStatus() && !turn.isDone()) {
        emit({ kind: "status", state: "thinking", label: "thinking" });
      }
    }, STATUS_INJECT_MS);

    await entry.session.send(prompt, emit);
    entry.lastUsed = Date.now();
  } catch (err) {
    // Files are written before the session exists. If the turn failed without
    // a session being registered, nothing will ever dispose them, so drop them
    // now. A live session keeps its files: it may still be reading them.
    if (!sessions.has(chatId)) removeUploads(chatId);
    emit({ kind: "error", message: scrub(String((err && err.message) || err)) });
  } finally {
    activeChats.delete(chatId);
    clearTimeout(statusTimer);
    if (!turn.isDone()) emit({ kind: "done" });
  }
}

// ---------------------------------------------------------------------------
// Slash commands (PROTOCOL.md v1.3 sections B, C, D2)

async function handleCommand(msg) {
  const chatId = msg.chatId;
  const name = String(msg.name == null ? "" : msg.name).trim().replace(/^\//, "");
  const args = typeof msg.args === "string" ? msg.args : "";
  const adapterName = msg.adapter || config.adapter;
  const requestedModel = typeof msg.model === "string" && msg.model !== "" ? msg.model : null;

  let statusTimer = null;
  const state = { model: requestedModel };
  const turn = createTurnEmitter(chatId, adapterName, state);
  const emit = turn.emit;

  if (runningCommands.has(chatId)) {
    emit({
      kind: "error",
      message: `/${runningCommands.get(chatId).name} is already running in this chat.`
    });
    emit({ kind: "done" });
    return;
  }
  if (activeChats.has(chatId)) {
    emit({ kind: "error", message: "this chat is already waiting on a reply." });
    emit({ kind: "done" });
    return;
  }

  const command = commandByName(name);
  const wantsSession = command != null && command.scope === "server" && needsChatSession(name);
  const spawnsLanes = command != null && command.scope === "server" && needsLaneSessions(name);

  log("command /" + name, chatId, "adapter=" + adapterName, "model=" + (requestedModel || "default"));

  // Reserved before the first await, for the same reason handleChat reserves
  // early: two commands dispatched from one socket read would otherwise both
  // pass the guard, and the second would overwrite the first's record, leaving
  // a loop nothing could abort.
  const record = { name, controller: new AbortController(), laneSessions: new Set() };
  runningCommands.set(chatId, record);

  let usage = null;
  try {
    // /help and /tabs cost nothing, so they must not reach the key check or
    // create a session: no model is involved at all.
    if (wantsSession || spawnsLanes) {
      if (!(await providerKeyReady(chatId, adapterName, emit))) return;
    }

    let session = null;
    if (wantsSession) {
      // abortRunning:false: this command is the one in runningCommands, and a
      // model or adapter switch disposing the old session must not abort it
      // before its first iteration.
      const entry = await getSessionEntry(chatId, adapterName, requestedModel, emit, {
        abortRunning: false
      });
      state.model = entry.model;
      session = entry.session;
    } else if (spawnsLanes) {
      // Lane sessions are not in the sessions map, so nothing else would fill
      // in the model the meta (and therefore the cost lookup) needs.
      const mod = await loadAdapterModule();
      state.model =
        typeof mod.resolveModel === "function"
          ? mod.resolveModel(adapterName, requestedModel, config)
          : requestedModel || (await descriptorFor(adapterName)).defaultModel || null;
    }

    statusTimer = setTimeout(() => {
      if (!turn.sawStatus() && !turn.isDone()) {
        emit({ kind: "status", state: "working", label: "/" + name });
      }
    }, STATUS_INJECT_MS);

    const ctx = {
      chatId,
      adapter: adapterName,
      model: state.model,
      context: msg.context && typeof msg.context === "object" ? msg.context : null,
      callBrowserTool,
      // Lane sessions live only for this command. They are registered on the
      // record so abort reaches them and the finally below disposes them
      // however the command ends.
      createSession: async () => {
        if (record.laneSessions.size >= PARALLEL_MAX_LANES) {
          throw new Error("lane limit reached");
        }
        const mod = await loadAdapterModule();
        const laneSession = await mod.createSession(adapterName, {
          callBrowserTool,
          config,
          model: requestedModel || null,
          getApiKey,
          tools: TOOLS
        });
        record.laneSessions.add(laneSession);
        return laneSession;
      },
      abort: (reason) => abortCommand(chatId, reason),
      touch: () => {
        const entry = sessions.get(chatId);
        if (entry) entry.lastUsed = Date.now();
      },
      log: (...a) => log(...a)
    };

    const result = await dispatch(name, {
      args,
      session,
      emit,
      ctx,
      signal: record.controller.signal
    });
    if (result && result.usage) usage = result.usage;
  } catch (err) {
    emit({ kind: "error", message: scrub(String((err && err.message) || err)) });
  } finally {
    clearTimeout(statusTimer);
    if (runningCommands.get(chatId) === record) runningCommands.delete(chatId);
    for (const laneSession of record.laneSessions) {
      try {
        laneSession.dispose();
      } catch (err) {
        log("lane dispose failed:", err.message);
      }
    }
    record.laneSessions.clear();
    if (!turn.isDone()) {
      // One meta and one done for the whole command, carrying the summed usage
      // of every iteration or lane it ran.
      emit({
        kind: "meta",
        model: state.model || null,
        adapter: adapterName,
        elapsedMs: Date.now() - turn.startedAt,
        inputTokens: usage ? usage.inputTokens : null,
        outputTokens: usage ? usage.outputTokens : null,
        cacheReadTokens: usage ? usage.cacheReadTokens : null,
        cacheWriteTokens: usage ? usage.cacheWriteTokens : null
      });
      emit({ kind: "done" });
    }
  }
}

function handleChatAbort(msg) {
  log("chat_abort", msg.chatId);
  abortCommand(msg.chatId, "chat_abort");
  const entry = sessions.get(msg.chatId);
  if (!entry) return;
  try {
    entry.session.abort();
  } catch (err) {
    log("abort failed:", err.message);
  }
}

async function handleSetKey(ws, msg) {
  const provider = msg.provider;
  if (!PROVIDERS.includes(provider)) {
    log("set_key with unknown provider, ignoring");
    return;
  }
  const key =
    typeof msg.key === "string" && msg.key.trim() !== "" ? msg.key.trim() : null;
  try {
    await storeKey(provider, key);
    log("api key " + (key ? "stored" : "cleared") + " for provider " + provider);
  } catch (err) {
    // scrub() runs inside log(); an error string could quote the value.
    log("set_key failed for provider " + provider + ":", err.message);
  }
  await sendCapabilities(ws);
}

setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of sessions) {
    // A chat with work in flight is not idle, whatever lastUsed says: a single
    // iteration or a long tool call can outlast the window.
    if (runningCommands.has(chatId) || activeChats.has(chatId)) continue;
    if (now - entry.lastUsed > SESSION_IDLE_MS) {
      disposeSession(chatId, "idle");
    }
  }
  // Totals for chats that only ever ran a session-less command (/help, /tabs)
  // have no session to expire with. Drop them once the map grows.
  if (sessionTotals.size > MAX_TOTALS_ENTRIES) {
    for (const chatId of sessionTotals.keys()) {
      if (!sessions.has(chatId) && !runningCommands.has(chatId) && !activeChats.has(chatId)) {
        sessionTotals.delete(chatId);
      }
    }
  }
}, SWEEP_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Message handling

function handleHello(ws, msg) {
  if (msg.role === "extension") {
    if (extensionSocket && extensionSocket !== ws) {
      log("extension displaced by new connection");
      failPendingExtensionCalls("displaced");
      try {
        extensionSocket.close();
      } catch (err) {
        // already closing
        log("closing displaced extension socket failed:", err && err.message);
      }
    }
    extensionSocket = ws;
    ws.agentchatRole = "extension";
    log("extension connected", msg.version ? "v" + msg.version : "");
    // Load the keystore before the first capabilities message so keyConfigured
    // reflects the real store rather than the fallback read.
    loadKeystore().then(() => sendCapabilities(ws));
  } else if (msg.role === "harness") {
    ws.agentchatRole = "harness";
    ws.agentchatName = typeof msg.name === "string" ? msg.name : "harness";
    log("harness connected:", ws.agentchatName);
  } else {
    log("hello with unknown role, ignoring:", msg.role);
  }
}

function handleHarnessToolCall(ws, msg) {
  const { id, tool } = msg;
  log("tool_call", tool, "(harness: " + ws.agentchatName + ")");
  if (!extensionAvailable()) {
    safeSend(ws, { type: "tool_result", id, ok: false, error: "no extension connected" });
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(id);
    safeSend(ws, { type: "tool_result", id, ok: false, error: "timeout" });
  }, TOOL_TIMEOUT_MS);
  pending.set(id, { kind: "harness", ws, timer });
  safeSend(extensionSocket, {
    type: "tool_call", id, tool, args: msg.args || {}, permissions: consentPolicy(),
  });
}

function handleToolResult(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return; // timed out or displaced
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  if (entry.kind === "hub") {
    if (msg.ok) {
      entry.resolve(msg.result || {});
    } else {
      entry.reject(new Error(msg.error || "tool call failed"));
    }
  } else {
    safeSend(entry.ws, msg);
  }
}

function handleMessage(ws, msg) {
  if (msg.type === "hello") {
    handleHello(ws, msg);
    return;
  }

  if (ws.agentchatRole === "harness") {
    if (msg.type === "tool_call") handleHarnessToolCall(ws, msg);
    // Read-only: lets `agentbrowser backends` show adapter readiness to
    // harness-side tooling, same payload the extension gets.
    else if (msg.type === "get_capabilities") sendCapabilities(ws);
    return;
  }

  if (ws.agentchatRole === "extension") {
    if (msg.type === "tool_result") handleToolResult(msg);
    else if (msg.type === "chat") handleChat(msg);
    else if (msg.type === "command") handleCommand(msg);
    else if (msg.type === "chat_abort") handleChatAbort(msg);
    else if (msg.type === "set_key") handleSetKey(ws, msg);
    else if (msg.type === "get_capabilities") sendCapabilities(ws);
    else if (msg.type === "chat_list") handleChatList(ws);
    else if (msg.type === "chat_resume") handleChatResume(ws, msg);
  }
}

function handleClose(ws) {
  if (ws.agentchatRole === "extension") {
    if (extensionSocket === ws) {
      extensionSocket = null;
      failPendingExtensionCalls("extension disconnected");
      // Nothing is watching, and a loop with no browser and no reader is just
      // burning tokens. Stop every command that is still running.
      for (const chatId of [...runningCommands.keys()]) {
        abortCommand(chatId, "extension disconnected");
      }
      log("extension disconnected");
    }
    // A displaced socket closing is already logged at displacement time.
  } else if (ws.agentchatRole === "harness") {
    for (const [id, entry] of pending) {
      if (entry.kind === "harness" && entry.ws === ws) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    }
    log("harness disconnected:", ws.agentchatName || "");
  } else {
    log("client disconnected before hello");
  }
}

// ---------------------------------------------------------------------------
// Server

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT }, () => {
  log("listening on ws://127.0.0.1:" + PORT);
});

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(
      "port " + PORT + " is already in use." +
      " Another hub (or another tool) is bound to it." +
      " Stop that process or set AGENTCHAT_PORT to a free port."
    );
    process.exit(1);
  }
  log("server error:", err.message);
});

wss.on("connection", (ws) => {
  ws.agentchatRole = null;
  ws.agentchatName = null;
  log("client connected, awaiting hello");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      log("dropping non-JSON client message:", err && err.message);
      return; // not JSON, ignore
    }
    if (!msg || typeof msg.type !== "string") return;
    handleMessage(ws, msg);
  });

  ws.on("close", () => handleClose(ws));
  ws.on("error", (err) => log("socket error:", err.message));
});
