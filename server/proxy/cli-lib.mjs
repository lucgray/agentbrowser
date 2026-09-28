// cli-lib.mjs — shared plumbing for the agentbrowser CLI and its session
// mode: a lazy hub WebSocket client (role harness) that keeps one connection
// open across many tool calls, plus the --output helper. Nothing else is
// stateful here — buffers and debugger attachments live in the extension.
// One-shot invocations simply use one call on the client and close it.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';

const CONNECT_TIMEOUT_MS = 5000;

export function createHubClient(hubUrl, name = 'agentbrowser-cli') {
  let ws = null;
  let connecting = null;
  const pending = new Map(); // tool_call id -> { resolve, reject, timer }
  let capWaiter = null; // { resolve, reject, timer } while awaiting capabilities

  function failAllPending(message) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
    if (capWaiter) {
      clearTimeout(capWaiter.timer);
      capWaiter.reject(new Error(message));
      capWaiter = null;
    }
  }

  function onFrame(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.warn(`[agentbrowser-cli] non-JSON frame ignored: ${String(err && err.message)}`);
      return;
    }
    if (msg.type === 'tool_result' && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'tool failed'));
    } else if (msg.type === 'capabilities' && capWaiter) {
      const entry = capWaiter;
      capWaiter = null;
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  function ensureConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(hubUrl);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          connecting = null;
          reject(new Error(`cannot reach hub at ${hubUrl}`));
        }
        try { socket.terminate(); } catch { /* already gone */ }
      }, CONNECT_TIMEOUT_MS);
      socket.once('open', () => {
        clearTimeout(timer);
        socket.on('message', onFrame);
        socket.send(JSON.stringify({ type: 'hello', role: 'harness', name }));
        ws = socket;
        connecting = null;
        settled = true;
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          // Connect-phase failure: same surface the one-shot CLI always had.
          settled = true;
          connecting = null;
          reject(err);
          return;
        }
        if (ws === socket) {
          ws = null;
          failAllPending(`hub socket error: ${String((err && err.message) || err)}`);
        }
      });
      socket.once('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          connecting = null;
          reject(new Error(`cannot reach hub at ${hubUrl}`));
          return;
        }
        // Only fail calls on the current socket; a late close from a replaced
        // socket must not kill calls in flight on its successor.
        if (ws === socket) {
          ws = null;
          failAllPending('hub connection lost');
        }
      });
    });
    return connecting;
  }

  async function call(tool, args, timeoutMs) {
    await ensureConnected();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: 'tool_call', id, tool, args }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function capabilities(timeoutMs) {
    await ensureConnected();
    return new Promise((resolve, reject) => {
      capWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          capWaiter = null;
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs)
      };
      try {
        ws.send(JSON.stringify({ type: 'get_capabilities' }));
      } catch (err) {
        clearTimeout(capWaiter.timer);
        capWaiter = null;
        reject(err);
      }
    });
  }

  function close() {
    if (ws) {
      const socket = ws;
      ws = null;
      try { socket.close(); } catch { /* already gone */ }
    }
    failAllPending('closed');
  }

  return { call, capabilities, close };
}

// Result helpers for --output: results that carry a binary payload
// (screenshot -> image/png, print_pdf -> application/pdf) get decoded to a
// file while stdout keeps only compact metadata.

export function pickBase64(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.base64 !== 'string' || !result.base64) return null;
  return {
    base64: result.base64,
    mimeType: typeof result.mimeType === 'string' ? result.mimeType : 'application/octet-stream'
  };
}

export function saveBase64(result, outPath) {
  const payload = pickBase64(result);
  if (!payload) return null;
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  const buf = Buffer.from(payload.base64, 'base64');
  writeFileSync(abs, buf);
  return { saved: abs, mimeType: payload.mimeType, bytes: buf.length };
}
