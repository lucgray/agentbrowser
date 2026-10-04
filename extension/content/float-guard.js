// Content script helper: detects foreign floating overlays (other extensions'
// buttons/popups — read-frog, 沙拉查词, DeepL, …) so AgentBrowser's own
// floating UI can yield instead of stacking on top of them. Detection only —
// we never hide or touch foreign elements; we suppress our own.
//
// Exposed on window.__abFloatGuard:
//   foreignOverlayAt(x, y)  -> topmost element at that viewport point that is
//                              not ours and looks like a floating overlay,
//                              else null.
//   foreignAtRect(rect)     -> same, probed at the rect's centre + corners.
//   watchForeign(rect, cb)  -> MutationObserver; cb() fires when a foreign
//                              overlay candidate appears near rect. Returns
//                              a stop() function.

(function () {
  if (window.__abFloatGuard) return;

  const OWN_PREFIX = "agentbrowser-";
  // Anything above this z-index is almost certainly a floating UI layer —
  // page chrome (nav bars, sticky headers) sits far lower.
  const FLOAT_Z_MIN = 9999;
  // Foreign overlays are small by nature (buttons, popups, tooltips) — a
  // fullscreen fixed backdrop is a page overlay, not an extension floater.
  const FLOAT_MAX_AREA = 800 * 600;

  function isOwn(el) {
    let node = el;
    while (node) {
      if (node.id && String(node.id).startsWith(OWN_PREFIX)) return true;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return false;
  }

  function looksFloaty(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "HTML" || tag === "BODY") return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (err) {
      console.warn("[agentbrowser] float guard style read failed", err);
      return false;
    }
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const pos = cs.position;
    if (pos !== "fixed" && pos !== "absolute" && pos !== "sticky") return false;
    const z = parseInt(cs.zIndex, 10);
    if (!(z >= FLOAT_Z_MIN)) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.width * r.height > FLOAT_MAX_AREA) return false;
    } catch (err) {
      console.warn("[agentbrowser] float guard rect failed", err);
      return false;
    }
    return true;
  }

  function foreignOverlayAt(x, y) {
    if (typeof document.elementsFromPoint !== "function") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let stack;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch (err) {
      console.warn("[agentbrowser] elementsFromPoint failed", err);
      return null;
    }
    for (const el of stack) {
      if (isOwn(el)) continue;
      if (el === document.documentElement || el === document.body) return null;
      if (looksFloaty(el)) return el;
      // A normal page element on top means the spot is covered by content,
      // not by a floater — that is fine, it is not a conflict.
      return null;
    }
    return null;
  }

  function foreignAtRect(rect) {
    if (!rect) return null;
    const pts = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left, rect.top],
      [rect.right, rect.top],
      [rect.left, rect.bottom],
      [rect.right, rect.bottom],
    ];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const el = foreignOverlayAt(x, y);
      if (el) return el;
    }
    return null;
  }

  // Cheap candidate check for MutationObserver-added nodes — avoids a
  // computed-style read on every DOM insertion. Foreign overlays arrive as
  // positioned hosts (often shadow hosts) with a high inline z-index or a
  // shadow root; confirm the expensive way only for candidates.
  function isCandidate(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id && String(node.id).startsWith(OWN_PREFIX)) return false;
    const st = node.style;
    if (!st) return false;
    const pos = st.position;
    if (pos === "fixed" || pos === "absolute" || pos === "sticky") return true;
    // Extensions that style inside a shadow root leave a bare host element;
    // its only tell is an open shadow root.
    return !!node.shadowRoot;
  }

  function watchForeign(rect, cb) {
    if (typeof MutationObserver !== "function" || !document.body) return () => {};
    let stopped = false;
    let pending = false;
    const check = () => {
      pending = false;
      if (stopped) return;
      if (foreignAtRect(rect)) cb();
    };
    const mo = new MutationObserver((records) => {
      if (pending) return;
      for (const rec of records) {
        for (const n of rec.addedNodes) {
          if (isCandidate(n)) {
            pending = true;
            // Let the foreign element finish styling before probing.
            setTimeout(check, 60);
            return;
          }
        }
      }
    });
    try {
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      console.warn("[agentbrowser] float guard observer failed", err);
      return () => {};
    }
    return () => {
      stopped = true;
      mo.disconnect();
    };
  }

  window.__abFloatGuard = { isOwn, foreignOverlayAt, foreignAtRect, watchForeign };
})();
