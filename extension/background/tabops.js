// Per-tab in-flight operation ledger (v2.31). Records which agent is running
// which tool on which tab so concurrent agents can see each other and decide
// for themselves — this is advisory marking, never a lock. Pure state; sw.js
// owns the chrome.* side effects (action badge, tabs_list exposure).
const ops = new Map(); // tabId -> Map<callId, {agent, tool, since}>

export function opsFor(tabId) {
  const m = ops.get(tabId);
  return m ? [...m.values()] : [];
}

export function agentsOn(tabId) {
  return [...new Set(opsFor(tabId).map((o) => o.agent))];
}

// Register one call. Returns an advisory note when *another* agent already
// has work in flight on this tab — the caller still proceeds, the note just
// surfaces the overlap in its tool result.
export function begin(tabId, callId, agent, tool) {
  let m = ops.get(tabId);
  if (!m) ops.set(tabId, (m = new Map()));
  const foreign = [...m.values()].filter((o) => o.agent !== agent);
  m.set(callId, { agent: agent || 'agent', tool, since: Date.now() });
  if (!foreign.length) return null;
  const o = foreign[0];
  const ago = Math.max(0, Math.round((Date.now() - o.since) / 1000));
  return (
    `tab ${tabId} is also being operated by ${o.agent} ` +
    `(${o.tool}, ${ago}s ago) — concurrent agents on one tab interleave ` +
    `input and page state; coordinate or pick another tab`
  );
}

export function end(tabId, callId) {
  const m = ops.get(tabId);
  if (!m) return;
  m.delete(callId);
  if (!m.size) ops.delete(tabId);
}

export function dropTab(tabId) {
  ops.delete(tabId);
}

// tabId -> [{agent, tool, since}] for tabs_list.
export function snapshot() {
  const out = {};
  for (const [tabId, m] of ops) out[tabId] = [...m.values()];
  return out;
}

// Test hook.
export function _reset() {
  ops.clear();
}
