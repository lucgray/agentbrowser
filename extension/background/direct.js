// Hubless direct mode: the service worker talks to the model API itself and
// executes browser tools locally via sw.js's executor — no local hub needed.
// Enabled through chrome.storage.local.abDirect:
//   { enabled, provider: 'anthropic'|'openai', apiKey, model, baseUrl? }
// Emits the same chat_event vocabulary the hub's adapters produce, so the
// panel renders a direct turn exactly like a hubbed one.

import { DIRECT_TOOLS } from './direct-schema.js';

const MAX_TOOL_ITERATIONS = 8;
const MAX_TEXT = 8000;

export async function config() {
  const { abDirect } = await chrome.storage.local.get('abDirect');
  return abDirect && typeof abDirect === 'object' ? abDirect : {};
}

export function isEnabled(cfg) {
  return !!(cfg && cfg.enabled && cfg.apiKey && cfg.provider);
}

export async function enabled() {
  return isEnabled(await config());
}

const SYSTEM_PROMPT = [
  'You are a browser operator inside the user\'s real, logged-in browser.',
  'You act through the provided browser tools — read the page first',
  '(read_page, page_snapshot or screenshot) before clicking or typing.',
  'page_snapshot returns the clickable map in one call; click_element takes',
  '{"nodeId":"n12"} directly on a snapshot node, no selector needed.',
  'Set a short "label" on every tool call in the user\'s language — it is the',
  'action\'s title in the UI. Prefer composite tools over step chains: fill',
  'for input+type, wait_for instead of polling, read_elements for a scoped',
  'list, batch for a fixed sequence ending in a read.',
  'A message may start with a <context> block naming the current tab, tagged',
  'tabs and selected text; pass those tabIds to your tools rather than',
  'guessing. Never submit, post or buy unless the user explicitly asked.',
].join(' ');

// One in-memory conversation per chatId. No persistence — transcripts are a
// hub feature; a worker restart simply starts the chat over.
const chats = new Map();

export function abort(chatId) {
  const chat = chats.get(chatId);
  if (chat && chat.abort) chat.abort.abort();
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

function errText(err) {
  return String((err && err.message) || err);
}

// <context> prefix matching what the hub composes (current tab, tagged tabs,
// selection, attachments note) so direct turns see the same situation.
function contextPrefix(context) {
  if (!context || typeof context !== 'object') return '';
  const lines = [];
  const cur = context.currentTab;
  if (cur) lines.push(`current tab: [${cur.tabId}] ${cur.title || ''} ${cur.url || ''}`);
  for (const t of context.taggedTabs || []) {
    lines.push(`tagged tab: [${t.tabId}] ${t.title || ''} ${t.url || ''}`);
  }
  const sel = context.selection;
  if (sel && sel.text) {
    lines.push(`selected text: """${clip(sel.text, 2000)}"""`);
    if (sel.blockText) lines.push(`surrounding block: """${clip(sel.blockText, 2000)}"""`);
    if (sel.tableBlock) lines.push(`table: ${clip(sel.tableBlock, 1500)}`);
  }
  return lines.length ? `<context>\n${lines.join('\n')}\n</context>\n\n` : '';
}

function userContent(provider, msg) {
  const text = contextPrefix(msg.context) + clip(msg.text, MAX_TEXT * 2);
  const parts = [{ type: 'text', text }];
  for (const a of msg.attachments || []) {
    if (a && /^image\//.test(a.mimeType || '') && typeof a.base64 === 'string') {
      if (provider === 'anthropic') {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mimeType, data: a.base64 },
        });
      } else {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${a.mimeType};base64,${a.base64}` },
        });
      }
    } else if (a && a.name) {
      parts.push({ type: 'text', text: `[attached file saved for you: ${a.name}]` });
    }
  }
  return provider === 'anthropic'
    ? parts
    : parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : p));
}

async function anthropicTurn(cfg, messages, signal) {
  const res = await fetch(`${cfg.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: DIRECT_TOOLS,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(body.error && body.error.message) || res.statusText}`);
  return {
    texts: (body.content || []).filter((b) => b.type === 'text').map((b) => b.text),
    calls: (body.content || [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, tool: b.name, args: b.input || {} })),
    assistantMessage: { role: 'assistant', content: body.content || [] },
    usage: {
      inputTokens: body.usage && body.usage.input_tokens,
      outputTokens: body.usage && body.usage.output_tokens,
    },
    toolMessage: (results) => ({ role: 'user', content: results }),
  };
}

async function openaiTurn(cfg, messages, signal) {
  const res = await fetch(`${cfg.baseUrl || 'https://api.openai.com'}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      tools: DIRECT_TOOLS.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`openai ${res.status}: ${(body.error && body.error.message) || res.statusText}`);
  const m = (body.choices && body.choices[0] && body.choices[0].message) || {};
  return {
    texts: m.content ? [m.content] : [],
    calls: (m.tool_calls || []).map((c) => ({
      id: c.id,
      tool: c.function && c.function.name,
      args: (() => {
        try {
          return JSON.parse((c.function && c.function.arguments) || '{}');
        } catch {
          return {};
        }
      })(),
    })),
    assistantMessage: m,
    usage: {
      inputTokens: body.usage && body.usage.prompt_tokens,
      outputTokens: body.usage && body.usage.completion_tokens,
    },
    toolMessage: null, // openai appends one message per result
  };
}

