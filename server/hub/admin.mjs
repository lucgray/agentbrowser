// Admin HTTP surface (v2.17): one shared port with the WebSocket hub.
// GET /admin serves a single-file management page; /admin/api/* is a small
// JSON API driving the same actions the extension uses over the wire
// (plugin toggles, translate config, keys, adapter/model). Localhost-only:
// the hub binds 127.0.0.1, same trust level as the WS port itself.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.join(__dirname, "admin.html"), "utf8");
const LOGO = readFileSync(path.join(__dirname, "../../extension/icons/icon-128.png"));
const MAX_BODY = 256 * 1024;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ctx supplies hub internals without importing them (hub.mjs passes them in):
//   state()          -> the full admin state payload
//   setPlugin(id, on)-> {ok, error?}
//   setTranslate(cfg)-> Promise<{ok, config, provider}>
//   setKey(provider, key) -> Promise<{ok, error?}>
//   setGeneral(cfg)  -> {ok, error?}      adapter/model/permissions patch
//   getConfig()      -> raw config object (never contains keys)
//   notes            -> the notes service module (v2.23)
export function createAdminHandler(ctx) {
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/admin/logo.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      res.end(LOGO);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/api/state") {
      try {
        json(res, 200, await ctx.state());
      } catch (err) {
        json(res, 500, { error: String((err && err.message) || err) });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/api/config") {
      json(res, 200, ctx.getConfig());
      return;
    }

    // Notes library API (v2.23) — the same ops the in-page sidebar performs
    // via note_op, exposed over HTTP so the notes live on the local port for
    // any workflow (this is pipebox's "Api 接口" feature, self-hosted).
    if (req.method === "GET" && url.pathname === "/admin/api/notes") {
      const N = ctx.notes;
      if (url.searchParams.get("id")) {
        const n = N.getNote(url.searchParams.get("id"));
        json(res, n ? 200 : 404, n ? { note: n } : { error: "not found" });
      } else {
        json(res, 200, {
          notes: N.listNotes({
            q: url.searchParams.get("q") || undefined,
            tag: url.searchParams.get("tag") || undefined,
            domain: url.searchParams.get("domain") || undefined,
            url: url.searchParams.get("url") || undefined,
            limit: url.searchParams.get("limit") || undefined,
          }),
          tags: N.listTags(),
          stats: N.notesStats(),
        });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/api/notes/export") {
      const md = ctx.notes.exportNote(url.searchParams.get("id"));
      if (md == null) {
        json(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''note-${encodeURIComponent(url.searchParams.get("id") || "")}.md`,
      });
      res.end(md);
      return;
    }
    if (req.method !== "POST" || !url.pathname.startsWith("/admin/api/")) {
      json(res, 404, { error: "not found" });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: String((err && err.message) || err) });
      return;
    }

    try {
      if (url.pathname === "/admin/api/plugin") {
        const r = ctx.setPlugin(String(body.id || ""), body.enabled === true);
        json(res, r.ok ? 200 : 400, r);
      } else if (url.pathname === "/admin/api/translate") {
        json(res, 200, await ctx.setTranslate(body && typeof body === "object" ? body : {}));
      } else if (url.pathname === "/admin/api/key") {
        json(res, 200, await ctx.setKey(String(body.provider || ""), typeof body.key === "string" ? body.key : null));
      } else if (url.pathname === "/admin/api/config") {
        const r = ctx.setGeneral(body && typeof body === "object" ? body : {});
        json(res, r.ok ? 200 : 400, r);
      } else if (url.pathname === "/admin/api/notes") {
        const N = ctx.notes;
        const op = String(body.op || "save");
        const r =
          op === "save" || op === "update"
            ? N.saveNote(body)
            : op === "delete"
              ? N.deleteNote(body.id)
              : op === "append"
                ? N.appendContent(body.id, body.text)
                : op === "quote"
                  ? N.appendQuote(body.id, body)
                  : op === "asset"
                    ? N.addAsset(body.name, body.data)
                    : { error: "unknown notes op: " + op };
        json(res, r && r.error ? 400 : 200, r || { error: "empty result" });
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      json(res, 500, { error: String((err && err.message) || err) });
    }
  };
}
