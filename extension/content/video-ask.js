// Content script: our icon on media — injected into the player's own control
// bar on sites we recognize (YouTube, bilibili), else a floating "@" chip at
// the media's top-left. Clicking it opens a small menu: 引用到面板 (sends the
// media context to the side panel — title/url, playhead + pause state for
// video, src/alt for images — staged as a chip plus an image attachment) and
// 下载视频 (asks the hub to run yt-dlp on the page URL).

// All content scripts share one isolated world — wrap in an IIFE so
// top-level identifiers can't collide with selection.js / annotation.js.
(function () {

const BTN_ID = "agentbrowser-video-ask-btn";
const MENU_ID = "agentbrowser-media-menu";
const TOAST_ID = "agentbrowser-media-toast";
const HIDE_DELAY_MS = 600;
const FLOAT_THEME_KEY = "floatTheme";
const FLOAT_THEMES = new Set(["frost", "ink", "paper"]);

// Player control bars we inject our icon into. Each entry probes ancestors
// of the hovered <video> for the selector — the first ancestor that contains
// it wins, so nested player containers work.
const CONTROL_BARS = [
  {
    match: /(^|\.)youtube\.com$/,
    bar: ".ytp-right-controls",
    anchor: ".ytp-fullscreen-button",
  },
  {
    match: /(^|\.)youtube-nocookie\.com$/,
    bar: ".ytp-right-controls",
    anchor: ".ytp-fullscreen-button",
  },
  {
    match: /(^|\.)bilibili\.com$/,
    bar: ".bpx-player-control-bottom-right, .bilibili-player-video-control",
    anchor: ".bpx-player-ctrl-full",
  },
];

let btn = null;
let menu = null;
let toast = null;
let toastTimer = null;
let hoverEl = null;
let hoverKind = null;
let hoverMode = null; // "float" chip owns hoverEl vs "control" bar icon
let hideTimer = null;
let lastContext = null;
let dlPending = false;
let dlDone = null;
let lastPos = null; // last chip position — sub-pixel rewrites are jitter
let floatTheme = "frost";
if (isContextValid()) {
  chrome.storage.local
    .get({ [FLOAT_THEME_KEY]: "frost" })
    .then((r) => {
      floatTheme = FLOAT_THEMES.has(r[FLOAT_THEME_KEY]) ? r[FLOAT_THEME_KEY] : "frost";
      for (const el of [btn, menu, toast]) if (el) el.dataset.abtheme = floatTheme;
    })
    .catch((err) => logWarn("floatTheme read failed", err));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(FLOAT_THEME_KEY in changes)) return;
    const v = changes[FLOAT_THEME_KEY].newValue;
    floatTheme = FLOAT_THEMES.has(v) ? v : "frost";
    for (const el of [btn, menu, toast]) if (el) el.dataset.abtheme = floatTheme;
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

const NS = "http://www.w3.org/2000/svg";
function iconSvg(paths, size) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}
const AT_PATHS = [
  "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94",
];
const DOWN_PATHS = ["M12 3v13", "M5 11l7 7 7-7", "M4 21h16"];

// ---------------------------------------------------------------------------
// Floating chip (fallback for players without a recognized control bar, and
// for images). Clicking opens the menu rather than asking directly.
function ensureButton() {
  if (btn) return btn;
  btn = document.createElement("div");
  btn.id = BTN_ID;
  btn.dataset.abtheme = floatTheme;
  btn.title = "AgentBrowser";

  const item = document.createElement("button");
  item.type = "button";
  item.className = "ab-item";
  item.appendChild(iconSvg(AT_PATHS, 15));
  const label = document.createElement("span");
  label.className = "ab-exp";
  label.textContent = "引用";
  item.appendChild(label);
  btn.appendChild(item);

  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu(btn.getBoundingClientRect());
  });
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
  if (btn) {
    btn.classList.remove("ab-show");
    btn.style.display = "none";
  }
  hoverEl = null;
  hoverKind = null;
  hoverMode = null;
  lastPos = null;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    if (menu && menu.classList.contains("ab-show")) return; // menu open keeps chip
    hideButton();
  }, HIDE_DELAY_MS);
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

