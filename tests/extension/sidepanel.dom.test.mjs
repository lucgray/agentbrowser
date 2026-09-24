// Behaviour tests for the side panel: init() driven against a stub DOM and a
// stub chrome Port, so what is asserted here is what the panel actually does
// with a message, not what its helpers would return.
//
// Separate process from sidepanel.test.mjs on purpose: that suite asserts the
// module can be imported with no document at all, and node's ESM cache would
// hand it this file's already-initialised copy.
import assert from "node:assert/strict";

const SIDEPANEL = new URL("../../extension/sidepanel.js", import.meta.url).href;

// --- the smallest DOM init() can run against ---------------------------------

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    style: {},
    listeners: {},
    _text: "",
    value: "",
    hidden: false,
    disabled: false,
    title: "",
    placeholder: "",
    selectionStart: 0,
    selectionEnd: 0,
    scrollHeight: 20,
    scrollTop: 0,
    parentNode: null,
    classList: {
      _s: new Set(),
      add(...c) { for (const x of c) this._s.add(x); },
      remove(...c) { for (const x of c) this._s.delete(x); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    append(...c) { for (const x of c) this.appendChild(x); },
    insertBefore(n) { this.children.unshift(n); return n; },
    replaceChildren(...c) { this.children = []; for (const x of c) this.appendChild(x); },
    remove() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
      this.parentNode = null;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); },
    querySelector() { return null; },
    focus() {},
    click() {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    scrollIntoView() {},
    get lastChild() { return this.children[this.children.length - 1]; },
  };
  // The panel sets classes both ways (el.className = "lane-block live" and
  // classList.add("failed")), so the two have to be the same storage.
  Object.defineProperty(el, "className", {
    get() { return [...this.classList._s].join(" "); },
    set(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    enumerable: true,
  });
  return el;
}

const byId = {};
globalThis.document = {
  activeElement: null,
  getElementById(id) { return (byId[id] ||= makeEl("div")); },
  createElement: makeEl,
  createElementNS: (ns, tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeText: String(t) }),
  addEventListener() {},
};

const portListeners = [];
const sent = [];
globalThis.chrome = {
  runtime: {
    connect: () => ({
      postMessage: (m) => sent.push(m),
      onMessage: { addListener: (fn) => portListeners.push(fn) },
      onDisconnect: { addListener: () => {} },
    }),
  },
  tabs: {
    query: async () => [{ id: 5, url: "https://example.com/", title: "Example", active: true }],
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
  },
  windows: { onFocusChanged: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};
// Node exposes these as getter-only globals.
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: () => "chat-1" },
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US" },
  configurable: true,
});
globalThis.window = {};

await import(SIDEPANEL); // init() runs on import

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(name + ": " + (e && e.message));
  }
}

const input = byId["input"];
const pop = byId["command-pop"];
const messages = byId["messages"];
const usage = byId["session-usage"];

const deliver = (msg) => { for (const fn of portListeners) fn(msg); };
const chatEvent = (event) => deliver({ type: "chat_event", chatId: "chat-1", event });
const type = (text, caret) => {
  input.value = text;
  input.selectionStart = caret == null ? text.length : caret;
  input.dispatch("input", {});
};
const enter = () => input.dispatch("keydown", { key: "Enter", shiftKey: false, preventDefault() {} });
const lastSent = () => sent[sent.length - 1];
const laneGroup = (turn) => turn.children.find((c) => c.className === "lane-group");
const turnMetaEl = (turn) => turn.children.find((c) => c.className === "turn-meta");
const lastTurn = () => {
  for (let i = messages.children.length - 1; i >= 0; i--) {
    if (messages.children[i].className === "turn") return messages.children[i];
  }
  return null;
};

deliver({ type: "status", connected: true });
deliver({
  type: "capabilities",
  adapters: [
    {
      name: "claude-agent-sdk",
      label: "Claude",
      provider: "anthropic",
      keyConfigured: true,
      models: [{ id: "claude-opus-5", label: "Opus 5" }],
      defaultModel: "claude-opus-5",
    },
  ],
  commands: [
    { name: "loop", args: "<n> <instruction>", summary: "run an instruction n times", scope: "server" },
    { name: "parallel", args: "<instruction>", summary: "one lane per tagged tab", scope: "server" },
    { name: "clear", args: "", summary: "start a new conversation", scope: "client" },
  ],
});

