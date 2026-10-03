// Hub-side translation service (PROTOCOL v2.14): batching, caching and
// provider dispatch for the page translation engine.
//
// The extension pushes {type:'translate_request', items:[{tid,text}]}; this
// module resolves each item through a two-tier cache (in-memory LRU + a JSON
// file in ~/.agentchat) and groups the misses into provider batches of ≤4
// items / ≤1200 chars joined by a `%%` separator line — one LLM call carries
// several paragraphs. A reply that does not split back into the same number
// of segments is retried once, then the batch degrades to per-item requests.
//
// Providers: "openai" and "anthropic" reuse the user's stored BYO key with a
// small default model; "free" hits the Google translate scrape endpoint with
// no key at all. "auto" prefers openai, then anthropic, then free.

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getKey } from '../adapters/keystore.mjs';

export const BATCH_SEPARATOR = '%%';
const SEP_LINE_RE = /\r?\n[ \t]*%%[ \t]*\r?\n/;
const NO_TRANSLATION = '{{NO_TRANSLATION_NEEDED}}';

const MEM_CACHE_CAP = 1000;
const FILE_CACHE_CAP = 4000;
const MAX_ITEMS_PER_BATCH = 4;
const MAX_CHARS_PER_BATCH = 1200;
const PROVIDER_TIMEOUT_MS = 60000;
const CONCURRENCY = 3;

const DEFAULT_MODELS = { openai: 'gpt-5.6-mini', anthropic: 'claude-haiku-4-5' };
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_FREE_URL = 'https://translate.googleapis.com/translate_a/single';

const SYSTEM_PROMPT = `You are a translation engine. Translate the user's text into the requested target language.

Rules:
- Output ONLY the translated text. No explanations, no notes, no quotation marks around the output.
- Preserve the original meaning, tone, and formatting (line breaks, markdown, code spans).
- Keep proper nouns, code, formulas, URLs and HTML tags untranslated.
- If the input contains a standalone line containing only ${BATCH_SEPARATOR}, it separates independent segments: translate each segment on its own and put a standalone ${BATCH_SEPARATOR} line between them, in the same order, with exactly one output segment per input segment.
- If a segment needs no translation (already in the target language, a name, code, a URL), output ${NO_TRANSLATION} for that segment instead of a translation.
- If the whole input needs no translation, output exactly ${NO_TRANSLATION}.`;

export function hashKey(provider, model, targetLang, contextKey, text) {
  return createHash('sha256')
    .update([provider, model, targetLang, contextKey || '', text].join('\x01'))
    .digest('hex');
}

export function joinBatch(texts) {
  return texts.join('\n%%\n');
}

// Split a batch reply into per-item translations. null = unrecoverable split
// (wrong count or an empty segment) — caller retries, then falls back to
// per-item requests.
export function splitBatchResponse(text, count) {
  const t = String(text || '');
  if (count === 1) return t.trim() ? [t.trim()] : null;
  if (!SEP_LINE_RE.test(t)) return null;
  const parts = t.split(SEP_LINE_RE).map((s) => s.trim());
  if (parts.length !== count || parts.some((p) => p === '')) return null;
  return parts;
}

export function groupBatches(items, maxItems = MAX_ITEMS_PER_BATCH, maxChars = MAX_CHARS_PER_BATCH) {
  const out = [];
  let cur = [], chars = 0;
  for (const it of items) {
    const len = String(it.text || '').length;
    if (cur.length && (cur.length >= maxItems || chars + len > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

class LruCache {
  constructor(cap) {
    this.cap = cap;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (!v) return;
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
  }
}

// Persisted cache: a flat {hash: translation} JSON file. Writes are debounced
// and atomic (tmp + rename) so a crash mid-write never corrupts the file.
class FileCache {
  constructor(file) {
    this.file = file;
    this.map = null;
    this.timer = null;
  }
  load() {
    if (this.map !== null) return this.map;
    this.map = new Map();
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        for (const k of Object.keys(data)) this.map.set(k, data[k]);
      }
    } catch (err) {
      console.warn('[translate] cache load failed, starting empty:', err.message);
    }
    return this.map;
  }
  get(k) {
    return this.load().get(k);
  }
  set(k, v) {
    if (!v) return;
    const m = this.load();
    if (m.has(k)) m.delete(k);
    m.set(k, v);
    while (m.size > FILE_CACHE_CAP) m.delete(m.keys().next().value);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 1500);
      if (this.timer.unref) this.timer.unref();
    }
  }
  flush() {
    this.timer = null;
    if (this.map === null) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[translate] cache save failed:', err.message);
    }
  }
}

