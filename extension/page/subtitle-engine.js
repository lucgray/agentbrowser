// Injected subtitle engine (PROTOCOL v2.16): probes the video site for
// caption-track parameters, drives the bilingual overlay, and queues cue
// translation through the __abSubtitleBus binding. Network fetching happens
// in the service worker (host permissions beat page-context CORS); this file
// only reads page globals, renders, and talks to the bus.
(function () {
  if (window.__abSubtitle) return;
  var UI_ATTR = 'data-ab-sub-ui';
  var WRAP_CLASS = 'ab-sub-wrap';
  var SEND_DEPTH = 3;   // max translation batches in flight
  var BATCH_SIZE = 4;   // cues per batch, same as the page translator

  var CSS = [
    '.ab-sub-wrap{position:absolute;left:50%;bottom:12%;transform:translateX(-50%);',
    'z-index:2147483000;max-width:88%;text-align:center;pointer-events:none;line-height:1.45}',
    '.ab-sub-wrap .ab-sub-src{font-size:14px;opacity:.7;color:#fff;',
    'text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 6px rgba(0,0,0,.6)}',
    '.ab-sub-wrap .ab-sub-zh{font-size:20px;font-weight:600;color:#fff;',
    'text-shadow:0 1px 4px rgba(0,0,0,.95),0 0 8px rgba(0,0,0,.7);margin-top:2px}',
  ].join('');

  var cfg = null;
  var cues = [];        // [{start,end,text,translated}]
  var video = null;
  var wrap = null;
  var styleEl = null;
  var container = null; // positioned ancestor we attach to
  var sendQueue = [];   // cue indexes pending send, in playback-first order
  var inflight = new Map(); // req -> cue indexes
  var nextReq = 1;
  var activeCue = -1;
  var running = false;
  var onTime = null;

  function bus(msg) {
    try {
      window.__abSubtitleBus && window.__abSubtitleBus(JSON.stringify(msg));
    } catch (err) {
      console.warn('[agentbrowser] subtitle bus failed', err);
    }
  }

  function findVideo() {
    var best = null, bestArea = 0;
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var r = vids[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { best = vids[i]; bestArea = area; }
    }
    return best;
  }

  // ------------------------------------------------------------- probing
  // Returns the fetch inputs the coordinator needs; never does network IO.
  function probe() {
    var site = detectSite(location.href);
    if (site === 'youtube') {
      var tracks = [];
      try {
        var pr = window.ytInitialPlayerResponse;
        var list = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
        for (var t of (list && list.captionTracks) || []) {
          if (t && t.baseUrl) {
            tracks.push({
              lang: String(t.languageCode || ''),
              name: String((t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode || ''),
              url: String(t.baseUrl) + (String(t.baseUrl).indexOf('fmt=') < 0 ? '&fmt=srv3' : ''),
              auto: t.kind === 'asr',
            });
          }
        }
      } catch (err) {
        console.warn('[agentbrowser] youtube track probe failed', err);
      }
      var vid = /[?&]v=([^&]+)/.exec(location.search);
      return { site: site, videoId: vid ? vid[1] : null, tracks: tracks };
    }
    if (site === 'bilibili') {
      var bvid = /\/video\/(BV[\w]+)/.exec(location.pathname);
      var st = window.__INITIAL_STATE__ || {};
      var vd = st.videoData || {};
      return {
        site: site,
        bvid: bvid ? bvid[1] : (vd.bvid || null),
        aid: vd.aid || null,
        cid: vd.cid || st.cid || window.cid || null,
      };
    }
    if (site === 'x') {
      // X ships HTML5 textTracks on the <video> itself — no network fetch at
      // all: the SW just asks us to read the cues out of the chosen track.
      var xv = findVideo();
      var xtracks = [];
      if (xv && xv.textTracks) {
        for (var i = 0; i < xv.textTracks.length; i++) {
          var tt = xv.textTracks[i];
          if (tt && (tt.kind === 'subtitles' || tt.kind === 'captions')) {
            xtracks.push({ index: i, lang: String(tt.language || ''), name: String(tt.label || tt.language || '') });
          }
        }
      }
      return { site: site, tracks: xtracks };
    }
    return { site: null };
  }

  // ------------------------------------------------------------ overlay
  function ensureUI() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute(UI_ATTR, '');
      styleEl.textContent = CSS;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    if (wrap && wrap.isConnected) return;
    container = (video && video.closest(
      '#movie_player, .html5-video-player, #bilibili-player, .bpx-player-container, .bilibili-player-video-wrap'
    )) || (video && video.parentElement) || document.documentElement;
    try {
      if (container !== document.documentElement &&
          getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
    } catch (err) {
      console.warn('[agentbrowser] subtitle container probe failed', err);
    }
    wrap = document.createElement('div');
    wrap.className = WRAP_CLASS;
    wrap.setAttribute(UI_ATTR, '');
    container.appendChild(wrap);
  }

  function render() {
    if (!running || !wrap) return;
    var c = activeCue >= 0 && activeCue < cues.length ? cues[activeCue] : null;
    wrap.textContent = '';
    if (!c) return;
    var src = document.createElement('div');
    src.className = 'ab-sub-src';
    src.textContent = c.text;
    wrap.appendChild(src);
    if (c.translated) {
      var zh = document.createElement('div');
      zh.className = 'ab-sub-zh';
      zh.textContent = c.translated;
      wrap.appendChild(zh);
    }
  }

  // ----------------------------------------------------- translation queue
  function sendMore() {
    while (inflight.size < SEND_DEPTH && sendQueue.length) {
      var idxs = sendQueue.splice(0, BATCH_SIZE);
      var items = [];
      for (var i = 0; i < idxs.length; i++) {
        var c = cues[idxs[i]];
        if (c && !c.translated) items.push({ tid: idxs[i], text: c.text });
      }
      if (!items.length) continue;
      var req = nextReq++;
      inflight.set(req, idxs);
      bus({ kind: 'sub-batch', req: req, items: items });
    }
  }

  function applyBatch(req, results) {
    var idxs = inflight.get(Number(req));
    inflight.delete(Number(req));
    if (results && typeof results === 'object') {
      for (var k in results) {
        var i = Number(k);
        var c = cues[i];
        if (c && results[k]) {
          c.translated = String(results[k]);
          if (window.__abSubSidebar) window.__abSubSidebar.cueTranslated(i);
        }
      }
    }
    sendMore();
    render(); // the current cue may have just been translated
  }

  // ------------------------------------------------------------- x tracks
  // Read cues out of an HTML5 TextTrack. mode='hidden' keeps them loading
  // without showing X's own rendering; some players leave tracks unloaded
  // until asked, so we poll briefly for cues to appear.
  function readTextTrackCues(index) {
    var v = findVideo();
    if (!v || !v.textTracks) return Promise.resolve({ error: 'no video' });
    var track = v.textTracks[Number(index)];
    if (!track || (track.kind !== 'subtitles' && track.kind !== 'captions')) {
      return Promise.resolve({ error: 'no subtitle track at index ' + index });
    }
    var hadMode = track.mode;
    track.mode = 'hidden';
    var deadline = Date.now() + 4000;
    return new Promise(function (resolve) {
      (function poll() {
        var list = track.cues;
        if (list && list.length) {
          var out = [];
          for (var i = 0; i < list.length; i++) {
            var c = list[i];
            var text = String(c.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) out.push({ start: c.startTime, end: c.endTime, text: text });
          }
          if (out.length) {
            resolve({ cues: out, track: { lang: String(track.language || ''), name: String(track.label || '') } });
            return;
          }
        }
        if (Date.now() > deadline) resolve({ error: 'track never produced cues' });
        else setTimeout(poll, 150);
      })();
    }).then(function (r) {
      // Restore 'showing' only if the player had it that way — ours set hidden.
      if (hadMode === 'showing' && track.mode === 'hidden') track.mode = 'showing';
      return r;
    });
  }

  // ---------------------------------------------------------------- API
  function start(opts) {
    opts = opts || {};
    stop();
    cfg = { targetLang: String(opts.targetLang || 'zh') };
    cues = (Array.isArray(opts.cues) ? opts.cues : []).map(function (c) {
      return { start: Number(c.start), end: Number(c.end), text: String(c.text || ''), translated: null };
    });
    video = findVideo();
    if (!video) { bus({ kind: 'error', error: 'no <video> element found' }); return { started: false, error: 'no video' }; }
    running = true;
    ensureUI();
    onTime = function () {
      var i = cueAt(cues, video.currentTime);
      if (i !== activeCue) {
        activeCue = i;
        render();
        if (window.__abSubSidebar) window.__abSubSidebar.setActive(i);
      }
    };
    video.addEventListener('timeupdate', onTime);
    var at = cueAt(cues, video.currentTime);
    activeCue = at;
    if (window.__abSubSidebar) window.__abSubSidebar.mount({ cues: cues, video: video, bus: bus });
    sendQueue = sendOrder(cues.length, at >= 0 ? at : 0);
    // Cues with text already in the target script get skipped by the hub's
    // own heuristics downstream; sending them anyway keeps this branch-free.
    sendMore();
    onTime();
    return { started: true, cues: cues.length };
  }

  function stop() {
    running = false;
    if (video && onTime) video.removeEventListener('timeupdate', onTime);
    onTime = null;
    if (wrap && wrap.isConnected) wrap.remove();
    wrap = null;
    if (window.__abSubSidebar) window.__abSubSidebar.unmount();
    if (styleEl && styleEl.isConnected) styleEl.remove();
    styleEl = null;
    cues = [];
    sendQueue = [];
    inflight.clear();
    activeCue = -1;
  }

  function status() {
    var done = 0;
    for (var i = 0; i < cues.length; i++) if (cues[i].translated) done++;
    return {
      running: running,
      cues: cues.length,
      translated: done,
      queue: sendQueue.length,
      inflight: inflight.size,
      activeCue: activeCue,
    };
  }

  window.__abSubtitle = {
    __v: 1,
    probe: probe,
    start: start,
    stop: stop,
    status: status,
    applyBatch: applyBatch,
    readTextTrackCues: readTextTrackCues,
  };
})();
