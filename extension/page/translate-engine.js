// Page-side translation engine (PROTOCOL v2.14). Injected into the tab by
// translate.js via Runtime.evaluate with translate-core.js prepended (exports
// stripped) — this file must stay free of import/export and chrome.* calls.
//
// Surface it installs:
//   window.__abTranslate.start(cfg)      -> {paragraphs}
//   window.__abTranslate.stop()          -> {stopped:true}
//   window.__abTranslate.configure(cfg)  -> live mode/lang/wordHover update
//   window.__abTranslate.applyBatch(req, map) -> render results {tid:text}
//   window.__abTranslate.applyWord(tid, text) -> fill the hover tooltip
//   window.__abTranslate.translatePara(tid)   -> on-demand one-paragraph
//   window.__abTranslate.status()             -> counters for the panel
// Outbound: __abTranslateBus(JSON.stringify({kind:'batch'|'word'|'progress'|
// 'ready'|'error', ...})) — a Runtime.addBinding channel the service worker
// forwards to the hub.
(function () {
  'use strict';
  if (window.__abTranslate && window.__abTranslate.__v === 1) return;

  var TID_ATTR = 'data-ab-tid';
  var HOST_CLASS = 'ab-trans-host';
  var UI_ATTR = 'data-ab-ui';
  var nextTid = 1;
  var nextReq = 1;

  var cfg = resolveEngineConfig({});
  var active = false;
  var paragraphs = new Map(); // tid -> {el, text, state: 'pending'|'sent'|'done'|'skipped'}
  var pending = new Map();    // tid -> true while awaiting a batch flush
  var inflight = new Map();   // req -> {tids:[], count}
  var io = null;
  var mo = null;
  var moTimer = null;
  var flushTimer = null;
  var stats = { total: 0, done: 0, translating: 0 };
  var floatBtn = null;        // shared on-demand affordance
  var wordTip = null;         // shared word tooltip
  var wordWrapped = new WeakSet();
  var hoveredPara = null;
  var styleEl = null;

  var busWarned = false;
  function bus(obj) {
    try {
      if (typeof __abTranslateBus === 'function') __abTranslateBus(JSON.stringify(obj));
    } catch (e) {
      // Page bridge gone — warn once, not per call.
      if (!busWarned) { busWarned = true; console.warn('[agentbrowser] translate bus failed', e); }
    }
  }

  // ---------------------------------------------------------------- styles
  var CSS = `
  .${HOST_CLASS}{display:block}
  .ab-t-body{position:relative;font-size:.95em;color:#565c64;line-height:1.8;
    font-family:inherit}
  .ab-t-tag{display:none;position:absolute;font-size:10px;font-weight:600;
    letter-spacing:.6px;line-height:1;padding:3px 8px;border-radius:99px;
    user-select:none}
  .ab-t-mode-bilingual .ab-t-body{padding:1px 0 2px 14px}
  .ab-t-mode-bilingual .ab-t-body::before{content:"";position:absolute;left:0;
    top:5px;bottom:6px;width:2px;border-radius:2px;
    background:linear-gradient(180deg,#8fa6ff 0%,#d7defa 100%)}
  .ab-t-mode-bilingual .${HOST_CLASS}{margin-top:.2em;margin-bottom:.4em}
  .ab-t-mode-card .ab-t-body{background:#fff;border:1px solid #e5e8f2;
    border-radius:12px;padding:14px 16px 13px;color:#3c4250;
    box-shadow:0 2px 12px rgba(55,65,100,.07)}
  .ab-t-mode-card .ab-t-tag{display:inline-block;top:-7px;left:14px;
    background:#4a6cf7;color:#fff;box-shadow:0 2px 6px rgba(74,108,247,.35)}
  .ab-t-mode-card .${HOST_CLASS}{margin-top:11px}
  .ab-t-mode-dim.ab-src{color:#9aa0a6 !important}
  .ab-t-mode-replace.ab-src{display:none !important}
  .ab-t-loading{color:transparent !important;border:0 !important;padding:0 !important;
    background:linear-gradient(90deg,#e8eaee 25%,#f4f5f8 50%,#e8eaee 75%) !important;
    background-size:200% 100% !important;animation:ab-shim 1.1s infinite;
    border-radius:6px;min-height:1.6em}
  @keyframes ab-shim{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .ab-para-btn{position:absolute;z-index:2147483000;width:22px;height:22px;
    border-radius:6px;border:1px solid #e4e6eb;background:#fff;color:#65676b;
    font-size:12px;line-height:20px;text-align:center;cursor:pointer;
    box-shadow:0 1px 4px rgba(0,0,0,.08);font-family:inherit;padding:0}
  .ab-para-btn:hover{border-color:#4a6cf7;color:#4a6cf7}
  .ab-para-btn.ab-on{border-color:#4a6cf7;color:#4a6cf7}
  .ab-word-tip{position:fixed;z-index:2147483001;max-width:280px;background:#23262b;
    color:#f2f3f5;border-radius:8px;padding:7px 11px;font-size:13px;
    line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.22);pointer-events:none;
    font-family:inherit}
  .ab-word-tip .w{font-weight:600;color:#8fa6ff;margin-right:6px}
  span.abw{border-radius:3px}
  span.abw:hover{background:rgba(74,108,247,.16)}
  `;

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute(UI_ATTR, '');
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // Mask inline code/math so the provider sees "... {{1}} ..." and can
  // neither drop nor rewrite it. Originals ride on the paragraph record and
  // are cloned back in at render time.
  function extractMasked(el) {
    var protect = [];
    var parts = [];
    (function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { parts.push(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        if (c.hasAttribute && c.hasAttribute(UI_ATTR)) continue;
        if (c.classList && c.classList.contains(HOST_CLASS)) continue;
        if (PROTECT_TAGS.has(c.tagName) && protect.length < PROTECT_MAX) {
          protect.push(c.cloneNode(true));
          parts.push(' {{' + protect.length + '}} ');
          continue;
        }
        walk(c);
      }
    })(el);
    return { text: parts.join(''), protect: protect };
  }

  // Restore {{n}} placeholders into cloned originals; unmatched placeholders
  // (provider invented one, or list overflow) render as their literal text.
  function renderTranslated(t, text, protect) {
    var segs = splitProtected(text);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.text !== undefined) {
        t.appendChild(document.createTextNode(s.text));
      } else {
        var orig = protect && protect[s.idx - 1];
        if (orig) t.appendChild(orig.cloneNode(true));
        else t.appendChild(document.createTextNode('{{' + s.idx + '}}'));
      }
    }
  }

  // ---------------------------------------------------------------- walker
  // Returns true when the element was labeled — a labeled paragraph owns its
  // whole subtree (its textContent is the unit), so the walk does not descend.
  function label(el) {
    if (!(el instanceof Element)) return false;
    if (el.hasAttribute(TID_ATTR)) return true;
    if (el.closest('[' + UI_ATTR + ']') || el.closest('.' + HOST_CLASS)) return true;
    if (SKIP_TAGS.has(el.tagName) || el.isContentEditable) return true;
    if (!hasProseChild(el.childNodes)) return false;
    var ex = extractMasked(el);
    var text = normalizeText(ex.text);
    if (text.length < cfg.minChars) return false;
    var tid = nextTid++;
    el.setAttribute(TID_ATTR, String(tid));
    paragraphs.set(tid, { el: el, text: text, protect: ex.protect, state: 'pending' });
    stats.total++;
    if (cfg.mode !== 'ondemand' && io) io.observe(el);
    return true;
  }

  // Iterative, time-sliced walk: ≤40 ms per slice then yields, so a heavy page
  // never janks. Elements already labeled or under our own UI are not re-cut.
  function walk(root) {
    var stack = [root || document.documentElement];
    drainStack(stack, Date.now() + 40);
  }
  function drainStack(stack, deadline) {
    while (stack.length) {
      var node = stack.pop();
      if (node instanceof ShadowRoot) {
        for (var i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      } else if (node instanceof Element) {
        if (!label(node)) {
          if (node.shadowRoot) stack.push(node.shadowRoot);
          for (var c = node.children.length - 1; c >= 0; c--) stack.push(node.children[c]);
        }
      }
      if (Date.now() > deadline) {
        setTimeout(function () { drainStack(stack, Date.now() + 40); }, 0);
        return;
      }
    }
  }

  // ------------------------------------------------------------- observers
  function setupObservers() {
    io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var el = entries[i].target;
        io.unobserve(el);
        var tid = Number(el.getAttribute(TID_ATTR));
        if (tid) queuePara(tid);
      }
    }, { rootMargin: cfg.viewportMargin, threshold: 0 });

    mo = new MutationObserver(function (mutations) {
      var any = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n instanceof Element && !n.closest('[' + UI_ATTR + ']') &&
              !n.closest('.' + HOST_CLASS)) { any = true; }
        }
      }
      if (!any) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(function () { walk(document.documentElement); }, 350);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ----------------------------------------------------------------- queue
  function queuePara(tid) {
    var rec = paragraphs.get(tid);
    if (!rec || rec.state !== 'pending') return;
    if (looksLikeTargetLang(rec.text, cfg.targetLang)) {
      rec.state = 'skipped';
      stats.done++;
      reportProgress();
      return;
    }
    rec.state = 'queued';
    pending.set(tid, true);
    if (pending.size >= cfg.maxItemsPerBatch) flush();
    else if (!flushTimer) {
      flushTimer = setTimeout(flush, cfg.batchFlushMs);
    }
  }

  function flush() {
    flushTimer = null;
    if (!pending.size) return;
    // Split into provider-sized batches here so one bus call carries at most
    // one provider request's worth of work.
    var items = [];
    var chars = 0;
    for (var tid of pending.keys()) {
      var rec = paragraphs.get(tid);
      if (!rec || rec.state !== 'queued') { pending.delete(tid); continue; }
      if (items.length >= cfg.maxItemsPerBatch || chars + rec.text.length > cfg.maxCharsPerBatch) break;
      items.push({ tid: tid, text: rec.text });
      chars += rec.text.length;
      pending.delete(tid);
      rec.state = 'sent';
      stats.translating++;
    }
    if (!items.length) return;
    var req = nextReq++;
    inflight.set(req, { tids: items.map(function (i) { return i.tid; }) });
    bus({ kind: 'batch', req: req, items: items });
    if (pending.size && !flushTimer) flushTimer = setTimeout(flush, cfg.batchFlushMs);
  }

  function reportProgress() {
    bus({ kind: 'progress', total: stats.total, done: stats.done,
          translating: stats.translating });
  }

  // --------------------------------------------------------------- render
  function hostFor(el) {
    var next = el.nextElementSibling;
    if (next && next.classList && next.classList.contains(HOST_CLASS)) return next;
    var host = document.createElement('ab-trans');
    host.className = HOST_CLASS + ' ab-t-mode-' + cfg.mode;
    host.setAttribute('translate', 'no');
    host.setAttribute(UI_ATTR, '');
    el.parentNode && el.parentNode.insertBefore(host, next);
    return host;
  }

  function renderPara(tid, text) {
    var rec = paragraphs.get(tid);
    if (!rec || rec.state === 'done') return;
    var el = rec.el;
    if (!el.isConnected) { rec.state = 'pending'; return; }
    var host = hostFor(el);
    var body = host.querySelector('.ab-t-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'ab-t-body';
      body.innerHTML = '<span class="ab-t-tag">译</span><span class="ab-t-text"></span>';
      host.appendChild(body);
    }
    var t = body.querySelector('.ab-t-text');
    body.classList.remove('ab-t-loading');
    t.textContent = '';
    renderTranslated(t, text, rec.protect);
    if (cfg.mode === 'dim') el.classList.add('ab-t-mode-dim', 'ab-src');
    if (cfg.mode === 'replace') el.classList.add('ab-t-mode-replace', 'ab-src');
    rec.state = 'done';
    rec.rendered = text;
    stats.done++;
    stats.translating = Math.max(0, stats.translating - 1);
    reportProgress();
  }

  // Re-render every done paragraph after a mode change — the structure stays,
  // only host class/source visibility move.
  function restyleAll() {
    for (var pair of paragraphs) {
      var rec = pair[1];
      var el = rec.el;
      el.classList.remove('ab-t-mode-dim', 'ab-t-mode-replace', 'ab-src');
      var host = el.nextElementSibling;
      if (host && host.classList && host.classList.contains(HOST_CLASS)) {
        host.className = HOST_CLASS + ' ab-t-mode-' + cfg.mode;
      }
      if (rec.state === 'done') {
        if (cfg.mode === 'dim') el.classList.add('ab-t-mode-dim', 'ab-src');
        if (cfg.mode === 'replace') el.classList.add('ab-t-mode-replace', 'ab-src');
      }
    }
  }

  // -------------------------------------------------------- on-demand mode
  function ensureFloatBtn() {
    if (floatBtn && floatBtn.isConnected) return floatBtn;
    floatBtn = document.createElement('button');
    floatBtn.className = 'ab-para-btn';
    floatBtn.setAttribute(UI_ATTR, '');
    floatBtn.textContent = '译';
    floatBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (hoveredPara) togglePara(hoveredPara);
    });
    document.documentElement.appendChild(floatBtn);
    return floatBtn;
  }

  function onMouseOver(e) {
    // Hovering our own button/tooltip must not clear the hovered paragraph —
    // the float button sits outside the paragraph and would hide on approach.
    var inUI = e.target && e.target.closest ? e.target.closest('[' + UI_ATTR + ']') : null;
    var el = e.target && e.target.closest ? e.target.closest('[' + TID_ATTR + ']') : null;
    if (cfg.mode === 'ondemand' && !inUI) {
      hoveredPara = el;
      var b = ensureFloatBtn();
      if (el) {
        var r = el.getBoundingClientRect();
        b.style.display = 'block';
        b.style.left = (r.left + window.scrollX - 30) + 'px';
        b.style.top = (r.top + window.scrollY + 4) + 'px';
        var tid = Number(el.getAttribute(TID_ATTR));
        var rec = paragraphs.get(tid);
        var done = rec && rec.state === 'done';
        b.textContent = done ? '原' : '译';
        b.classList.toggle('ab-on', !!done);
      } else {
        b.style.display = 'none';
      }
    }
    if (cfg.wordHover) maybeWordTip(e);
  }

  // Single-paragraph translate used by the on-demand button AND the
  // translate_para tool — works in any mode once the engine is up.
  function togglePara(el) {
    var tid = typeof el === 'number' ? el : Number(el && el.getAttribute(TID_ATTR));
    var rec = paragraphs.get(tid);
    if (!rec) return;
    var btn = floatBtn;
    if (rec.state === 'done') {
      // 原 -> restore the source, drop the rendered block.
      var host = rec.el.nextElementSibling;
      if (host && host.classList && host.classList.contains(HOST_CLASS)) host.remove();
      rec.el.classList.remove('ab-t-mode-dim', 'ab-t-mode-replace', 'ab-src');
      rec.state = 'pending';
      stats.done--;
      if (btn && hoveredPara === rec.el) { btn.textContent = '译'; btn.classList.remove('ab-on'); }
      reportProgress();
      return;
    }
    if (rec.state === 'sent' || rec.state === 'queued') return;
    rec.state = 'queued';
    pending.set(tid, true);
    if (btn) btn.textContent = '…';
    flush();
  }

  // -------------------------------------------------------------- word tip
  function wrapWords(el) {
    if (wordWrapped.has(el)) return;
    wordWrapped.add(el);
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!LETTER_RE.test(n.nodeValue || '')) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (p && p.closest('[' + UI_ATTR + ']')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var frag = document.createDocumentFragment();
      var parts = String(n.nodeValue).split(/(\s+)/);
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (part === '') continue;
        if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(part));
        else {
          var s = document.createElement('span');
          s.className = 'abw';
          s.textContent = part;
          frag.appendChild(s);
        }
      }
      n.parentNode.replaceChild(frag, n);
    }
  }

  function ensureWordTip() {
    if (wordTip && wordTip.isConnected) return wordTip;
    wordTip = document.createElement('div');
    wordTip.className = 'ab-word-tip';
    wordTip.setAttribute(UI_ATTR, '');
    wordTip.style.display = 'none';
    document.documentElement.appendChild(wordTip);
    return wordTip;
  }

  function maybeWordTip(e) {
    var tip = ensureWordTip();
    var s = e.target && e.target.closest ? e.target.closest('span.abw') : null;
    if (!s) {
      var para = e.target && e.target.closest ? e.target.closest('[' + TID_ATTR + ']') : null;
      if (para) wrapWords(para);
      else tip.style.display = 'none';
      return;
    }
    var raw = s.textContent;
    var r = s.getBoundingClientRect();
    tip.innerHTML = '';
    var w = document.createElement('span');
    w.className = 'w';
    w.textContent = raw;
    tip.appendChild(w);
    tip.appendChild(document.createTextNode('…'));
    tip.style.display = 'block';
    tip.style.left = Math.max(8, r.left + r.width / 2 - 60) + 'px';
    tip.style.top = Math.max(8, r.top + window.scrollY - 44) + 'px';
    tip.style.position = 'absolute';
    tip.dataset.tid = String(Number(s.closest('[' + TID_ATTR + ']').getAttribute(TID_ATTR)) || 0);
    tip.dataset.word = raw;
    bus({ kind: 'word', tid: Number(tip.dataset.tid) || 0, text: raw });
  }

  function applyWord(tid, text) {
    if (!wordTip || !wordTip.isConnected) return;
    if (String(tid) !== wordTip.dataset.tid) return;
    var w = wordTip.querySelector('.w');
    wordTip.innerHTML = '';
    if (w) wordTip.appendChild(w);
    wordTip.appendChild(document.createTextNode(text));
  }

  // ----------------------------------------------------------------- api
  window.__abTranslate = {
    __v: 1,

    start: function (userCfg) {
      cfg = resolveEngineConfig(userCfg);
      ensureStyle();
      if (!active) {
        active = true;
        setupObservers();
        document.addEventListener('mouseover', onMouseOver, true);
        document.addEventListener('scroll', hideWordTip, { passive: true, capture: true });
      }
      walk(document.documentElement);
      reportProgress();
      return { paragraphs: stats.total, mode: cfg.mode, targetLang: cfg.targetLang };
    },

    stop: function () {
      active = false;
      if (io) io.disconnect();
      if (mo) mo.disconnect();
      clearTimeout(moTimer);
      clearTimeout(flushTimer);
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('scroll', hideWordTip, true);
      for (var pair of paragraphs) {
        var rec = pair[1];
        rec.el.removeAttribute(TID_ATTR);
        rec.el.classList.remove('ab-t-mode-dim', 'ab-t-mode-replace', 'ab-src');
        var host = rec.el.nextElementSibling;
        if (host && host.classList && host.classList.contains(HOST_CLASS)) host.remove();
      }
      paragraphs.clear();
      pending.clear();
      inflight.clear();
      stats = { total: 0, done: 0, translating: 0 };
      if (floatBtn) floatBtn.remove();
      if (wordTip) wordTip.remove();
      if (styleEl) styleEl.remove();
      floatBtn = null;
      wordTip = null;
      styleEl = null;
      return { stopped: true };
    },

    configure: function (next) {
      var wasMode = cfg.mode;
      cfg = resolveEngineConfig({ ...cfg, ...(next || {}) });
      if (cfg.mode !== wasMode) restyleAll();
      if (cfg.mode !== 'ondemand') {
        for (var pair of paragraphs) {
          if (pair[1].state === 'pending') queuePara(pair[0]);
        }
      }
      return { mode: cfg.mode, targetLang: cfg.targetLang, wordHover: cfg.wordHover };
    },

    applyBatch: function (req, map) {
      var flight = inflight.get(req);
      if (flight) inflight.delete(req);
      for (var k in map) {
        var tid = Number(k);
        var text = map[k];
        if (isNoTranslation(text)) text = '';
        if (text) renderPara(tid, text);
        else {
          var rec = paragraphs.get(tid);
          if (rec && rec.state === 'sent') { rec.state = 'skipped'; stats.done++; stats.translating--; }
        }
      }
      reportProgress();
      return { applied: Object.keys(map).length };
    },

    applyWord: applyWord,

    translatePara: function (tid) {
      var rec = paragraphs.get(Number(tid));
      if (!rec) return { ok: false, error: 'no paragraph with tid ' + tid };
      togglePara(rec.el);
      return { ok: true, tid: Number(tid) };
    },

    status: function () {
      return { active: active, total: stats.total, done: stats.done,
               translating: stats.translating, mode: cfg.mode,
               targetLang: cfg.targetLang };
    },
  };

  function hideWordTip() {
    if (wordTip) wordTip.style.display = 'none';
  }

  bus({ kind: 'ready' });
})();
