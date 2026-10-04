// Content script: a floating "@" button at the left edge of whatever <video>
// the pointer is over. Clicking it sends the video's context (url, title,
// playhead, pause state, element rect) to the service worker, which opens the
// side panel, pulls the running subtitle session's transcript window, and —
// while the video is paused — grabs a cropped tab screenshot of the frame.
// Both land in the composer as a selection chip + image attachment.

const BTN_ID = "agentbrowser-video-ask-btn";
const HIDE_DELAY_MS = 600;

let btn = null;
let hoverVideo = null;
let hideTimer = null;
let lastContext = null;

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
  btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.textContent = "@";
  btn.title = "引用此视频到 AgentBrowser";
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", onAsk);
  // Keep the button alive while the pointer moves from the video onto it.
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
  if (btn) btn.style.display = "none";
  hoverVideo = null;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(hideButton, HIDE_DELAY_MS);
}

function pickVideo(target) {
  let el = target && target.nodeType === 1 ? target : null;
  while (el) {
    if (el.tagName === "VIDEO" && el.isConnected) return el;
    el = el.parentElement;
  }
  return null;
}

// The button parks at the video's top-left inner edge. Fullscreen still works:
// the button lives in <body>, and a fullscreen video fills the viewport so
// fixed positioning at its rect remains correct.
function placeButton(video) {
  const r = video.getBoundingClientRect();
  if (r.width < 120 || r.height < 80) return false; // ignore thumbnail players
  const b = ensureButton();
  b.style.position = "fixed";
  b.style.left = Math.max(4, r.left + 8) + "px";
  b.style.top = Math.max(4, r.top + 8) + "px";
  b.style.display = "flex";
  return true;
}

document.addEventListener(
  "mouseover",
  (e) => {
    const v = pickVideo(e.target);
    if (!v) return;
    clearHideTimer();
    hoverVideo = v;
    if (!placeButton(v)) hideButton();
  },
  true
);

document.addEventListener(
  "mouseout",
  (e) => {
    if (pickVideo(e.target)) scheduleHide();
  },
  true
);

// Scrolling / fullscreen transitions can move the video out from under the
// button; re-place on scroll, drop on fullscreen change.
addEventListener(
  "scroll",
  () => {
    if (hoverVideo && (!hoverVideo.isConnected || !placeButton(hoverVideo))) hideButton();
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

  if (!isContextValid() || !hoverVideo) return;
  const v = hoverVideo;
  const r = v.getBoundingClientRect();
  const ctx = {
    url: String(location.href),
    title: String(document.title || ""),
    currentTime: Number(v.currentTime) || 0,
    duration: Number.isFinite(v.duration) ? Number(v.duration) : null,
    paused: !!v.paused,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
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
