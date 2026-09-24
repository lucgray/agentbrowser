// Native Anthropic Messages API adapter (PROTOCOL.md v1.2).
//
// No CLI subprocess and no MCP: this talks straight to
// https://api.anthropic.com/v1/messages over https with the user's own key,
// runs the agentic tool loop in-process, and calls ctx.callBrowserTool for
// every tool the model asks for.
//
// Transport note: @anthropic-ai/sdk is NOT in server/node_modules (only
// @anthropic-ai/claude-agent-sdk, which is the Claude Code harness, not the
// Messages API client). So this uses fetch + SSE directly. ctx.fetchImpl
// overrides globalThis.fetch, which is how the unit tests feed canned SSE
// without spending API calls.
//
// The message array lives on the session, so consecutive send() calls on the
// same chatId continue one conversation.

import { TOOLS } from '../hub/tools.mjs';
import { getKey } from './keystore.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOOL_ITERATIONS = 40;
const MAX_TOKENS = 32000;

function logWarn(context, err) {
  console.error('[api-anthropic]', context + ':', (err && err.message) || err);
}

// PROTOCOL v1.3 D1: several tool_use blocks in one assistant turn run
// concurrently, at most this many in flight.
export const MAX_TOOL_CONCURRENCY = 6;

// Screenshots are full base64 PNGs and they stay in `messages` for the life of
// the session, so a long browsing turn grows every subsequent request body
// without bound. Only this many of the most recent images are kept.
export const SCREENSHOT_HISTORY_LIMIT = 2;
export const SCREENSHOT_PLACEHOLDER = '[screenshot from an earlier step, omitted]';

// Copied from claude-agent-sdk.mjs (its SYSTEM_PROMPT is a module-private
// const, not an export, and that file is owned by another builder). Exported
// here so api-openai.mjs shares this exact text instead of keeping a second
// copy that can drift.
export const SYSTEM_PROMPT = [
  "You are a browser operator. You control the user's real, logged-in browser",
  'through trusted CDP input using the browser tools (tabs_list, tab_new,',
  'tab_close, navigate, read_page, screenshot, click, type_text, press_key,',
  'eval_js). Read the page (read_page or screenshot) before acting on it.',
  'A message may start with a <context> block listing the current tab, tabs the',
  'user tagged, and files saved on this machine. When the user says "this page",',
  '"this tab" or names a tagged tab, pass that tabId to read_page, screenshot',
  'and eval_js instead of guessing, and read the tab before you act on it.',
  'Read attached files with your file tools at the paths given.',
  'To fill a form: first read its structure with eval_js over the inputs and',
  'their labels, names, types and current values. Then fill one field at a time',
  'with click on the field followed by type_text; press_key "Tab" moves focus',
  'to the next field when that is easier. After filling, read the values back',
  '(eval_js or read_page) and report what is in each field.',
  'Never click submit, send, post, buy or any equivalent action, and never',
  'publish content anywhere, unless the user explicitly asked for that',
  'submission in this chat. Filling a form is not permission to submit it.'
].join(' ');

export const DESCRIPTOR = {
  label: 'Anthropic API',
  models: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
  ],
  defaultModel: 'claude-opus-5',
  provider: 'anthropic'
};

// Adaptive thinking is the Claude 5 family shape; budget_tokens is REJECTED
// with a 400 on those models. Haiku 4.5 is pre-4.6 and takes neither, so it
// gets no thinking field at all (sending {type:"adaptive"} there 400s too).
// display:"summarized" is required or the thinking blocks stream empty text.
const ADAPTIVE_THINKING_MODELS = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5'
]);

export function thinkingParam(model) {
  return ADAPTIVE_THINKING_MODELS.has(model)
    ? { type: 'adaptive', display: 'summarized' }
    : undefined;
}

// tools.mjs entries are {name, description, args}; the Messages API wants
// {name, description, input_schema}.
export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.args || { type: 'object', properties: {}, required: [] }
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

// --- bounded concurrency -----------------------------------------------

// Runs fn over items with at most `limit` in flight and returns the results in
// the ORIGINAL item order, whatever order the calls finish in. That ordering is
// the whole point: tool results are paired to tool_use ids positionally, so a
// completion-ordered array would hand the model the wrong result for each id.
//
// Never rejects. A rejection would abandon the in-flight siblings, which is
// exactly what "one failing tool must not kill the batch" forbids, so a throw
// is handed to onError(err, item, index) and its return value takes the slot.
// api-openai.mjs imports this rather than keeping a second copy.
export async function mapConcurrent(items, limit, fn, onError) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  if (list.length === 0) return results;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (err) {
        logWarn('concurrent task failed', err);
        results[index] = typeof onError === 'function'
          ? onError(err, list[index], index)
          : undefined;
      }
    }
  };

  const width = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

