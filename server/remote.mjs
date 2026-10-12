// Remote relay (v2.26): exposes the hub's harness surface over tailscale so
// an AI on another machine (a grok bot, another agent) can drive THIS browser
// with the local tool set — nothing on the hub itself changes.
//
//   remote AI --ws-->  relay (tailscale IP :9011, ?token=...) --ws--> hub :9010
//
// The relay is a frame-level pipe with three duties beyond transport:
//   1. auth — the ?token query must match config.remote.token
//   2. role lock — remote clients can only be 'harness' (tool calls +
//      capabilities); anything else is refused
//   3. sharing allowlist — config.remote.allowTools (core tool names) +
//      allowPlugins (plugin ids, sharing their extraTools). tool_calls for
//      unshared tools are rejected relay-side; the capabilities broadcast is
//      rewritten so the remote only ever sees what it may call.
//
// admin stays on 127.0.0.1:9010 — the relay never serves it.

import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { listPlugins } from "./hub/plugins.mjs";
import { TOOLS } from "./hub/tools.mjs";

const DEFAULT_REMOTE_PORT = 9011;
const HELLO_TIMEOUT_MS = 10000;

// First tailscale IPv4 — the relay binds to it so it is reachable only over
// the tailnet, never the LAN. null when tailscale isn't up.
export function tailscaleIPv4() {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ip = out.trim().split(/\s+/)[0];
    return /^100\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null; // tailscale missing or down — caller decides the fallback
  }
}

export function ensureRemoteToken(config) {
  if (!config.remote || typeof config.remote !== "object") config.remote = {};
  if (typeof config.remote.token !== "string" || config.remote.token.length < 16) {
    config.remote.token = randomBytes(24).toString("base64url");
    return { token: config.remote.token, generated: true };
  }
  return { token: config.remote.token, generated: false };
}

// Tool names a remote client may call: allowTools plus every extraTool
// declared by a plugin listed in allowPlugins.
export function remoteAllowedTools(config) {
  const r = (config && config.remote) || {};
  const allow = new Set(
    Array.isArray(r.allowTools) ? r.allowTools.map(String) : []
  );
  const plugins = new Set(
    Array.isArray(r.allowPlugins) ? r.allowPlugins.map(String) : []
  );
  for (const p of listPlugins()) {
    if (!plugins.has(p.id)) continue;
    for (const t of p.extraTools) {
      if (t && typeof t === "object" && t.name) allow.add(String(t.name));
    }
  }
  return allow;
}

// Plugin ids a remote client may use — each contributes its extraTools.
export function remoteAllowedPlugins(config) {
  const r = (config && config.remote) || {};
  return new Set(Array.isArray(r.allowPlugins) ? r.allowPlugins.map(String) : []);
}

// Schemas of everything the remote may call: allowed core tools plus the
// extraTools of allowed plugins. Injected into capabilities as `tools` — the
// frame never carries tool schemas, so this also gives remotes real
// discovery instead of out-of-band name knowledge.
export function remoteToolSchemas(config) {
  const names = remoteAllowedTools(config);
  const schemas = TOOLS.filter((t) => names.has(t.name));
  const plugins = remoteAllowedPlugins(config);
  for (const p of listPlugins()) {
    if (!plugins.has(p.id)) continue;
    for (const t of p.extraTools) {
      if (t && typeof t === "object" && t.name) schemas.push(t);
    }
  }
  return schemas;
}

// Plugin descriptors filtered for a remote: only shared plugins are listed,
// and their `tools` is clipped to names the remote may actually call.
function filterPluginList(list, allow) {
  if (!Array.isArray(list)) return list;
  return list
    .filter((p) => p && allow.plugins.has(String(p.id)))
    .map((p) => ({
      ...p,
      tools: (Array.isArray(p.tools) ? p.tools : []).filter((t) =>
        allow.tools.has(String(t))
      ),
    }));
}

// Rewrite an upstream frame for the remote: unshared tools and plugins are
// invisible, not just blocked. Handles `capabilities` (plugins list +
// injected tools schemas) and `plugins` (plugins_list/plugin_set replies).
export function filterCapabilities(msg, allow) {
  if (!msg || typeof msg !== "object") return msg;
  if (msg.type === "plugins") {
    return { ...msg, plugins: filterPluginList(msg.plugins, allow) };
  }
  if (msg.type !== "capabilities") return msg;
  return {
    ...msg,
    tools: allow.schemas,
    plugins: filterPluginList(msg.plugins, allow),
  };
}