// --- palette -----------------------------------------------------------------

t('"/" in an empty composer opens the palette with the hub\'s commands', () => {
  type("/");
  assert.equal(pop.hidden, false);
  assert.equal(pop.children.length, 3);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  const [head] = pop.children[0].children;
  assert.equal(head.children[0].textContent, "/loop");
  assert.equal(head.children[1].textContent, "<n> <instruction>");
  assert.equal(pop.children[0].children[1].textContent, "run an instruction n times");
  assert.equal(pop.children[0].getAttribute("role"), "option");
  assert.equal(pop.children[0].getAttribute("aria-selected"), "true");
});

t('"/" anywhere but the start leaves the palette shut', () => {
  type("tell me about /loop");
  assert.equal(pop.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

t("typing filters the palette, Enter inserts the command", () => {
  const before = sent.length;
  type("/par");
  assert.equal(pop.children.length, 1);
  enter();
  assert.equal(input.value, "/parallel ");
  assert.equal(pop.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  // Picking a row types the command; it does not send anything.
  assert.equal(sent.length, before);
});

t("arrow keys move the selection without re-filtering", () => {
  type("/");
  input.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
  input.dispatch("keyup", { key: "ArrowDown" });
  assert.equal(pop.children[1].getAttribute("aria-selected"), "true");
  input.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(pop.hidden, true);
  type("");
});

// --- dispatch ----------------------------------------------------------------

t("a server command goes out as a command message", () => {
  const before = sent.length;
  input.value = "/parallel compare the pricing pages";
  enter();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(lastSent(), {
    type: "command",
    chatId: "chat-1",
    name: "parallel",
    args: "compare the pricing pages",
    adapter: "claude-agent-sdk",
    model: "claude-opus-5",
    context: {
      currentTab: { tabId: 5, url: "https://example.com/", title: "Example" },
      tabs: [],
    },
  });
  assert.equal(input.value, "");
});

// --- lanes -------------------------------------------------------------------

t("lane events group into lane blocks and non-lane events do not", () => {
  const lane0 = { index: 0, tabId: 5, title: "Docs" };
  const lane1 = { index: 1, tabId: 9, title: "Pricing page" };
  chatEvent({ kind: "info", message: "2 lanes" });
  chatEvent({ kind: "tool_use", tool: "navigate", args: { url: "https://a" }, lane: lane0 });
  chatEvent({ kind: "tool_use", tool: "navigate", args: { url: "https://b" }, lane: lane1 });
  chatEvent({ kind: "tool_result", tool: "navigate", ok: true, lane: lane1 });
  chatEvent({ kind: "token", text: "**cheaper** here", lane: lane1 });
  chatEvent({ kind: "error", message: "lane one blew up", lane: lane0 });
  chatEvent({ kind: "token", text: "main reply" });

  const turn = lastTurn();
  const group = laneGroup(turn);
  assert.ok(group, "the turn should hold a lane group");
  assert.equal(group.children.length, 2);

  const heads = group.children.map((b) => b.children[0]);
  assert.deepEqual(heads.map((h) => h.children[0].textContent), [
    "Lane 1 · Docs",
    "Lane 2 · Pricing page",
  ]);
  assert.deepEqual(heads.map((h) => h.children[1].textContent), [
    "failed · 1 step",
    "running · 1 step",
  ]);
  for (const head of heads) {
    assert.equal(head.getAttribute("aria-expanded"), "false");
    assert.ok(/^Show what Lane \d/.test(head.getAttribute("aria-label")));
  }
  // Lanes stay collapsed while the run is going.
  assert.deepEqual(group.children.map((b) => b.children[1].hidden), [true, true]);
  // A failing lane does not end the turn: lane 2 is still live.
  assert.equal(group.children[0].classList.contains("failed"), true);
  assert.equal(group.children[1].classList.contains("live"), true);
  // The untagged token went to the turn's own reply, not into a lane.
  const reply = turn.children.find((c) => c.className.startsWith("msg assistant"));
  assert.ok(reply, "the untagged token should render as the turn's reply");
  assert.equal(reply.mdSource, "main reply");
});

t("clicking a lane head expands it", () => {
  const group = laneGroup(lastTurn());
  const block = group.children[1];
  block.children[0].dispatch("click", {});
  assert.equal(block.children[1].hidden, false);
  assert.equal(block.children[0].getAttribute("aria-expanded"), "true");
  assert.ok(block.children[0].getAttribute("aria-label").startsWith("Hide what"));
});

// --- usage numbers -----------------------------------------------------------

t("the session readout appears with the first meta", () => {
  chatEvent({
    kind: "meta",
    model: "claude-opus-5",
    adapter: "anthropic-api",
    elapsedMs: 12432,
    inputTokens: 12000,
    outputTokens: 1800,
    sessionInputTokens: 12000,
    sessionOutputTokens: 1800,
    cacheReadTokens: 4096,
    cacheWriteTokens: 128,
    costUsd: 0.08,
  });
  assert.equal(usage.hidden, false);
  assert.equal(usage.textContent, "session: 12k in / 1.8k out · $0.08");
});

t("done renders the meta line and settles every lane", () => {
  const turn = lastTurn();
  chatEvent({ kind: "done" });
  assert.equal(
    turnMetaEl(turn).textContent,
    "claude-opus-5 via anthropic-api · 12.4s · 12k in / 1.8k out · $0.08"
  );
  const statuses = laneGroup(turn).children.map((b) => b.children[0].children[1].textContent);
  assert.deepEqual(statuses, ["failed · 1 step", "done · 1 step"]);
});

t("session totals accumulate across a second turn", () => {
  input.value = "and now the docs";
  enter();
  assert.equal(lastSent().type, "chat");
  chatEvent({ kind: "token", text: "docs answer" });
  chatEvent({
    kind: "meta",
    model: "claude-opus-5",
    adapter: "anthropic-api",
    elapsedMs: 4000,
    inputTokens: 12100,
    outputTokens: 1400,
    sessionInputTokens: 24100,
    sessionOutputTokens: 3200,
    costUsd: 0.06,
  });
  // The readout moves on meta, without waiting for the turn to end.
  assert.equal(usage.textContent, "session: 24.1k in / 3.2k out · $0.14");
  chatEvent({ kind: "done" });
});

t("a turn with no lanes and no cost renders neither", () => {
  chatEvent({ kind: "token", text: "plain answer" });
  const turn = lastTurn();
  chatEvent({ kind: "done" });
  assert.ok(!laneGroup(turn), "a lane-free turn must not build a lane group");

  input.value = "one more";
  enter();
  chatEvent({ kind: "token", text: "sure" });
  chatEvent({
    kind: "meta",
    model: "claude-opus-5",
    adapter: "claude-cli",
    elapsedMs: 2000,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: null,
  });
  const third = lastTurn();
  chatEvent({ kind: "done" });
  // No cost on this turn's line, and the session cost from the earlier turns
  // stands: the tokens moved, the money did not.
  assert.equal(turnMetaEl(third).textContent, "claude-opus-5 via claude-cli · 2s · 100 in / 50 out");
  assert.equal(usage.textContent, "session: 24.2k in / 3.3k out · $0.14");
});

// --- client commands ---------------------------------------------------------

t("a client command sends nothing and clears the conversation", () => {
  const before = sent.length;
  input.value = "/clear";
  enter();
  assert.equal(sent.length, before, "a client command must not reach the wire");
  assert.equal(input.value, "");
  assert.equal(messages.children.length, 0);
  assert.equal(usage.textContent, "");
  assert.equal(usage.hidden, true);
});

t("an unknown command is sent as ordinary chat text", () => {
  const before = sent.length;
  input.value = "/nope do a thing";
  enter();
  assert.equal(sent.length, before + 1);
  assert.equal(lastSent().type, "chat");
  assert.equal(lastSent().text, "/nope do a thing");
  chatEvent({ kind: "done" });
});

t("with no registry the palette stays shut and every slash line is chat", () => {
  deliver({ type: "capabilities", adapters: [], commands: [] });
  type("/");
  assert.equal(pop.hidden, true);
  const before = sent.length;
  input.value = "/clear";
  enter();
  assert.equal(sent.length, before + 1);
  assert.equal(lastSent().type, "chat");
  chatEvent({ kind: "done" });
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