// --- SSE ---------------------------------------------------------------

// Yields Uint8Array/string chunks from either a web ReadableStream (node
// fetch) or any async iterable (the test transport).
async function* iterateBody(body) {
  if (!body) return;
  if (typeof body[Symbol.asyncIterator] === 'function') {
    yield* body;
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
}

// Parses an SSE byte stream into parsed `data:` payloads. Carries a buffer
// across chunk boundaries and splits on the blank-line record separator, so a
// canned chunk may contain a partial event or several whole ones.
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of iterateBody(body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseSseRecord(record);
      if (parsed !== undefined) yield parsed;
    }
  }
  const tail = parseSseRecord(buffer);
  if (tail !== undefined) yield tail;
}

function parseSseRecord(record) {
  const dataLines = [];
  for (const rawLine of record.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return undefined;
  try {
    return JSON.parse(data);
  } catch (err) {
    logWarn('malformed SSE data, skipping', err);
    return undefined;
  }
}

// --- session -----------------------------------------------------------

export function createAnthropicApiSession(ctx = {}) {
  const config = ctx.config || {};
  const model = ctx.model || config.model || DESCRIPTOR.defaultModel;
  const tools = toAnthropicTools(ctx.tools || TOOLS);
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const readKey = typeof ctx.getApiKey === 'function'
    ? (p) => ctx.getApiKey(p)
    : (p) => getKey(p);

  // Persisted across send() calls: this is the conversation.
  const messages = [];

  let closed = false;
  let controller = null; // per-turn, so abort() does not poison later turns
  let turn = null; // { emit, done }

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
      adapter: 'anthropic-api',
      elapsedMs: Date.now() - startedAt,
      inputTokens: usage.input == null ? null : usage.input,
      outputTokens: usage.output == null ? null : usage.output,
      cacheReadTokens: usage.cacheRead == null ? null : usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite == null ? null : usage.cacheWrite
    });
  }

  async function request(apiKey, signal) {
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stream: true
    };
    const thinking = thinkingParam(model);
    if (thinking) body.thinking = thinking;

    const res = await fetchImpl(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION
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
      // The key is only ever in the request headers; the body we echo here is
      // the API's own error text.
      throw new Error(`Anthropic API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  // Streams one assistant message. Emits token/thinking as they arrive and
  // tool_use when a tool block completes. Returns the assistant content blocks
  // in wire order (thinking blocks keep their signature so the echo back into
  // `messages` stays valid), plus stop_reason and usage.
  async function streamAssistantMessage(res, usage) {
    const blocks = [];
    let stopReason = null;

    for await (const event of sseEvents(res.body)) {
      if (!event || typeof event !== 'object') continue;
      switch (event.type) {
        case 'message_start': {
          const u = event.message && event.message.usage;
          if (u && typeof u.input_tokens === 'number') {
            usage.input = (usage.input || 0) + u.input_tokens;
          }
          // Anthropic reports input_tokens EXCLUSIVE of the cached buckets, so
          // these are separate numbers, not a subset. Dropping them undercounts
          // a cached turn's cost: a cache write bills at 1.25x the input rate.
          if (u && typeof u.cache_read_input_tokens === 'number') {
            usage.cacheRead = (usage.cacheRead || 0) + u.cache_read_input_tokens;
          }
          if (u && typeof u.cache_creation_input_tokens === 'number') {
            usage.cacheWrite = (usage.cacheWrite || 0) + u.cache_creation_input_tokens;
          }
          break;
        }
        case 'content_block_start': {
          const cb = event.content_block || {};
          blocks[event.index] = cb.type === 'tool_use'
            ? { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' }
            : cb.type === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : cb.type === 'redacted_thinking'
                ? { type: 'redacted_thinking', data: cb.data || '' }
                : { type: 'text', text: '' };
          break;
        }
        case 'content_block_delta': {
          const block = blocks[event.index];
          const delta = event.delta || {};
          if (!block) break;
          if (delta.type === 'text_delta' && delta.text) {
            block.text += delta.text;
            safeEmit({ kind: 'token', text: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            block.thinking += delta.thinking;
            safeEmit({ kind: 'thinking', text: delta.thinking });
          } else if (delta.type === 'signature_delta' && delta.signature) {
            block.signature += delta.signature;
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            block._json += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks[event.index];
          if (block && block.type === 'tool_use') {
            block.input = block._json ? safeJson(block._json) : {};
            delete block._json;
            safeEmit({ kind: 'tool_use', tool: block.name, args: block.input });
          }
          break;
        }
        case 'message_delta': {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage && typeof event.usage.output_tokens === 'number') {
            usage.output = (usage.output || 0) + event.usage.output_tokens;
          }
          break;
        }
        case 'error': {
          const e = event.error || {};
          throw new Error(e.message || e.type || 'stream error');
        }
        default:
          break; // ping, message_stop, unknown
      }
    }

    // Drop holes (a stream that skipped an index), the scratch field, and
    // empty text/thinking blocks — the API rejects those when they are echoed
    // back in the assistant turn.
    const content = blocks
      .filter(Boolean)
      .map((b) => {
        if (b.type === 'tool_use') {
          const { _json, ...rest } = b;
          return { ...rest, input: rest.input || {} };
        }
        return b;
      })
      .filter((b) => {
        if (b.type === 'text') return b.text.length > 0;
        if (b.type === 'thinking') return b.thinking.length > 0;
        return true;
      });
    return { content, stopReason };
  }

  function safeJson(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      logWarn('malformed JSON in stream, skipping', err);
      return {};
    }
  }

  // Runs a tool and returns the tool_result content block plus the summary
  // for the tool_result chat_event. Screenshots come back as an image block so
  // the model can actually see the page.
  async function runTool(block) {
    try {
      const result = await ctx.callBrowserTool(block.name, block.input || {});
      if (block.name === 'screenshot' && result && result.base64) {
        return {
          ok: true,
          summary: '[image]',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: result.mimeType || 'image/png',
              data: result.base64
            }
          }]
        };
      }
      return { ok: true, summary: summarize(result), content: JSON.stringify(result ?? null) };
    } catch (err) {
      logWarn('tool call failed', err);
      return { ok: false, summary: truncate(errText(err)), content: errText(err), isError: true };
    }
  }

  function toResultBlock(block, outcome) {
    const resultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content: outcome.content
    };
    if (outcome.isError) resultBlock.is_error = true;
    return resultBlock;
  }

  // Keeps at most SCREENSHOT_HISTORY_LIMIT image blocks in the history and
  // swaps every older one for a text block in the same position, which the API
  // accepts anywhere an image block is legal (including inside a tool_result
  // content array, where a screenshot lands).
  function pruneScreenshots() {
    const slots = [];
    const scan = (array) => {
      for (const block of array) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'image') slots.push({ array, block });
        else if (block.type === 'tool_result' && Array.isArray(block.content)) scan(block.content);
      }
    };
    for (const message of messages) {
      if (Array.isArray(message.content)) scan(message.content);
    }

    for (let i = 0; i < slots.length - SCREENSHOT_HISTORY_LIMIT; i += 1) {
      const { array, block } = slots[i];
      const at = array.indexOf(block);
      if (at !== -1) array[at] = { type: 'text', text: SCREENSHOT_PLACEHOLDER };
    }
  }

  async function runTurn(text) {
    const startedAt = Date.now();
    const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };

    const apiKey = readKey('anthropic');
    if (!apiKey) {
      safeEmit({ kind: 'status', state: 'idle', label: 'no key' });
      emitDone('no Anthropic API key configured — set one in the panel');
      return;
    }

    messages.push({ role: 'user', content: [{ type: 'text', text }] });
    safeEmit({ kind: 'status', state: 'thinking', label: 'Thinking' });

    controller = new AbortController();
    const signal = controller.signal;

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const res = await request(apiKey, signal);
        const { content } = await streamAssistantMessage(res, usage);

        // Echo the assistant turn back verbatim — thinking blocks keep their
        // signature, tool_use blocks keep their ids.
        if (content.length > 0) messages.push({ role: 'assistant', content });

        const toolUses = content.filter((b) => b.type === 'tool_use');
        if (toolUses.length === 0) {
          emitMeta(startedAt, usage);
          emitDone(null);
          return;
        }

        // The tool_use events for the whole batch are already out — they are
        // emitted as each block closes during the stream, before any tool
        // runs. The calls themselves go concurrently and each tool_result
        // event fires as that call lands, so results surface in completion
        // order while `results` stays in the model's original order.
        const results = await mapConcurrent(
          toolUses,
          MAX_TOOL_CONCURRENCY,
          async (block) => {
            const outcome = await runTool(block);
            safeEmit({
              kind: 'tool_result', tool: block.name, ok: outcome.ok, summary: outcome.summary
            });
            return toResultBlock(block, outcome);
          },
          (err, block) => {
            // runTool catches everything it can; this is the backstop that
            // keeps one bad call from taking its siblings down with it.
            safeEmit({
              kind: 'tool_result', tool: block.name, ok: false, summary: truncate(errText(err))
            });
            return toResultBlock(block, { content: errText(err), isError: true });
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

        // Always pushed whole, even on abort: the API rejects an assistant
        // turn whose tool_use blocks are not all answered, so a partial batch
        // would poison every later send() on this session.
        messages.push({ role: 'user', content: results });
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
        // aborted turns end cleanly: the conversation so far is still valid
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

    // test/debug surface only
    _messages: messages
  };
}

export default createAnthropicApiSession;
