// Video-subtitle coordinator (PROTOCOL v2.16): injects the subtitle engine,
// fetches caption tracks from the service worker — host permissions beat
// page-context CORS, so api.bilibili.com and YouTube timedtext both work
// here — and streams cue translations through the hub's translate_request
// channel under "sb-" prefixed request ids.

import * as cdp from './cdp.js';
import { parseSrv3, parseBilibili } from '../page/subtitle-core.js';

const BINDING = '__abSubtitleBus';
const CORE_URL = 'page/subtitle-core.js';
const ENGINE_URL = 'page/subtitle-engine.js';
const MAX_TRANSCRIPT_CUES = 400;

const sessions = new Map(); // tabId -> {cfg, running, startPromise}
const pendingReqs = new Map(); // reqId -> tabId
const boundTabs = new Set();
let sources = null;
let hubSend = null;

export function wireHub({ sendToHub }) {
  hubSend = sendToHub;
}

async function loadSources() {
  if (sources) return sources;
  const [core, engine] = await Promise.all([
    fetch(chrome.runtime.getURL(CORE_URL)).then((r) => r.text()),
    fetch(chrome.runtime.getURL(ENGINE_URL)).then((r) => r.text()),
  ]);
  // The core ships ES exports for node --test; the page evaluate is a classic
  // script, so they are stripped before concatenation.
  sources = core.replace(/^export\s+/gm, '') + '\n' + engine;
  return sources;
}

// Runtime.evaluate without the action overlay flash.
async function evalRaw(tabId, expression) {
  const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(
      (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed'
    );
  }
  return res.result ? res.result.value : undefined;
}

async function ensureEngine(tabId) {
  if (!boundTabs.has(tabId)) {
    await cdp.sendCommand(tabId, 'Runtime.enable').catch((err) => {
      console.warn('[agentbrowser] Runtime.enable for subtitle failed', err);
    });
    await cdp.sendCommand(tabId, 'Runtime.addBinding', { name: BINDING }).catch((err) => {
      console.warn('[agentbrowser] subtitle addBinding failed', err);
      throw new Error('subtitle binding failed: ' + ((err && err.message) || err));
    });
    boundTabs.add(tabId);
  }
  const probe = await evalRaw(tabId, '!!window.__abSubtitle');
  if (probe === true) return;
  const src = await loadSources();
  await evalRaw(tabId, src + '\n!!window.__abSubtitle');
}

function session(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { cfg: {}, running: false, startPromise: null };
    sessions.set(tabId, s);
  }
  return s;
}

// ------------------------------------------------------------- fetching
// probe() runs in the page: it reads player globals and returns fetch inputs
// only. Every network request happens here in the worker.

async function probe(tabId) {
  await ensureEngine(tabId);
  const p = await evalRaw(tabId, '__abSubtitle && __abSubtitle.probe()');
  if (!p || !p.site) throw new Error('no supported video on this page');
  return p;
}

function pickTrack(tracks, lang) {
  if (!tracks || !tracks.length) return null;
  if (lang) {
    const exact = tracks.find((t) => t.lang === lang);
    if (exact) return exact;
    const prefix = tracks.find((t) => t.lang && lang && t.lang.split('-')[0] === lang.split('-')[0]);
    if (prefix) return prefix;
  }
  return tracks.find((t) => !t.auto) || tracks[0];
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`subtitle fetch ${res.status} for ${url.slice(0, 120)}`);
  return res.json();
}

