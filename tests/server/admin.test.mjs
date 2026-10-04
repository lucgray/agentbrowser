// Admin HTTP surface (v2.17): routing, JSON API actions, body limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAdminHandler } from '../../server/hub/admin.mjs';

// Minimal ctx: in-memory config, scripted actions recording calls.
function makeCtx() {
  const calls = [];
  return {
    calls,
    ctx: createAdminHandler({
      state: async () => ({ adapters: [], keys: {}, plugins: [], config: { adapter: 'x' } }),
      setPlugin: (id, enabled) => { calls.push(['plugin', id, enabled]); return { ok: true }; },
      setTranslate: async (cfg) => { calls.push(['translate', cfg]); return { ok: true, config: cfg, provider: 'free' }; },
      setKey: async (p, k) => { calls.push(['key', p, k != null]); return { ok: true }; },
      setGeneral: (cfg) => { calls.push(['general', cfg]); return { ok: true }; },
      getConfig: () => ({ adapter: 'x' }),
    }),
  };
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function req(srv, method, path, body) {
  const port = srv.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, json, text };
}

test('GET /admin serves the management page; unknown paths 404', async () => {
  const srv = await serve(makeCtx().ctx);
  try {
    const page = await req(srv, 'GET', '/admin');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('AgentBrowser admin'));
    const miss = await req(srv, 'GET', '/admin/api/nope');
    assert.equal(miss.status, 404);
  } finally {
    srv.close();
  }
});

test('GET /admin/api/state calls ctx.state and returns it', async () => {
  const srv = await serve(makeCtx().ctx);
  try {
    const r = await req(srv, 'GET', '/admin/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.config.adapter, 'x');
  } finally {
    srv.close();
  }
});

test('POST /admin/api/plugin and /translate route to the right actions', async () => {
  const { ctx, calls } = makeCtx();
  const srv = await serve(ctx);
  try {
    const p = await req(srv, 'POST', '/admin/api/plugin', { id: 'translate', enabled: false });
    assert.equal(p.json.ok, true);
    assert.deepEqual(calls[0], ['plugin', 'translate', false]);
    const t = await req(srv, 'POST', '/admin/api/translate', { provider: 'openai', targetLang: 'zh' });
    assert.equal(t.json.provider, 'free');
    assert.deepEqual(calls[1][1].provider, 'openai');
  } finally {
    srv.close();
  }
});

test('POST /admin/api/key and /config reach keystore/general paths', async () => {
  const { ctx, calls } = makeCtx();
  const srv = await serve(ctx);
  try {
    await req(srv, 'POST', '/admin/api/key', { provider: 'openai', key: 'sk-x' });
    assert.deepEqual(calls[0], ['key', 'openai', true]);
    await req(srv, 'POST', '/admin/api/key', { provider: 'openai', key: null });
    assert.deepEqual(calls[1], ['key', 'openai', false]);
    const g = await req(srv, 'POST', '/admin/api/config', { adapter: 'y' });
    assert.equal(g.json.ok, true);
    assert.deepEqual(calls[2], ['general', { adapter: 'y' }]);
  } finally {
    srv.close();
  }
});

test('malformed JSON body gets a 400, not a crash', async () => {
  const srv = await serve(makeCtx().ctx);
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/plugin`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad',
    });
    assert.equal(r.status, 400);
  } finally {
    srv.close();
  }
});
