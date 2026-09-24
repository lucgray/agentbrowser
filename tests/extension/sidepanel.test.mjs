// Unit tests for the side panel's pure helpers: the slash command palette and
// its dispatch, the usage numbers on the meta line and the session readout, and
// lane grouping for /parallel. Everything under test is exported from the top
// of sidepanel.js, which has no DOM and no chrome API, so node can import it —
// init() is behind a `typeof document !== "undefined"` guard and never runs.
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const SIDEPANEL = new URL("../../extension/sidepanel.js", import.meta.url);
const SRC = await fs.readFile(SIDEPANEL, "utf8");

const mod = await import(SIDEPANEL.href);
const {
  findCommandToken,
  filterCommands,
  normalizeCommands,
  commandEntry,
  applyCommand,
  parseCommandLine,
  planSend,
  buildCommandMessage,
  formatCostUsd,
  formatMetaLine,
  emptySession,
  accumulateSession,
  formatSessionLine,
  laneOf,
  laneLabel,
  makeLaneGrouper,
  CLIENT_COMMANDS,
  buildContext,
  buildChatMessage,
  normalizeSelection,
  SELECTION_LIMITS,
} = mod;

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

// The registry the hub sends in the capabilities message. Nothing in the panel
// may hardcode this list; these tests always pass it in.
const COMMANDS = [
  { name: "loop", args: "<n> <instruction>", summary: "run an instruction n times", scope: "server" },
  { name: "goal", args: "<condition>", summary: "re-run until the condition is met", scope: "server" },
  { name: "parallel", args: "<instruction>", summary: "run against every tagged tab", scope: "server" },
  { name: "clear", args: "", summary: "start a new conversation", scope: "client" },
  { name: "model", args: "[id]", summary: "switch the model", scope: "client" },
  { name: "stop", args: "", summary: "abort the running turn", scope: "client" },
];

// --- source discipline -------------------------------------------------------

t("sidepanel.js builds DOM without HTML strings", () => {
  const code = SRC.replace(/^\s*\/\/.*$/gm, "");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/]) {
    assert.ok(!bad.test(code), "sidepanel.js must not use " + bad);
  }
});

t("importing the module does not touch the DOM", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof findCommandToken, "function");
});

t("the panel calls the tested helpers instead of repeating them", () => {
  // A helper that only the tests use is a second implementation waiting to
  // drift. These are the call sites inside init().
  for (const call of [
    "planSend(text, commands)",
    "buildCommandMessage({",
    "makeLaneGrouper()",
    "accumulateSession(session, turnMeta)",
    "formatSessionLine(session)",
    "findCommandToken(inputEl.value",
    "filterCommands(commands, token.query)",
    "applyCommand(inputEl.value, palette, cmd.name)",
    "normalizeCommands(commandList)",
    "laneLabel(entry)",
  ]) {
    assert.ok(SRC.includes(call), "init() should call " + call);
  }
});

// --- palette trigger ---------------------------------------------------------

t('"/" at the start of an empty input opens the palette', () => {
  const token = findCommandToken("/", 1);
  assert.deepEqual(token, { start: 0, end: 1, query: "" });
});

t('"/" anywhere but the start does not open the palette', () => {
  assert.equal(findCommandToken("hi /", 4), null);
  assert.equal(findCommandToken(" /loop", 6), null);
  assert.equal(findCommandToken("what/now", 8), null);
  assert.equal(findCommandToken("", 0), null);
  assert.equal(findCommandToken("loop", 4), null);
});

t("the palette follows the command token and closes once arguments start", () => {
  assert.deepEqual(findCommandToken("/lo", 3), { start: 0, end: 3, query: "lo" });
  // caret past the space: the user is typing arguments now
  assert.equal(findCommandToken("/loop 3", 7), null);
  assert.equal(findCommandToken("/loop 3 do it", 13), null);
  // caret still inside the name, with arguments already typed after it
  assert.deepEqual(findCommandToken("/loop 3", 5), { start: 0, end: 5, query: "loop" });
  // caret before the slash
  assert.equal(findCommandToken("/loop", 0), null);
  // absurdly long token: not a command
  assert.equal(findCommandToken("/" + "x".repeat(60), 61), null);
});

