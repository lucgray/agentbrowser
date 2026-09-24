// Claude Agent SDK adapter (PROTOCOL.md "Adapter interface").
//
// One SDK session per chat session: query() is started once with a streaming
// input generator fed by a queue, so every send() lands in the same
// conversation. Browser tools are exposed to the model as an in-process MCP
// server whose handlers call ctx.callBrowserTool.

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_NAMES } from '../tools.mjs';

const MCP_SERVER_NAME = 'browser';
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function logWarn(context, err) {
  console.error('[claude-agent-sdk]', context + ':', (err && err.message) || err);
}

const SYSTEM_PROMPT = [
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

const tabIdSchema = z.number().optional().describe('Target tab id; omit for the active tab');

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(err) {
  const message = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function buildMcpServer(ctx) {
  const call = (name) => async (args) => {
    try {
      return textResult(await ctx.callBrowserTool(name, args));
    } catch (err) {
      logWarn('browser tool failed', err);
      return errorResult(err);
    }
  };

  const tools = [
    tool('tabs_list', 'List open browser tabs. Returns {tabs:[{tabId,url,title,active}]}.',
      {}, call('tabs_list')),
    tool('tab_new', 'Open a new browser tab, optionally at a URL. Returns {tabId}.',
      { url: z.string().optional().describe('URL to open in the new tab') },
      call('tab_new')),
    tool('tab_close', 'Close a tab by id. Returns {closed:true}.',
      { tabId: z.number().describe('Id of the tab to close') },
      call('tab_close')),
    tool('navigate', 'Navigate a tab to a URL and wait for the load event (20s cap). Returns {url, title}.',
      { url: z.string().describe('URL to navigate to'), tabId: tabIdSchema },
      call('navigate')),
    tool('read_page', 'Read the visible text of a page (document.body.innerText, default cap 60000 chars). Returns {url, title, text}.',
      { tabId: tabIdSchema, maxChars: z.number().optional().describe('Maximum characters of text to return (default 60000)') },
      call('read_page')),
    tool('screenshot', 'Capture a screenshot of a tab as an image.',
      { tabId: tabIdSchema },
      async (args) => {
        try {
          const result = await ctx.callBrowserTool('screenshot', args);
          return {
            content: [{
              type: 'image',
              data: result.base64,
              mimeType: result.mimeType || 'image/png'
            }]
          };
        } catch (err) {
          logWarn('browser tool failed', err);
          return errorResult(err);
        }
      }),
    tool('click', 'Click at viewport coordinates using trusted CDP input (left button, single click). Returns {clicked:true}.',
      { x: z.number().describe('Viewport x coordinate'), y: z.number().describe('Viewport y coordinate'), tabId: tabIdSchema },
      call('click')),
    tool('type_text', 'Type text into the focused element via CDP Input.insertText (trusted input, works in rich editors). Returns {typed:<charcount>}.',
      { text: z.string().describe('Text to insert at the caret'), tabId: tabIdSchema },
      call('type_text')),
    tool('press_key', 'Press a key or modifier combo, e.g. "Enter", "Tab", "Escape", "Backspace", "ArrowDown", "Meta+A", "Meta+C", "Meta+V". Returns {pressed:key}.',
      { key: z.string().describe('Key name, optionally with modifiers joined by +'), tabId: tabIdSchema },
      call('press_key')),
    tool('eval_js', 'Evaluate a JavaScript expression in the page (Runtime.evaluate, returnByValue, awaits promises). Returns {value}.',
      { expression: z.string().describe('JavaScript expression to evaluate'), tabId: tabIdSchema },
      call('eval_js'))
  ];

  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools });
}

function shortToolName(name) {
  return name && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function summarizeToolResult(content) {
  if (content == null) return 'ok';
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && block.text) parts.push(block.text);
      else if (block && block.type === 'image') parts.push('[image]');
    }
    return truncate(parts.join(' ')) || 'ok';
  }
  return truncate(JSON.stringify(content));
}

function truncate(s, max = 200) {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// --- usage ------------------------------------------------------------------
//
// SDKResultMessage.usage is typed NonNullableUsage in
// node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts,
// which is the Anthropic API's BetaUsage with every field non-nullable — so the
// wire names are the API's: input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens.
//
// The numbers are per turn, not cumulative. In streaming-input mode the SDK's
// cli.js runs one generator per input prompt and starts that generator's usage
// accumulator at zero, so each `result` message covers only its own turn. The
// hub can add them into session totals without double counting.
const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null
};

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Exported so the parser can be tested against a canned result message without
// starting an SDK query.
export function usageFromApi(usage) {
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE };
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens)
  };
}