// payload: the panel's {type:'chat', chatId, text, context, attachments, …}.
// emit(event) delivers {kind:…} events; execTool(name,args) runs the tool;
// gate(name,args) runs the consent check first. Both are sw.js injections.
export async function sendChat(payload, { emit, execTool, gate }) {
  const cfg = await config();
  if (!isEnabled(cfg)) {
    emit({ kind: 'error', message: 'direct mode is off — enable it in settings or start the hub' });
    emit({ kind: 'done' });
    return;
  }
  const chatId = String(payload.chatId || 'direct');
  let chat = chats.get(chatId);
  if (!chat) {
    chat = { messages: [], busy: false, abort: null };
    chats.set(chatId, chat);
  }
  if (chat.busy) {
    emit({ kind: 'error', message: 'a turn is already in progress for this chat' });
    emit({ kind: 'done' });
    return;
  }
  chat.busy = true;
  chat.abort = new AbortController();
  const startedAt = Date.now();
  const turn = cfg.provider === 'openai' ? openaiTurn : anthropicTurn;
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    emit({ kind: 'status', state: 'thinking', label: 'Thinking' });
    chat.messages.push({ role: 'user', content: userContent(cfg.provider, payload) });
    for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
      const resp = await turn(cfg, chat.messages, chat.abort.signal);
      if (resp.usage) {
        usage.inputTokens += resp.usage.inputTokens || 0;
        usage.outputTokens += resp.usage.outputTokens || 0;
      }
      chat.messages.push(resp.assistantMessage);
      for (const t of resp.texts) emit({ kind: 'token', text: t });
      if (!resp.calls.length) {
        emitMeta(emit, cfg, startedAt, usage);
        emit({ kind: 'done' });
        return;
      }
      if (i === MAX_TOOL_ITERATIONS) {
        emitMeta(emit, cfg, startedAt, usage);
        emit({ kind: 'error', message: `tool loop hit the ${MAX_TOOL_ITERATIONS}-iteration cap` });
        emit({ kind: 'done' });
        return;
      }
      // Run the calls concurrently like the hub adapters do; results keep
      // their original order for the transcript.
      const results = await Promise.all(
        resp.calls.map(async (c) => {
          emit({ kind: 'tool_use', tool: c.tool, args: c.args, id: c.id, label: c.args && c.args.label });
          try {
            if (gate) await gate(c.tool, c.args);
            const r = await execTool(c.tool, c.args || {});
            emit({ kind: 'tool_result', tool: c.tool, ok: true, summary: summarize(r), id: c.id });
            return { c, ok: true, body: r };
          } catch (err) {
            console.warn('[agentbrowser] direct tool call failed:', c.tool, err);
            emit({ kind: 'tool_result', tool: c.tool, ok: false, summary: errText(err), id: c.id });
            return { c, ok: false, body: errText(err) };
          }
        })
      );
      emit({ kind: 'status', state: 'thinking', label: 'Thinking' });
      if (cfg.provider === 'openai') {
        for (const r of results) {
          chat.messages.push({
            role: 'tool',
            tool_call_id: r.c.id,
            content: r.ok ? clip(JSON.stringify(r.body), MAX_TEXT) : `error: ${clip(r.body, 1000)}`,
          });
        }
      } else {
        chat.messages.push(
          resp.toolMessage(
            results.map((r) => ({
              type: 'tool_result',
              tool_use_id: r.c.id,
              is_error: !r.ok,
              content: r.ok ? clip(JSON.stringify(r.body), MAX_TEXT) : `error: ${clip(r.body, 1000)}`,
            }))
          )
        );
      }
    }
  } catch (err) {
    if (chat.abort && chat.abort.signal.aborted) {
      emit({ kind: 'status', state: 'idle', label: 'aborted' });
      emit({ kind: 'done' });
      return;
    }
    emitMeta(emit, cfg, startedAt, usage);
    emit({ kind: 'error', message: errText(err) });
    emit({ kind: 'done' });
  } finally {
    chat.busy = false;
    chat.abort = null;
  }
}

function emitMeta(emit, cfg, startedAt, usage) {
  emit({
    kind: 'meta',
    model: cfg.model || null,
    adapter: `direct-${cfg.provider}`,
    elapsedMs: Date.now() - startedAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    sessionInputTokens: usage.inputTokens,
    sessionOutputTokens: usage.outputTokens,
  });
}

function summarize(r) {
  if (r == null) return 'ok';
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// Minimal capabilities so the panel's backend picker stays sensible in
// hubless mode — one entry named after the configured provider.
export function capabilitiesFor(cfg) {
  const model = cfg.model || (cfg.provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-5');
  return {
    type: 'capabilities',
    adapters: [
      {
        name: `direct-${cfg.provider}`,
        label: cfg.provider === 'openai' ? 'OpenAI 直连' : 'Anthropic 直连',
        models: [{ id: model, label: model }],
        defaultModel: model,
        ready: true,
      },
    ],
    commands: [],
    browsers: [],
  };
}