// --- filtering ---------------------------------------------------------------

t("an empty query lists the whole registry in order", () => {
  const rows = filterCommands(COMMANDS, "");
  assert.deepEqual(rows.map((r) => r.name), ["loop", "goal", "parallel", "clear", "model", "stop"]);
});

t("filtering matches the name first, then the summary", () => {
  assert.deepEqual(filterCommands(COMMANDS, "lo").map((r) => r.name), ["loop"]);
  // "parallel" matches by prefix and leads; "loop" and "stop" only contain a p.
  assert.deepEqual(filterCommands(COMMANDS, "p").map((r) => r.name), ["parallel", "loop", "stop"]);
  assert.deepEqual(filterCommands(COMMANDS, "tagged").map((r) => r.name), ["parallel"]);
  assert.deepEqual(filterCommands(COMMANDS, "LOOP").map((r) => r.name), ["loop"]);
  assert.deepEqual(filterCommands(COMMANDS, "zzz"), []);
});

t("a missing registry offers nothing at all", () => {
  assert.deepEqual(filterCommands(undefined, ""), []);
  assert.deepEqual(filterCommands([], "loop"), []);
  assert.deepEqual(normalizeCommands([{ name: "" }, null, { nope: 1 }]), []);
  assert.equal(commandEntry([], "loop"), null);
});

