// Owns the WebSocket to the hub. Lives in the offscreen document so the
// connection survives service worker shutdowns. Reconnects with a 3s backoff
// forever and reports every status change to the service worker.

const RECONNECT_MS = 3000;
// Chrome suspends the service worker after ~30s without events. While a chat
// turn is in flight the hub may stay silent for minutes (a long "thinking"
// stretch), and the suspended worker kills the panel port mid-stream — the
// "connection to background restarted; chat stream lost" failure. The
// offscreen document never sleeps, so it pings the worker while a turn is
// open to hold it alive until the turn's events resume.
const HEARTBEAT_MS = 20000;
const HEARTBEAT_MAX_IDLE_MS = 30 * 60 * 1000;

let hubUrl = null;
let ws = null;
let reconnectTimer = null;
let helloSent = false;
// chatIds with a turn in flight (seen a `chat` send, cleared on done/error).
const openTurns = new Set();
let lastHubTraffic = 0;

setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (openTurns.size === 0) return;
  if (Date.now() - lastHubTraffic > HEARTBEAT_MAX_IDLE_MS) return;
  post({ target: 'sw', cmd: 'ws_heartbeat' });
}, HEARTBEAT_MS);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'offscreen') return;
  if (message.cmd === 'connect') {
    if (message.url !== hubUrl || !ws || ws.readyState > WebSocket.OPEN) {
      hubUrl = message.url;
      reconnect();
    } else if (ws.readyState === WebSocket.OPEN) {
      // Same URL, already connected: the service worker probably restarted
      // and lost its status; re-report so it catches up.
      report(true);
    }
  } else if (message.cmd === 'send') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const p = message.payload;
      // A dropped chat has no timeout covering it (unlike tool_results);
      // surface the failure to the panel instead of losing the message.
      if (p && p.type === 'chat' && p.chatId) {
        openTurns.delete(p.chatId);
        post({ target: 'sw', cmd: 'ws_message', payload: { type: 'chat_event', chatId: p.chatId, event: { kind: 'error', message: 'hub not connected' } } });
        post({ target: 'sw', cmd: 'ws_message', payload: { type: 'chat_event', chatId: p.chatId, event: { kind: 'done' } } });
      }
      report(false);
      return;
    }
    if (message.payload && message.payload.type === 'hello') {
      // A restarted service worker re-sends hello on every ws_status
      // connected report; one hello per socket is enough.
      if (helloSent) return;
      helloSent = true;
    }
    if (message.payload && message.payload.type === 'chat' && message.payload.chatId) {
      // A turn starts here; the heartbeat holds the worker until it ends.
      openTurns.add(message.payload.chatId);
      lastHubTraffic = Date.now();
    }
    ws.send(JSON.stringify(message.payload));
  }
});

function reconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close();
    } catch (err) {
      console.warn('[agentbrowser] closing old hub socket failed', err);
    }
  }
  if (hubUrl) open();
}

function open() {
  let socket;
  try {
    socket = new WebSocket(hubUrl);
  } catch (err) {
    console.warn('[agentbrowser] hub socket creation failed', err);
    report(false);
    scheduleReconnect();
    return;
  }
  ws = socket;
  helloSent = false;
  socket.onopen = () => {
    if (ws !== socket) return;
    report(true);
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      console.warn('[agentbrowser] dropping malformed hub message', err);
      return;
    }
    if (payload && payload.type === 'chat_event') {
      lastHubTraffic = Date.now();
      const kind = payload.event && payload.event.kind;
      if ((kind === 'done' || kind === 'error') && payload.chatId) {
        openTurns.delete(payload.chatId);
      }
    }
    post({ target: 'sw', cmd: 'ws_message', payload });
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    report(false);
    scheduleReconnect();
  };
  socket.onerror = () => {
    // onclose follows and handles the reconnect.
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!ws && hubUrl) open();
  }, RECONNECT_MS);
}

function report(connected) {
  post({ target: 'sw', cmd: 'ws_status', connected });
}

function post(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[agentbrowser] offscreen -> sw message failed', err);
  });
}
