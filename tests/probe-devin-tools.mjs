// Probe: does Devin's ACP server emit tool_call session updates?
import { spawn } from "node:child_process";

const proc = spawn("devin", ["acp"], { shell: process.platform === "win32" });
let buf = "";
const updates = [];
const thoughtSamples = [];
const pending = new Map();
let nextId = 0;
let finished = false;

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    handleLine(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
proc.stderr.on("data", () => {});
proc.on("exit", (code) => finish("devin exited code " + code));

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(method + " timeout"));
      }
    }, 60000);
  });
}
function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message || "acp error")) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params && msg.params.update;
    if (!u) return;
    const kind = u.sessionUpdate || "unknown";
    const extra = u.title ? " :: " + u.title : u.content && u.content.text ? " :: " + String(u.content.text).slice(0, 60) : "";
    updates.push(kind + extra);
    if (kind === "agent_thought_chunk") {
      const text = u.content && u.content.text ? String(u.content.text) : "";
      thoughtSamples.push(text);
    }
  }
}

function finish(reason) {
  if (finished) return;
  finished = true;
  console.log("=== " + reason + " ===");
  const counts = {};
  for (const u of updates) {
    const k = u.split(" ::")[0];
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log("update kinds:", JSON.stringify(counts));
  const toolCalls = updates.filter((u) => u.startsWith("tool_call"));
  console.log("tool_call updates:", toolCalls.length);
  for (const t of toolCalls.slice(0, 10)) console.log("  ", t);
  console.log("thought chunks:", thoughtSamples.length);
  for (const t of thoughtSamples) {
    console.log("  THOUGHT len=" + t.length + ":", JSON.stringify(t.slice(0, 100)));
  }
  try {
    proc.kill();
  } catch {}
  process.exit(0);
}

setTimeout(() => finish("probe timeout"), 90000);

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "acp-probe", version: "0.0.1" }
  });
  console.log("init ok; agentCapabilities:", JSON.stringify(init && init.agentCapabilities ? init.agentCapabilities : {}).slice(0, 200));
  const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
  console.log("session:", session && session.sessionId);
  await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Use your shell/terminal tool to run exactly this command: echo devin-acp-toolprobe-ok. Then reply with its output. Nothing else." }]
  });
  finish("turn completed");
} catch (err) {
  finish("error: " + err.message);
}
