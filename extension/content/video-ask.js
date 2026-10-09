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
  {
    match: /(^|\.)(twitter\.com|x\.com)$/,
    // x.com exposes no stable class names — resolve the controls group by
    // structure (the approach read-frog uses): it exists only while the
    // progress slider renders, and control icons sit at a fixed
    // button > div > svg depth inside it.
    resolve(video) {
      const box =
        video.closest(
          "[data-testid='videoPlayer'],[data-testid='videoComponent'],[data-testid='videoPlayerContainer']",
        ) || video.parentElement;
      if (!box || !box.querySelector("[role='slider']")) return null;
      const svg = box.querySelector("button[role='button'] > div > svg");
      return (
        (svg &&
          svg.parentElement &&
          svg.parentElement.parentElement &&
          svg.parentElement.parentElement.parentElement &&
          svg.parentElement.parentElement.parentElement.parentElement) ||
        null
      );
    },
    anchorLast: true, // the last child is the fullscreen button
  },
];

let btn = null;

// Native fullscreen renders ONLY the fullscreen element's subtree — floating
// UI on document.body vanishes (bilibili fullscreens its player container).
// Host all our floaters on the fullscreen element when one is active.
function floatHost() {
  return document.fullscreenElement || document.body || document.documentElement;
}
document.addEventListener("fullscreenchange", () => {
  const host = floatHost();
  for (const el of [btn, menu, toast, learn && learn.el]) {
    if (el && el.parentNode !== host) host.appendChild(el);
  }
});
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
      for (const el of [btn, menu, toast, learn && learn.el]) {
        if (el) el.dataset.abtheme = floatTheme;
      }
    })
    .catch((err) => logWarn("floatTheme read failed", err));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(FLOAT_THEME_KEY in changes)) return;
    const v = changes[FLOAT_THEME_KEY].newValue;
    floatTheme = FLOAT_THEMES.has(v) ? v : "frost";
    for (const el of [btn, menu, toast, learn && learn.el]) {
      if (el) el.dataset.abtheme = floatTheme;
    }
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
const SUB_PATHS = [
  "M4 5h16v14H4z",
  "M7 10h10",
  "M7 14h6",
];
const DM_PATHS = ["M4 6h16", "M4 12h10", "M4 18h13"];
const BOOK_PATHS = [
  "M4 4h6v16H4z",
  "M14 4h6v16h-6z",
  "M6.5 8h2M6.5 11h2",
];

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
  floatHost().appendChild(btn);
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

function ours(node) {
  return !!(node && node.closest && node.closest("[id^='agentbrowser-']"));
}

// The player wrapper framing a media's own overlays (control chrome, poster,
// captions). Foreign overlays covering the media — a sticky site header the
// video scrolled under, an overlapping card — sit OUTSIDE this box, which is
// how we tell "own chrome" from "media is covered by the page".
function mediaBox(el) {
  return (
    el.closest(
      "[data-testid='videoPlayer'],[data-testid='videoComponent']," +
        "[data-testid='videoPlayerContainer'],.html5-video-player," +
        ".bpx-player-container,.bilibili-player,[data-testid='tweetPhoto']",
    ) || el.parentElement
  );
}

