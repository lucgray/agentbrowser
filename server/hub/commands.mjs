// Slash commands (PROTOCOL.md v1.3, sections B, C and D2).
//
// The panel parses a leading "/" locally. Client-scope commands it handles
// itself; server-scope commands arrive at the hub as
// {type:"command", chatId, name, args, adapter, model, context} and are routed
// here. Everything a command emits travels on the same chat_event stream as an
// ordinary chat turn, so the transcript stays uniform.
//
// dispatch(name, {args, session, emit, ctx, signal, maxMs}) -> {usage}
//   args    the rest of the line, verbatim
//   session the chat's adapter session, or null for commands that need none
//   emit    the hub's per-turn emitter (terminal guard, meta augmentation)
//   signal  AbortSignal for this command (chat_abort, wall clock, disconnect)
//   maxMs   optional shorter wall clock for tests; clamped to LOOP_MAX_MS, so
//           it can only tighten the cap. The hub never passes it.
//   ctx     { chatId, adapter, model, context, callBrowserTool, createSession,
//             abort(reason), touch(), log(...) }
//
// dispatch never emits done or meta: the hub owns both, exactly once. Inner
// per-turn done/meta events from session.send are swallowed here and their
// token counts are summed into the usage object dispatch returns.

export const LOOP_MAX_ITERATIONS = 20;
export const LOOP_MAX_MS = 15 * 60 * 1000;
export const PARALLEL_MAX_LANES = 6;

// Prepended to every generated iteration/lane prompt. The hub grants no
// publish authority of its own: only what the user typed can authorise it.
const NO_SUBMIT =
  "Do not publish, submit, post, purchase or send anything unless the " +
  "instruction above explicitly says to.";

export const COMMANDS = [
  {
    name: "help",
    args: "",
    summary: "List every command.",
    scope: "server"
  },
  {
    name: "tabs",
    args: "",
    summary: "List the open browser tabs. No model call.",
    scope: "server"
  },
  {
    name: "loop",
    args: "<n> <instruction>",
    summary: "Run the instruction n times (max 20 iterations, 15 minutes).",
    scope: "server"
  },
  {
    name: "goal",
    args: "<condition>",
    summary: "Re-run until the model reports the condition met (same caps).",
    scope: "server"
  },
  {
    name: "parallel",
    args: "<instruction>",
    summary: "Run the instruction against every @-tagged tab at once (max 6).",
    scope: "server"
  },
  {
    name: "clear",
    args: "",
    summary: "Start a new chat.",
    scope: "client"
  },
  {
    name: "model",
    args: "<id>",
    summary: "Switch the model for this chat.",
    scope: "client"
  },
  {
    name: "adapter",
    args: "<name>",
    summary: "Switch the adapter for this chat.",
    scope: "client"
  },
  {
    name: "keys",
    args: "",
    summary: "Open the API key settings.",
    scope: "client"
  },
  {
    name: "stop",
    args: "",
    summary: "Abort whatever is running in this chat.",
    scope: "client"
  }
];

// Which commands need an adapter session, and which kind. /help and /tabs are
// absent on purpose: they must never create a session, because creating one can
// spawn a CLI child process or open an API session for a command that costs
// nothing to answer.
const SESSION_NEEDS = { loop: "chat", goal: "chat", parallel: "lanes" };

export function commandByName(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

// True when the hub must hand dispatch() the chat's own adapter session.
export function needsChatSession(name) {
  return SESSION_NEEDS[name] === "chat";
}

// True when the command creates its own sessions through ctx.createSession.
export function needsLaneSessions(name) {
  return SESSION_NEEDS[name] === "lanes";
}

// ---------------------------------------------------------------------------
// Usage accumulation
//
// Each inner session.send emits its own meta. Those are swallowed (the hub
// emits exactly one meta for the whole command) but their numbers are summed
// here so the command's single meta reports what the whole run cost.

function usageAccumulator() {
  const totals = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null
  };
  return {
    totals,
    add(event) {
      for (const key of Object.keys(totals)) {
        const value = event[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          totals[key] = (totals[key] || 0) + value;
        }
      }
    }
  };
}

