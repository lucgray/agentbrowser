// Native OpenAI-compatible /v1/chat/completions adapter (PROTOCOL.md v1.2).
//
// Same shape as api-anthropic.mjs: no subprocess, a raw API key drives the
// browser directly, and the agentic tool loop runs in-process against
// ctx.callBrowserTool.
//
// The endpoint shape is also what Ollama, LM Studio, OpenRouter, vLLM and
// friends speak, so the base URL is configurable:
//   server/config.json  ->  {"openaiBaseUrl": "http://127.0.0.1:11434/v1"}
// and so is the model list the panel offers:
//   server/config.json  ->  {"openaiModels": [{"id":"llama3.1","label":"Llama 3.1"}]}
// (a plain array of id strings works too).
//
// ctx.fetchImpl overrides globalThis.fetch — that is how the unit tests feed
// canned SSE without spending API calls.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../tools.mjs';
import { getKey } from './keystore.mjs';
// Shared with the Anthropic adapter rather than duplicated: the operator
// prompt and SSE parser as before, plus the D1 concurrency limiter and the
// screenshot-history bounds, so the two API paths cannot drift apart on
// batch size or on how much image history a session carries.
import {
  SYSTEM_PROMPT,
  sseEvents,
  mapConcurrent,
  MAX_TOOL_CONCURRENCY,
  SCREENSHOT_HISTORY_LIMIT,
  SCREENSHOT_PLACEHOLDER
} from './api-anthropic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function logWarn(context, err) {
  console.error('[api-openai]', context + ':', (err && err.message) || err);
}
const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOOL_ITERATIONS = 40;
const MAX_TOKENS = 16000;

const DEFAULT_MODELS = [
  { id: 'gpt-5.6', label: 'GPT-5.6' },
  { id: 'gpt-5.6-mini', label: 'GPT-5.6 mini' },
  { id: 'o4', label: 'o4' }
];

// Read once at import: config.json is a small local file and the hub reads it
// the same way. Never throws — a missing or broken file falls back to
// defaults.
export function loadOpenAiConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logWarn('config.json unreadable, using defaults', err);
    return {};
  }
}

function normalizeModels(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry) out.push({ id: entry, label: entry });
    else if (entry && typeof entry.id === 'string' && entry.id) {
      out.push({ id: entry.id, label: entry.label || entry.id });
    }
  }
  return out.length > 0 ? out : null;
}

const fileConfig = loadOpenAiConfig();
const MODELS = normalizeModels(fileConfig.openaiModels) || DEFAULT_MODELS;

export const DESCRIPTOR = {
  label: 'OpenAI-compatible API',
  models: MODELS,
  defaultModel: MODELS[0].id,
  provider: 'openai'
};

// The session never validates ctx.model against DESCRIPTOR.models — an
// Ollama/OpenRouter user may pass any id their endpoint serves.
export function resolveBaseUrl(config) {
  const raw = (config && config.openaiBaseUrl) || fileConfig.openaiBaseUrl || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

// tools.mjs entries are {name, description, args}; chat/completions wants
// {type:"function", function:{name, description, parameters}}.
export function toOpenAiTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.args || { type: 'object', properties: {}, required: [] }
    }
  }));
}