// ------------------------------------------------------------------ calls
async function callOpenAI(texts, opts, fetchFn, keyOf) {
  const key = keyOf('openai');
  if (!key) throw new Error('no openai key configured (set one in Settings or use provider "free"/"auto")');
  const res = await fetchFn(`${(opts.baseUrl || OPENAI_BASE_URL).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODELS.openai,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(joinBatch(texts), opts.targetLang, opts.context) },
      ],
      temperature: 0.3,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  return String(content || '');
}

async function callAnthropic(texts, opts, fetchFn, keyOf) {
  const key = keyOf('anthropic');
  if (!key) throw new Error('no anthropic key configured (set one in Settings or use provider "free"/"auto")');
  const res = await fetchFn(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODELS.anthropic,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(joinBatch(texts), opts.targetLang, opts.context) }],
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}

// Google translate scrape endpoint — no key needed. Multiple `q` params
// batch several segments per request; the response is one entry per q.
async function callFree(texts, opts, fetchFn) {
  const url = new URL(GOOGLE_FREE_URL);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', opts.targetLang);
  url.searchParams.set('dt', 't');
  for (const t of texts) url.searchParams.append('q', t);
  const res = await fetchFn(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`free translate ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const entry of Array.isArray(data) ? data[0] : []) {
    out.push(String(entry && entry[0] || ''));
  }
  // The endpoint returns one concatenated result per q param.
  if (out.length === texts.length) return out;
  if (texts.length === 1) return [out.join('')];
  return null; // wrong segment count — caller retries individually
}

function buildUserPrompt(text, targetLang, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const parts = [`Target language: ${targetLang}`];
  if (ctx.webTitle) parts.push(`Page title: ${ctx.webTitle}`);
  if (ctx.webDescription) parts.push(`Page description: ${ctx.webDescription}`);
  parts.push('Text to translate:', '', text);
  return parts.join('\n');
}