// Ancestor-walk misses media covered by sibling overlays — YouTube parks an
// invisible control layer on top of <video>, so the pointer's target is never
// the media itself. elementsFromPoint sees through the cover; scan the whole
// stack for the first media element (skipping our own floaters).
function pickMediaAt(e) {
  const direct = pickMedia(e.target);
  if (direct) return direct;
  if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return null;
  if (typeof document.elementsFromPoint !== "function") return null;
  let stack;
  try {
    stack = document.elementsFromPoint(e.clientX, e.clientY);
  } catch (err) {
    logWarn("elementsFromPoint failed", err);
    return null;
  }
  // Hysteresis: keep the media we already picked while it stays under the
  // pointer. Sibling overlays (poster img, player chrome) shuffle the stack
  // order at edges, and switching hit.el re-places the chip — the jitter.
  if (hoverEl && stack.includes(hoverEl)) {
    return { el: hoverEl, kind: hoverEl.tagName === "VIDEO" ? "video" : "image" };
  }
  for (const el of stack) {
    if (el.id && String(el.id).startsWith("agentbrowser-")) continue;
    if (el.tagName === "VIDEO" || el.tagName === "IMG") {
      return { el, kind: el.tagName === "VIDEO" ? "video" : "image" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Control-bar injection: on recognized sites we put our icon inside the
// player's own controls so it lives where users expect player actions.
const cbBtns = new WeakSet(); // control bars already carrying our icon

function findControlBar(video) {
  if (video.tagName !== "VIDEO") return null;
  let el = video;
  for (let i = 0; el && i < 8; i++) {
    for (const site of CONTROL_BARS) {
      if (!site.match.test(location.hostname)) continue;
      try {
        const bar = el.querySelector ? el.querySelector(site.bar) : null;
        if (bar && bar.isConnected) return { bar, site };
      } catch (err) {
        logWarn("control bar probe failed", err);
      }
    }
    el = el.parentElement;
  }
  return null;
}

function mountControlIcon(video) {
  const found = findControlBar(video);
  if (!found) return false;
  const { bar, site } = found;
  if (cbBtns.has(bar)) return true;
  if (bar.querySelector(".ab-media-cb")) {
    cbBtns.add(bar);
    return true;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ab-media-cb";
  b.title = "AgentBrowser";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hoverEl = video;
    hoverKind = "video";
    hoverMode = "control";
    toggleMenu(b.getBoundingClientRect());
  });
  // Size from the bar's own buttons — hardcoding 36px looked right on
  // YouTube but oversized inside bilibili's shorter control row.
  let h = 36;
  try {
    const sib =
      bar.querySelector("button, .ytp-button, .bpx-player-ctrl-btn") || bar;
    const sh = Math.round(sib.getBoundingClientRect().height);
    if (sh >= 20 && sh <= 48) h = sh;
  } catch (err) {
    logWarn("control bar sizing failed", err);
  }
  const icon = Math.max(14, Math.min(18, h - 14));
  b.appendChild(iconSvg(AT_PATHS, icon));
  b.style.display = "inline-flex";
  b.style.alignItems = "center";
  b.style.justifyContent = "center";
  b.style.alignSelf = "center";
  b.style.width = h + "px";
  b.style.height = h + "px";
  b.style.color = "inherit";
  b.style.opacity = "0.92";
  const svg = b.firstElementChild;
  if (svg) svg.style.display = "block";
  // Sit just left of the fullscreen button (site.anchor); unknown layouts
  // fall back to the left edge of the right-controls group.
  const anchorEl = site.anchor ? bar.querySelector(site.anchor) : null;
  bar.insertBefore(b, anchorEl || bar.firstChild);
  cbBtns.add(bar);
  return true;
}

// ---------------------------------------------------------------------------
// Menu: fixed-position popover above the icon that opened it.
function closeMenu() {
  if (menu) {
    menu.classList.remove("ab-show");
    menu.style.display = "none";
  }
  scheduleHide(); // the menu was keeping the chip alive — re-arm the hide
}

function menuItem(iconPaths, text, onClick) {
  const it = document.createElement("button");
  it.type = "button";
  it.className = "ab-menu-item";
  it.appendChild(iconSvg(iconPaths, 14));
  const t = document.createElement("span");
  t.textContent = text;
  it.appendChild(t);
  it.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(it, t);
  });
  return it;
}

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = MENU_ID;
  menu.dataset.abtheme = floatTheme;
  menu.addEventListener("mouseenter", clearHideTimer);
  menu.addEventListener("mouseleave", scheduleHide);
  (document.body || document.documentElement).appendChild(menu);
  return menu;
}