// At this stack's point, is the media covered by something outside its own
// player wrapper? Own overlays (player chrome inside mediaBox) don't count,
// and a wrapping ancestor (link around an img) doesn't either.
function mediaCovered(stack, el, box) {
  let top = null;
  for (const n of stack) {
    if (!ours(n)) {
      top = n;
      break;
    }
  }
  if (!top) return true;
  if (top === el || top.contains(el)) return false;
  return !(box && box.contains(top));
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
  // See-through is for VIDEO only: a video's invisible control layer sits on
  // top of it. Applying it to IMG latched the chip onto images covered by
  // article text (e.g. a weibo cover under the headline) — the @ then glued
  // to the image's top-left corner, landing on the title. Covered images get
  // no chip; an uncovered img still hits via the ancestor walk above.
  for (const el of stack) {
    if (el.id && String(el.id).startsWith("agentbrowser-")) continue;
    // The stack can also contain a video hidden BENEATH foreign content —
    // e.g. a player scrolled under x.com's sticky header. Anchoring there
    // lands the chip on the header. Only videos whose point is actually
    // visible (topmost is the video or its own chrome) qualify.
    if (el.tagName === "VIDEO" && !mediaCovered(stack, el, mediaBox(el))) {
      return { el, kind: "video" };
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
  for (const site of CONTROL_BARS) {
    if (!site.resolve || !site.match.test(location.hostname)) continue;
    try {
      const bar = site.resolve(video);
      if (bar && bar.isConnected) return { bar, site };
    } catch (err) {
      logWarn("control bar resolve failed", err);
    }
  }
  let el = video;
  for (let i = 0; el && i < 8; i++) {
    for (const site of CONTROL_BARS) {
      if (!site.bar || !site.match.test(location.hostname)) continue;
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
  // Players can re-render the bar's children while keeping the bar element
  // (YouTube does on resolution/quality changes) — a WeakSet hit would skip
  // remounting our wiped button, so check the live DOM instead.
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
  // YouTube but oversized inside bilibili's shorter control row. Measure the
  // anchor (fullscreen) button first: it's always an icon button, unlike a
  // text-quality sibling that skews the width. Re-runnable: bilibili builds
  // the bar lazily, so a first-hover mount can precede the anchor's render —
  // the reposition observer below calls this again once it exists.
  const applySize = () => {
    let h = 36;
    let w = 0;
    try {
      const sib =
        (site.anchor ? bar.querySelector(site.anchor) : null) ||
        bar.querySelector("button, .ytp-button, .bpx-player-ctrl-btn") ||
        bar;
      const sr = sib.getBoundingClientRect();
      const sh = Math.round(sr.height);
      const sw = Math.round(sr.width);
      if (sh >= 20 && sh <= 48) h = sh;
      if (sw >= 20 && sw <= 64) w = sw;
    } catch (err) {
      logWarn("control bar sizing failed", err);
    }
    const icon = Math.max(14, Math.min(18, h - 8));
    const svg = b.firstElementChild;
    if (svg) {
      svg.setAttribute("width", String(icon));
      svg.setAttribute("height", String(icon));
      svg.style.display = "block";
    }
    b.style.width = (w || h) + "px";
    b.style.height = h + "px";
  };
  b.appendChild(iconSvg(AT_PATHS, 16));
  b.style.display = "inline-flex";
  b.style.alignItems = "center";
  b.style.justifyContent = "center";
  b.style.color = "inherit";
  b.style.opacity = "0.92";
  applySize();
  // Sit just left of the fullscreen button (site.anchor). The bar's children
  // may not exist yet on first hover (bilibili builds them lazily) — fall
  // back to the far end, then move left of the anchor once it appears.
  // insertBefore needs a direct child of the bar — climb the anchor to its
  // top-level ancestor (it may sit inside a wrapper), and verify parentage
  // since YouTube re-renders the bar's children in batches.
  const barChild = (el) => {
    let n = el;
    while (n && n.parentNode !== bar) n = n.parentNode;
    return n;
  };
  const anchorEl = site.anchor ? bar.querySelector(site.anchor) : null;
  let ref = anchorEl ? barChild(anchorEl) : null;
  if (!ref && site.anchorLast && bar.lastElementChild) {
    ref = bar.lastElementChild;
  }
  if (ref) {
    bar.insertBefore(b, ref);
  } else {
    bar.appendChild(b);
    if (site.anchor) {
      const mo = new MutationObserver(() => {
        const a = bar.querySelector(site.anchor);
        const r = a ? barChild(a) : null;
        if (r) {
          applySize(); // anchor exists now — first-mount size was guessed
          bar.insertBefore(b, r);
          mo.disconnect();
        }
      });
      mo.observe(bar, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 15000);
    }
  }
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
  floatHost().appendChild(menu);
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
  // Subtitle-backed items (learn popup, 获取字幕/弹幕) only exist on the
  // video pages our subtitle pipeline supports — same sites detectSite in
  // page/subtitle-core.js probes. A random article's embedded video gets
  // neither.
  const vidSite =
    (/youtube\.com\/watch|youtu\.be\//.test(location.href) && "youtube") ||
    (/bilibili\.com\/video\/|b23\.tv\//.test(location.href) && "bilibili") ||
    (/\/\/(?:[a-z0-9-]+\.)*(x|twitter)\.com\//.test(location.href) && "x") ||
    null;
  if (hoverKind === "video" && vidSite) {
    m.appendChild(
      menuItem(BOOK_PATHS, "学习弹窗", () => {
        closeMenu();
        openLearn();
      })
    );
    const sub = menuItem(SUB_PATHS, "获取字幕", (it, t) => {
      if (it.dataset.busy) return;
      it.dataset.busy = "1";
      it.classList.add("ab-busy");
      t.textContent = "获取中…";
      onFetchSubs("subs", (ok, detail) => {
        it.classList.remove("ab-busy");
        t.textContent = ok ? "已保存" : "获取失败";
        showToast(anchorRect, ok ? `已保存: ${detail}` : detail, !ok);
        setTimeout(closeMenu, 1600);
      });
    });
    m.appendChild(sub);
    if (vidSite === "bilibili") {
      m.appendChild(
        menuItem(DM_PATHS, "获取弹幕", (it, t) => {
          if (it.dataset.busy) return;
          it.dataset.busy = "1";
          it.classList.add("ab-busy");
          t.textContent = "获取中…";
          onFetchSubs("danmaku", (ok, detail) => {
            it.classList.remove("ab-busy");
            t.textContent = ok ? "已保存" : "获取失败";
            showToast(anchorRect, ok ? `已保存: ${detail}` : detail, !ok);
            setTimeout(closeMenu, 1600);
          });
        })
      );
    }
  }
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
    floatHost().appendChild(toast);
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
  (e) => {
    if (hoverMode !== "float" || !hoverEl) return;
    // Only a scroll of the document or of an ancestor moves the media's
    // viewport rect. Unrelated scrollers (chat feeds, side panes auto-
    // scrolling on stream) fire constantly — re-placing on every tick turns
    // any sub-pixel reflow of the media into a visible horizontal shake.
    const t = e.target;
    const docScroll =
      t === document || t === document.documentElement || t === document.body;
    if (!docScroll && !(t && t.contains && t.contains(hoverEl))) return;
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
  // The ideal anchor can be covered while the media is still mostly visible —
  // e.g. a video scrolled under x.com's sticky header pins the chip against
  // the header, reading as a stray badge at the page corner. Anchor at the
  // first point down the left edge the media actually owns; covered
  // everywhere → hide.
  const left = Math.round(Math.max(4, r.left + 8));
  if (left > window.innerWidth - 28) return false;
  const box = kind === "video" ? mediaBox(el) : null;
  let top = -1;
  const hi = Math.min(r.bottom - 24, window.innerHeight - 28);
  for (let y = Math.round(Math.max(4, r.top + 8)); y <= hi; y += 24) {
    let stack;
    try {
      stack = document.elementsFromPoint(left + 10, y + 10);
    } catch (err) {
      logWarn("elementsFromPoint failed", err);
      top = y;
      break;
    }
    if (!mediaCovered(stack, el, box)) {
      top = y;
      break;
    }
  }
  if (top < 0) return false;
  const b = ensureButton();
  // Deadzone: identical/sub-pixel writes on every scroll event re-run layout
  // for nothing — and visible restarts of the pop-in transition read as
  // jitter at edges.
  if (
    lastPos &&
    lastPos.left === left &&
    lastPos.top === top &&
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

// ---------------------------------------------------------------------------
// Learn popup （学习弹窗）: fixed side dialog, three tabs — 字幕 (cue list,
// click to seek, follows the playhead), 汇总 and 弹幕热议 (agent generations
// streamed back via learn_event on the learn-<tabId> chat).
const LEARN_ID = "agentbrowser-learn";
let learn = null; // { el, panes, tabBtns }
let learnCues = null;
let learnCuesFor = null; // location.href the cue list belongs to (SPA navs)
let learnNowRow = null;
let learnGen = null; // { kind, outEl, text }

function learnAsk(kind) {
  return chrome.runtime
    .sendMessage({
      target: "sw",
      cmd: "learn_ask",
      kind,
      title: String(document.title || ""),
    })
    .catch((err) => {
      logWarn("learn_ask send failed", err);
      return { success: false, error: String((err && err.message) || err) };
    });
}

function ensureLearn() {
  if (learn) return learn;
  const el = document.createElement("div");
  el.id = LEARN_ID;
  el.dataset.abtheme = floatTheme;

  const head = document.createElement("div");
  head.className = "ab-learn-head";
  const tabsEl = document.createElement("div");
  tabsEl.className = "ab-learn-tabs";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ab-learn-close";
  close.textContent = "✕";
  close.addEventListener("click", closeLearn);
  head.appendChild(tabsEl);
  head.appendChild(close);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "ab-learn-body";
  el.appendChild(body);

  const panes = {};
  const tabBtns = {};
  const tabDefs = [
    ["cues", "逐句"],
    ["summary", "AI 摘要"],
    ["danmaku", "弹幕热议"],
  ];
  for (const [key, label] of tabDefs) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "ab-learn-tab";
    t.textContent = label;
    t.addEventListener("click", () => learnTab(key));
    tabsEl.appendChild(t);
    tabBtns[key] = t;
    const pane = document.createElement("div");
    pane.className = "ab-learn-pane";
    body.appendChild(pane);
    panes[key] = pane;
  }

  // Tool strip (demo parity): SRT export, follow toggle, LIVE badge.
  const tools = document.createElement("div");
  tools.className = "ab-learn-tools";
  const srt = document.createElement("button");
  srt.type = "button";
  srt.className = "ab-learn-tool";
  srt.textContent = "⬇ SRT";
  srt.title = "导出字幕文件";
  srt.addEventListener("click", () => {
    srt.classList.add("ab-busy");
    onFetchSubs("subs", (ok, detail) => {
      srt.classList.remove("ab-busy");
      showToast(el.getBoundingClientRect(), ok ? `已保存 ${detail}` : detail, !ok);
    });
  });
  const follow = document.createElement("button");
  follow.type = "button";
  follow.className = "ab-learn-tool ab-on";
  follow.textContent = "⌖ 跟随";
  follow.title = "跟随播放头滚动";
  follow.addEventListener("click", () => {
    learnFollow = !learnFollow;
    follow.classList.toggle("ab-on", learnFollow);
  });
  const live = document.createElement("span");
  live.className = "ab-learn-live";
  live.innerHTML = "<i></i>LIVE";
  live.style.display = "none";
  tools.appendChild(srt);
  tools.appendChild(follow);
  const tsp = document.createElement("span");
  tsp.className = "ab-learn-sp";
  tools.appendChild(tsp);
  tools.appendChild(live);
  el.insertBefore(tools, body);

  floatHost().appendChild(el);
  learn = { el, panes, tabBtns, live };
  buildLearnPanes();
  return learn;
}

function learnTab(key) {
  if (!learn) return;
  for (const k of Object.keys(learn.panes)) {
    learn.panes[k].classList.toggle("ab-active", k === key);
    learn.tabBtns[k].classList.toggle("ab-active", k === key);
  }
}

function buildLearnPanes() {
  // 汇总 / 弹幕热议 share one shape: output area + a generate button.
  for (const [key, btnLabel] of [
    ["summary", "生成汇总"],
    ["danmaku", "生成热议分析"],
  ]) {
    const pane = learn.panes[key];
    const out = document.createElement("div");
    out.className = "ab-learn-out";
    const gen = document.createElement("button");
    gen.type = "button";
    gen.className = "ab-learn-gen";
    gen.textContent = btnLabel;
    gen.addEventListener("click", () => runLearnGen(key, out, gen));
    pane.appendChild(out);
    pane.appendChild(gen);
  }
}

function runLearnGen(kind, outEl, genBtn) {
  if (learnGen) return;
  learnGen = { kind, outEl, text: "" };
  outEl.textContent = "生成中…";
  genBtn.classList.add("ab-busy");
  learnAsk(kind).then((res) => {
    genBtn.classList.remove("ab-busy");
    if (!res || !res.success) {
      outEl.textContent = `生成失败：${(res && res.error) || "未知错误"}`;
      if (learnGen && learnGen.outEl === outEl) learnGen = null;
    }
  });
}

function loadLearnCues() {
  const pane = learn.panes.cues;
  pane.textContent = "";
  const note = document.createElement("div");
  note.className = "ab-learn-note";
  note.textContent = "读取字幕…";
  pane.appendChild(note);
  learnAsk("cues").then((res) => {
    pane.textContent = "";
    if (!res || !res.success || !res.cues || !res.cues.length) {
      const n = document.createElement("div");
      n.className = "ab-learn-note";
      n.textContent = `没有可用字幕${res && res.error ? `：${res.error}` : ""}`;
      pane.appendChild(n);
      return;
    }
    learnCues = res.cues;
    learnCuesFor = location.href;
    const frag = document.createDocumentFragment();
    const rows = [];
    for (const c of res.cues) {
      const row = document.createElement("div");
      row.className = "ab-learn-cue";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = fmtSec(c.start);
      const src = document.createElement("span");
      src.className = "src";
      src.textContent = String(c.text || "");
      const tr = document.createElement("span");
      tr.className = "tr";
      row.appendChild(t);
      row.appendChild(src);
      row.appendChild(tr);
      row._t = Number(c.start) || 0;
      row.addEventListener("click", () => {
        const v = learnTargetVideo();
        if (v) v.currentTime = c.start;
      });
      rows.push(row);
      frag.appendChild(row);
    }
    pane.appendChild(frag);
    translateLearnCues(rows);
  });
}

// Fill the .tr line of each cue row via the hub's translate pipeline, in
// chunks so translations land progressively. Skips silently when the hub
// isn't there — the source track still renders.
function translateLearnCues(rows) {
  const CHUNK = 24;
  const href = location.href;
  const step = (i) => {
    if (i >= rows.length || learnCuesFor !== href || !isContextValid()) return;
    const slice = rows.slice(i, i + CHUNK);
    chrome.runtime
      .sendMessage({
        target: "sw",
        cmd: "learn_ask",
        kind: "cues_translate",
        items: slice.map((r) => r.querySelector(".src").textContent),
      })
      .then((res) => {
        if (res && res.success && res.results) {
          slice.forEach((r, j) => {
            const tr = r.querySelector(".tr");
            const text = res.results[String(j)];
            if (tr && text && text !== "{{NO_TRANSLATION_NEEDED}}") {
              tr.textContent = String(text);
            }
          });
        } else if (res && !res.success) {
          return; // provider/hub unavailable — don't churn the rest
        }
        step(i + CHUNK);
      })
      .catch((err) => logWarn("cues_translate failed", err));
  };
  step(0);
}

// The video the learn popup was opened for — captured at open time because
// hoverEl is cleared when the menu auto-hides, and first-in-DOM <video> is
// wrong on multi-video pages.
let learnVideo = null;
function learnTargetVideo() {
  if (learnVideo && learnVideo.isConnected) return learnVideo;
  return document.querySelector("video");
}

// Follow the playhead inside the 逐句 tab; the 跟随 toggle only gates the
// auto-scroll, the highlight still tracks. LIVE badge mirrors play state.
let learnTick = null;
let learnFollow = true;
function startLearnTick() {
  if (learnTick) return;
  learnTick = setInterval(() => {
    if (!learn || !learn.el.classList.contains("ab-show")) return;
    const v = learnTargetVideo();
    if (learn.live) learn.live.style.display = v && !v.paused ? "" : "none";
    if (!learnCues || !learn.panes.cues.classList.contains("ab-active")) return;
    if (!v) return;
    const t = Number(v.currentTime) || 0;
    let hit = null;
    for (const row of learn.panes.cues.querySelectorAll(".ab-learn-cue")) {
      if (row._t == null) continue;
      if (row._t <= t) hit = row;
      else break;
    }
    if (hit === learnNowRow) return;
    if (learnNowRow) learnNowRow.classList.remove("ab-now");
    learnNowRow = hit;
    if (hit) {
      hit.classList.add("ab-now");
      if (learnFollow) hit.scrollIntoView({ block: "nearest" });
    }
  }, 500);
}

function openLearn() {
  learnVideo =
    hoverEl && hoverEl.tagName === "VIDEO" ? hoverEl : learnVideo;
  const l = ensureLearn();
  // 弹幕 tab only makes sense on bilibili.
  const hasDm = /(^|\.)bilibili\.com$/.test(location.hostname);
  l.tabBtns.danmaku.style.display = hasDm ? "" : "none";
  l.el.dataset.abtheme = floatTheme;
  l.el.classList.add("ab-show");
  learnTab("cues");
  if (!learnCues || learnCuesFor !== location.href) {
    learnCues = null;
    learnCuesFor = location.href;
    loadLearnCues();
  }
  startLearnTick();
}

function closeLearn() {
  if (learn) learn.el.classList.remove("ab-show");
  learnNowRow = null;
}

// 获取字幕/弹幕: sw fetches the track (or danmaku XML) and saves the file
// via chrome.downloads — the request itself resolves in the response, so a
// settled promise is the whole lifecycle.
function onFetchSubs(kind, done) {
  if (!isContextValid()) return done(false, "extension context invalid");
  try {
    chrome.runtime
      .sendMessage({ target: "sw", cmd: "subtitle_fetch", kind })
      .then((res) => {
        if (res && res.success) done(true, String(res.name || "saved"));
        else done(false, String((res && res.error) || "fetch failed"));
      })
      .catch((err) => {
        logWarn("subtitle_fetch send failed", err);
        done(false, String((err && err.message) || err));
      });
  } catch (err) {
    logWarn("subtitle_fetch send failed", err);
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
  if (msg.cmd === "learn_event") {
    const ev = msg.event || {};
    const g = learnGen;
    if (g && g.outEl) {
      if (ev.kind === "token" && ev.text) {
        g.text += String(ev.text);
        g.outEl.textContent = g.text;
        g.outEl.scrollTop = g.outEl.scrollHeight;
      } else if (ev.kind === "error") {
        g.outEl.textContent = `${g.text}\n\n生成出错：${ev.message || "error"}`;
        learnGen = null;
      } else if (ev.kind === "done") {
        learnGen = null;
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

// Used by tests and by the sw when it wants the freshest rect again.
window.__abVideoAsk = { lastContext: () => lastContext, fmtSec };

})();
