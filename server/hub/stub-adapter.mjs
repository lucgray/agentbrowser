// Stub adapter module for verification. AGENTCHAT_ADAPTER_MODULE points the hub
// here so loop-safety and cost tests spend no model tokens and spawn no CLI.
//
// Each send() takes SEND_MS, emits one token and one meta with fixed usage, and
// resolves. abort() makes the in-flight send reject immediately, which is what
// the real adapters do and what the loop's abort path relies on.

const SEND_MS = Number(process.env.STUB_SEND_MS) || 120;
const LOG = process.env.STUB_LOG || null;

import fs from "node:fs";

function note(line) {
  if (LOG) fs.appendFileSync(LOG, line + "\n");
}

const NAMES = [
  "claude-agent-sdk", "claude-cli", "codex", "opencode", "copilot",
  "grok", "agy", "gemini", "anthropic-api", "openai-api", "stub"
];

export const ADAPTERS = NAMES.slice();

// provider null everywhere so no key check blocks a test; the hub still prices
// off the adapter NAME, which is the thing under test.
export const DESCRIPTORS = Object.fromEntries(
  NAMES.map((n) => [n, {
    label: n,
    models: [{ id: "claude-opus-5", label: "Opus 5" }],
    defaultModel: "claude-opus-5",
    provider: null
  }])
);

export function resolveModel(name, requested) {
  return requested || "claude-opus-5";
}

export function createSession(name, ctx) {
  let aborted = false;
  let rejectCurrent = null;
  let seq = 0;
  note(`create ${name}`);
  return {
    async send(text, emit) {
      seq += 1;
      const n = seq;
      note(`send ${name} #${n}`);
      aborted = false;
      emit({ kind: "status", state: "thinking", label: "stub" });
      await new Promise((resolve, reject) => {
        rejectCurrent = reject;
        const t = setTimeout(() => {
          rejectCurrent = null;
          resolve();
        }, SEND_MS);
        if (aborted) {
          clearTimeout(t);
          rejectCurrent = null;
          reject(new Error("aborted"));
        }
      });
      note(`done ${name} #${n}`);
      emit({ kind: "token", text: `stub reply ${n}. GOAL: NOT MET` });
      emit({
        kind: "meta",
        model: ctx && ctx.model ? ctx.model : "claude-opus-5",
        adapter: name,
        elapsedMs: SEND_MS,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      });
      emit({ kind: "status", state: "idle", label: "" });
      emit({ kind: "done" });
    },
    abort() {
      aborted = true;
      note(`abort ${name}`);
      if (rejectCurrent) {
        const r = rejectCurrent;
        rejectCurrent = null;
        r(new Error("aborted"));
      }
    },
    dispose() {
      note(`dispose ${name}`);
      this.abort();
    }
  };
}