function truncate(s, max = 200) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function summarize(value) {
  if (value == null) return 'ok';
  if (typeof value === 'string') return truncate(value) || 'ok';
  try {
    return truncate(JSON.stringify(value));
  } catch (err) {
    logWarn('summarize fell back for unserializable value', err);
    return 'ok';
  }
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function safeJson(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch (err) {
    logWarn('malformed JSON in stream, skipping', err);
    return {};
  }
}

// o-series reasoning models reject `max_tokens` (they take
// `max_completion_tokens`) and reject `temperature` entirely, so temperature
// is never sent on any model here.
function tokenLimitField(model) {
  return /^o\d/i.test(String(model || '')) ? 'max_completion_tokens' : 'max_tokens';
}

export function createOpenAiApiSession(ctx = {}) {
  const config = ctx.config || {};
  const model = ctx.model || config.model || DESCRIPTOR.defaultModel;
  const baseUrl = resolveBaseUrl(config);
  const tools = toOpenAiTools(ctx.tools || TOOLS);
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const readKey = typeof ctx.getApiKey === 'function'
    ? (p) => ctx.getApiKey(p)
    : (p) => getKey(p);

  // Persisted across send() calls: this is the conversation.
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  let closed = false;
  let controller = null;
  let turn = null;

  function emitDone(errorMessage) {
    const t = turn;
    if (!t) return;
    turn = null;
    if (errorMessage) t.emit({ kind: 'error', message: errorMessage });
    t.emit({ kind: 'done' });
    t.done();
  }

  // Every in-turn event goes through here. dispose() can land mid-stream, and
  // it ends the turn immediately (error + done); anything the abort is still
  // unwinding — a buffered token, the meta event — must not emit after done.
  function safeEmit(event) {
    if (turn) turn.emit(event);
  }

  function emitMeta(startedAt, usage) {
    safeEmit({
      kind: 'meta',
      model,
      adapter: 'openai-api',
      elapsedMs: Date.now() - startedAt,
      inputTokens: usage.input == null ? null : usage.input,
      outputTokens: usage.output == null ? null : usage.output
    });
  }

  async function request(apiKey, signal) {
    const body = {
      model,
      messages,
      tools,
      stream: true,
      // Tolerated as unknown by most local servers; when it is honoured we get
      // a final usage chunk for the meta event.
      stream_options: { include_usage: true }
    };
    body[tokenLimitField(model)] = MAX_TOKENS;

    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (res && res.ok === false) {
      let detail = '';
      try {
        detail = truncate(await res.text(), 300);
      } catch (err) {
        logWarn('error body unread, using status only', err);
        detail = '';
      }
      throw new Error(`OpenAI API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  // Streams one assistant message. Emits token/thinking as they arrive and
  // tool_use once a tool call's arguments are complete. Returns the assistant
  // message to append plus the parsed tool calls.
  async function streamAssistantMessage(res, usage) {
    let text = '';
    const calls = new Map(); // index -> {id, name, args}
    const announced = new Set();
    let finish = null;

    const announce = (index) => {
      const call = calls.get(index);
      if (!call || announced.has(index) || !call.name) return;
      announced.add(index);
      safeEmit({ kind: 'tool_use', tool: call.name, args: safeJson(call.args) });
    };

    for await (const event of sseEvents(res.body)) {
      if (!event || typeof event !== 'object') continue;
      if (event.error) {
        const e = event.error;
        throw new Error(e.message || e.type || 'stream error');
      }
      if (event.usage) {
        if (typeof event.usage.prompt_tokens === 'number') usage.input = event.usage.prompt_tokens;
        if (typeof event.usage.completion_tokens === 'number') {
          usage.output = event.usage.completion_tokens;
        }
      }
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        safeEmit({ kind: 'token', text: delta.content });
      }
      // Some OpenAI-compatible servers expose reasoning text; both spellings
      // are in the wild.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        safeEmit({ kind: 'thinking', text: reasoning });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : calls.size;
          if (!calls.has(index)) calls.set(index, { id: '', name: '', args: '' });
          const call = calls.get(index);
          if (tc.id) call.id = tc.id;
          if (tc.function && tc.function.name) call.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') {
            call.args += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finish = choice.finish_reason;
        for (const index of calls.keys()) announce(index);
      }
    }

    // Streams that end without a finish_reason still get their tool calls out.
    for (const index of calls.keys()) announce(index);

    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name);

    const assistant = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map((call, i) => ({
        id: call.id || `call_${i}`,
        type: 'function',
        function: { name: call.name, arguments: call.args || '{}' }
      }));
    }
    return { assistant, toolCalls, finish };
  }

  // Runs a tool. DEVIATION from the Anthropic path: a chat/completions
  // `role:"tool"` message is text-only, so a screenshot cannot be returned as
  // an image there. The tool message carries a text acknowledgement and the
  // image follows as a separate user message with an image_url data URI, which
  // is the only way this endpoint shape can show the model a picture.
  async function runTool(call) {
    const args = safeJson(call.args);
    try {
      const result = await ctx.callBrowserTool(call.name, args);
      if (call.name === 'screenshot' && result && result.base64) {
        const mime = result.mimeType || 'image/png';
        return {
          ok: true,
          summary: '[image]',
          content: JSON.stringify({ captured: true, mimeType: mime }),
          followUp: {
            role: 'user',
            content: [
              { type: 'text', text: 'Screenshot of the requested tab:' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${result.base64}` } }
            ]
          }
        };
      }
      return { ok: true, summary: summarize(result), content: JSON.stringify(result ?? null) };
    } catch (err) {
      logWarn('tool call failed', err);
      return { ok: false, summary: truncate(errText(err)), content: `Error: ${errText(err)}` };
    }
  }

  // Keeps at most SCREENSHOT_HISTORY_LIMIT image parts in the history and
  // swaps every older one for a text part in the same position. The images
  // live in the follow-up user messages runTool builds, and a content array of
  // text parts is as valid as one that mixes text and image_url.
  function pruneScreenshots() {
    const slots = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part && typeof part === 'object' && part.type === 'image_url') {
          slots.push({ array: message.content, part });
        }
      }
    }

    for (let i = 0; i < slots.length - SCREENSHOT_HISTORY_LIMIT; i += 1) {
      const { array, part } = slots[i];
      const at = array.indexOf(part);
      if (at !== -1) array[at] = { type: 'text', text: SCREENSHOT_PLACEHOLDER };
    }
  }

  async function runTurn(text) {
    const startedAt = Date.now();
    const usage = { input: null, output: null };

    const apiKey = readKey('openai');
    if (!apiKey) {
      safeEmit({ kind: 'status', state: 'idle', label: 'no key' });
      emitDone('no OpenAI API key configured — set one in the panel');
      return;
    }

    messages.push({ role: 'user', content: text });
    safeEmit({ kind: 'status', state: 'thinking', label: 'Thinking' });

    controller = new AbortController();
    const signal = controller.signal;

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const res = await request(apiKey, signal);
        const { assistant, toolCalls } = await streamAssistantMessage(res, usage);
        messages.push(assistant);

        if (toolCalls.length === 0) {
          emitMeta(startedAt, usage);
          emitDone(null);
          return;
        }

        // The tool_use events for the whole batch are already out — they are
        // announced at the end of the stream, before any tool runs. The calls
        // themselves go concurrently and each tool_result event fires as that
        // call lands, while `outcomes` stays in the model's original order so
        // the tool_call_id pairing below cannot slip.
        const outcomes = await mapConcurrent(
          toolCalls,
          MAX_TOOL_CONCURRENCY,
          async (call) => {
            const outcome = await runTool(call);
            safeEmit({
              kind: 'tool_result', tool: call.name, ok: outcome.ok, summary: outcome.summary
            });
            return outcome;
          },
          (err, call) => {
            // runTool catches everything it can; this is the backstop that
            // keeps one bad call from taking its siblings down with it.
            const summary = truncate(errText(err));
            safeEmit({ kind: 'tool_result', tool: call.name, ok: false, summary });
            return { ok: false, summary, content: `Error: ${errText(err)}` };
          }
        );

        // dispose() mid-batch already ended the turn and cleared `messages`;
        // pushing now would resurrect a dead conversation from a promise the
        // turn no longer owns.
        if (closed) {
          emitMeta(startedAt, usage);
          emitDone(null);
          return;
        }

        // Always pushed whole, even on abort: chat/completions rejects an
        // assistant message whose tool_calls are not all answered, so a
        // partial batch would poison every later send() on this session.
        // Pairing is positional against assistant.tool_calls, never against
        // call.id — servers that omit ids get a synthesised one there.
        const followUps = [];
        for (let i = 0; i < outcomes.length; i += 1) {
          const outcome = outcomes[i];
          messages.push({
            role: 'tool',
            tool_call_id: assistant.tool_calls[i].id,
            content: outcome.content
          });
          if (outcome.followUp) followUps.push(outcome.followUp);
        }
        for (const followUp of followUps) messages.push(followUp);
        pruneScreenshots();

        // callBrowserTool does not see the signal, so an abort that lands
        // during a tool call is only noticed here rather than one request
        // later.
        if (signal.aborted) {
          emitMeta(startedAt, usage);
          emitDone(null);
          return;
        }
      }

      emitMeta(startedAt, usage);
      emitDone(`tool loop hit the ${MAX_TOOL_ITERATIONS}-iteration cap`);
    } catch (err) {
      if (isAbort(err) || closed) {
        logWarn('turn aborted', err);
        emitMeta(startedAt, usage);
        emitDone(null);
        return;
      }
      emitMeta(startedAt, usage);
      emitDone(errText(err));
    } finally {
      controller = null;
    }
  }

  return {
    async send(text, emit) {
      if (closed) {
        emit({ kind: 'error', message: 'session disposed' });
        emit({ kind: 'done' });
        return;
      }
      if (turn) {
        emit({ kind: 'error', message: 'a turn is already in progress for this chat' });
        emit({ kind: 'done' });
        return;
      }
      await new Promise((resolve) => {
        turn = { emit, done: resolve };
        runTurn(text).catch((err) => {
          logWarn('turn failed', err);
          emitDone(errText(err));
        });
      });
    },

    abort() {
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          logWarn('abort failed', err);
        }
      }
    },

    dispose() {
      closed = true;
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          logWarn('dispose abort failed', err);
        }
      }
      emitDone('session disposed');
      messages.length = 0;
    },

    _messages: messages
  };
}

export default createOpenAiApiSession;