function toggleMenu(anchorRect) {
  if (menu && menu.classList.contains("ab-show")) {
    closeMenu();
    return;
  }
  if (!hoverEl) return;
  const m = ensureMenu();
  m.textContent = "";
  m.dataset.abtheme = floatTheme;
  m.appendChild(
    menuItem(AT_PATHS, "引用到 AgentBrowser", () => {
      closeMenu();
      onAsk();
    })
  );
  if (hoverKind === "video") {
    const dl = menuItem(DOWN_PATHS, "下载视频", (it, t) => {
      if (dlPending) return;
      dlPending = true;
      it.classList.add("ab-busy");
      t.textContent = "下载中…";
      onDownload((ok, detail) => {
        dlPending = false;
        it.classList.remove("ab-busy");
        t.textContent = ok ? "已保存" : "下载失败";
        showToast(anchorRect, ok ? `已下载: ${detail}` : detail, !ok);
        setTimeout(closeMenu, 1600);
      });
    });
    m.appendChild(dl);
  }
  m.style.display = "block";
  const mw = m.offsetWidth || 160;
  const mh = m.offsetHeight || 70;
  const x = Math.max(4, Math.min(anchorRect.left, window.innerWidth - mw - 8));
  const y = anchorRect.top - mh - 8 > 4 ? anchorRect.top - mh - 8 : anchorRect.bottom + 8;
  m.style.left = x + "px";
  m.style.top = y + "px";
  requestAnimationFrame(() => m.classList.add("ab-show"));
}

function showToast(anchorRect, text, isErr) {
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    (document.body || document.documentElement).appendChild(toast);
  }
  toast.dataset.abtheme = floatTheme;
  toast.dataset.err = isErr ? "1" : "0";
  toast.textContent = String(text || "").slice(0, 200);
  toast.style.display = "block";
  const x = Math.max(4, Math.min(anchorRect.left, window.innerWidth - 300));
  const y = Math.max(4, anchorRect.top - 44);
  toast.style.left = x + "px";
  toast.style.top = y + "px";
  requestAnimationFrame(() => toast.classList.add("ab-show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("ab-show");
    toast.style.display = "none";
  }, 4000);
}

document.addEventListener("mousedown", (e) => {
  if (
    menu &&
    menu.classList.contains("ab-show") &&
    !menu.contains(e.target) &&
    !(btn && btn.contains(e.target)) &&
    !(e.target && e.target.closest && e.target.closest(".ab-media-cb"))
  ) {
    closeMenu();
  }
});

