// Notes service (PROTOCOL v2.23): the hub-side half of the "notes" plugin —
// a pipebox-style page notes store living under ~/.agentchat/notes/ so notes
// stay local instead of in a cloud account. One JSON file per note plus an
// assets/ dir for pasted images. Pure storage + query code; hub.mjs wires it
// to tool calls, the note_op wire message and the admin HTTP API.
//
// Note shape: { id, title, url, domain, tags[], content(md), quotes[],
//               created, updated }
// Quote shape: { id, text, prefix, suffix, url, anchor:{xpath,start,end}, ts }
// — the anchor serializes where in the page DOM the quote was highlighted so
// the content script can re-apply it on the next visit.

import {
  readdirSync, readFileSync, writeFileSync, renameSync, existsSync,
  mkdirSync, rmSync, statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const MAX_BODY = 256 * 1024;       // per-note markdown cap
const MAX_ASSET = 8 * 1024 * 1024; // pasted-image cap
const MAX_LIST = 200;
const SAFE_NAME = /[^A-Za-z0-9._-]/g;

let logWarn = console.error;
export function wireNotes({ warn } = {}) {
  if (typeof warn === "function") logWarn = warn;
}

export function notesDir() {
  return process.env.AGENTCHAT_NOTES_DIR || path.join(os.homedir(), ".agentchat", "notes");
}
export function assetsDir() {
  return path.join(notesDir(), "assets");
}

function ensureDir() {
  try {
    mkdirSync(assetsDir(), { recursive: true, mode: 0o700 });
  } catch (err) {
    logWarn("[notes] cannot create notes dir:", err.message);
  }
}

function notePath(id) {
  return path.join(notesDir(), String(id).replace(SAFE_NAME, "_") + ".json");
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function writeAtomic(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

function readNoteFile(file) {
  try {
    const n = JSON.parse(readFileSync(file, "utf8"));
    if (!n || typeof n !== "object" || !n.id) return null;
    return {
      id: String(n.id),
      title: String(n.title || ""),
      url: String(n.url || ""),
      domain: String(n.domain || ""),
      tags: Array.isArray(n.tags) ? n.tags.map((t) => String(t)).filter(Boolean) : [],
      content: String(n.content || ""),
      quotes: Array.isArray(n.quotes) ? n.quotes : [],
      created: Number(n.created) || 0,
      updated: Number(n.updated) || 0,
    };
  } catch (err) {
    logWarn(`[notes] skipping unreadable ${path.basename(file)}:`, err.message);
    return null;
  }
}

function allNotes() {
  ensureDir();
  let files;
  try {
    files = readdirSync(notesDir()).filter((f) => f.endsWith(".json"));
  } catch (err) {
    logWarn("[notes] cannot read notes dir:", err.message);
    return [];
  }
  return files.map((f) => readNoteFile(path.join(notesDir(), f))).filter(Boolean);
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function summaryOf(n) {
  const body = n.content.replace(/\s+/g, " ").trim();
  return {
    id: n.id,
    title: n.title,
    url: n.url,
    domain: n.domain,
    tags: n.tags,
    quoteCount: n.quotes.length,
    excerpt: body.slice(0, 120),
    created: n.created,
    updated: n.updated,
  };
}

export function listNotes({ q, tag, domain, url, limit } = {}) {
  const needle = typeof q === "string" && q.trim() ? q.trim().toLowerCase() : null;
  const tagNeedle = tag ? String(tag) : null;
  const domainNeedle = domain ? String(domain) : null;
  const urlNeedle = url ? String(url) : null;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIST);
  return allNotes()
    .filter((n) => {
      if (tagNeedle && !n.tags.includes(tagNeedle)) return false;
      if (domainNeedle && n.domain !== domainNeedle) return false;
      if (urlNeedle && n.url !== urlNeedle) return false;
      if (needle) {
        const hay = `${n.title}\n${n.content}\n${n.tags.join(" ")}\n${n.url}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => b.updated - a.updated)
    .slice(0, lim)
    .map(summaryOf);
}

export function getNote(id) {
  const file = notePath(id);
  if (!existsSync(file)) return null;
  return readNoteFile(file);
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return undefined;
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
}

export function saveNote({ id, title, url, domain, tags, content, quotes } = {}) {
  const now = Date.now();
  let note = id ? getNote(id) : null;
  if (id && !note) return { error: "note not found: " + id };
  if (!note) {
    note = {
      id: newId("n"),
      title: "",
      url: "",
      domain: "",
      tags: [],
      content: "",
      quotes: [],
      created: now,
      updated: now,
    };
  }
  if (typeof title === "string") note.title = title.slice(0, 200);
  if (typeof url === "string") {
    note.url = url.slice(0, 2000);
    note.domain = domainOf(note.url);
  }
  if (typeof domain === "string") note.domain = domain.slice(0, 200);
  const t = cleanTags(tags);
  if (t) note.tags = t;
  if (typeof content === "string") {
    if (content.length > MAX_BODY) return { error: "content too large" };
    note.content = content;
  }
  if (Array.isArray(quotes)) note.quotes = quotes.slice(0, 500);
  note.updated = now;
  try {
    ensureDir();
    writeAtomic(notePath(note.id), JSON.stringify(note, null, 1));
  } catch (err) {
    logWarn("[notes] save failed:", err.message);
    return { error: String(err.message) };
  }
  return { note };
}

export function deleteNote(id) {
  const file = notePath(id);
  if (!existsSync(file)) return { error: "note not found: " + id };
  try {
    rmSync(file);
  } catch (err) {
    logWarn("[notes] delete failed:", err.message);
    return { error: String(err.message) };
  }
  return { deleted: id };
}

// Append a markdown chunk — used for "存笔记" of a selection, chatGPT exports
// and agent-side note_append. Returns the updated note.
export function appendContent(id, text) {
  const note = getNote(id);
  if (!note) return { error: "note not found: " + id };
  const chunk = String(text || "").trim();
  if (!chunk) return { error: "empty text" };
  const next = note.content ? note.content.replace(/\s+$/, "") + "\n\n" + chunk + "\n" : chunk + "\n";
  if (next.length > MAX_BODY) return { error: "content too large" };
  return saveNote({ id, content: next });
}

// Record a page quote: the highlighted text plus enough context to re-find it
// (exact text + prefix/suffix + serialized DOM anchor).
export function appendQuote(id, q = {}) {
  const note = getNote(id);
  if (!note) return { error: "note not found: " + id };
  const text = String(q.text || "").trim();
  if (!text) return { error: "empty quote" };
  note.quotes.push({
    id: newId("q"),
    text: text.slice(0, 4000),
    prefix: String(q.prefix || "").slice(0, 120),
    suffix: String(q.suffix || "").slice(0, 120),
    url: String(q.url || note.url || ""),
    anchor: q.anchor && typeof q.anchor === "object" ? q.anchor : null,
    ts: Date.now(),
  });
  if (note.quotes.length > 500) note.quotes = note.quotes.slice(-500);
  try {
    ensureDir();
    writeAtomic(notePath(note.id), JSON.stringify(note, null, 1));
  } catch (err) {
    logWarn("[notes] quote save failed:", err.message);
    return { error: String(err.message) };
  }
  return { note, quote: note.quotes[note.quotes.length - 1] };
}

export function listTags() {
  const counts = new Map();
  for (const n of allNotes()) {
    for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// Quotes for a page: every note's quotes anchored to this URL, so the content
// script can re-apply highlights on load.
export function quotesForUrl(url) {
  const u = String(url || "");
  if (!u) return [];
  const out = [];
  for (const n of allNotes()) {
    for (const q of n.quotes) {
      if (q.url === u || (q.url && u.startsWith(q.url.split("#")[0]) && q.url === u.split("#")[0])) {
        out.push({ ...q, noteId: n.id, noteTitle: n.title });
      }
    }
  }
  return out;
}

// Paste/upload an image into the assets dir; returns the URL path the note's
// markdown embeds (served by the admin HTTP handler).
export function addAsset(name, dataB64) {
  let buf;
  try {
    buf = Buffer.from(String(dataB64 || ""), "base64");
  } catch {
    return { error: "bad base64" };
  }
  if (!buf.length) return { error: "empty asset" };
  if (buf.length > MAX_ASSET) return { error: "asset too large" };
  const ext = (String(name || "").match(/\.[a-z0-9]{1,8}$/i) || [".png"])[0].toLowerCase();
  const fname = `${newId("img")}${ext}`;
  try {
    ensureDir();
    writeFileSync(path.join(assetsDir(), fname), buf, { mode: 0o600 });
  } catch (err) {
    logWarn("[notes] asset save failed:", err.message);
    return { error: String(err.message) };
  }
  return { name: fname, url: "/notes-assets/" + fname, bytes: buf.length };
}

export function readAsset(fname) {
  const safe = String(fname || "").replace(SAFE_NAME, "_");
  const file = path.join(assetsDir(), safe);
  if (!existsSync(file)) return null;
  try {
    return {
      data: readFileSync(file),
      mime:
        { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(safe).toLowerCase()] ||
        "application/octet-stream",
    };
  } catch (err) {
    logWarn("[notes] asset read failed:", err.message);
    return null;
  }
}

// Markdown export of a note (download from the library UI / API).
export function exportNote(id) {
  const note = getNote(id);
  if (!note) return null;
  const tags = note.tags.map((t) => "#" + t).join(" ");
  const head = `# ${note.title || "untitled"}\n\n${note.url ? note.url + "\n\n" : ""}${tags ? tags + "\n\n" : ""}`;
  const quotes = note.quotes.length
    ? "\n\n---\n\n" + note.quotes.map((q) => `> ${q.text.split("\n").join("\n> ")}\n\n— [${q.url || note.url}](${q.url || note.url})`).join("\n\n")
    : "";
  return head + note.content + quotes;
}

export function notesStats() {
  const ns = allNotes();
  let assets = 0;
  try {
    assets = existsSync(assetsDir()) ? readdirSync(assetsDir()).length : 0;
  } catch (err) {
    logWarn("[notes] assets count failed:", err.message);
  }
  return {
    notes: ns.length,
    quotes: ns.reduce((s, n) => s + n.quotes.length, 0),
    tags: listTags().length,
    assets,
    bytes: ns.reduce((s, n) => {
      try {
        return s + statSync(notePath(n.id)).size;
      } catch {
        return s;
      }
    }, 0),
  };
}
