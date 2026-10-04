// Injected learn sidebar (PROTOCOL v2.18): a per-site transcript/summary
// panel docked next to the video — over the recommendations column in normal
// view, inside the player's right edge in fullscreen. Built with DOM APIs
// only: YouTube's Trusted Types CSP rejects innerHTML. The subtitle engine
// owns mount/update/stop; cue text never crosses innerHTML (textContent only).
(function () {
  if (window.__abSubSidebar) return;
  var SID = 'ab-sub-side';
  var W = 380;

  var CSS = [
    '#' + SID + '{position:fixed;width:' + W + 'px;z-index:2147483001;',
    'background:rgba(255,255,255,.94);backdrop-filter:blur(20px);',
    'border:1px solid #e4e4e7;border-radius:16px;display:flex;flex-direction:column;',
    'box-shadow:0 12px 40px rgba(0,0,0,.35);',
    'font:14px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;color:#18181b;overflow:hidden}',
    '#' + SID + ' .head{padding:8px 12px 0;border-bottom:1px solid #e4e4e7;display:flex}',
    '#' + SID + ' .tabs{display:flex;gap:4px;flex:1}',
    '#' + SID + ' .tabs button{border:0;background:none;font:600 13px inherit;color:#71717a;',
    'padding:8px 10px 9px;cursor:pointer;border-bottom:2px solid transparent}',
    '#' + SID + ' .tabs button.on{color:#18181b;border-color:#4f46e5}',
    '#' + SID + ' .x{border:0;background:none;color:#71717a;font-size:15px;cursor:pointer;padding:6px 8px}',
    '#' + SID + ' .tools{display:flex;gap:6px;padding:7px 12px;border-bottom:1px solid #e4e4e7;align-items:center}',
    '#' + SID + ' .tools button{border:1px solid #e4e4e7;background:#fff;border-radius:8px;',
    'font-size:11.5px;padding:4px 9px;cursor:pointer;color:#3f3f46}',
    '#' + SID + ' .tools button:hover{background:#f4f4f5}',
    '#' + SID + ' .live{margin-left:auto;font-size:11px;color:#16a34a;font-weight:600;',
    'display:flex;align-items:center;gap:4px}',
    '#' + SID + ' .live i{width:6px;height:6px;border-radius:50%;background:#16a34a;animation:abSbPulse 1.4s infinite}',
    '@keyframes abSbPulse{50%{opacity:.25}}',
    '#' + SID + ' .body{flex:1;overflow-y:auto;padding:8px 10px 16px;scrollbar-width:thin}',
    '#' + SID + ' .row{display:block;width:100%;text-align:left;border:0;background:none;cursor:pointer;',
    'padding:8px 10px;border-radius:10px;white-space:normal;overflow-wrap:break-word;',
    'transition:background .12s;font-family:inherit}',
    '#' + SID + ' .row:hover{background:#f1f1f3}',
    '#' + SID + ' .row .ts{font:500 11px ui-monospace,Menlo,monospace;color:#71717a}',
    '#' + SID + ' .row .src{display:block;font-size:13.5px;line-height:1.5;margin-top:1px;color:#18181b}',
    '#' + SID + ' .row .tr{display:block;font-size:13px;line-height:1.5;margin-top:1px;color:#71717a}',
    '#' + SID + ' .row.active{background:#eef2ff}',
    '#' + SID + ' .row.active .src{font-weight:600}',
    '#' + SID + ' .sum{padding:14px 16px;font-size:13.5px;color:#3f3f46}',
    '#' + SID + ' .sum h3{font-size:15px;margin:14px 0 6px;color:#18181b}',
    '#' + SID + ' .sum h3:first-child{margin-top:0}',
    '#' + SID + ' .sum p{margin:6px 0}',
    '#' + SID + ' .sum li{margin:3px 0 3px 16px}',
    '#' + SID + ' .sum .skl{height:11px;border-radius:6px;margin:9px 0;',
    'background:linear-gradient(90deg,#ececf0 25%,#f6f6f8 50%,#ececf0 75%);',
    'background-size:200% 100%;animation:abSbSkl 1.3s infinite}',
    '@keyframes abSbSkl{to{background-position:-200% 0}}',
  ].join('');

  var root = null;
  var styleEl = null;
  var bodyEl = null;
  var video = null;
  var cues = [];
  var follow = true;
  var activeEl = null;
  var busFn = null;
  var summaryState = 'idle'; // idle | loading | done | error

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // -------------------------------------------------------------- docking
  function playerEl() {
    return document.getElementById('movie_player') ||
      document.querySelector('.bpx-player-container, .bilibili-player-video-wrap, .html5-video-player') ||
      (video && video.parentElement);
  }

  function inFs() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function dock() {
    if (!root) return;
    // Elements outside the fullscreen element are clipped by the top layer —
    // reparent into the fullscreen host so the sidebar stays visible.
    var host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (root.parentElement !== host) host.appendChild(root);
    if (inFs()) {
      var pr = (playerEl() || video).getBoundingClientRect();
      var m = 10;
      root.style.top = (pr.top + m) + 'px';
      root.style.height = Math.max(120, pr.height - m * 2) + 'px';
      root.style.bottom = '';
      root.style.left = (pr.right - W - m) + 'px';
      root.style.right = '';
      root.style.width = W + 'px';
    } else {
      var sec = document.getElementById('secondary') || document.getElementById('related') ||
        document.querySelector('.recommend-list-v1, .right-container');
      var r = sec ? sec.getBoundingClientRect() : null;
      if (r && r.width > 200) {
        root.style.left = r.left + 'px';
        root.style.width = r.width + 'px';
        root.style.right = '';
      } else {
        root.style.left = '';
        root.style.right = '8px';
        root.style.width = W + 'px';
      }
      root.style.top = '8px';
      root.style.height = '';
      root.style.bottom = '64px';
    }
  }

  // ------------------------------------------------------------ transcript
  function renderRows() {
    bodyEl.textContent = '';
    for (var i = 0; i < cues.length; i++) {
      (function (c, idx) {
        var b = h('button', 'row');
        b.append(h('span', 'ts', fmtTs(c.start)), h('span', 'src', c.text));
        var tr = h('span', 'tr', c.translated || '');
        tr.style.display = c.translated ? 'block' : 'none';
        b.append(tr);
        b.onclick = function () {
          video.currentTime = c.start + 0.01;
          video.play && video.play().catch(function (err) {
            console.warn('[agentbrowser] sidebar seek play failed', err);
          });
        };
        c.el = b;
        bodyEl.appendChild(b);
      })(cues[i], i);
    }
  }

  function setActive(idx) {
    var c = idx >= 0 && idx < cues.length ? cues[idx] : null;
    var el = c && c.el;
    if (el === activeEl) return;
    if (activeEl) activeEl.classList.remove('active');
    activeEl = el || null;
    if (activeEl) {
      activeEl.classList.add('active');
      if (follow) activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  // --------------------------------------------------------------- summary
  function renderSummary() {
    bodyEl.textContent = '';
    var sum = h('div', 'sum');
    if (summaryState === 'loading') {
      for (var w = 0; w < 5; w++) {
        var s = h('div', 'skl');
        s.style.width = (95 - w * 7) + '%';
        sum.appendChild(s);
      }
    } else if (summaryState === 'error') {
      sum.appendChild(h('p', '', summaryError || '摘要生成失败'));
    } else if (summaryText) {
      // minimal markdown: ## / ### headings, - bullets, *em/strong* kept plain
      var lines = String(summaryText).split('\n');
      var list = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) { list = null; continue; }
        var m = /^(#{1,4})\s+(.*)$/.exec(line);
        if (m) { list = null; sum.appendChild(h('h3', '', m[2].replace(/\*\*/g, ''))); continue; }
        if (/^[-*•]\s+/.test(line)) {
          if (!list) { list = h('ul'); sum.appendChild(list); }
          list.appendChild(h('li', '', line.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '')));
          continue;
        }
        list = null;
        sum.appendChild(h('p', '', line.replace(/\*\*/g, '')));
      }
      if (!sum.children.length) sum.appendChild(h('p', '', summaryText));
    } else {
      sum.appendChild(h('p', '', '正在生成摘要…'));
    }
    bodyEl.appendChild(sum);
  }

  var summaryText = null;
  var summaryError = null;

  function requestSummary() {
    if (summaryState === 'loading' || summaryState === 'done') return;
    summaryState = 'loading';
    summaryError = null;
    renderSummary();
    busFn && busFn({ kind: 'summary' });
  }

  // --------------------------------------------------------------- tabs
  var activeTab = 'ts';
  function renderTab(name) {
    activeTab = name;
    var tabs = root && root.querySelectorAll('.tabs button');
    if (tabs) for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].dataset.t === name);
    }
    if (name === 'ts') { renderRows(); setActive(lastActive); }
    else if (name === 'sum') { if (summaryState === 'idle') requestSummary(); else renderSummary(); }
    else { // vocab placeholder
      bodyEl.textContent = '';
      var v = h('div', 'sum');
      v.appendChild(h('h3', '', '生词本'));
      v.appendChild(h('p', '', '双击逐句单词弹生词卡，存入后在这里管理（下一版接入）。'));
      bodyEl.appendChild(v);
    }
  }

  // --------------------------------------------------------------- mount
  function mount(opts) {
    unmount();
    cues = opts.cues || [];
    video = opts.video;
    busFn = opts.bus;
    follow = true;
    activeEl = null;
    summaryState = 'idle';
    summaryText = null;
    summaryError = null;
    activeTab = 'ts';

    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);

    root = h('div'); root.id = SID;
    var head = h('div', 'head');
    var tabs = h('div', 'tabs');
    [['ts', '逐句'], ['sum', 'AI 摘要'], ['vb', '生词本']].forEach(function (t) {
      var b = h('button', t[0] === 'ts' ? 'on' : '', t[1]);
      b.dataset.t = t[0];
      b.onclick = function () { renderTab(t[0]); };
      tabs.appendChild(b);
    });
    var x = h('button', 'x', '✕');
    x.onclick = unmount;
    head.append(tabs, x);

    var tools = h('div', 'tools');
    var srtB = h('button', '', '⬇ SRT');
    srtB.onclick = exportSrt;
    var folB = h('button', '', '⌖ 跟随');
    folB.onclick = function () {
      follow = !follow;
      folB.style.color = follow ? '#4f46e5' : '#3f3f46';
      if (follow && activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    var live = h('span', 'live');
    live.appendChild(h('i'));
    live.appendChild(document.createTextNode('LIVE'));
    tools.append(srtB, folB, live);

    bodyEl = h('div', 'body');
    root.append(head, tools, bodyEl);
    document.body.appendChild(root);
    renderRows();
    dock();
    playerRO = new ResizeObserver(dock);
    var p = playerEl();
    if (p) playerRO.observe(p);
    addEventListener('scroll', dock, { passive: true });
    addEventListener('resize', dock);
    document.addEventListener('fullscreenchange', dock);
    document.addEventListener('webkitfullscreenchange', dock);
  }

  var playerRO = null;
  var lastActive = -1;

  function exportSrt() {
    var srt = buildSrt(cues);
    if (!srt.trim()) return;
    var blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transcript.srt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function unmount() {
    if (playerRO) { playerRO.disconnect(); playerRO = null; }
    removeEventListener('scroll', dock);
    removeEventListener('resize', dock);
    document.removeEventListener('fullscreenchange', dock);
    document.removeEventListener('webkitfullscreenchange', dock);
    if (root && root.isConnected) root.remove();
    if (styleEl && styleEl.isConnected) styleEl.remove();
    root = null;
    styleEl = null;
    bodyEl = null;
    activeEl = null;
  }

  window.__abSubSidebar = {
    __v: 1,
    mount: mount,
    unmount: unmount,
    setActive: function (idx) { lastActive = idx; setActive(idx); },
    cueTranslated: function (idx) {
      var c = cues[idx];
      if (!c || !c.el || activeTab !== 'ts') return;
      var tr = c.el.querySelector('.tr');
      if (tr) { tr.textContent = c.translated || ''; tr.style.display = c.translated ? 'block' : 'none'; }
    },
    onSummary: function (r) {
      if (r && r.error) { summaryState = 'error'; summaryError = String(r.error); }
      else { summaryState = 'done'; summaryText = String(r && r.summary || ''); }
      if (activeTab === 'sum') renderSummary();
    },
    isOpen: function () { return !!root; },
  };
})();