// Wraps the hub emitter for one inner turn: drops that turn's done, captures
// its meta, drops its "idle" status (the panel's cooking indicator must not
// flicker between iterations), and tags every surviving event with the lane.
function relay(emit, acc, lane, onText) {
  return (event) => {
    if (!event || typeof event !== "object") return;
    if (event.kind === "done") return;
    if (event.kind === "meta") {
      acc.add(event);
      return;
    }
    if (event.kind === "status" && event.state === "idle") return;
    if (event.kind === "token" && typeof event.text === "string" && onText) onText(event.text);
    emit(lane ? { ...event, lane } : event);
  };
}

function describeTab(tab) {
  const title = tab && tab.title != null ? String(tab.title) : "";
  const url = tab && tab.url != null ? String(tab.url) : "";
  return `"${title}" ${url}`.trim();
}

function errorOut(emit, message) {
  emit({ kind: "error", message });
  return { usage: null };
}

// ---------------------------------------------------------------------------
// /help and /tabs (no model call)

function runHelp(emit) {
  const server = COMMANDS.filter((c) => c.scope === "server");
  const client = COMMANDS.filter((c) => c.scope === "client");
  const width = Math.max(
    ...COMMANDS.map((c) => (`/${c.name} ${c.args}`).trim().length)
  );
  const line = (c) => `  ${(`/${c.name} ${c.args}`).trim().padEnd(width)}  ${c.summary}`;
  const lines = ["Commands:", ...server.map(line)];
  lines.push("", "Handled by the side panel:", ...client.map(line));
  lines.push(
    "",
    `/loop and /goal stop after ${LOOP_MAX_ITERATIONS} iterations, after ` +
      `${LOOP_MAX_MS / 60000} minutes, or when you press stop.`
  );
  emit({ kind: "info", message: lines.join("\n") });
  return { usage: null };
}

async function runTabs(emit, ctx) {
  let result;
  try {
    result = await ctx.callBrowserTool("tabs_list", {});
  } catch (err) {
    return errorOut(emit, `tabs_list failed: ${(err && err.message) || err}`);
  }
  const tabs = Array.isArray(result && result.tabs) ? result.tabs : [];
  if (tabs.length === 0) {
    emit({ kind: "info", message: "No open tabs." });
    return { usage: null };
  }
  const lines = [`${tabs.length} open tab${tabs.length === 1 ? "" : "s"}:`];
  for (const tab of tabs) {
    lines.push(`  [${tab.tabId}] ${describeTab(tab)}${tab.active ? " (active)" : ""}`);
  }
  emit({ kind: "info", message: lines.join("\n") });
  return { usage: null };
}

// ---------------------------------------------------------------------------
// /loop and /goal
//
// Hard caps, in order of the checks: abort before each iteration, wall clock
// before each iteration, abort again after each iteration, and a timer that
// aborts the whole command at the wall clock even if a single iteration hangs.

