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
// small default model; "deepl" uses the DeepL API (free or pro key); "microsoft"
// and "free" hit keyless endpoints (Edge's translator auth flow / the Google
// gtx scrape endpoint). "auto" prefers openai, then anthropic, deepl,
// microsoft, then free.

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
const DEEPL_FREE_URL = 'https://api-free.deepl.com/v2/translate';
const DEEPL_PRO_URL = 'https://api.deepl.com/v2/translate';
const MS_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const MS_TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';
const MS_TOKEN_TTL_MS = 9 * 60 * 1000;

// Providers whose call returns a per-item array (no %% splitting involved).
const ARRAY_PROVIDERS = new Set(['free', 'deepl', 'microsoft']);

const SYSTEM_PROMPT = `You are a translation engine. Translate the user's text into the requested target language.

Rules:
- Output ONLY the translated text. No explanations, no notes, no quotation marks around the output.
- Preserve the original meaning, tone, and formatting (line breaks, markdown, code spans).
- Keep proper nouns, code, formulas, URLs and HTML tags untranslated.
- If the input contains a standalone line containing only ${BATCH_SEPARATOR}, it separates independent segments: translate each segment on its own and put a standalone ${BATCH_SEPARATOR} line between them, in the same order, with exactly one output segment per input segment.
- Placeholders like {{1}}, {{2}} mark protected inline content (code, math): keep every placeholder verbatim, in place, and untranslated.
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
        { role: 'system', content: opts.system || SYSTEM_PROMPT },
        { role: 'user', content: opts.user || buildUserPrompt(joinBatch(texts), opts.targetLang, opts.context) },
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
      system: opts.system || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: opts.user || buildUserPrompt(joinBatch(texts), opts.targetLang, opts.context) }],
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

// DeepL API — key required (free keys end in ':fx'). Batches natively: one
// `text` array entry per segment, translations come back in the same order.
function deeplTargetLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (l === 'zh' || l.startsWith('zh-')) return l.includes('tw') || l.includes('hk') ? 'ZH-HANT' : 'ZH-HANS';
  if (l === 'en') return 'EN-US';
  if (l === 'pt') return 'PT-BR';
  return l.toUpperCase();
}

async function callDeepL(texts, opts, fetchFn, keyOf) {
  const key = keyOf('deepl');
  if (!key) throw new Error('no deepl key configured (set one in Settings or use provider "free"/"auto")');
  const url = (opts.baseUrl || (/:fx$/.test(key) ? DEEPL_FREE_URL : DEEPL_PRO_URL)).replace(/\/+$/, '');
  const res = await fetchFn(`${url}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({ text: texts, target_lang: deeplTargetLang(opts.targetLang) }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`deepl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const out = (data && Array.isArray(data.translations) ? data.translations : [])
    .map((t) => t && t.text);
  if (out.length === texts.length && out.every((t) => typeof t === 'string')) return out;
  return null;
}

// Microsoft translator through the Edge auth flow — no key needed: fetch a
// short-lived Bearer token, then POST one {Text} per segment.
function createMicrosoftCaller() {
  let token = { value: null, exp: 0 };
  return async function callMicrosoft(texts, opts, fetchFn) {
    if (!token.value || Date.now() >= token.exp) {
      const auth = await fetchFn(MS_AUTH_URL, { signal: opts.signal });
      if (!auth.ok) throw new Error(`microsoft auth ${auth.status}`);
      token = { value: String(await auth.text()), exp: Date.now() + MS_TOKEN_TTL_MS };
    }
    const url = new URL(MS_TRANSLATE_URL);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', opts.targetLang);
    const res = await fetchFn(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.value}` },
      body: JSON.stringify(texts.map((t) => ({ Text: t }))),
      signal: opts.signal,
    });
    if (res.status === 401) token = { value: null, exp: 0 }; // stale token — next call re-auths
    if (!res.ok) throw new Error(`microsoft ${res.status}`);
    const data = await res.json();
    const out = (Array.isArray(data) ? data : []).map(
      (d) => d && Array.isArray(d.translations) && d.translations[0] && d.translations[0].text
    );
    if (out.length === texts.length && out.every((t) => typeof t === 'string')) return out;
    return null;
  };
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
    deepl: (texts, opts, f) => callDeepL(texts, opts, f, keyOf),
    microsoft: createMicrosoftCaller(),
    free: callFree,
  };
  const providerOf = (want) => {
    const w = String(want || 'auto');
    if (w === 'auto') {
      if (keyOf('openai')) return 'openai';
      if (keyOf('anthropic')) return 'anthropic';
      if (keyOf('deepl')) return 'deepl';
      return 'microsoft';
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
  const recent = []; // ring of {text, translation, targetLang, provider, ts}
  let active = 0;
  const waiters = [];

  // Token-bucket pacing on top of the concurrency cap: provider calls first
  // wait for a token, then for a slot. A 429 from the provider pauses all new
  // calls for an exponentially growing cooldown.
  const RATE_RPS = Math.max(0, Number(cfg.ratePerSec == null ? 8 : cfg.ratePerSec));
  const RATE_BURST = Math.max(1, Number(cfg.rateBurst == null ? 8 : cfg.rateBurst));
  let tokens = RATE_BURST;
  let lastRefill = Date.now();
  let cooldownUntil = 0;
  let consec429 = 0;

  async function acquireToken() {
    if (RATE_RPS <= 0 && cooldownUntil <= Date.now()) return;
    for (;;) {
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_RPS);
      lastRefill = now;
      const cooldown = cooldownUntil - now;
      if (cooldown <= 0 && (RATE_RPS <= 0 || tokens >= 1)) {
        if (RATE_RPS > 0) tokens -= 1;
        return;
      }
      const wait = cooldown > 0 ? cooldown : ((1 - tokens) / RATE_RPS) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(5, Math.min(wait, 60000))));
    }
  }

  function noteProviderError(err) {
    const msg = String((err && err.message) || err || '');
    if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
      consec429 += 1;
      cooldownUntil = Date.now() + Math.min(60000, 1000 * 2 ** consec429);
      console.warn(`[translate] provider rate-limited; pausing requests ${Math.round((cooldownUntil - Date.now()) / 1000)}s`);
    }
  }

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
      await acquireToken();
      const out = await withSlot(() =>
        call(texts, { ...opts, model: cfg.model, baseUrl: cfg.baseUrl, signal: ac.signal }, fetchFn)
      );
      consec429 = 0;
      return out;
    } catch (err) {
      noteProviderError(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Translate one provider batch (already grouped). Returns per-item texts in
  // order; on a malformed split retries once, then degrades to singles.
  async function translateBatch(items, opts, provider) {
    const texts = items.map((i) => i.text);
    let reply = await callProvider(texts, opts);
    let parts = ARRAY_PROVIDERS.has(provider)
      ? reply /* these calls return a per-item array */
      : splitBatchResponse(reply, items.length);
    if (!parts) {
      reply = await callProvider(texts, opts);
      parts = ARRAY_PROVIDERS.has(provider) ? reply : splitBatchResponse(reply, items.length);
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

    // Ring of recent pairs — the translate_recent tool reads this so the
    // agent can ground follow-ups in what the user just read.
    for (const it of items) {
      const text = results[it.tid];
      if (typeof text === 'string' && text) {
        recent.push({
          text: String(it.text).slice(0, 400),
          translation: text.slice(0, 400),
          targetLang,
          provider,
          ts: Date.now(),
        });
      }
    }
    while (recent.length > 200) recent.shift();

    return { results, provider, cached: cachedCount };
  }

  // summary_request (extension -> hub): a video transcript -> markdown
  // summary in the target language. Chat-only providers apply; deepl,
  // microsoft and free are pure translators and reject here.
  const SUMMARY_SYSTEM = `You are a video-summary engine. Given a video transcript, write a compact summary in the requested target language.

Rules:
- Output markdown only: a "TL;DR" section (2-3 sentences), then "## 要点" bullet points with timestamps where the cue positions allow, then "## 关键词" as a comma-separated tag list.
- Keep it under 400 words. No preamble, no sign-off.`;

  async function summarize(msg) {
    const provider = providerOf(cfg.provider);
    if (!['openai', 'anthropic'].includes(provider)) {
      throw new Error(`provider "${provider}" cannot summarize — set translate.provider to openai or anthropic`);
    }
    const transcript = String(msg.transcript || '').slice(0, 24000);
    if (!transcript.trim()) throw new Error('empty transcript');
    const targetLang = String(msg.targetLang || cfg.targetLang);
    const text = await callProvider(['x'], {
      targetLang,
      system: SUMMARY_SYSTEM,
      user: `Target language: ${targetLang}\n\nTranscript:\n${transcript}`,
    });
    return { summary: String(text || '').trim(), provider };
  }

  // analyze_request (extension -> hub): the selection popup's 词典/长难句.
  // mode "dict" -> compact dictionary entry as plain text; mode "parse" ->
  // JSON segments [{text, role, note}] the popup can annotate onto the page.
  const DICT_SYSTEM = `You are a bilingual dictionary engine. Given a word or short phrase, output a compact dictionary entry.

Rules:
- Output plain text, no markdown fences, no preamble.
- Line 1: the headword, its phonetic (IPA) in slashes if English, then the translation.
- Then one line per sense: "词性. 释义 — 例句" (gloss in the target language, example in the source language).
- At most 4 senses. No sign-off.`;

  const PARSE_SYSTEM = `You are a sentence-structure analyzer for language learners. Given a sentence, break it into its grammatical components.

Rules:
- Output ONLY a JSON array — no markdown fences, no preamble — of objects {"text","role","note"}.
- "text" is the exact substring of the input for that component (it MUST appear verbatim in the input).
- "role" is a short Chinese grammatical label like 主句/谓语/宾语从句/定语从句/状语从句/同位语/插入语/连接成分.
- "note" is one short Chinese sentence explaining the component's function.
- Cover the whole sentence; 3-10 segments, in source order.`;

  // parseSegments pulls the JSON array out of a model reply that may wrap it
  // in prose or code fences — exported for tests.
  function parseSegments(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/\[[\s\S]*\]/);
    if (!m) return null;
    let arr;
    try {
      arr = JSON.parse(m[0]);
    } catch (err) {
      console.warn('[translate] analyze parse JSON failed:', err.message);
      return null;
    }
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const text = String(it.text || '').trim();
      if (!text) continue;
      out.push({ text, role: String(it.role || ''), note: String(it.note || '') });
    }
    return out.length ? out : null;
  }

  async function analyze(msg) {
    const provider = providerOf(cfg.provider);
    if (!['openai', 'anthropic'].includes(provider)) {
      throw new Error(`provider "${provider}" cannot analyze — set translate.provider to openai or anthropic`);
    }
    const mode = msg && msg.mode;
    const text = String((msg && msg.text) || '').slice(0, 4000);
    if (!text.trim()) throw new Error('empty text');
    const targetLang = String((msg && msg.targetLang) || cfg.targetLang);
    const system = mode === 'dict' ? DICT_SYSTEM : mode === 'parse' ? PARSE_SYSTEM : null;
    if (!system) throw new Error(`unknown analyze mode "${mode}"`);

    const hash = hashKey(provider, cfg.model || '', targetLang, `an-${mode}`, text);
    const hit = mem.get(hash) !== undefined ? mem.get(hash) : file.get(hash);
    if (hit !== undefined) {
      return mode === 'dict'
        ? { text: hit, provider }
        : { segments: parseSegments(hit) || [], provider };
    }
    const out = await callProvider(['x'], {
      targetLang,
      system,
      user: `Target language: ${targetLang}\n\n${mode === 'dict' ? 'Word/phrase' : 'Sentence'}:\n${text}`,
    });
    const body = String(out || '').trim();
    if (body) {
      mem.set(hash, body);
      file.set(hash, body);
    }
    return mode === 'dict'
      ? { text: body, provider }
      : { segments: parseSegments(body) || [], provider };
  }

  return {
    handleRequest,
    summarize,
    analyze,
    parseSegments,
    provider: () => providerOf(cfg.provider),
    config: cfg,
    flushCache: () => file.flush(),
    recentList: (n) => recent.slice(-Math.min(200, Math.max(1, Number(n) || 20))),
    stats: () => ({
      provider: providerOf(cfg.provider),
      model: cfg.model || null,
      targetLang: cfg.targetLang,
      memCache: mem.map.size,
      fileCache: file.load().size,
      inflight: inflight.size,
      active,
      recent: recent.length,
      rateLimit: {
        perSec: RATE_RPS,
        burst: RATE_BURST,
        cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
      },
    }),
    clearCache: () => {
      mem.map.clear();
      file.load().clear();
      file.flush();
      return { cleared: true };
    },
  };
}

export default createTranslator;
