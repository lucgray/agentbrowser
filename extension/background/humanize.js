// Humanized input pacing — log-normal action delays and curved pointer
// paths, ported from xiaohongshu-mcp's humanize/ package (provider.go,
// mouse.go, input.go) so dispatched input stops reading as a metronome.
// On by default: chrome.storage.local.humanize === false is the only global
// off switch; a tool arg humanize:false bypasses per call.
// Pure math and per-tab pointer state live here — no CDP calls — so the
// file stays node-testable.

const TIMING = {
  afterClick:    { mu: -0.92, sigma: 0.35, min: 150,  max: 2000 },
  afterType:     { mu: -0.51, sigma: 0.40, min: 200,  max: 3000 },
  afterNavigate: { mu:  0.41, sigma: 0.45, min: 600,  max: 6000 },
  betweenScroll: { mu: -0.22, sigma: 0.40, min: 250,  max: 3000 },
  beforeSubmit:  { mu:  0.00, sigma: 0.40, min: 400,  max: 4000 },
  beforeClick:   { mu: -1.61, sigma: 0.45, min: 80,   max: 1000 },
  reading:       { mu: -0.36, sigma: 0.40, min: 300,  max: 3000 },
  keystroke:     { mu: -2.12, sigma: 0.50, min: 30,   max: 400 },
  clickHold:     { mu: -2.47, sigma: 0.33, min: 45,   max: 250 },
  afterInteract: { mu:  0.88, sigma: 0.30, min: 2000, max: 3000 },
  pointerSettle: { mu: -1.20, sigma: 0.35, min: 200,  max: 1200 },
};

// Standard normal via Box-Muller — rand.NormFloat64() in the Go original.
function normSample() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// One draw from an action's log-normal delay, clamped to [min, max] ms.
export function sampleMs(action) {
  const d = TIMING[action] || TIMING.afterClick;
  const ms = Math.exp(d.mu + d.sigma * normSample()) * 1000;
  return Math.min(Math.max(ms, d.min), d.max);
}

// Per-move step delay — constant within one curve, 5-9ms like the original.
export function stepDelayMs() {
  return 5 + Math.floor(Math.random() * 5);
}

// --- enabled flag ------------------------------------------------------------
// Same read-once + onChanged pattern as cdp.js's overlayEnabled: unset key
// means ON, only an explicit false disables.

let enabledCache = null;
let enabledPref = null;

export function enabled() {
  if (enabledCache !== null) return Promise.resolve(enabledCache);
  if (!enabledPref) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      enabledPref = Promise.resolve(true);
      return enabledPref;
    }
    enabledPref = chrome.storage.local
      .get('humanize')
      .then((stored) => {
        if (enabledCache === null) {
          enabledCache = !(stored && stored.humanize === false);
        }
        return enabledCache;
      })
      .catch((err) => {
        console.warn('[agentbrowser] humanize preference read failed', err);
        return true;
      });
  }
  return enabledPref;
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.humanize) return;
    enabledCache = changes.humanize.newValue !== false;
  });
}

// Sleep one sampled delay; resolves with 0 immediately when disabled.
export async function pause(action) {
  if (!(await enabled())) return 0;
  const ms = sampleMs(action);
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

// --- click-point jitter ------------------------------------------------------
// jitterOffset: ±15% of the element dimension, capped at 8px — the aim
// scatter humans produce instead of dead-center hits.

export function jitterOffset(size) {
  const limit = Math.min(Math.abs(size) * 0.15, 8);
  return (Math.random() - 0.5) * 2 * limit;
}

export function jitterPoint(pt, w, h) {
  return { x: pt.x + jitterOffset(w), y: pt.y + jitterOffset(h) };
}

// --- curved pointer paths ----------------------------------------------------

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

// Two control points pushed perpendicular to the straight line — off is
// 5-15% of the distance, randomly either side, halved on the second point.
function curveControlPoints(a, b, dist) {
  const nx = -(b.y - a.y) / dist;
  const ny = (b.x - a.x) / dist;
  let off = dist * (0.05 + Math.random() * 0.10);
  if (Math.random() < 0.5) off = -off;
  return [
    { x: a.x + (b.x - a.x) / 3 + nx * off, y: a.y + (b.y - a.y) / 3 + ny * off },
    { x: a.x + ((b.x - a.x) * 2) / 3 + nx * off * 0.5, y: a.y + ((b.y - a.y) * 2) / 3 + ny * off * 0.5 },
  ];
}

// Points to walk from `start` to `target` along an ease-in-out cubic Bézier
// — the moveMouseCurvedWithin port. dist<6 teleports straight to target.
// opts.steps overrides the distance-derived count (round(dist/10), clamped
// [10,40]); opts.bounds {left,top,right,bottom} clamps every point.
export function curvePath(start, target, opts = {}) {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 6) return [{ x: target.x, y: target.y }];
  let steps = opts.steps != null
    ? Math.max(1, Math.trunc(Number(opts.steps)) || 1)
    : Math.min(Math.max(Math.round(dist / 10), 10), 40);
  const [c1, c2] = curveControlPoints(start, target, dist);
  const b = opts.bounds;
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    let p = i >= steps
      ? { x: target.x, y: target.y }
      : cubicBezier(start, c1, c2, target, easeInOut(i / steps));
    if (b) {
      p = {
        x: Math.min(Math.max(p.x, b.left), b.right),
        y: Math.min(Math.max(p.y, b.top), b.bottom),
      };
    }
    pts.push(p);
  }
  return pts;
}

// --- pointer tracking ----------------------------------------------------------
// Where we last put the pointer, per tab — the user's own moves don't reach
// the SW, so this is only OUR trail. A first move starts from elsewhere.

const pointer = new Map();

export function notePointer(tabId, x, y) {
  if (Number.isFinite(x) && Number.isFinite(y)) pointer.set(tabId, { x, y });
}

export function lastPointer(tabId) {
  return pointer.get(tabId) || null;
}

export function forgetPointer(tabId) {
  pointer.delete(tabId);
}

// --- typing chunks -------------------------------------------------------------
// Go's Type inserts per rune with a keystroke delay between. For short text
// we do the same per code point; past ~120 chars a human types in word
// bursts, not metronomic keystrokes — and an agent dumping an essay would
// otherwise sit for minutes — so longer text goes in random 20-60 char
// bursts with the same keystroke pause between.

export function typeChunks(text) {
  const chars = [...String(text)];
  if (chars.length <= 120) return chars;
  const chunks = [];
  for (let i = 0; i < chars.length; ) {
    const n = 20 + Math.floor(Math.random() * 41);
    chunks.push(chars.slice(i, i + n).join(''));
    i += n;
  }
  return chunks;
}