// {cues, track:{lang,name}} for the probed page.
async function loadCues(p, lang) {
  if (p.site === 'youtube') {
    const track = pickTrack(p.tracks, lang);
    if (!track) throw new Error('no caption tracks on this video');
    const res = await fetch(track.url);
    if (!res.ok) throw new Error(`timedtext fetch ${res.status}`);
    const cues = parseSrv3(await res.text());
    if (!cues.length) throw new Error('caption track was empty');
    return { cues, track: { lang: track.lang, name: track.name } };
  }
  if (p.site === 'bilibili') {
    if (!p.bvid) throw new Error('bilibili video id not found');
    let cid = p.cid;
    if (!cid) {
      const list = await fetchJson(
        `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(p.bvid)}`
      );
      cid = list && list.data && list.data[0] && list.data[0].cid;
    }
    if (!cid) throw new Error('bilibili cid not found');
    const player = await fetchJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(p.bvid)}&cid=${encodeURIComponent(cid)}`
    );
    const raw =
      (player && player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
    const track = pickTrack(
      raw.map((t) => ({
        lang: String(t.lan || ''),
        name: String(t.lan_doc || t.lan || ''),
        url: String(t.subtitle_url || ''),
        auto: !!t.ai_type,
      })),
      lang
    );
    if (!track || !track.url) throw new Error('no subtitle tracks on this video');
    const json = await fetchJson(track.url.startsWith('//') ? `https:${track.url}` : track.url);
    const cues = parseBilibili(json);
    if (!cues.length) throw new Error('subtitle track was empty');
    return { cues, track: { lang: track.lang, name: track.name } };
  }
  throw new Error(`unsupported site: ${p.site}`);
}

// ------------------------------------------------------------- tool entry

// tool_call: subtitle_translate — bilingual overlay over the video.
export async function start(tabId, cfg) {
  const s = session(tabId);
  s.cfg = { targetLang: 'zh', ...(s.cfg || {}), ...(cfg || {}) };
  if (s.startPromise) return s.startPromise;
  s.startPromise = (async () => {
    const p = await probe(tabId);
    const { cues, track } = await loadCues(p, s.cfg.trackLang);
    const r = await evalRaw(
      tabId,
      `__abSubtitle.start(${JSON.stringify({ cues, targetLang: s.cfg.targetLang })})`
    );
    if (r && r.error) throw new Error(r.error);
    s.running = true;
    return { site: p.site, track, cues: cues.length, ...(r || {}) };
  })();
  try {
    return await s.startPromise;
  } finally {
    s.startPromise = null;
  }
}

// tool_call: subtitle_stop.
export async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.running) return { stopped: false };
  s.running = false;
  try {
    await evalRaw(tabId, '__abSubtitle && __abSubtitle.stop()');
  } catch (err) {
    console.warn('[agentbrowser] subtitle stop eval failed', err);
  }
  sessions.delete(tabId);
  return { stopped: true };
}

// tool_call: subtitle_status.
export async function status(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.running) return { active: false };
  try {
    return await evalRaw(tabId, '__abSubtitle.status()');
  } catch (err) {
    console.warn('[agentbrowser] subtitle status eval failed', err);
    return { active: false };
  }
}

// tool_call: transcript_get — cues of the video's caption track, optional
// window around the playhead. No overlay is started.
export async function transcript(tabId, args) {
  const p = await probe(tabId);
  const { cues, track } = await loadCues(p, args && args.lang);
  let out = cues;
  let truncated = false;
  if (args && args.aroundSec != null) {
    const t = await evalRaw(
      tabId,
      `(function(){var v=document.querySelector('video');return v?v.currentTime:null})()`
    );
    if (typeof t === 'number') {
      const w = Number(args.aroundSec) || 60;
      out = cues.filter((c) => c.end >= t - w && c.start <= t + w);
    }
  }
  if (out.length > MAX_TRANSCRIPT_CUES) {
    out = out.slice(0, MAX_TRANSCRIPT_CUES);
    truncated = true;
  }
  return {
    site: p.site,
    videoId: p.videoId || p.bvid || null,
    track,
    total: cues.length,
    truncated,
    cues: out.map((c) => ({
      start: Math.round(c.start * 100) / 100,
      end: Math.round(c.end * 100) / 100,
      text: c.text,
    })),
  };
}

// ------------------------------------------------------------- bus wiring

// Runtime.bindingCalled → translate_request on the hub socket ("sb-" ids).
export function onBindingCalled(tabId, payload) {
  let msg;
  try {
    msg = JSON.parse(String(payload || ''));
  } catch (err) {
    console.warn('[agentbrowser] subtitle bus payload not JSON', err);
    return;
  }
  const s = sessions.get(tabId);
  if (msg.kind === 'sub-batch' && hubSend) {
    const reqId = `sb-${tabId}-${msg.req}`;
    pendingReqs.set(reqId, tabId);
    hubSend({
      type: 'translate_request',
      id: reqId,
      tabId,
      items: Array.isArray(msg.items) ? msg.items : [],
      targetLang: (s && s.cfg && s.cfg.targetLang) || 'zh',
    });
  } else if (msg.kind === 'error') {
    console.warn('[agentbrowser] subtitle engine error:', msg.error);
  }
}

// translate_result fan-in — sw asks us first; returns true when the id was
// one of ours ("sb-") so translate never sees it.
export function onResult(msg) {
  const tabId = pendingReqs.get(msg.id);
  if (tabId == null) return false;
  pendingReqs.delete(msg.id);
  const s = sessions.get(tabId);
  if (!s || !s.running) return true;
  if (msg.error) {
    console.warn('[agentbrowser] subtitle translate request failed:', msg.error);
    return true;
  }
  const req = Number(String(msg.id || '').split('-').pop()) || 0;
  evalRaw(
    tabId,
    `__abSubtitle && __abSubtitle.applyBatch(${req}, ${JSON.stringify(msg.results || {})})`
  ).catch((err) => {
    console.warn('[agentbrowser] subtitle apply failed', err);
  });
  return true;
}

// The engine dies on navigation; a running session re-arms itself.
export function onTabUpdated(tabId, info) {
  const s = sessions.get(tabId);
  if (!s || !s.running || !info || info.status !== 'complete') return;
  boundTabs.delete(tabId);
  start(tabId, s.cfg).catch((err) => {
    console.warn('[agentbrowser] subtitle re-arm after navigation failed', err);
    s.running = false;
  });
}

export function onTabRemoved(tabId) {
  sessions.delete(tabId);
  boundTabs.delete(tabId);
  for (const [id, t] of pendingReqs) if (t === tabId) pendingReqs.delete(id);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || source.tabId == null || !params) return;
  if (method !== 'Runtime.bindingCalled' || params.name !== BINDING) return;
  onBindingCalled(source.tabId, params.payload);
});

chrome.tabs.onUpdated.addListener((tabId, info) => onTabUpdated(tabId, info));
chrome.tabs.onRemoved.addListener((tabId) => onTabRemoved(tabId));
