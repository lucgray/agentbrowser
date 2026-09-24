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

// --- page-side expressions --------------------------------------------------

// Element -> a stable CSS path ("html>body>div:nth-of-type(2)>p").
// Used to relocate elements for patch_revert after the DOM may have shifted.
const CSS_PATH_FN = `
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
