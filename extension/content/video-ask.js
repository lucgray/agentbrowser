// Content script: a floating "@" button at the left edge of whatever <video>
// or <img> the pointer is over. Clicking it sends the media's context (url,
// title, playhead/pause state for video, src/alt for images, element rect) to
// the service worker, which opens the side panel and stages a selection chip
// plus an image attachment — a cropped screenshot for a paused video or
// unfetchable image, the fetched source otherwise.

const BTN_ID = "agentbrowser-video-ask-btn";
const HIDE_DELAY_MS = 600;
const FLOAT_THEME_KEY = "floatTheme";
const FLOAT_THEMES = new Set(["frost", "ink", "paper"]);

let btn = null;
let hoverEl = null;
let hoverKind = null;
let hideTimer = null;
let lastContext = null;
let floatTheme = "frost";
let foreignStop = null;

if (isContextValid()) {
  chrome.storage.local
    .get({ [FLOAT_THEME_KEY]: "frost" })
    .then((r) => {
      floatTheme = FLOAT_THEMES.has(r[FLOAT_THEME_KEY]) ? r[FLOAT_THEME_KEY] : "frost";
      if (btn) btn.dataset.abtheme = floatTheme;
    })
    .catch((err) => logWarn("floatTheme read failed", err));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(FLOAT_THEME_KEY in changes)) return;
    const v = changes[FLOAT_THEME_KEY].newValue;
    floatTheme = FLOAT_THEMES.has(v) ? v : "frost";
    if (btn) btn.dataset.abtheme = floatTheme;
  });
}

function isContextValid() {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.id !== "undefined"
  );
}

function logWarn(context, err) {
  console.warn("[agentbrowser] video-ask:", context, err);
}

function ensureButton() {
  if (btn) return btn;
  btn = document.createElement("div");
  btn.id = BTN_ID;
  btn.dataset.abtheme = floatTheme;
  btn.title = "引用到 AgentBrowser";

  const item = document.createElement("button");
  item.type = "button";
  item.className = "ab-item";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of [
    "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  const label = document.createElement("span");
  label.className = "ab-exp";
  label.textContent = "引用";
  item.append(svg, label);
  btn.appendChild(item);

  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", onAsk);
  // Keep the button alive while the pointer moves from the media onto it.
  btn.addEventListener("mouseenter", clearHideTimer);
  btn.addEventListener("mouseleave", scheduleHide);
  (document.body || document.documentElement).appendChild(btn);
  return btn;
}

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideButton() {
  clearHideTimer();
  if (foreignStop) {
    foreignStop();
    foreignStop = null;
  }
  if (btn) {
    btn.classList.remove("ab-show");
    btn.style.display = "none";
  }
  hoverEl = null;
  hoverKind = null;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(hideButton, HIDE_DELAY_MS);
}

function pickMedia(target) {
  let el = target && target.nodeType === 1 ? target : null;
  while (el) {
    if (el.isConnected && (el.tagName === "VIDEO" || el.tagName === "IMG")) {
      return { el, kind: el.tagName === "VIDEO" ? "video" : "image" };
    }
    el = el.parentElement;
  }
  return null;
}

// The button parks at the media's top-left inner edge. Fullscreen still works:
// the button lives in <body>, and a fullscreen video fills the viewport so
// fixed positioning at its rect remains correct. A foreign overlay already
// sitting there (another extension's floater) wins — we yield rather than
// stack.
function placeButton(el, kind) {
  const r = el.getBoundingClientRect();
  const minW = kind === "video" ? 120 : 80;
  const minH = 80;
  if (r.width < minW || r.height < minH) return false; // ignore thumbnails/icons
  const g = window.__abFloatGuard;
  if (g && g.foreignOverlayAt(r.left + 8, r.top + 8)) return false;
  const b = ensureButton();
  b.dataset.abtheme = floatTheme;
  b.style.position = "fixed";
  b.style.left = Math.max(4, r.left + 8) + "px";
  b.style.top = Math.max(4, r.top + 8) + "px";
  b.style.display = "flex";
  requestAnimationFrame(() => b.classList.add("ab-show"));
  if (g && !foreignStop) {
    foreignStop = g.watchForeign(
      { left: r.left + 8, top: r.top + 8, width: 40, height: 34 },
      hideButton
    );
  }
  return true;
}

document.addEventListener(
  "mouseover",
  (e) => {
    const hit = pickMedia(e.target);
    if (!hit) return;
    clearHideTimer();
    hoverEl = hit.el;
    hoverKind = hit.kind;
    if (!placeButton(hit.el, hit.kind)) hideButton();
  },
  true
);

document.addEventListener(
  "mouseout",
  (e) => {
    if (pickMedia(e.target)) scheduleHide();
  },
  true
);

// Scrolling / fullscreen transitions can move the media out from under the
// button; re-place on scroll, drop on fullscreen change.
addEventListener(
  "scroll",
  () => {
    if (hoverEl && (!hoverEl.isConnected || !placeButton(hoverEl, hoverKind))) hideButton();
  },
  true
);
document.addEventListener("fullscreenchange", hideButton);

function fmtSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

async function onAsk(e) {
  e.preventDefault();
  e.stopPropagation();

  if (!isContextValid() || !hoverEl) return;
  const v = hoverEl;
  const r = v.getBoundingClientRect();
  const ctx = {
    kind: hoverKind || "video",
    url: String(location.href),
    title: String(document.title || ""),
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
  if (ctx.kind === "video") {
    ctx.currentTime = Number(v.currentTime) || 0;
    ctx.duration = Number.isFinite(v.duration) ? Number(v.duration) : null;
    ctx.paused = !!v.paused;
  } else {
    ctx.src = String(v.currentSrc || v.src || "");
    ctx.alt = String(v.alt || "").slice(0, 300);
    ctx.naturalWidth = Number(v.naturalWidth) || 0;
    ctx.naturalHeight = Number(v.naturalHeight) || 0;
  }
  lastContext = ctx;

  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "video_ask",
      video: ctx,
    });
    if (response && response.success) {
      hideButton();
    } else {
      logWarn("video_ask rejected", response && response.error);
      hideButton();
    }
  } catch (err) {
    logWarn("video_ask send failed", err);
    hideButton();
  }
}

// Used by tests and by the sw when it wants the freshest rect again.
window.__abVideoAsk = { lastContext: () => lastContext, fmtSec };
