// Native-messaging host for com.agentbrowser.hub. The browser spawns this
// when the extension sends a native message; it makes sure the hub is
// listening on 127.0.0.1:PORT, spawning it detached when it isn't, then
// answers with one framed reply and exits. One hub serves every browser on
// the machine — the TCP probe is the dedupe, and hub.mjs itself exits on
// EADDRINUSE, so a spawn race can only produce a harmless extra attempt.
//
// Wire format (Chrome native messaging): 4-byte little-endian length +
// UTF-8 JSON, in both directions. NOTHING but frames goes to stdout.

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.join(HERE, "..", "hub", "hub.mjs");
const PORT = Number(process.env.AGENTCHAT_PORT) || 9010;
const BASE = path.join(os.homedir(), ".agentchat");
const LOG = path.join(BASE, "hub-autostart.log");
const LOCK = path.join(BASE, "hub-spawn.lock");
const LOCK_STALE_MS = 60_000;

function logErr(...args) {
  console.error("[hub-keeper]", ...args);
}

function probe(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (up) => {
      s.destroy();
      resolve(up);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function waitUp(probeFn, ms) {
  return new Promise(async (resolve) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await probeFn()) return resolve(true);
      await new Promise((r) => setTimeout(r, 250));
    }
    resolve(false);
  });
}

// mkdir is atomic across processes — one keeper spawns, the rest wait.
// A lock older than LOCK_STALE_MS is treated as abandoned (holder crashed).
function tryLock(lock) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true, recursive: true });
          continue;
        }
      } catch (err) {
        logErr("stale lock check failed", err);
      }
      return false;
    }
  }
  return false;
}

function spawnHub(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [HUB], {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
}

export async function ensureHub({
  port = PORT,
  logPath = LOG,
  lock = LOCK,
  waitMs = 12_000,
  probeFn = null,
  spawnFn = null,
} = {}) {
  const isUp = probeFn || (() => probe(port));
  const doSpawn = spawnFn || (() => spawnHub(logPath));
  if (await isUp()) return { ok: true, already: true, port };
  const spawned = tryLock(lock);
  if (spawned) {
    try {
      doSpawn();
    } catch (err) {
      logErr("hub spawn failed", err);
      try {
        fs.rmSync(lock, { force: true, recursive: true });
      } catch (rmErr) {
        logErr("lock cleanup failed", rmErr);
      }
      return { ok: false, error: String(err && err.message ? err.message : err), port };
    }
  }
  const up = await waitUp(isUp, waitMs);
  if (spawned) {
    try {
      fs.rmSync(lock, { force: true, recursive: true });
    } catch (err) {
      logErr("lock cleanup failed", err);
    }
  }
  return up
    ? { ok: true, started: spawned, port }
    : { ok: false, error: `hub not listening on ${port} after ${waitMs}ms`, port };
}

function sendFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function readFrames(onMessage) {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      let msg = null;
      try {
        msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      } catch (err) {
        logErr("bad frame dropped", err);
      }
      buf = buf.subarray(4 + len);
      if (msg) onMessage(msg);
    }
  });
}

async function main() {
  let seen = 0;
  readFrames(async (msg) => {
    seen++;
    if (!msg || msg.type !== "ensure") {
      sendFrame({ ok: false, error: "unknown request" });
      process.exit(0);
    }
    sendFrame(await ensureHub());
    process.exit(0);
  });
  // Chrome holds stdin open while it waits for the reply — exiting on 'end'
  // is only for "port closed without ever asking", not mid-request.
  process.stdin.on("end", () => {
    if (!seen) process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logErr("fatal", err);
    sendFrame({ ok: false, error: String(err && err.message ? err.message : err) });
    process.exit(1);
  });
}
