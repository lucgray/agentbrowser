// Pure helpers for the video-subtitle pipeline (PROTOCOL v2.16): site
// detection, caption-format parsers and cue lookup. DOM-free so node --test
// covers everything; the page engine and the service-worker coordinator both
// consume it (the engine gets it injected with `export ` stripped).

// Which video site a URL belongs to, or null — drives probing and fetching.
export function detectSite(url) {
  const u = String(url || '');
  if (/youtube\.com\/watch/.test(u) || /youtu\.be\//.test(u)) return 'youtube';
  if (/bilibili\.com\/video\//.test(u) || /b23\.tv\//.test(u)) return 'bilibili';
  return null;
}

// Minimal entity decoding for caption bodies.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');

const TEXT_RE = /<text\b[^>]*\bstart="([\d.]+)"[^>]*\bdur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>|<text\b[^>]*\bdur="([\d.]+)"[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;

// YouTube timedtext srv3: <timedtext><body><p .../><text start d dur>...</text>
// — the watch-page captionTracks baseUrl + "&fmt=srv3" response. Returns
// [{start,end,text}] sorted by start; karaoke <s> children are flattened.
export function parseSrv3(xml) {
  const cues = [];
  const s = String(xml || '');
  let m;
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(s))) {
    const start = Number(m[1] !== undefined ? m[1] : m[5]);
    const dur = Number(m[2] !== undefined ? m[2] : m[4]);
    const body = m[3] !== undefined ? m[3] : m[6];
    const text = decodeEntities(stripTags(body)).replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(dur)) continue;
    cues.push({ start, end: start + dur, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// Bilibili subtitle file: {font_size, font_color, body:[{from,to,content,
// location}]} fetched from the track's subtitle_url.
export function parseBilibili(json) {
  const cues = [];
  const body = (json && Array.isArray(json.body) ? json.body : []);
  for (const c of body) {
    const start = Number(c && c.from);
    const end = Number(c && c.to);
    const text = String((c && c.content) || '').replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// Index of the cue active at time t (start <= t < end), or -1. Binary search
// over cues sorted by start.
export function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  while (best >= 0 && best < cues.length && t >= cues[best].end) best += 1;
  if (best >= 0 && best < cues.length && cues[best].start <= t && t < cues[best].end) return best;
  return -1;
}

// Send order for translation: the cue at/after `fromIdx` first (playback has
// arrived — it is what the viewer sees now), then forward, then the skipped
// prefix so a seek backwards still lands.
export function sendOrder(length, fromIdx) {
  const out = [];
  for (let i = Math.max(0, fromIdx); i < length; i++) out.push(i);
  for (let i = 0; i < Math.max(0, fromIdx); i++) out.push(i);
  return out;
}

// ---- sidebar helpers (v2.18): pure so node --test covers them ----

// "MM:SS" below an hour, "H:MM:SS" above — matches player timestamp style.
export function fmtTs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

// SRT timestamp "HH:MM:SS,mmm" for the transcript export.
function srtTs(sec) {
  const ms = Math.round(Math.max(0, Number(sec) || 0) * 1000);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:` +
    `${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

// Bilingual .srt text: source line then translated line under one sequence.
export function buildSrt(cues) {
  const out = [];
  let n = 0;
  for (const c of cues || []) {
    if (!c || !c.text) continue;
    n += 1;
    out.push(String(n));
    out.push(`${srtTs(c.start)} --> ${srtTs(c.end)}`);
    out.push(String(c.text));
    if (c.translated) out.push(String(c.translated));
    out.push('');
  }
  return out.join('\n');
}

// Transcript text for the summary request, bounded to `budget` chars. When
// the track is longer, even windows of contiguous lines are sampled so the
// model still sees beginning, middle and end rather than a hard truncation.
export function sampleTranscript(cues, budget = 20000) {
  const lines = (cues || []).map((c) => String(c && c.text || '').trim()).filter(Boolean);
  const joined = lines.join('\n');
  if (joined.length <= budget) return joined;
  const WINDOWS = 8;
  const winSize = Math.ceil(lines.length / WINDOWS);
  const perWin = Math.floor((budget - (WINDOWS - 1) * 2) / WINDOWS);
  const runs = [];
  for (let i = 0; i < lines.length; i += winSize) {
    let run = '';
    for (const line of lines.slice(i, i + winSize)) {
      const next = run ? `${run}\n${line}` : line;
      if (next.length > perWin) break;
      run = next;
    }
    if (run) runs.push(run);
  }
  return runs.join('\n\n');
}