// The full allow spec for one remote connection (rebuilt per frame so admin
// edits to config.remote apply live).
function remoteAllow(config) {
  return {
    tools: remoteAllowedTools(config),
    plugins: remoteAllowedPlugins(config),
    schemas: remoteToolSchemas(config),
  };
}

export function startRemote(config, { hubUrl, log = () => {} } = {}) {
  const r = config.remote || {};
  // 0 stays 0 — OS-assigned port, used by tests.
  const port = r.port !== undefined && r.port !== null ? Number(r.port) : DEFAULT_REMOTE_PORT;
  const host =
    r.host === "auto" || !r.host ? tailscaleIPv4() : String(r.host);
  if (!host) {
    return {
      ok: false,
      error: "remote.host=auto but no tailscale IPv4 — set host explicitly",
    };
  }
  const token = ensureRemoteToken(config).token;
  const upstream = hubUrl || `ws://127.0.0.1:${process.env.AGENTCHAT_PORT || 9010}`;

  const server = http.createServer((req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("agentbrowser remote relay — websocket endpoint");
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://remote");
    } catch {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("token") !== token) {
      log("remote: rejected connection (bad token) from", req.socket.remoteAddress);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.on("error", (err) => {
    log("remote server error:", err.message);
  });

  wss.on("connection", (ws, req) => {
    const remoteName = req.socket.remoteAddress || "remote";
    log("remote client connected:", remoteName);
    let named = remoteName;
    const up = new WebSocket(upstream);
    let open = false;
    const helloTimer = setTimeout(() => {
      log("remote client sent no hello, closing:", named);
      ws.close();
    }, HELLO_TIMEOUT_MS);

    const closeAll = (why) => {
      clearTimeout(helloTimer);
      for (const s of [ws, up]) {
        try {
          s.terminate();
        } catch (err) {
          log("remote close failed (" + why + "):", err && err.message);
        }
      }
    };

    // upstream -> remote: forward everything, but rewrite capabilities so
    // unshared tools are invisible to the remote side.
    up.on("message", (data) => {
      let msg = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        msg = null; // non-JSON upstream frame — pass through untouched
      }
      if (msg && (msg.type === "capabilities" || msg.type === "plugins")) {
        const filtered = filterCapabilities(msg, remoteAllow(config));
        ws.send(JSON.stringify(filtered));
        return;
      }
      ws.send(data.toString());
    });
    up.on("open", () => {
      open = true;
    });
    up.on("close", () => closeAll("upstream closed"));
    up.on("error", (err) => {
      log("remote upstream error:", err.message);
      closeAll("upstream error");
    });
    // Queue until upstream is open — tool_calls racing a reconnect must not
    // throw on readyState CONNECTING.
    const sendUp = (payload) => {
      if (open) up.send(payload);
      else up.once("open", () => up.send(payload));
    };

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        log("remote: dropping non-JSON frame:", err && err.message);
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        if (msg.role !== "harness") {
          // Remote clients are harnesses, period — an extension-role hello
          // would let a remote pose as a browser.
          log("remote: rejected hello role", msg.role, "from", named);
          ws.send(JSON.stringify({
            type: "error",
            error: "remote relay accepts harness clients only",
          }));
          ws.close();
          return;
        }
        named = "remote:" + String(msg.name || "agent");
        msg.name = named;
        log("remote harness hello:", named);
        sendUp(JSON.stringify(msg));
        return;
      }
      if (msg.type === "tool_call") {
        const tool = String(msg.tool || "");
        if (!remoteAllowedTools(config).has(tool)) {
          log("remote: denied unshared tool", tool, "from", named);
          ws.send(JSON.stringify({
            type: "tool_result",
            id: msg.id,
            ok: false,
            error: `tool not shared remotely: ${tool}`,
          }));
          return;
        }
        log("remote tool_call", tool, "from", named);
        sendUp(data.toString());
        return;
      }
      // Any other harness-frame type (get_capabilities, ...) passes through.
      sendUp(data.toString());
    });
    ws.on("close", () => {
      log("remote client disconnected:", named);
      closeAll("remote closed");
    });
    ws.on("error", (err) => {
      log("remote client error:", err.message);
      closeAll("remote error");
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const bound = server.address();
      log(`remote relay listening on ws://${host}:${bound.port} (tailnet only)`);
      resolve({
        ok: true,
        host,
        port: bound.port,
        token,
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
    server.once("error", (err) => {
      resolve({ ok: false, error: String(err && err.message), host, port });
    });
  });
}