// ---------------------------------------------------------------------------
// Hover wiring
document.addEventListener(
  "mouseover",
  (e) => {
    const hit = pickMediaAt(e);
    if (!hit) {
      if (hoverEl && btn && btn.classList.contains("ab-show")) scheduleHide();
      return;
    }
    if (hit.kind === "video" && mountControlIcon(hit.el)) {
      // Control-bar icon handles the affordance; retire the float chip if
      // it was showing, but never clobber control-mode state — the menu may
      // be open against it.
      if (hoverMode === "float") hideButton();
      return;
    }
    clearHideTimer();
    if (hit.el === hoverEl) return;
    hoverEl = hit.el;
    hoverKind = hit.kind;
    hoverMode = "float";
    if (!placeButton(hit.el, hit.kind)) hideButton();
  },
  true
);

document.addEventListener(
  "mouseout",
  (e) => {
    if (!pickMediaAt(e) && hoverEl && btn && btn.classList.contains("ab-show")) scheduleHide();
  },
  true
);

// Scrolling / fullscreen transitions can move the media out from under the
// button; re-place on scroll, drop on fullscreen change.
addEventListener(
  "scroll",
  () => {
    if (hoverMode !== "float" || !hoverEl) return;
    if (!hoverEl.isConnected || !placeButton(hoverEl, hoverKind)) hideButton();
  },
  true
);
document.addEventListener("fullscreenchange", hideButton);

// The button parks at the media's top-left inner edge. Fullscreen still works:
// the button lives in <body>, and a fullscreen video fills the viewport so
// fixed positioning at its rect remains correct. This chip does not yield to
// foreign overlays — the float guard is for the selection toolbar only.
function placeButton(el, kind) {
  const r = el.getBoundingClientRect();
  const minW = kind === "video" ? 120 : 80;
  const minH = 80;
  if (r.width < minW || r.height < minH) return false; // ignore thumbnails/icons
  const b = ensureButton();
  const left = Math.max(4, r.left + 8);
  const top = Math.max(4, r.top + 8);
  // Deadzone: identical/sub-pixel writes on every scroll event re-run layout
  // for nothing — and visible restarts of the pop-in transition read as
  // jitter at edges.
  if (
    lastPos &&
    Math.abs(lastPos.left - left) < 1 &&
    Math.abs(lastPos.top - top) < 1 &&
    b.classList.contains("ab-show")
  ) {
    return true;
  }
  lastPos = { left, top };
  b.dataset.abtheme = floatTheme;
  b.style.position = "fixed";
  b.style.left = left + "px";
  b.style.top = top + "px";
  b.style.display = "flex";
  requestAnimationFrame(() => b.classList.add("ab-show"));
  return true;
}

function fmtSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

async function onAsk() {
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
    if (!(response && response.success)) {
      logWarn("video_ask rejected", response && response.error);
    }
    hideButton();
  } catch (err) {
    logWarn("video_ask send failed", err);
    hideButton();
  }
}

// 下载视频: fire-and-forget to the sw → hub yt-dlp; the result comes back as
// a pushed download_result message (downloads can take minutes — we do not
// hold sendResponse that long).
function onDownload(done) {
  if (!isContextValid()) return done(false, "extension context invalid");
  const reqId = `dl-${Date.now()}`;
  dlDone = done;
  try {
    chrome.runtime
      .sendMessage({
        target: "sw",
        cmd: "video_download",
        id: reqId,
        url: String(location.href),
      })
      .then((res) => {
        // Rejected up front (no hub, bad url) — surface it instead of
        // leaving the item on 下载中… forever.
        if (res && res.success === false && dlDone === done) {
          dlDone = null;
          done(false, String(res.error || "download rejected"));
        }
      })
      .catch((err) => logWarn("video_download send failed", err));
  } catch (err) {
    logWarn("video_download send failed", err);
    dlDone = null;
    done(false, String((err && err.message) || err));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "video-ask") return;
  if (msg.cmd === "download_result") {
    const cb = dlDone;
    dlDone = null;
    if (cb) cb(!!msg.ok, String(msg.file || msg.error || ""));
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

// Used by tests and by the sw when it wants the freshest rect again.
window.__abVideoAsk = { lastContext: () => lastContext, fmtSec };

})();