export function createClaudeAgentSdkSession(ctx) {
  const abortController = new AbortController();
  let closed = false;
  let activeQuery = null;
  let pushInput = null; // rebound by ensureStarted for the current query
  let wakeCurrent = null; // wakes the current query's generator (for dispose)
  let turn = null; // { emit, resolve, startedAt }
  let turnUsage = { ...EMPTY_USAGE }; // filled by the result message, if it arrives
  const toolNamesById = new Map();

  // Ends the current turn exactly once: optional error event, meta, then done.
  // Every termination path (result, stream error, dispose) goes through here,
  // so exactly one meta lands per turn — with nulls on the paths that never saw
  // a result message, since the contract still wants a meta on those turns.
  function endTurn(errorMessage) {
    const t = turn;
    if (!t) return;
    turn = null;
    if (errorMessage) t.emit({ kind: 'error', message: errorMessage });
    t.emit({
      kind: 'meta',
      model: ctx.model || (ctx.config && ctx.config.model) || null,
      adapter: 'claude-agent-sdk',
      elapsedMs: Date.now() - t.startedAt,
      ...turnUsage
    });
    turnUsage = { ...EMPTY_USAGE };
    t.emit({ kind: 'done' });
    t.resolve();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (turn) turn.emit({ kind: 'info', message: `session started (model ${msg.model})` });
      return;
    }
    if (msg.type === 'assistant') {
      const content = msg.message && msg.message.content;
      if (!Array.isArray(content) || !turn) return;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          turn.emit({ kind: 'token', text: block.text });
        } else if (block.type === 'tool_use') {
          toolNamesById.set(block.id, block.name);
          turn.emit({ kind: 'tool_use', tool: shortToolName(block.name), args: block.input || {} });
        }
      }
      return;
    }
    if (msg.type === 'user') {
      const content = msg.message && msg.message.content;
      if (!Array.isArray(content) || !turn) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const name = toolNamesById.get(block.tool_use_id) || 'tool';
          toolNamesById.delete(block.tool_use_id);
          turn.emit({
            kind: 'tool_result',
            tool: shortToolName(name),
            ok: !block.is_error,
            summary: summarizeToolResult(block.content)
          });
        }
      }
      return;
    }
    if (msg.type === 'result') {
      // Read usage before endTurn — endTurn is what emits the meta event.
      turnUsage = usageFromApi(msg.usage);
      if (msg.is_error) {
        const message = Array.isArray(msg.errors) && msg.errors.length > 0
          ? msg.errors.join('; ')
          : (msg.result || msg.subtype || 'error');
        endTurn(message);
      } else {
        endTurn(null);
      }
    }
  }

  function ensureStarted() {
    if (activeQuery) return;
    // Input state is per-query. After a stream error the abandoned generator
    // can stay suspended holding the old wake resolver; sharing one queue
    // with it would let it steal the next message into a dead query. Fresh
    // queue + generator per query makes that impossible.
    const queue = [];
    let wake = null;
    pushInput = (message) => {
      queue.push(message);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    wakeCurrent = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    async function* inputStream() {
      while (!closed) {
        while (queue.length > 0) yield queue.shift();
        if (closed) break;
        await new Promise((resolve) => { wake = resolve; });
      }
    }
    activeQuery = query({
      prompt: inputStream(),
      options: {
        abortController,
        model: ctx.model || (ctx.config && ctx.config.model),
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Pre-approval list, not a restriction (the SDK's `tools` option is
        // what restricts). Read is listed because chats can carry attachments
        // the hub saved to disk and named in the prompt.
        allowedTools: [...TOOL_NAMES.map((n) => TOOL_PREFIX + n), 'Read'],
        mcpServers: { [MCP_SERVER_NAME]: buildMcpServer(ctx) },
        persistSession: false
      }
    });
    runReader(activeQuery);
  }

  async function runReader(q) {
    try {
      for await (const msg of q) handleMessage(msg);
      endTurn(closed ? null : 'SDK stream ended unexpectedly');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      endTurn(closed ? null : message);
    } finally {
      if (activeQuery === q) activeQuery = null;
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
      // Below the concurrency guard (so an in-flight turn's tally is never
      // clobbered) but above ensureStarted, which can bail out without
      // reaching endTurn.
      turnUsage = { ...EMPTY_USAGE };
      try {
        ensureStarted();
      } catch (err) {
        emit({ kind: 'error', message: err && err.message ? err.message : String(err) });
        emit({ kind: 'done' });
        return;
      }
      await new Promise((resolve) => {
        turn = { emit, resolve, startedAt: Date.now() };
        pushInput({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: ''
        });
      });
    },

    abort() {
      if (activeQuery) {
        activeQuery.interrupt().catch((err) => {
          logWarn('interrupt failed', err);
        });
      }
    },

    dispose() {
      closed = true;
      if (wakeCurrent) wakeCurrent();
      endTurn('session disposed');
      try {
        abortController.abort();
      } catch (err) {
        logWarn('dispose abort failed', err);
      }
      activeQuery = null;
    }
  };
}
