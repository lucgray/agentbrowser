// Pure helpers for the inspection toolkit (inspect.js + sw.js TOOLS).
// No chrome.* references: importable from node --test. Page-side work is
// built as self-invoking Runtime.evaluate expressions.

export const CONSOLE_CAP = 500;
export const NETWORK_CAP = 500;
export const DIALOG_HOLD_MS = 5000;
export const TEXT_CAP = 1000;

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// RemoteObject[] -> printable arg list for console_log entries.
export function consoleArgsToText(args) {
  if (!Array.isArray(args)) return '';
  const parts = args.map((a) => {
    if (!a || typeof a !== 'object') return String(a);
    if (a.value !== undefined) return String(a.value);
    if (a.unserializableValue !== undefined) return String(a.unserializableValue);
    if (a.description) return truncate(a.description, 200);
    return String(a.type || 'object');
  });
  return truncate(parts.join(' '), TEXT_CAP);
}

// --- header sanitizing ------------------------------------------------------
// Credentials never leave the extension: these header names are dropped from
// every network_log/HAR response regardless of flags.
const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = typeof v === 'string' ? truncate(v, 500) : String(v);
  }
  return out;
}

// --- HAR 1.2 ----------------------------------------------------------------

export function buildHar(entries, page) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'AgentBrowser', version: '1.6' },
      pages: [
        {
          id: 'page_1',
          title: String((page && page.title) || ''),
          startedDateTime: new Date().toISOString(),
          pageTimings: {},
        },
      ],
      entries: entries.map((e) => ({
        pageref: 'page_1',
        startedDateTime: new Date(e.startTime || Date.now()).toISOString(),
        time: e.duration != null ? e.duration : -1,
        request: {
          method: e.method || 'GET',
          url: e.url || '',
          headers: Object.entries(sanitizeHeaders(e.requestHeaders)).map(
            ([name, value]) => ({ name, value })
          ),
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: e.status || 0,
          statusText: e.errorText || '',
          mimeType: e.mimeType || '',
          headers: Object.entries(sanitizeHeaders(e.responseHeaders)).map(
            ([name, value]) => ({ name, value })
          ),
          content: { size: e.size || 0, mimeType: e.mimeType || '' },
          headersSize: -1,
          bodySize: e.size || 0,
          redirectURL: '',
        },
        timings: { send: -1, wait: e.duration != null ? e.duration : -1, receive: -1 },
      })),
    },
  };
}

// --- Debugger domain helpers -------------------------------------------------

// CDP callFrames -> compact stack summary for tool output. `scripts` maps
// scriptId -> url (filled by Debugger.scriptParsed). Scope/local data is
// deliberately left out — agents read it on demand with debug_eval.
export function summarizeCallFrames(callFrames, scripts) {
  return (Array.isArray(callFrames) ? callFrames : []).map((f) => {
    const loc = (f && f.location) || {};
    const url =
      (f && f.url) ||
      (scripts && loc.scriptId && scripts.get(loc.scriptId)) ||
      '';
    return {
      callFrameId: f && f.callFrameId,
      functionName: (f && f.functionName) || '(anonymous)',
      url: String(url),
      lineNumber: loc.lineNumber ?? 0,
      columnNumber: loc.columnNumber ?? 0,
    };
  });
}

// --- page-side expressions --------------------------------------------------

// Element -> a stable CSS path ("html>body>div:nth-of-type(2)>p").
// Used to relocate elements for patch_revert after the DOM may have shifted,
// and as the `path` field on element_check / dom_inspect / page_snapshot /
// read_elements so a match stays addressable after navigation (unlike the
// per-snapshot data-ab-node stamp).
export const CSS_PATH_FN = `
function abCssPath(el) {
  var path = [];
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    var sel = el.localName;
    if (el.id) { sel += '#' + CSS.escape(el.id); path.unshift(sel); break; }
    var parent = el.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) {
        return c.localName === el.localName;
      });
      if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    path.unshift(sel);
    el = parent;
  }
  path.unshift('html');
  return path.join('>');
}`;

export function domInspectExpression({ selector, all = true, styles = [], max = 25 }) {
  const want = JSON.stringify(Array.isArray(styles) ? styles : []);
  return `(function () {
${CSS_PATH_FN}
  var max = ${Number(max) || 25};
  var wantStyles = ${want};
  var defaultStyles = ['display','position','visibility','color','background-color','font-size','margin','padding','z-index','overflow'];
  var sel = ${JSON.stringify(String(selector || ''))};
  var els = ${all ? 'Array.prototype.slice.call(document.querySelectorAll(sel))' : '[document.querySelector(sel)].filter(Boolean)'};
  els = els.slice(0, max);
  return {
    url: location.href,
    selector: sel,
    matched: els.length,
    elements: els.map(function (el) {
      var cs = getComputedStyle(el);
      var names = wantStyles.length ? wantStyles : defaultStyles;
      var styles = {};
      names.forEach(function (n) { styles[n] = cs.getPropertyValue(n); });
      var r = el.getBoundingClientRect();
      var attrs = {};
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (attrs.hasOwnProperty(a.name)) return;
        attrs[a.name] = String(a.value).slice(0, 300);
      });
      return {
        tag: el.localName,
        id: el.id || null,
        classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 200) : null,
        path: abCssPath(el),
        attributes: attrs,
        text: (el.innerText || el.textContent || '').slice(0, 300),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        styles: styles,
      };
    }),
  };
})()`;
}