// createTranslator({config, fetchImpl, cacheDir, getKey}) — getKey(provider)
// resolves a stored API key (the hub injects its scrub-aware getApiKey so key
// values never reach the log; keystore.mjs is the default for tests).
export function createTranslator({ config, fetchImpl, cacheDir, getKey: getKeyOverride } = {}) {
  const keyOf = getKeyOverride || getKey;
  const calls = {
    openai: (texts, opts, f) => callOpenAI(texts, opts, f, keyOf),
    anthropic: (texts, opts, f) => callAnthropic(texts, opts, f, keyOf),
    free: callFree,
  };
  const providerOf = (want) => {
    const w = String(want || 'auto');
    if (w === 'auto') {
      if (keyOf('openai')) return 'openai';
      if (keyOf('anthropic')) return 'anthropic';
      return 'free';
    }
    return w;
  };
  const cfg = {
    provider: 'auto',
    model: null,
    baseUrl: null,
    targetLang: 'zh',
    context: true,
    ...(config && typeof config === 'object' ? config : {}),
  };
  const fetchFn = fetchImpl || fetch;
  const mem = new LruCache(MEM_CACHE_CAP);
  const file = new FileCache(
    cacheDir || path.join(os.homedir(), '.agentchat', 'translate-cache.json')
  );
  const inflight = new Map(); // hash -> Promise<text>
  let active = 0;
  const waiters = [];

  async function withSlot(fn) {
    while (active >= CONCURRENCY) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); } finally {
      active--;
      const w = waiters.shift();
      if (w) w();
    }
  }

  async function callProvider(texts, opts) {
    const provider = providerOf(cfg.provider);
    const call = calls[provider];
    if (!call) throw new Error(`unknown translate provider "${provider}"`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
    try {
      return await withSlot(() =>
        call(texts, { ...opts, model: cfg.model, baseUrl: cfg.baseUrl, signal: ac.signal }, fetchFn)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Translate one provider batch (already grouped). Returns per-item texts in
  // order; on a malformed split retries once, then degrades to singles.
  async function translateBatch(items, opts, provider) {
    const texts = items.map((i) => i.text);
    let reply = await callProvider(texts, opts);
    let parts = provider === 'free'
      ? reply /* callFree returns an array */
      : splitBatchResponse(reply, items.length);
    if (!parts) {
      reply = await callProvider(texts, opts);
      parts = provider === 'free' ? reply : splitBatchResponse(reply, items.length);
    }
    if (parts && parts.length === items.length) return parts;
    // Degrade: one request per item, all concurrent.
    return Promise.all(items.map(async (it) => {
      try {
        const r = await callProvider([it.text], opts);
        if (Array.isArray(r)) return r[0] || '';
        return String(r || '');
      } catch (err) {
        console.warn('[translate] single-item fallback failed:', err && err.message);
        return '';
      }
    }));
  }

  // One translate_request: {items:[{tid,text}], targetLang?, context?}.
  // Returns {results:{tid:text}, provider, cached}.
  async function handleRequest(msg) {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const targetLang = String(msg.targetLang || cfg.targetLang);
    const provider = providerOf(cfg.provider);
    const context = msg.context && cfg.context !== false ? msg.context : {};
    const contextKey = context.webTitle || '';
    const opts = { targetLang, context };

    const results = {};
    const misses = [];
    const dupes = []; // repeated text inside one request — resolves via textByHash
    const textByHash = new Map();
    let cachedCount = 0;
    const seen = new Set();

    for (const it of items) {
      const tid = it && it.tid;
      const text = String((it && it.text) || '').trim();
      if (tid == null || !text) continue;
      const hash = hashKey(provider, cfg.model || '', targetLang, contextKey, text);
      const hit = mem.get(hash) !== undefined ? mem.get(hash) : file.get(hash);
      if (hit !== undefined) {
        results[tid] = hit;
        textByHash.set(hash, hit);
        cachedCount++;
        continue;
      }
      if (seen.has(hash)) {
        dupes.push({ tid, hash });
        continue;
      }
      seen.add(hash);
      misses.push({ tid, text, hash });
    }

    // In-flight dedup: an identical paragraph already being translated (e.g.
    // re-sent after a remount) joins the existing provider call instead of
    // paying for a second one.
    const owned = [];
    const joiners = [];
    for (const m of misses) {
      const existing = inflight.get(m.hash);
      if (existing) joiners.push({ m, p: existing });
      else owned.push(m);
    }

    const groupPs = groupBatches(owned).map((group) => {
      const p = (async () => {
        const texts = await translateBatch(group, opts, provider);
        const out = new Map();
        for (let i = 0; i < group.length; i++) out.set(group[i].hash, texts[i] || '');
        return out;
      })();
      for (const m of group) {
        inflight.set(m.hash, p.then((r) => r.get(m.hash) || ''));
      }
      return p;
    });
    await Promise.allSettled(groupPs);

    for (const m of owned) {
      const p = inflight.get(m.hash);
      inflight.delete(m.hash);
      try {
        const text = await p;
        results[m.tid] = typeof text === 'string' ? text : '';
        textByHash.set(m.hash, results[m.tid]);
        if (results[m.tid]) {
          mem.set(m.hash, results[m.tid]);
          file.set(m.hash, results[m.tid]);
        }
      } catch (err) {
        console.warn('[translate] batch result failed:', err && err.message);
        results[m.tid] = '';
        textByHash.set(m.hash, '');
      }
    }
    for (const j of joiners) {
      try {
        const text = await j.p;
        results[j.m.tid] = typeof text === 'string' ? text : '';
        textByHash.set(j.m.hash, results[j.m.tid]);
      } catch (err) {
        console.warn('[translate] joined batch result failed:', err && err.message);
        results[j.m.tid] = '';
        textByHash.set(j.m.hash, '');
      }
    }
    for (const d of dupes) {
      results[d.tid] = textByHash.get(d.hash) || '';
    }

    return { results, provider, cached: cachedCount };
  }

  return {
    handleRequest,
    provider: () => providerOf(cfg.provider),
    config: cfg,
    flushCache: () => file.flush(),
  };
}

export default createTranslator;
