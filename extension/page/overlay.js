// Builds the on-page "an agent is driving this tab" overlay.
//
// The overlay never runs as a content script: it is a string handed to CDP
// Runtime.evaluate on the tab cdp.js is already attached to. Everything here is a pure function: no chrome.* access,
// no side effects, so it can be unit-tested under plain node.
//
// The injected code owns exactly one node (#agentchat-overlay-root) appended to
// <html>, not <body>: body.innerText is what read_page returns, and the overlay
// must not end up in the model's view of the page. Every value that comes from
// the caller crosses into the payload through JSON, and every label is written
// with textContent, so a label can never become code.
//
// Colors follow agentchat/DESIGN.md section 2: #22c55e accent, #0b0f0d surface,
// #dbe5df text, #9aa8a0 secondary. Motion follows section 6: 200ms in, 400ms
// out, cubic-bezier(0.2, 0, 0.2, 1).

export const OVERLAY_ROOT_ID = 'agentchat-overlay-root';

// How long the overlay stays up after the last action before it fades itself
// out and removes its node. Each new action resets this.
export const OVERLAY_IDLE_MS = 2500;

const MAX_LABEL_CHARS = 80;

// Tool name -> what the pill says. Anything unmapped falls back to "working".
const ACTION_LABELS = {
  navigate: 'navigating',
  read_page: 'reading page',
  click: 'clicking',
  type_text: 'typing',
  press_key: 'typing',
  screenshot: 'capturing screen',
  eval_js: 'running script',
};

const CLICK_ACTIONS = new Set(['click']);
const TYPE_ACTIONS = new Set(['type_text', 'press_key']);

export function labelForAction(action) {
  const key = typeof action === 'string' ? action : '';
  return ACTION_LABELS[key] || 'working';
}

// One line, bounded length. Newlines and control characters collapse to spaces
// so the pill can never grow a second row and shift its own layout.
function sanitizeLabel(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_CHARS);
  return text || 'working';
}

function finiteCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Viewport coordinates; clamp so a bogus number cannot produce a huge style.
  return Math.round(Math.max(-100000, Math.min(100000, n)));
}

// A JS string literal for `value`. U+2028/U+2029 and "<" are escaped too so the
// literal stays inert in every evaluation context.
function jsStringLiteral(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c');
}

// A JS expression that evaluates to a deep copy of `value` inside the page.
// Routing through JSON means quotes, backslashes and newlines in any label are
// safe by construction: there is no path from caller data to executable code.
function embedJson(value) {
  return 'JSON.parse(' + jsStringLiteral(JSON.stringify(value)) + ')';
}

/**
 * Build the self-contained IIFE to pass to Runtime.evaluate.
 *
 * @param {string} action  tool name, e.g. "click" or "read_page"
 * @param {{label?: string, x?: number, y?: number}} [detail]
 * @returns {string} JavaScript source, always valid, never throwing at runtime
 */