// Fallback when Accessibility.getFullAXTree is unavailable: a semantic
// outline of landmarks, headings, links and form controls.
export function outlineExpression(maxDepth = 6) {
  return `(function () {
  var maxDepth = ${Number(maxDepth) || 6};
  var nodes = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  var depth = 0;
  var el = document.body;
  while (el && nodes.length < 800) {
    var role = el.getAttribute('role') ||
      ({ NAV:'navigation', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo',
         ASIDE:'complementary', SECTION:'region', FORM:'form', A:'link',
         BUTTON:'button', INPUT:'textbox', SELECT:'combobox', TEXTAREA:'textbox',
         H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading',
         H6:'heading', IMG:'img', TABLE:'table', UL:'list', OL:'list', LI:'listitem',
         DIALOG:'dialog' })[el.tagName] || null;
    if (role) {
      var name = el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('title') || el.getAttribute('placeholder') ||
        (el.innerText || '').slice(0, 80);
      nodes.push({ depth: depth, role: role, name: name.replace(/\\s+/g, ' ').trim(), tag: el.localName });
    }
    if (el.firstElementChild && depth < maxDepth) { el = el.firstElementChild; depth++; continue; }
    while (el && !el.nextElementSibling) { el = el.parentElement; depth--; }
    el = el ? el.nextElementSibling : null;
  }
  return { url: location.href, title: document.title, nodes: nodes };
})()`;
}

export function patchApplyExpression(patches) {
  const spec = JSON.stringify(
    (Array.isArray(patches) ? patches : []).map((p) => ({
      selector: String((p && p.selector) || ''),
      styles: p && p.styles && typeof p.styles === 'object' ? p.styles : null,
      attributes: p && p.attributes && typeof p.attributes === 'object' ? p.attributes : null,
      insertAdjacentHTML:
        p && p.insertAdjacentHTML && typeof p.insertAdjacentHTML === 'object'
          ? { position: String(p.insertAdjacentHTML.position || 'beforeend'), html: String(p.insertAdjacentHTML.html || '') }
          : null,
      remove: !!(p && p.remove),
    }))
  );
  return `(function () {
${CSS_PATH_FN}
  var patches = ${spec};
  var results = [];
  patches.forEach(function (p) {
    if (!p.selector) { results.push({ selector: '', error: 'empty selector' }); return; }
    var els;
    try { els = Array.prototype.slice.call(document.querySelectorAll(p.selector)); }
    catch (e) { results.push({ selector: p.selector, error: 'bad selector: ' + e.message }); return; }
    var items = [];
    els.slice(0, 20).forEach(function (el) {
      items.push({ path: abCssPath(el), outerHTML: el.outerHTML });
      if (p.remove) { el.remove(); return; }
      if (p.styles) for (var k in p.styles) el.style.setProperty(k, String(p.styles[k]));
      if (p.attributes) for (var a in p.attributes) {
        if (p.attributes[a] === null) el.removeAttribute(a);
        else el.setAttribute(a, String(p.attributes[a]));
      }
      if (p.insertAdjacentHTML) {
        var pos = ['beforebegin','afterbegin','beforeend','afterend'].indexOf(p.insertAdjacentHTML.position) >= 0
          ? p.insertAdjacentHTML.position : 'beforeend';
        el.insertAdjacentHTML(pos, p.insertAdjacentHTML.html);
      }
    });
    results.push({ selector: p.selector, matched: els.length, items: items });
  });
  return { url: location.href, results: results };
})()`;
}

export function patchRevertExpression(items) {
  const spec = JSON.stringify(
    (Array.isArray(items) ? items : []).map((i) => ({
      path: String((i && i.path) || ''),
      outerHTML: String((i && i.outerHTML) || ''),
    }))
  );
  return `(function () {
  var items = ${spec};
  var reverted = 0, missing = 0;
  items.forEach(function (i) {
    var el = null;
    try { el = document.querySelector(i.path); } catch (e) { el = null; }
    if (!el) { missing++; return; }
    el.outerHTML = i.outerHTML;
    reverted++;
  });
  return { reverted: reverted, missing: missing };
})()`;
}

