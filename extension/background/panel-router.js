// Pure routing table for side-panel ports — one per browser window (v2.1).
// Before this, a single global port meant the last-opened window's panel
// silently stole every chat event. Keeps no chrome.* state so tests can
// exercise the routing rules directly.

export const DEFAULT_WINDOW = 'default'; // panels that cannot name their window

// Panels connect as `sidepanel:<windowId>`; a bare `sidepanel` (older panel)
// collapses to the shared DEFAULT_WINDOW slot, preserving single-port behavior.
export function windowIdFromPortName(name) {
  if (name === 'sidepanel') return DEFAULT_WINDOW;
  const m = /^sidepanel:(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

// Types every open panel needs regardless of which window asked: hub status,
// adapter capabilities, the shared chat history.
const BROADCAST_TYPES = new Set(['status', 'capabilities', 'chat_list']);

export function createPanelRouter() {
  const ports = new Map(); // windowId -> Port
  const chatWindows = new Map(); // chatId -> owning windowId
  let lastWindowId = DEFAULT_WINDOW;

  function connect(windowId, port) {
    ports.set(windowId, port);
    lastWindowId = windowId;
  }

  function disconnect(windowId, port) {
    if (ports.get(windowId) === port) ports.delete(windowId);
  }

  // Called for each inbound panel message: binds chatIds to the window that
  // started (or resumed) them so replies stream back there only.
  function noteInbound(windowId, msg) {
    lastWindowId = windowId;
    if (
      msg &&
      msg.chatId &&
      (msg.type === 'chat' || msg.type === 'command' || msg.type === 'chat_resume')
    ) {
      chatWindows.set(msg.chatId, windowId);
    }
  }

  // WindowIds that should receive an outbound message. Events for a chatId no
  // panel here owns are dropped — same rule the old single panelChatIds set
  // enforced, now per window.
  function route(message) {
    if (!message || typeof message !== 'object' || ports.size === 0) return [];
    if (BROADCAST_TYPES.has(message.type)) return [...ports.keys()];
    if (message.chatId != null) {
      const owner = chatWindows.get(message.chatId);
      return owner !== undefined && ports.has(owner) ? [owner] : [];
    }
    if (ports.has(lastWindowId)) return [lastWindowId];
    return [ports.keys().next().value];
  }

  return { connect, disconnect, noteInbound, route, ports, lastWindow: () => lastWindowId };
}
