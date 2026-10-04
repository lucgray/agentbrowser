// Hub translation service (PROTOCOL v2.14): batching, dedup, cache, provider
// dispatch — all exercised through createTranslator with a scripted fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  BATCH_SEPARATOR,
  hashKey,
  joinBatch,
  splitBatchResponse,
  groupBatches,
  createTranslator,
} from '../../server/hub/translate.mjs';

const tmpDirs = [];
function tmpCache() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-tr-'));
  tmpDirs.push(dir);
  return path.join(dir, 'cache.json');
}
process.on('exit', () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// A fetch stub answering the openai chat-completions shape: it pulls the
// joined paragraph block out of the user message and echoes one "T:<seg>"
// line per %% segment, recording every request it serves.
function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const content = JSON.parse(init.body).messages.find((m) => m.role === 'user').content;
    const text = content.split('Text to translate:\n\n').pop();
    const reply = text.split('\n%%\n').map((p) => 'T:' + p.trim()).join('\n%%\n');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
      text: async () => reply,
    };
  };
}

const openaiKey = (p) => (p === 'openai' ? 'sk-test' : null);

test('joinBatch + splitBatchResponse round-trip; count mismatch returns null', () => {
  const joined = joinBatch(['first para', 'second para', 'third']);
  assert.equal((joined.match(/%%/g) || []).length, 2);
  assert.deepEqual(splitBatchResponse('一\n%%\n二\n%%\n三', 3), ['一', '二', '三']);
  assert.equal(splitBatchResponse('只有一段', 3), null);
  assert.deepEqual(splitBatchResponse('solo', 1), ['solo']);
});

test('groupBatches splits on item count and char budget', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ tid: i, text: 'x'.repeat(100) }));
  const groups = groupBatches(items, 4, 1000);
  assert.equal(groups.length, 3); // 4 + 4 + 1
  assert.equal(groups[0].length, 4);
  const tiny = groupBatches(items.slice(0, 2), 4, 150);
  assert.equal(tiny.length, 2); // char budget forces one per group
});

test('hashKey is sensitive to provider, lang, context and text', () => {
  const a = hashKey('openai', 'm', 'zh', 'ctx', 'hello');
  assert.equal(a, hashKey('openai', 'm', 'zh', 'ctx', 'hello'));
  for (const diff of [
    hashKey('anthropic', 'm', 'zh', 'ctx', 'hello'),
    hashKey('openai', 'm', 'en', 'ctx', 'hello'),
    hashKey('openai', 'm', 'zh', 'ctx2', 'hello'),
    hashKey('openai', 'm', 'zh', 'ctx', 'world'),
  ]) {
    assert.notEqual(a, diff);
  }
});

