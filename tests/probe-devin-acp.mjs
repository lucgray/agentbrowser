// Probe: does Devin's ACP server emit tool_call session updates?
import { spawn } from "node:child_process";

const proc = spawn("devin", ["acp"], { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const events = [];
let done = false;

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
proc.stderr.on("data", () => {});
proc.on("exit", () => { if (!done) finish("process exited"); });

const pending = new Map();
let nextId = 0;
function send(payload) {
  try { proc.stdin.write(JSON.stringify(payload) + "\n"); } catch {}
}
function req(method, params, timeoutMs = 30000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + " timeout")); } }, timeoutMs);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function handle(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message || "acp error")) : p.resolve(m.result);
    return;
  }
  if (m.method === "session/request_permission") {
    const opts = (m.params && m.params.options) || [];
    const allow = opts.find((o) => o && String(o.kind || "").startsWith("allow")) || opts[0];
    if (allow) send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    else send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } });
    return;
  }
  if (m.method === "session/update") {
    const u = m.params && m.params.update;
    if (!u) return;
    events.push({ kind: u.sessionUpdate, title: u.title, tool: u.kind });
    if (u.sessionUpdate === "agent_message_chunk") events.push({ kind: "TEXT", text: String(u.content && u.content.text || "").slice(0, 80) });
  }
}

function finish(reason) {
  done = true;
  console.log("reason:", reason);
  console.log("updates:", events.length);
  for (const e of events.slice(0, 30)) console.log(" ", e.kind, e.title || e.text || "");
  const tools = events.filter((e) => e.kind === "tool_call").length;
  console.log("tool_call updates:", tools, tools > 0 ? "-> PANEL WILL SHOW CHIPS" : "-> NO CHIPS (agent does not emit tool_call)");
  try { proc.kill(); } catch {}
  process.exit(0);
}

const init = await req("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "probe", version: "0.0.1" }
}).catch((e) => { console.log("init failed:", e.message); return null; });
if (!init) finish("init failed");
console.log("agentCapabilities:", JSON.stringify(init.agentCapabilities || {}).slice(0, 200));
const s = await req("session/new", { cwd: "D:\\CodeProject\\agentbrowser", mcpServers: [] }).catch((e) => { console.log("session/new failed:", e.message); return null; });
if (!s || !s.sessionId) finish("no session");
console.log("session ok:", s.sessionId);
setTimeout(() => finish("turn finished or timeout"), 90000);
await req("session/prompt", {
  sessionId: s.sessionId,
  prompt: [{ type: "text", text: "Use your shell tool to run exactly this command and reply with its output: echo devin-acp-probe-ok. Do nothing else." }]
}).then(() => finish("prompt resolved"), (e) => finish("prompt error: " + e.message));