t("the registry is normalized: scope defaults to server, duplicates drop", () => {
  const rows = normalizeCommands([
    { name: "/slashy", summary: "leading slash is stripped" },
    { name: "slashy", summary: "duplicate" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "slashy");
  assert.equal(rows[0].scope, "server");
  assert.equal(rows[0].args, "");
});

// --- selection ---------------------------------------------------------------

t("selecting a row inserts the command and leaves the caret after it", () => {
  const token = findCommandToken("/lo", 3);
  const applied = applyCommand("/lo", token, "loop");
  assert.equal(applied.text, "/loop ");
  assert.equal(applied.caret, 6);
});

t("selecting a row keeps whatever followed the token", () => {
  const token = findCommandToken("/pa 3 times", 3);
  const applied = applyCommand("/pa 3 times", token, "parallel");
  assert.equal(applied.text, "/parallel  3 times");
  assert.equal(applied.caret, 10);
});

// --- dispatch ----------------------------------------------------------------

t("a server command is sent as a command message, not chat", () => {
  const plan = planSend("/loop 3 refresh the page", COMMANDS);
  assert.deepEqual(plan, { mode: "server", name: "loop", args: "3 refresh the page" });

  const msg = buildCommandMessage({
    chatId: "c-1",
    name: plan.name,
    args: plan.args,
    adapter: "claude-agent-sdk",
    model: "claude-opus-5",
    currentTab: { tabId: 7, url: "https://example.com/", title: "Example" },
    taggedTabs: [{ tabId: 9, url: "https://example.com/pricing", title: "Pricing page" }],
  });
  assert.deepEqual(msg, {
    type: "command",
    chatId: "c-1",
    name: "loop",
    args: "3 refresh the page",
    adapter: "claude-agent-sdk",
    model: "claude-opus-5",
    context: {
      currentTab: { tabId: 7, url: "https://example.com/", title: "Example" },
      tabs: [{ tabId: 9, url: "https://example.com/pricing", title: "Pricing page" }],
    },
  });
});

t("an argument-less command still carries args as a string", () => {
  const plan = planSend("/parallel", COMMANDS);
  assert.deepEqual(plan, { mode: "server", name: "parallel", args: "" });
  const msg = buildCommandMessage({ chatId: "c-2", name: plan.name, args: plan.args, adapter: "codex" });
  assert.equal(msg.args, "");
  // Absent, not undefined: the Port structure-clones this object.
  assert.ok(!("model" in msg));
  assert.ok(!("context" in msg));
});

t("a client command sends nothing", () => {
  assert.deepEqual(planSend("/clear", COMMANDS), { mode: "client", name: "clear", args: "" });
  assert.deepEqual(planSend("/model opus", COMMANDS), { mode: "client", name: "model", args: "opus" });
  assert.deepEqual(planSend("/stop", COMMANDS), { mode: "client", name: "stop", args: "" });
  for (const name of ["clear", "model", "stop"]) {
    assert.ok(CLIENT_COMMANDS.includes(name));
  }
});

t("a client-scope command the panel cannot run falls through to chat", () => {
  const registry = [{ name: "theme", summary: "switch theme", scope: "client" }];
  assert.deepEqual(planSend("/theme dark", registry), { mode: "chat" });
});

t("an unknown command falls through to chat and is not swallowed", () => {
  assert.deepEqual(planSend("/foo bar", COMMANDS), { mode: "chat" });
  assert.deepEqual(planSend("/", COMMANDS), { mode: "chat" });
  assert.deepEqual(planSend("what does /loop do?", COMMANDS), { mode: "chat" });
  assert.deepEqual(planSend("plain text", COMMANDS), { mode: "chat" });
  // No registry at all: everything is chat, including names the panel could run
  assert.deepEqual(planSend("/clear", []), { mode: "chat" });
});

t("parseCommandLine splits the name from the rest of the line", () => {
  assert.deepEqual(parseCommandLine("/goal   the cart is empty  "), {
    name: "goal",
    args: "the cart is empty",
  });
  assert.equal(parseCommandLine("no slash"), null);
  assert.equal(parseCommandLine("/9lives"), null);
});

// --- meta line and cost ------------------------------------------------------

t("the meta line renders with a cost", () => {
  assert.equal(
    formatMetaLine({
      model: "claude-opus-5",
      adapter: "anthropic-api",
      elapsedMs: 12432,
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.021,
    }),
    "claude-opus-5 via anthropic-api · 12.4s · 1.2k in / 340 out · $0.021"
  );
});

t("the meta line omits the cost when it is null, and omits null counts", () => {
  assert.equal(
    formatMetaLine({
      model: "claude-opus-5",
      adapter: "claude-cli",
      elapsedMs: 12432,
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: null,
    }),
    "claude-opus-5 via claude-cli · 12.4s · 1.2k in / 340 out"
  );
  assert.equal(
    formatMetaLine({
      model: "gpt-5",
      adapter: "openai-api",
      elapsedMs: 900,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 4096,
      cacheWriteTokens: 128,
      costUsd: null,
    }),
    "gpt-5 via openai-api · 0.9s"
  );
});

t("token counts keep a decimal up to 100k", () => {
  const { formatTokenCount } = mod;
  assert.equal(formatTokenCount(340), "340");
  assert.equal(formatTokenCount(1200), "1.2k");
  assert.equal(formatTokenCount(24100), "24.1k");
  assert.equal(formatTokenCount(240000), "240k");
  assert.equal(formatTokenCount(null), null);
  assert.equal(formatTokenCount(-3), null);
});

t("cost formatting keeps two decimals and adds a third when it matters", () => {
  assert.equal(formatCostUsd(0.021), "$0.021");
  assert.equal(formatCostUsd(0.14), "$0.14");
  assert.equal(formatCostUsd(1.5), "$1.50");
  assert.equal(formatCostUsd(0), "$0.00");
  assert.equal(formatCostUsd(0.0004), "<$0.001");
  assert.equal(formatCostUsd(null), null);
  assert.equal(formatCostUsd(undefined), null);
  assert.equal(formatCostUsd("nope"), null);
  assert.equal(formatCostUsd(-1), null);
});

// --- session totals ----------------------------------------------------------

t("session totals accumulate across two metas", () => {
  let s = emptySession();
  assert.equal(formatSessionLine(s), "");

  s = accumulateSession(s, {
    inputTokens: 12000,
    outputTokens: 1800,
    sessionInputTokens: 12000,
    sessionOutputTokens: 1800,
    costUsd: 0.08,
  });
  assert.equal(formatSessionLine(s), "session: 12k in / 1.8k out · $0.08");

  s = accumulateSession(s, {
    inputTokens: 12100,
    outputTokens: 1400,
    sessionInputTokens: 24100,
    sessionOutputTokens: 3200,
    costUsd: 0.06,
  });
  assert.equal(s.inputTokens, 24100);
  assert.equal(s.outputTokens, 3200);
  assert.equal(s.turns, 2);
  assert.equal(formatSessionLine(s), "session: 24.1k in / 3.2k out · $0.14");
});

t("without hub session totals the panel adds the per-turn numbers itself", () => {
  let s = accumulateSession(emptySession(), { inputTokens: 500, outputTokens: 100, costUsd: null });
  s = accumulateSession(s, { inputTokens: 700, outputTokens: 250, costUsd: null });
  assert.equal(s.inputTokens, 1200);
  assert.equal(s.outputTokens, 350);
  // No adapter reported a price, so no "$0.00" appears.
  assert.equal(s.hasCost, false);
  assert.equal(formatSessionLine(s), "session: 1.2k in / 350 out");
});

t("a meta with no usage at all leaves the readout empty", () => {
  const s = accumulateSession(emptySession(), {
    model: "claude-opus-5",
    adapter: "claude-cli",
    elapsedMs: 1200,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  assert.equal(s.turns, 1);
  assert.equal(formatSessionLine(s), "");
});

// --- lanes -------------------------------------------------------------------

t("laneOf reads a lane tag and rejects anything else", () => {
  assert.deepEqual(laneOf({ kind: "token", lane: { index: 0, tabId: 5, title: "Docs" } }), {
    index: 0,
    tabId: 5,
    title: "Docs",
  });
  assert.equal(laneOf({ kind: "token" }), null);
  assert.equal(laneOf({ kind: "token", lane: null }), null);
  assert.equal(laneOf({ kind: "token", lane: { index: -1 } }), null);
  assert.equal(laneOf({ kind: "token", lane: { index: "x" } }), null);
  assert.equal(laneOf(null), null);
});

t("lane labels are 1-based on screen and survive a missing title", () => {
  assert.equal(laneLabel({ index: 1, title: "Pricing page" }), "Lane 2 · Pricing page");
  assert.equal(laneLabel({ index: 0, title: "" }), "Lane 1");
  assert.equal(laneLabel({ index: 2, title: "  wrapped\n title " }), "Lane 3 · wrapped title");
  assert.equal(laneLabel(null), "");
});

t("lane events group by lane and non-lane events do not", () => {
  const g = makeLaneGrouper();
  const events = [
    { kind: "info", message: "starting 2 lanes" },
    { kind: "tool_use", tool: "navigate", lane: { index: 0, tabId: 5, title: "Docs" } },
    { kind: "tool_use", tool: "navigate", lane: { index: 1, tabId: 9, title: "Pricing page" } },
    { kind: "token", text: "hi", lane: { index: 1 } },
    { kind: "tool_result", tool: "navigate", ok: true, lane: { index: 0 } },
    { kind: "meta", model: "claude-opus-5" },
    { kind: "done" },
  ];
  const main = [];
  const perLane = new Map();
  for (const ev of events) {
    const routed = g.route(ev);
    if (routed.target === "main") {
      main.push(ev);
      assert.equal(routed.lane, null);
      continue;
    }
    const list = perLane.get(routed.lane.index) || [];
    list.push(ev);
    perLane.set(routed.lane.index, list);
  }

  // Untagged events never create a lane.
  assert.deepEqual(main.map((e) => e.kind), ["info", "meta", "done"]);
  assert.equal(g.lanes.size, 2);

  const lanes = g.list();
  assert.deepEqual(lanes.map((l) => l.index), [0, 1]);
  assert.deepEqual(lanes.map((l) => l.title), ["Docs", "Pricing page"]);
  assert.deepEqual(lanes.map((l) => l.tabId), [5, 9]);
  assert.deepEqual(lanes.map((l) => l.count), [2, 2]);
  assert.deepEqual(perLane.get(0).map((e) => e.kind), ["tool_use", "tool_result"]);
  assert.deepEqual(perLane.get(1).map((e) => e.kind), ["tool_use", "token"]);
  // Labels come from the accumulated entry, not from whichever event was last.
  assert.deepEqual(lanes.map(laneLabel), ["Lane 1 · Docs", "Lane 2 · Pricing page"]);
});

t("a lane whose first event carries no title takes one from a later event", () => {
  const g = makeLaneGrouper();
  g.route({ kind: "status", state: "working", lane: { index: 0 } });
  g.route({ kind: "token", text: "x", lane: { index: 0, tabId: 3, title: "Late title" } });
  const [lane] = g.list();
  assert.equal(lane.title, "Late title");
  assert.equal(lane.tabId, 3);
  assert.equal(lane.count, 2);
  assert.equal(lane.view, null); // the panel owns the DOM slot, not the grouper
});

// --- selection context (v1.4) -----------------------------------------------

const SEL = {
  text: "const x = await fetch(url)",
  contentType: "code",
  surroundingBefore: "Example usage:",
  surroundingAfter: "Then handle the response.",
  parentHeading: "H2: Usage",
  semanticPath: "main > article > section",
  codeBlock: { language: "js", fullCode: "const x = await fetch(url);\nconsole.log(x);" },
  tableBlock: null,
  pageUrl: "https://example.com/docs",
  pageTitle: "Docs",
};

t("normalizeSelection keeps a code selection whole", () => {
  const sel = normalizeSelection(SEL);
  assert.equal(sel.text, SEL.text);
  assert.equal(sel.contentType, "code");
  assert.equal(sel.codeBlock.language, "js");
  assert.ok(sel.codeBlock.fullCode.includes("console.log"));
  assert.equal(sel.parentHeading, "H2: Usage");
  assert.equal(sel.semanticPath, "main > article > section");
  assert.equal(sel.pageUrl, "https://example.com/docs");
  assert.equal("tableBlock" in sel, false); // no block for a code selection
});

t("normalizeSelection drops empty and non-selection payloads", () => {
  assert.equal(normalizeSelection(null), null);
  assert.equal(normalizeSelection({}), null);
  assert.equal(normalizeSelection({ text: "   " }), null);
  assert.equal(normalizeSelection("a string"), null);
});

t("normalizeSelection clamps fields and falls back to text type", () => {
  const big = normalizeSelection({
    text: "x".repeat(SELECTION_LIMITS.text + 10),
    contentType: "weird",
    surroundingBefore: "b".repeat(2000),
    codeBlock: { language: "js", fullCode: "c".repeat(SELECTION_LIMITS.code + 10) },
  });
  assert.equal(big.text.length, SELECTION_LIMITS.text);
  assert.equal(big.contentType, "text");
  assert.equal(big.surroundingBefore.length, SELECTION_LIMITS.surrounding);
  assert.equal("codeBlock" in big, false); // non-code types carry no codeBlock
});

t("normalizeSelection keeps the table markdown only for table selections", () => {
  const sel = normalizeSelection({
    text: "42",
    contentType: "table",
    tableBlock: "| k | v |\n| --- | --- |\n| answer | 42 |",
  });
  assert.equal(sel.contentType, "table");
  assert.ok(sel.tableBlock.includes("| answer | 42 |"));
  assert.equal("codeBlock" in sel, false);
});

t("buildContext carries the selection and still returns null when empty", () => {
  const ctx = buildContext(null, [], SEL);
  assert.equal(ctx.currentTab, null);
  assert.deepEqual(ctx.tabs, []);
  assert.equal(ctx.selection.contentType, "code");
  assert.equal(buildContext(null, []), null);
  assert.equal(buildContext(null, [], { text: "" }), null);
});

t("buildChatMessage puts the selection on the wire next to the tab", () => {
  const msg = buildChatMessage({
    chatId: "c1",
    text: "explain this",
    adapter: "claude-agent-sdk",
    currentTab: { tabId: 5, url: "https://example.com/docs", title: "Docs" },
    taggedTabs: [],
    selection: SEL,
    attachments: [],
  });
  assert.equal(msg.context.currentTab.tabId, 5);
  assert.equal(msg.context.selection.text, SEL.text);
  assert.equal(msg.context.selection.codeBlock.language, "js");
});

t("buildCommandMessage never carries a selection", () => {
  const msg = buildCommandMessage({
    chatId: "c1",
    name: "/tabs",
    args: "",
    adapter: "claude-agent-sdk",
  });
  assert.equal(msg.context === undefined || !("selection" in msg.context), true);
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