test('handleRequest batches items into one provider call and maps tids back', async () => {
  const calls = [];
  const tr = createTranslator({
    config: { provider: 'openai', targetLang: 'zh' },
    fetchImpl: fakeFetch(calls),
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const r = await tr.handleRequest({
    items: [
      { tid: 1, text: 'Hello one' },
      { tid: 2, text: 'Hello two' },
      { tid: 3, text: 'Hello three' },
    ],
    context: { webTitle: 'Demo' },
  });
  assert.equal(r.provider, 'openai');
  assert.equal(Object.keys(r.results).length, 3);
  assert.ok(r.results[1].startsWith('T:'));
  assert.equal(calls.length, 1); // 4-items-per-batch: one call for all three
  const joined = calls[0].body.messages.find((m) => m.role === 'user').content;
  assert.ok(joined.includes('%%'));
  assert.ok(joined.includes('Demo')); // page context rides the batch prompt
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
});

test('cache: mem tier then file tier serve repeats without a fetch', async () => {
  const calls = [];
  const cacheDir = tmpCache();
  const mk = () => createTranslator({
    config: { provider: 'openai' },
    fetchImpl: fakeFetch(calls),
    cacheDir,
    getKey: openaiKey,
  });
  const first = mk();
  await first.handleRequest({ items: [{ tid: 1, text: 'Cache me' }] });
  assert.equal(calls.length, 1);
  // Same instance — the in-memory LRU answers.
  const again = await first.handleRequest({ items: [{ tid: 7, text: 'Cache me' }] });
  assert.equal(calls.length, 1);
  assert.ok(again.results[7]);
  // A fresh translator over the same file hits without a fetch — the file
  // write is debounced, so flush it deterministically first.
  first.flushCache();
  const third = mk();
  const r3 = await third.handleRequest({ items: [{ tid: 9, text: 'Cache me' }] });
  assert.equal(calls.length, 1);
  assert.ok(r3.results[9]);
  assert.equal(r3.cached, 1);
});

test('in-flight dedup: concurrent identical paragraphs share one provider call', async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFetch = async (url, init) => {
    calls.push(1);
    await gate;
    return fakeFetch([])(url, init);
  };
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl: slowFetch,
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const p1 = tr.handleRequest({ items: [{ tid: 1, text: 'same' }] });
  const p2 = tr.handleRequest({ items: [{ tid: 2, text: 'same' }] });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
  assert.equal(r1.results[1], r2.results[2]);
});

test('count mismatch degrades to per-item calls', async () => {
  // The batch call and its single retry both come back with one segment for
  // two items — unrecoverable — so the pipeline falls back to one call per
  // paragraph. Calls 3 and 4 carry the per-item replies.
  let i = 0;
  const fetchImpl = async () => {
    i++;
    // The content must be decided now — json() runs after later calls have
    // already incremented i, so a lazy `i` read would mislabel the reply.
    const content = i > 2 ? 'T' + i : 'only-one-segment';
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => '',
    };
  };
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl,
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'a' }, { tid: 2, text: 'b' }] });
  assert.equal(i, 4); // batch + batch-retry + 2 singles
  assert.equal(r.results[1], 'T3');
  assert.equal(r.results[2], 'T4');
});

test('sentinel results are cached and surfaced verbatim for the engine to skip', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{{NO_TRANSLATION_NEEDED}}' } }] }),
      text: async () => '',
    };
  };
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl,
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'already zh' }] });
  assert.equal(r.results[1], '{{NO_TRANSLATION_NEEDED}}');
  const r2 = await tr.handleRequest({ items: [{ tid: 2, text: 'already zh' }] });
  assert.equal(r2.results[2], '{{NO_TRANSLATION_NEEDED}}');
  assert.equal(calls.length, 1);
});

test('free provider uses the keyless google endpoint with per-item q params', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => [[['你好', 'hello'], ['世界', 'world']], null, 'en', null, null, null, 1, null, [['en'], [4]]],
      text: async () => '',
    };
  };
  const tr = createTranslator({
    config: { provider: 'free', targetLang: 'zh' },
    fetchImpl,
    cacheDir: tmpCache(),
    getKey: () => null,
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'hello' }, { tid: 2, text: 'world' }] });
  assert.equal(r.provider, 'free');
  assert.equal(r.results[1], '你好');
  assert.equal(r.results[2], '世界');
  assert.ok(calls[0].includes('client=gtx'));
  assert.ok(calls[0].includes('q=hello'));
});

test('auto provider prefers openai, then anthropic, deepl, then microsoft', async () => {
  const t1 = createTranslator({ config: {}, getKey: (p) => (p === 'openai' ? 'k' : null), cacheDir: tmpCache() });
  assert.equal(await t1.provider(), 'openai');
  const t2 = createTranslator({ config: {}, getKey: (p) => (p === 'anthropic' ? 'k' : null), cacheDir: tmpCache() });
  assert.equal(await t2.provider(), 'anthropic');
  const t3 = createTranslator({ config: {}, getKey: (p) => (p === 'deepl' ? 'k:fx' : null), cacheDir: tmpCache() });
  assert.equal(await t3.provider(), 'deepl');
  const t4 = createTranslator({ config: {}, getKey: () => null, cacheDir: tmpCache() });
  assert.equal(await t4.provider(), 'microsoft');
});

test('provider failure yields empty results, not a thrown handleRequest', async () => {
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'server error' }),
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'a' }, { tid: 2, text: 'b' }] });
  assert.equal(r.results[1], '');
  assert.equal(r.results[2], '');
});