export function buildOverlayScript(action, detail) {
  const info = detail && typeof detail === 'object' ? detail : {};
  const label = sanitizeLabel(info.label != null ? info.label : labelForAction(action));
  const kind = CLICK_ACTIONS.has(action) ? 'click' : TYPE_ACTIONS.has(action) ? 'type' : 'plain';
  const x = finiteCoord(info.x);
  const y = finiteCoord(info.y);

  const data = {
    id: OVERLAY_ROOT_ID,
    label,
    kind,
    x: kind === 'click' ? x : null,
    y: kind === 'click' ? y : null,
    idleMs: OVERLAY_IDLE_MS,
  };

  return `(function () {
  try {
    var D = ${embedJson(data)};
    var d = document;
    var w = window;
    if (!d || !d.documentElement) return false;

    var ID = D.id;
    var EASE = 'cubic-bezier(0.2,0,0.2,1)';
    var ACCENT = '#22c55e';
    var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

    var reduce = false;
    try {
      reduce = !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { console.warn('[agentbrowser] overlay matchMedia check failed', e); }

    // Reset the idle timers: a new action means the overlay stays up longer.
    try { if (w.__agentchatOverlayIdle) clearTimeout(w.__agentchatOverlayIdle); } catch (e) { console.warn('[agentbrowser] overlay timer clear failed', e); }
    try { if (w.__agentchatOverlayKill) clearTimeout(w.__agentchatOverlayKill); } catch (e) { console.warn('[agentbrowser] overlay timer clear failed', e); }
    w.__agentchatOverlayIdle = null;
    w.__agentchatOverlayKill = null;

    var root = d.getElementById(ID);
    // If something on the page squatted our id, drop it and build our own.
    if (root && root.__agentchat !== true) {
      try { root.parentNode && root.parentNode.removeChild(root); } catch (e) { console.warn('[agentbrowser] overlay squatter removal failed', e); }
      root = null;
    }

    if (!root) {
      root = d.createElement('div');
      root.id = ID;
      root.__agentchat = true;
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;' +
        'background:none;pointer-events:none;' +
        'z-index:2147483600;opacity:0;transition:opacity 200ms ' + EASE + ';';
      // No 'contain', no 'transform', no 'filter' on this node: any of those
      // would make it the containing block for its position:fixed children.

      var st = d.createElement('style');
      st.textContent =
        '#' + ID + ',#' + ID + ' *{pointer-events:none!important;box-sizing:border-box!important}' +
        '@keyframes agentchat-ov-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
        '@keyframes agentchat-ov-ripple{from{transform:scale(.5);opacity:1}to{transform:scale(2.8);opacity:0}}' +
        '@keyframes agentchat-ov-caret{0%,100%{opacity:.15}50%{opacity:1}}';
      root.appendChild(st);

      // Viewport glow: the tab is under agent control.
      var border = d.createElement('div');
      border.setAttribute('data-agentchat', 'border');
      border.style.cssText =
        'position:fixed;left:0;top:0;right:0;bottom:0;' +
        'border:2px solid rgba(34,197,94,0.55);' +
        'box-shadow:inset 0 0 26px rgba(34,197,94,0.32);pointer-events:none;';
      root.appendChild(border);

      // Status pill, bottom center.
      var pill = d.createElement('div');
      pill.setAttribute('data-agentchat', 'pill');
      pill.style.cssText =
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'display:flex;align-items:center;gap:8px;max-width:92vw;' +
        'padding:8px 14px;border-radius:999px;background:#0b0f0d;' +
        'border:1px solid rgba(34,197,94,0.45);box-shadow:0 0 16px rgba(34,197,94,0.28);' +
        'color:#dbe5df;font:600 14px/1.35 ' + FONT + ';white-space:nowrap;pointer-events:none;';

      var NS = 'http://www.w3.org/2000/svg';
      var bolt = d.createElementNS(NS, 'svg');
      bolt.setAttribute('viewBox', '0 0 24 24');
      bolt.setAttribute('width', '14');
      bolt.setAttribute('height', '14');
      bolt.setAttribute('fill', ACCENT);
      bolt.setAttribute('aria-hidden', 'true');
      var boltPath = d.createElementNS(NS, 'path');
      boltPath.setAttribute('d', 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z');
      bolt.appendChild(boltPath);
      try {
        bolt.style.cssText =
          'display:block;flex:0 0 auto;' +
          (reduce ? '' : 'animation:agentchat-ov-pulse 1600ms ease-in-out infinite;');
      } catch (e) { console.warn('[agentbrowser] overlay bolt style failed', e); }
      pill.appendChild(bolt);

      var name = d.createElement('span');
      name.setAttribute('data-agentchat', 'name');
      name.style.cssText = 'color:#dbe5df;font-weight:600;pointer-events:none;';
      name.textContent = 'AgentBrowser';
      pill.appendChild(name);

      var sep = d.createElement('span');
      sep.setAttribute('data-agentchat', 'sep');
      sep.style.cssText = 'color:#6f7d75;font-weight:400;pointer-events:none;';
      sep.textContent = '\\u00b7';
      pill.appendChild(sep);

      var act = d.createElement('span');
      act.setAttribute('data-agentchat', 'action');
      act.style.cssText =
        'color:#9aa8a0;font-weight:400;overflow:hidden;text-overflow:ellipsis;' +
        'max-width:60vw;pointer-events:none;';
      pill.appendChild(act);

      root.appendChild(pill);
      d.documentElement.appendChild(root);
      try { void root.offsetWidth; } catch (e) { console.warn('[agentbrowser] overlay reflow failed', e); }
    }

    root.style.transition = 'opacity 200ms ' + EASE;
    root.style.opacity = '1';

    var actionNode = null;
    try { actionNode = root.querySelector('[data-agentchat="action"]'); } catch (e) { console.warn('[agentbrowser] overlay action lookup failed', e); }
    // Written as text, never as markup: the label is inert by construction.
    if (actionNode) actionNode.textContent = D.label;

    // Click ripple at the coordinates the tool is about to dispatch.
    if (D.kind === 'click' && !reduce && D.x !== null && D.y !== null) {
      var ripple = d.createElement('div');
      ripple.style.cssText =
        'position:fixed;left:' + (D.x - 20) + 'px;top:' + (D.y - 20) + 'px;' +
        'width:40px;height:40px;border-radius:50%;border:2px solid ' + ACCENT + ';' +
        'background:rgba(34,197,94,0.20);box-shadow:0 0 12px rgba(34,197,94,0.60);' +
        'pointer-events:none;animation:agentchat-ov-ripple 600ms ' + EASE + ' forwards;';
      root.appendChild(ripple);
      setTimeout(function () {
        try { ripple.parentNode && ripple.parentNode.removeChild(ripple); } catch (e) { console.warn('[agentbrowser] overlay ripple cleanup failed', e); }
      }, 700);
    }

    // Caret shimmer over the focused field while text is going in. Read-only:
    // the focused element is measured, never styled.
    if (D.kind === 'type' && !reduce) {
      var rect = null;
      try {
        var target = d.activeElement;
        if (target && target !== d.body && target !== d.documentElement &&
            typeof target.getBoundingClientRect === 'function') {
          rect = target.getBoundingClientRect();
        }
      } catch (e) { console.warn('[agentbrowser] overlay caret rect failed', e); }
      if (rect && rect.width > 0 && rect.height > 0 && rect.width < 6000) {
        var h = Math.max(12, Math.min(rect.height - 8, 22));
        var caret = d.createElement('div');
        caret.style.cssText =
          'position:fixed;left:' + Math.round(rect.left + 10) + 'px;' +
          'top:' + Math.round(rect.top + (rect.height - h) / 2) + 'px;' +
          'width:2px;height:' + h + 'px;border-radius:1px;background:' + ACCENT + ';' +
          'box-shadow:0 0 8px rgba(34,197,94,0.70);pointer-events:none;' +
          'animation:agentchat-ov-caret 700ms ease-in-out 2;';
        root.appendChild(caret);
        setTimeout(function () {
          try { caret.parentNode && caret.parentNode.removeChild(caret); } catch (e) { console.warn('[agentbrowser] overlay caret cleanup failed', e); }
        }, 1500);
      }
    }

    w.__agentchatOverlayIdle = setTimeout(function () {
      try {
        var node = d.getElementById(ID);
        if (!node || node.__agentchat !== true) return;
        node.style.transition = 'opacity 400ms ' + EASE;
        node.style.opacity = '0';
        w.__agentchatOverlayKill = setTimeout(function () {
          try {
            var gone = d.getElementById(ID);
            // A newer action may have faded it back in; leave that one alone.
            if (gone && gone.__agentchat === true && gone.style.opacity === '0') {
              gone.parentNode && gone.parentNode.removeChild(gone);
            }
          } catch (e) { console.warn('[agentbrowser] overlay kill sweep failed', e); }
        }, 450);
      } catch (e) { console.warn('[agentbrowser] overlay fade failed', e); }
    }, D.idleMs);

    return true;
  } catch (e) {
    // Visual only. A hostile or locked-down page must never fail a tool call.
    console.warn('[agentbrowser] overlay injection failed', e);
    return false;
  }
})();`;
}
