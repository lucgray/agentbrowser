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
export function createAdminHandler(ctx) {
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
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
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      json(res, 500, { error: String((err && err.message) || err) });
    }
  };
}