test('deepl provider posts the text array with the auth header (free key → api-free host)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      json: async () => ({ translations: [{ text: '你好' }, { text: '世界' }] }),
      text: async () => '',
    };
  };
  const tr = createTranslator({
    config: { provider: 'deepl', targetLang: 'zh' },
    fetchImpl,
    cacheDir: tmpCache(),
    getKey: (p) => (p === 'deepl' ? 'abc:fx' : null),
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'hello' }, { tid: 2, text: 'world' }] });
  assert.deepEqual([r.results[1], r.results[2]], ['你好', '世界']);
  assert.ok(calls[0].url.startsWith('https://api-free.deepl.com/'));
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.text, ['hello', 'world']);
  assert.equal(body.target_lang, 'ZH-HANS');
  assert.equal(calls[0].init.headers.authorization, 'DeepL-Auth-Key abc:fx');
});

test('microsoft provider auths once via the edge flow and caches the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/translate/auth')) return { ok: true, text: async () => 'jwt-token' };
    return {
      ok: true,
      json: async () => JSON.parse(init.body).map(() => ({ translations: [{ text: '翻' }] })),
      text: async () => '',
    };
  };
  const tr = createTranslator({
    config: { provider: 'microsoft', targetLang: 'zh' },
    fetchImpl,
    cacheDir: tmpCache(),
    getKey: () => null,
  });
  const r = await tr.handleRequest({ items: [{ tid: 1, text: 'a' }, { tid: 2, text: 'b' }] });
  assert.deepEqual([r.results[1], r.results[2]], ['翻', '翻']);
  assert.equal(calls.filter((u) => u.includes('/translate/auth')).length, 1);
  assert.ok(calls.some((u) => u.includes('api-edge.cognitive.microsofttranslator.com')));
  await tr.handleRequest({ items: [{ tid: 3, text: 'c' }] });
  assert.equal(calls.filter((u) => u.includes('/translate/auth')).length, 1); // token reused
});

test('recent ring, stats and cache clear back the admin tools', async () => {
  const calls = [];
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl: fakeFetch(calls),
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  await tr.handleRequest({ items: [{ tid: 1, text: 'recent me' }] });
  const rec = tr.recentList(10);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].text, 'recent me');
  assert.ok(rec[0].translation.startsWith('T:'));
  assert.equal(rec[0].provider, 'openai');
  const s = tr.stats();
  assert.equal(s.provider, 'openai');
  assert.equal(s.recent, 1);
  assert.ok(s.memCache >= 1);
  tr.clearCache();
  assert.equal(tr.stats().memCache, 0);
  await tr.handleRequest({ items: [{ tid: 2, text: 'recent me' }] });
  assert.equal(calls.length, 2); // cleared cache forced a refetch
});

test('a 429 marks a cooldown window; stats exposes it (v2.15 rate limiting)', async () => {
  const tr = createTranslator({
    config: { provider: 'openai' },
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const p = tr.handleRequest({ items: [{ tid: 1, text: 'a' }] });
  await new Promise((r) => setTimeout(r, 50)); // let the first call fail
  assert.ok(tr.stats().rateLimit.cooldownUntil > Date.now());
  const r = await p; // retry + single degrade ride out the cooldown
  assert.equal(r.results[1], '');
});

test('token bucket paces provider calls at ratePerSec', async () => {
  const calls = [];
  const tr = createTranslator({
    config: { provider: 'openai', ratePerSec: 50, rateBurst: 1 },
    fetchImpl: fakeFetch(calls),
    cacheDir: tmpCache(),
    getKey: openaiKey,
  });
  const t0 = Date.now();
  // 9 misses -> 3 provider batches (4+4+1); burst 1 means calls 2 and 3 wait
  // ~20ms each (rps 50). Concurrency would otherwise fire them together.
  const items = Array.from({ length: 9 }, (_, i) => ({ tid: i + 1, text: 'paced-' + i }));
  await tr.handleRequest({ items });
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - t0 >= 30);
});
