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

  // Extension floaters that don't style their host (WXT-style shadow hosts
  // like read-frog's) are invisible to the style heuristic — recognise them
  // by marker/host shape instead. Keep the list generic: any open shadow
  // host that mounts positioned, high-z content counts as a foreign floater.
  const KNOWN_FOREIGN_HOSTS = "read-frog-selection, [data-rf-selection-overlay-root]";

  function isForeignHost(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.matches && el.matches(KNOWN_FOREIGN_HOSTS)) return true;
    } catch (err) {
      console.warn("[agentbrowser] foreign host match failed", err);
    }
    const root = el.shadowRoot;
    if (!root) return false;
    try {
      if (root.querySelector(KNOWN_FOREIGN_HOSTS)) return true;
      // Open shadow root with visibly positioned content = foreign overlay.
      // Bounded scan: a floater's positioned wrapper sits near the top of
      // the root; walking a whole component tree (hundreds of nodes) with a
      // computed-style read each is the hot path this cap avoids.
      const inner = root.querySelectorAll("*");
      for (let i = 0; i < inner.length && i < 60; i++) {
        const cs = getComputedStyle(inner[i]);
        if ((cs.position === "fixed" || cs.position === "absolute") &&
            cs.display !== "none" && cs.visibility !== "hidden") return true;
      }
    } catch (err) {
      console.warn("[agentbrowser] foreign host shadow scan failed", err);
    }
    return false;
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
      if (isForeignHost(el) || looksFloaty(el)) return el;
      // A normal page element on top means the spot is covered by content,
      // not by a floater — that is fine, it is not a conflict.
      return null;
    }
    return null;
  }

  function inflateRect(rect, margin) {
    const m = Number(margin) || 0;
    return {
      left: rect.left - m,
      top: rect.top - m,
      right: rect.right + m,
      bottom: rect.bottom + m,
      width: rect.width + 2 * m,
      height: rect.height + 2 * m,
    };
  }

  function foreignAtRect(rect, margin) {
    if (!rect) return null;
    const r = margin ? inflateRect(rect, margin) : rect;
    const midX = r.left + r.width / 2;
    const midY = r.top + r.height / 2;
    const pts = [
      [midX, midY],
      [r.left, r.top], [r.right, r.top],
      [r.left, r.bottom], [r.right, r.bottom],
      [midX, r.top], [midX, r.bottom],
      [r.left, midY], [r.right, midY],
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
    try {
      if (node.matches && node.matches(KNOWN_FOREIGN_HOSTS)) return true;
    } catch (err) {
      console.warn("[agentbrowser] foreign candidate match failed", err);
    }
    const st = node.style;
    if (!st) return !!node.shadowRoot;
    const pos = st.position;
    if (pos === "fixed" || pos === "absolute" || pos === "sticky") return true;
    // Extensions that style inside a shadow root leave a bare host element;
    // its only tell is an open shadow root.
    return !!node.shadowRoot;
  }

  // Foreign overlays keep arriving *after* our own UI mounts — read-frog's
  // selection toolbar, for one, renders a beat later inside a shadow root a
  // body-level observer cannot see into. So watchForeign also probes on a
  // few settle delays, and attaches observers inside any open shadow roots
  // it can reach.
  function watchForeign(rect, cb) {
    if (typeof MutationObserver !== "function" || !document.body) return () => {};
    let stopped = false;
    let pending = false;
    const shadowObservers = [];
    const timers = [];
    const check = () => {
      pending = false;
      if (stopped) return;
      if (foreignAtRect(rect)) cb();
    };
    const later = () => {
      if (pending) return;
      pending = true;
      timers.push(setTimeout(check, 60));
    };
    const mo = new MutationObserver((records) => {
      if (pending || stopped) return;
      for (const rec of records) {
        for (const n of rec.addedNodes) {
          if (!isCandidate(n)) continue;
          if (n.shadowRoot) {
            // Watch inside the open shadow too — toolbar content mounts there.
            const inner = new MutationObserver(later);
            try { inner.observe(n.shadowRoot, { childList: true, subtree: true }); } catch (err) { console.warn("[agentbrowser] shadow observe failed", err); }
            shadowObservers.push(inner);
          }
          later();
          return;
        }
      }
    });
    try {
      mo.observe(document.body, { childList: true, subtree: true });
      // Attach into open shadow roots already present (foreign overlays that
      // mounted before us — their hosts live at body level). Both caps are
      // deliberate: a full querySelectorAll("*") sweep is O(page size) and
      // web-component-heavy sites (YouTube) expose hundreds of open roots —
      // an observer on each one would fan every DOM churn into our check.
      const all = document.body.querySelectorAll("*");
      let attached = 0;
      for (let i = 0; i < all.length && i < 1500 && attached < 24; i++) {
        const el = all[i];
        if (el.shadowRoot && !(el.id && String(el.id).startsWith(OWN_PREFIX))) {
          const inner = new MutationObserver(later);
          try { inner.observe(el.shadowRoot, { childList: true, subtree: true }); } catch (err) { console.warn("[agentbrowser] shadow attach failed", err); }
          shadowObservers.push(inner);
          attached++;
        }
      }
      // Settle probes: closed-shadow and delayed floaters leave no observable
      // mutation at all — re-probe the rect a few times before standing down.
      for (const delay of [150, 450, 900, 1600]) {
        timers.push(setTimeout(() => { if (!stopped) check(); }, delay));
      }
    } catch (err) {
      console.warn("[agentbrowser] float guard observer failed", err);
      return () => {};
    }
    return () => {
      stopped = true;
      mo.disconnect();
      for (const o of shadowObservers) o.disconnect();
      for (const t of timers) clearTimeout(t);
    };
  }

  window.__abFloatGuard = { isOwn, foreignOverlayAt, foreignAtRect, watchForeign };
})();