// Shared by element_check and the click_element/type_text selector gates: a
// read-only probe that lists a selector's matches with the facts a click
// gate needs — visibility, occlusion via elementFromPoint at the rect
// center, and a stable `path` for each match.
export function elementCheckExpression({ selector, max = 10 } = {}) {
  const cap = Math.max(1, Math.min(Number(max) || 10, 50));
  return `(function () {
${CSS_PATH_FN}
  var sel = ${JSON.stringify(String(selector || ''))};
  var els;
  try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); }
  catch (e) { return { found: false, count: 0, error: 'bad selector: ' + e.message }; }
  var vw = window.innerWidth, vh = window.innerHeight;
  var rows = els.slice(0, ${cap}).map(function (el, i) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var visible = cs.display !== 'none' && cs.visibility === 'visible' && r.width > 0 && r.height > 0;
    var inViewport = visible && r.bottom >= 0 && r.right >= 0 && r.top <= vh && r.left <= vw;
    var occluder = null;
    if (inViewport) {
      var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        occluder = top.localName + (top.id ? '#' + top.id : '') +
          ((top.getAttribute('class') || '').trim().split(/\s+/)[0] ? '.' + (top.getAttribute('class') || '').trim().split(/\s+/)[0] : '');
      }
    }
    return {
      index: i,
      tag: el.localName,
      text: String(el.innerText || el.textContent || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      path: abCssPath(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: visible,
      inViewport: inViewport,
      occluded: !!occluder,
      occluder: occluder
    };
  });
  return { found: els.length > 0, count: els.length, matches: rows };
})()`;
}

// Click-half of the probe: after the caller picked a match index this
// scrolls it into view, then re-measures — the point and the occlusion test
// must reflect the post-scroll layout, not the pre-scroll one.
export function elementPointExpression({ selector, index = 0 } = {}) {
  const i = Math.max(0, Math.trunc(Number(index) || 0));
  return `(function () {
${CSS_PATH_FN}
  var el;
  try { el = document.querySelectorAll(${JSON.stringify(String(selector || ''))})[${i}]; }
  catch (e) { return { found: false, error: 'bad selector: ' + e.message }; }
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var cs = getComputedStyle(el);
  var r = el.getBoundingClientRect();
  var visible = cs.display !== 'none' && cs.visibility === 'visible' && r.width > 0 && r.height > 0;
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var occluder = null;
  if (visible && cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
    var top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      occluder = top.localName + (top.id ? '#' + top.id : '') +
        ((top.getAttribute('class') || '').trim().split(/\s+/)[0] ? '.' + (top.getAttribute('class') || '').trim().split(/\s+/)[0] : '');
    }
  }
  return {
    found: true,
    x: cx, y: cy, w: r.width, h: r.height,
    tag: el.localName,
    path: abCssPath(el),
    visible: visible,
    occluded: !!occluder,
    occluder: occluder
  };
})()`;
}

// page_snapshot: one evaluate maps the page's interactive layer — visible
// controls that an agent can act on. Each is stamped with `data-ab-node`
// (reused if already stamped) so a later `click_element {nodeId}` can hit it
// without a CSS selector; `path` is the stable CSS equivalent for across
// navigations. Text is truncated; the viewport check keeps off-screen
// elements out unless `full` asks for the whole document.
export function pageSnapshotExpression({ max = 300, maxChars = 80, full = false } = {}) {
  const cap = Math.max(1, Math.min(Number(max) || 300, 1000));
  const tcap = Math.max(1, Math.min(Number(maxChars) || 80, 500));
  const everywhere = full ? 'true' : 'false';
  return `(function () {
${CSS_PATH_FN}
  var SEL = 'a,button,input,select,textarea,summary,label,[role],[onclick],[contenteditable="true"],[tabindex]';
  var vw = window.innerWidth, vh = window.innerHeight;
  var out = [];
  var seq = 0;
  var els = document.querySelectorAll(SEL);
  for (var i = 0; i < els.length; i++) {
    if (out.length >= ${cap}) break;
    var el = els[i];
    if (el.getAttribute('tabindex') === '-1') continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (!${everywhere} && (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw)) continue;
    var node = el.getAttribute('data-ab-node');
    if (!node) { node = 'n' + (++seq); el.setAttribute('data-ab-node', node); }
    var text = String(el.innerText || el.textContent || el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('title') ||
      (el.tagName === 'INPUT' ? el.value : '') || '').replace(/\\s+/g, ' ').trim().slice(0, ${tcap});
    out.push({
      node: node,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || el.id || '',
      text: text,
      path: abCssPath(el),
      href: (typeof el.href === 'string' ? el.href : el.getAttribute('href') || '').slice(0, 200),
      value: ('value' in el ? String(el.value) : '').slice(0, 80),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height)
    });
  }
  return { url: location.href, count: out.length, nodes: out };
})()`;
}