async function loopCore({ label, iterations, buildPrompt, stopAfter, session, emit, ctx, signal, acc, maxMs }) {
  const startedAt = Date.now();
  let wallClock = false;
  let ran = 0;
  let stop = null;

  const timer = setTimeout(() => {
    wallClock = true;
    ctx.abort("wall clock cap");
  }, maxMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    for (let i = 1; i <= iterations; i += 1) {
      if (signal.aborted) {
        stop = wallClock ? "wall-clock" : "abort";
        break;
      }
      if (Date.now() - startedAt >= maxMs) {
        wallClock = true;
        stop = "wall-clock";
        break;
      }

      emit({ kind: "info", message: `iteration ${i}/${iterations}` });
      ctx.log(`${label} iteration ${i}/${iterations} chat=${ctx.chatId}`);

      const text = [];
      try {
        await session.send(buildPrompt(i, iterations), relay(emit, acc, null, (t) => text.push(t)));
      } catch (err) {
        ran = i;
        // An adapter that rejects because it was aborted is not an error, it is
        // the stop working. Anything else ends the loop with its own message
        // rather than escaping as one raw failure for the whole command.
        if (signal.aborted) {
          stop = wallClock ? "wall-clock" : "abort";
          break;
        }
        emit({
          kind: "error",
          message: `iteration ${i} failed: ${String((err && err.message) || err)}`
        });
        stop = "error";
        break;
      }
      ran = i;
      ctx.touch();

      if (signal.aborted) {
        stop = wallClock ? "wall-clock" : "abort";
        break;
      }
      if (stopAfter && stopAfter(text.join(""))) {
        stop = "met";
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!stop) stop = "complete";
  return { ran, stop, maxMs, elapsedMs: Date.now() - startedAt };
}

function summarize(label, { ran, stop, maxMs }, iterations) {
  switch (stop) {
    case "abort":
      return `${label} stopped by the user after ${ran} of ${iterations} iterations.`;
    case "wall-clock":
      return `${label} stopped at the wall clock cap (${Math.round(
        (maxMs || LOOP_MAX_MS) / 1000
      )}s) after ${ran} of ${iterations} iterations.`;
    case "met":
      return `Goal reported met after ${ran} iteration${ran === 1 ? "" : "s"}.`;
    case "error":
      return `${label} stopped after iteration ${ran} of ${iterations} failed.`;
    default:
      return `${label} finished ${ran} of ${iterations} iterations.`;
  }
}

async function runLoop({ args, session, emit, ctx, signal, maxMs }) {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(String(args || "").trim());
  if (!match) {
    return errorOut(emit, "usage: /loop <n> <instruction>, for example /loop 3 refresh the page and read the top story");
  }
  const n = Number(match[1]);
  const instruction = match[2].trim();
  if (!Number.isInteger(n) || n < 1) {
    return errorOut(emit, `"${match[1]}" is not a whole number of iterations. usage: /loop <n> <instruction>`);
  }
  if (n > LOOP_MAX_ITERATIONS) {
    return errorOut(
      emit,
      `/loop is capped at ${LOOP_MAX_ITERATIONS} iterations, ${n} requested. Run it again with ${LOOP_MAX_ITERATIONS} or fewer.`
    );
  }
  if (instruction === "") {
    return errorOut(emit, "usage: /loop <n> <instruction>");
  }

  const acc = usageAccumulator();
  const buildPrompt = (i, total) =>
    `${instruction}\n\n(This is iteration ${i} of ${total} of a /loop command. ${NO_SUBMIT})`;
  const outcome = await loopCore({
    label: "/loop",
    iterations: n,
    buildPrompt,
    stopAfter: null,
    session,
    emit,
    ctx,
    signal,
    acc,
    maxMs
  });
  emit({ kind: "info", message: summarize("/loop", outcome, n) });
  return { usage: acc.totals };
}

// "GOAL: NOT MET" must not read as met, and a model that mentions the marker
// mid-answer must not beat its own last word, so the last marker wins.
export function goalMet(text) {
  const matches = String(text || "").match(/GOAL:\s*(NOT\s*MET|MET)/gi);
  if (!matches || matches.length === 0) return false;
  return !/NOT/i.test(matches[matches.length - 1]);
}

async function runGoal({ args, session, emit, ctx, signal, maxMs }) {
  const condition = String(args || "").trim();
  if (condition === "") {
    return errorOut(emit, "usage: /goal <condition>, for example /goal the form is filled in and shows no validation errors");
  }

  const acc = usageAccumulator();
  const buildPrompt = (i, total) => {
    const head =
      i === 1
        ? `Goal: ${condition}\n\nWork toward this goal now.`
        : `The goal is not met yet. Keep working toward it: ${condition}`;
    return (
      `${head}\n\n${NO_SUBMIT}\n` +
      `This is attempt ${i} of at most ${total}. When you have finished this ` +
      `attempt, end your reply with a line that is exactly "GOAL: MET" or "GOAL: NOT MET".`
    );
  };

  const outcome = await loopCore({
    label: "/goal",
    iterations: LOOP_MAX_ITERATIONS,
    buildPrompt,
    stopAfter: goalMet,
    session,
    emit,
    ctx,
    signal,
    acc,
    maxMs
  });
  const message =
    outcome.stop === "complete"
      ? `Goal not reported met after ${outcome.ran} iterations (${LOOP_MAX_ITERATIONS} iteration cap).`
      : summarize("/goal", outcome, LOOP_MAX_ITERATIONS);
  emit({ kind: "info", message });
  return { usage: acc.totals };
}

// ---------------------------------------------------------------------------
// /parallel (contract D2)

async function runParallel({ args, emit, ctx, signal }) {
  const instruction = String(args || "").trim();
  if (instruction === "") {
    return errorOut(emit, "usage: /parallel <instruction>");
  }
  const context = ctx.context && typeof ctx.context === "object" ? ctx.context : {};
  const tagged = (Array.isArray(context.tabs) ? context.tabs : []).filter(
    (t) => t && typeof t === "object" && t.tabId != null
  );
  if (tagged.length === 0) {
    return errorOut(
      emit,
      "/parallel needs @-tagged tabs: tag the tabs you want it to run against, one lane per tab."
    );
  }

  const lanes = tagged.slice(0, PARALLEL_MAX_LANES);
  if (tagged.length > lanes.length) {
    const skipped = tagged.slice(PARALLEL_MAX_LANES).map((t) => t.tabId).join(", ");
    emit({
      kind: "info",
      message: `/parallel runs at most ${PARALLEL_MAX_LANES} lanes; skipping tabs ${skipped}.`
    });
  }

  const acc = usageAccumulator();
  emit({
    kind: "info",
    message: `/parallel running ${lanes.length} lane${lanes.length === 1 ? "" : "s"}.`
  });
  ctx.log(`/parallel ${lanes.length} lanes chat=${ctx.chatId}`);

  const settled = await Promise.allSettled(
    lanes.map(async (tab, index) => {
      const lane = { index, tabId: tab.tabId, title: tab.title == null ? "" : String(tab.title) };
      try {
        if (signal.aborted) throw new Error("aborted before the lane started");
        const session = await ctx.createSession(lane);
        const prompt =
          `${instruction}\n\n` +
          `Work only in browser tab ${tab.tabId} (${describeTab(tab)}). Pass ` +
          `tabId: ${tab.tabId} to every browser tool call and do not touch other tabs.\n` +
          NO_SUBMIT;
        await session.send(prompt, relay(emit, acc, lane, null));
        return { lane, ok: true };
      } catch (err) {
        // A lane failure is reported on the stream and never rejects the batch.
        const message = String((err && err.message) || err);
        emit({ kind: "error", message: `lane ${index} (tab ${tab.tabId}): ${message}`, lane });
        return { lane, ok: false, error: message };
      }
    })
  );

  // The lane body catches its own failures, so a rejection here means the emit
  // path itself threw. Report it the same way rather than losing the lane.
  const results = settled.map((s, index) => {
    if (s.status === "fulfilled") return s.value;
    const lane = {
      index,
      tabId: lanes[index].tabId,
      title: lanes[index].title == null ? "" : String(lanes[index].title)
    };
    const error = String((s.reason && s.reason.message) || s.reason);
    emit({ kind: "error", message: `lane ${index} (tab ${lane.tabId}): ${error}`, lane });
    return { lane, ok: false, error };
  });

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const detail = results
    .map((r) => `lane ${r.lane.index} (tab ${r.lane.tabId}) ${r.ok ? "ok" : "failed: " + r.error}`)
    .join("; ");
  emit({
    kind: "info",
    message: `/parallel finished: ${ok} ok, ${failed} failed. ${detail}`
  });
  return { usage: acc.totals };
}

// ---------------------------------------------------------------------------

// A caller may only SHORTEN the wall clock, never extend it: the 15 minute
// bound is the ceiling whatever is passed. The hub passes nothing; the shorter
// value exists so the cap itself can be tested in seconds.
function clampWallClock(maxMs) {
  const n = Number(maxMs);
  if (!Number.isFinite(n) || n <= 0) return LOOP_MAX_MS;
  return Math.min(n, LOOP_MAX_MS);
}

export async function dispatch(name, { args = "", session = null, emit, ctx, signal, maxMs }) {
  const command = commandByName(name);
  if (!command) {
    const known = COMMANDS.map((c) => "/" + c.name).join(", ");
    return errorOut(emit, `unknown command "/${name}". Known commands: ${known}`);
  }
  if (command.scope === "client") {
    return errorOut(emit, `/${name} is handled by the side panel, not the hub.`);
  }
  if (needsChatSession(name) && !session) {
    return errorOut(emit, `/${name} needs an adapter session and none was available.`);
  }

  switch (name) {
    case "help":
      return runHelp(emit);
    case "tabs":
      return runTabs(emit, ctx);
    case "loop":
      return runLoop({ args, session, emit, ctx, signal, maxMs: clampWallClock(maxMs) });
    case "goal":
      return runGoal({ args, session, emit, ctx, signal, maxMs: clampWallClock(maxMs) });
    case "parallel":
      return runParallel({ args, emit, ctx, signal });
    default:
      return errorOut(emit, `/${name} is not implemented on the hub.`);
  }
}
