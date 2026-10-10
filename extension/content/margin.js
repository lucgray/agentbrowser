// Margin card host (v2.25): a plugin that owns the shared card surface other
// plugins write to. Card anatomy and rail follow the demo's margin host —
// pill badge head, quote chip, skeleton→streamed body, foot actions,
// per-card follow-up input, mini collapse rows, and colored anchor threads.
// Three display modes, degrading by available space:
//
//   reader  page_reader tool entered reading mode — non-main content is
//           hidden, the rail docks over the freed right margin
//   compat  default — the rail pins to the viewport's right edge
//   strip   collapsed — a thin white strip; each card is a vertical color
//           marker, click expands the card leftward over the page
//
// Card API via __abPlugins.provide('margin'): mount() returns {id, el} where
// el is the card body; type()/setText() write stream text; ask() mounts a
// card and routes the question through the page_ask channel (pg-<tab>-<n>
// chatIds) so the reply streams into the card, not the side panel.
//
// Opt-in like every persistent surface: zero DOM until the hub plugin
// 'margin' is enabled AND the first card mounts.

(function () {
  const TAG = "[agentbrowser]";
  const HOST_ID = "agentbrowser-margin";
  const RAIL_W = 330;
  let enabled = false;
  let host = null; // shadow host element
  let root = null; // shadow root
  let rail = null; // rail element
  let box = null; // card stack inside the rail
  let countEl = null; // mhead counter pill
  let stripEl = null; // strip-mode bar
  let linksSvg = null; // anchor→card connector layer
  let mode = "compat"; // compat | reader | strip
  const cards = new Map(); // id -> card record
  let cardSeq = 0;
  let activeId = null;
  const chatCards = new Map(); // chatId -> cardId
  // Reader-mode restore: elements we display:none'd + the style tag.
  let hiddenEls = [];
  let readerStyle = null;
  let readerMain = null;

  const MARK_HUES = {
    red: "#e27474",
    yellow: "#d9a514",
    blue: "#4a90d9",
    green: "#4cae5c",
    pink: "#e26a9e",
    purple: "#8f6fd8",
  };

  function logWarn(...a) {
    console.warn(TAG, "margin:", ...a);
  }

  function bus() {
    return window.__abPlugins || null;
  }

  // ---- DOM -----------------------------------------------------------------

  const CSS = `
    :host {
      all: initial;
      --ink: #1c1917; --mut: #78716c; --line: #e7e5e4;
      --acc: #4f46e5; --acc-soft: #eef2ff;
    }
    .rail {
      position: fixed; top: 0; right: 0; z-index: 2147483645;
      width: ${RAIL_W}px; max-height: 100vh; overflow-y: auto;
      border-left: 1px solid var(--line); background: #fbfaf9;
      padding: 16px 14px; box-sizing: border-box;
      font: 12.5px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--ink);
    }
    .rail.expand { background: #fbfaf9f2; box-shadow: -8px 0 24px -12px rgba(28,25,23,.3); }
    .mhead { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
    .mhead .t { font-weight: 700; font-size: 12px; letter-spacing: .06em; color: var(--mut); text-transform: uppercase; }
    .mhead .pi { font-size: 10.5px; color: #a8a29e; border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; }
    .mhead .mode { margin-left: auto; font-size: 10px; color: #a8a29e; cursor: pointer; border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; }
    .mhead .mode:hover { color: var(--ink); border-color: var(--mut); }

    .card {
      background: #fff; border: 1px solid var(--line); border-radius: 12px;
      padding: 12px 13px; margin-bottom: 12px;
      box-shadow: 0 1px 2px rgba(28,25,23,.05);
      animation: cardin .26s ease;
    }
    @keyframes cardin { from { opacity: 0; transform: translateY(9px); } }
    .card.flash { box-shadow: 0 0 0 2px var(--acc); }
    .card .chead { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
    .card .chead .pi { font-size: 10.5px; font-weight: 600; color: var(--acc); background: var(--acc-soft); border-radius: 99px; padding: 1.5px 8px; }
    .card .chead .pc { font-size: 11px; color: var(--mut); }
    .card .cx { margin-left: auto; color: #a8a29e; cursor: pointer; font-size: 13px; }
    .card .cx:hover { color: var(--ink); }
    .card .qchip {
      display: block; border-left: 2px solid var(--mc, var(--acc));
      padding: 1px 0 1px 9px; font-size: 12.5px; color: #44403c;
      margin: 4px 0 7px; max-height: 4.5em; overflow: hidden;
    }
    .card .cbody { font-size: 13px; white-space: pre-wrap; word-break: break-word; }
    .card .cbody.typing { color: #8d8880; }
    .card .cbody .sk {
      height: 9px; border-radius: 99px; margin: 7px 0;
      background: linear-gradient(90deg, #f1efe9 25%, #e8e5e0 50%, #f1efe9 75%);
      background-size: 200% 100%; animation: sk 1.1s infinite linear;
    }
    @keyframes sk { to { background-position: -200% 0; } }
    .card .cbody b, .card .cbody strong { background: rgba(250,164,164,.35); border-radius: 2px; padding: 0 1px; font-weight: 600; }
    .card .err { color: #b91c1c; font-size: 12px; padding: 8px 0 0; }
    .card .ctx {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 6px;
      background: var(--acc-soft); color: var(--acc);
      border-radius: 99px; padding: 2.5px 9px; font-size: 11px;
    }
    .card .ctx .cx2 { cursor: pointer; opacity: .6; }
    .card .ctx .cx2:hover { opacity: 1; }
    .card .cfoot { display: flex; gap: 6px; align-items: center; margin-top: 9px; }
    .card .cfoot .src { font-size: 10.5px; color: var(--mut); }
    .card .cfoot button {
      border: none; background: none; cursor: pointer;
      font-size: 12px; color: var(--mut); padding: 2px 5px; border-radius: 5px;
    }
    .card .cfoot button:hover { background: #f5f4f2; }
    .card .cfoot button.on { color: var(--acc); }
    .card .askin { display: flex; gap: 6px; margin-top: 8px; }
    .card .askin input {
      flex: 1; border: 1px solid var(--line); border-radius: 8px;
      padding: 6px 9px; font: 12.5px/1 ui-sans-serif, system-ui; outline: none;
    }
    .card .askin input:focus { border-color: var(--acc); }
    .card .askin button {
      border: 1px solid var(--line); background: #fff; border-radius: 8px;
      cursor: pointer; color: var(--mut); padding: 0 9px; font-size: 12px;
    }
    .card .askin button:hover { color: var(--ink); border-color: var(--mut); }

    .card.mini { padding: 9px 12px; cursor: pointer; }
    .card.mini > :not(.mini-body) { display: none; }
    .card.mini .mini-t { font-size: 12px; font-weight: 600; }
    .card.mini .mini-t .pc { font-weight: 400; color: var(--mut); margin-left: 6px; font-size: 10.5px; }
    .card.mini .mini-x {
      margin-top: 4px; font-size: 11.5px; color: #a8a29e;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    .strip {
      position: fixed; top: 20vh; right: 0; z-index: 2147483645;
      display: flex; flex-direction: column; gap: 3px;
      width: 12px; padding: 6px 0;
      background: rgba(255,255,255,0.95);
      border: 1px solid var(--line); border-right: none;
      border-radius: 6px 0 0 6px;
      box-shadow: 0 4px 16px -4px rgba(28,25,23,.25);
    }
    .strip .mark {
      height: 26px; width: 6px; margin: 0 auto;
      border-radius: 3px; cursor: pointer; opacity: .75;
    }
    .strip .mark:hover, .strip .mark.sel { opacity: 1; }
    .strip .mark.sel { outline: 1px solid var(--ink); }

    svg.links {
      position: fixed; inset: 0; z-index: 2147483644;
      width: 100vw; height: 100vh; pointer-events: none;
    }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    rail = document.createElement("div");
    rail.className = "rail";
    const mh = document.createElement("div");
    mh.className = "mhead";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = "Margin";
    countEl = document.createElement("span");
    countEl.className = "pi";
    const modeBtn = document.createElement("span");
    modeBtn.className = "mode";
    modeBtn.textContent = "strip";
    modeBtn.title = "收起为边条";
    modeBtn.addEventListener("click", () => setMode("strip"));
    mh.append(t, countEl, modeBtn);
    box = document.createElement("div");
    rail.append(mh, box);
    stripEl = document.createElement("div");
    stripEl.className = "strip";
    stripEl.style.display = "none";
    linksSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    linksSvg.setAttribute("class", "links");
    root.append(style, rail, stripEl, linksSvg);
    (document.documentElement || document.body).appendChild(host);
  }

  function updateCount() {
    if (countEl) countEl.textContent = cards.size ? `${cards.size} card${cards.size > 1 ? "s" : ""}` : "card host";
  }

  // ---- anchors + connector threads -------------------------------------------

  // opts.anchor: Element | Range | {x,y} | markId (resolves [data-mid]).
  function anchorPoint(spec) {
    if (!spec) return null;
    if (typeof spec === "string") {
      const el = document.querySelector(`[data-mid="${CSS.escape(spec)}"]`);
      return el ? anchorPoint(el) : null;
    }
    if (spec instanceof Element) {
      if (!spec.isConnected) return null;
      const r = spec.getBoundingClientRect();
      return { x: r.right + 2, y: r.top + r.height / 2 };
    }
    if (typeof Range !== "undefined" && spec instanceof Range) {
      const r = spec.getBoundingClientRect();
      return { x: r.right + 2, y: r.top + r.height / 2 };
    }
    if (typeof spec.x === "number" && typeof spec.y === "number") return spec;
    return null;
  }

  function redrawLinks() {
    if (!linksSvg) return;
    linksSvg.textContent = "";
    if (!activeId) return;
    const c = cards.get(activeId);
    if (!c || c.mini || !c.el.isConnected) return;
    // Strip mode parks cards behind markers; threads only make sense once
    // one is expanded over the page (rail overlay).
    if (mode === "strip" && !c.el.classList.contains("open")) return;
    const cr = c.el.getBoundingClientRect();
    const x4 = cr.left - 2;
    const y4 = cr.top + 14;
    for (const spec of c.anchors) {
      const p0 = anchorPoint(spec);
      if (!p0) continue;
      const hue = c.markColor || "#bbb";
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", `M ${p0.x} ${p0.y} C ${p0.x + 24} ${p0.y}, ${x4 - 30} ${y4}, ${x4} ${y4}`);
      p.setAttribute("stroke", hue);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke-opacity", "0.55");
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", p0.x);
      dot.setAttribute("cy", p0.y);
      dot.setAttribute("r", 2.6);
      dot.setAttribute("fill", hue);
      linksSvg.append(p, dot);
    }
  }

  window.addEventListener("scroll", redrawLinks, { passive: true, capture: true });
  window.addEventListener("resize", redrawLinks);
  setInterval(redrawLinks, 900); // streams shift layout — keep threads fresh

  function anchorEls(c) {
    const els = [];
    for (const spec of c.anchors) {
      if (spec instanceof Element && spec.isConnected) els.push(spec);
      else if (typeof spec === "string") {
        for (const el of document.querySelectorAll(`[data-mid="${CSS.escape(spec)}"]`)) els.push(el);
      }
    }
    return els;
  }

  function setAnchorHover(c, on) {
    for (const el of anchorEls(c)) {
      if (on) {
        el._abMarginHover = el.style.outline;
        el.style.outline = `2px solid ${c.markColor || "#bbb"}`;
      } else if (el._abMarginHover !== undefined) {
        el.style.outline = el._abMarginHover;
        delete el._abMarginHover;
      }
    }
  }

  // ---- cards -----------------------------------------------------------------

  function skeleton(body) {
    body.textContent = "";
    for (const w of ["92%", "78%", "60%"]) {
      const sk = document.createElement("div");
      sk.className = "sk";
      sk.style.width = w;
      body.appendChild(sk);
    }
  }

  function miniTitle(c) {
    const base =
      c.title ||
      c.plugin +
        (c.quote ? ` “${c.quote.slice(0, 34)}${c.quote.length > 34 ? "…" : ""}”` : "");
    return base || "card";
  }

  function collapse(c) {
    if (c.mini || c.pinned) return;
    const mb = document.createElement("div");
    mb.className = "mini-body";
    const mt = document.createElement("div");
    mt.className = "mini-t";
    mt.textContent = miniTitle(c);
    if (c.para) {
      const pc = document.createElement("span");
      pc.className = "pc";
      pc.textContent = c.para;
      mt.appendChild(pc);
    }
    const mx = document.createElement("div");
    mx.className = "mini-x";
    mx.textContent = c.texts.slice(0, 150);
    mb.append(mt, mx);
    c.el.appendChild(mb);
    c.el.classList.add("mini");
    c.mini = true;
    mb.addEventListener("click", () => {
      expand(c);
      collapseAll(c.id);
      redrawLinks();
    });
  }

  function expand(c) {
    if (!c.mini) return;
    c.el.classList.remove("mini");
    const mb = c.el.querySelector(".mini-body");
    if (mb) mb.remove();
    c.mini = false;
    activeId = c.id;
  }

  function collapseAll(exceptId) {
    for (const c of cards.values()) if (c.id !== exceptId) collapse(c);
  }

  function mount(opts = {}) {
    if (!enabled) return null;
    ensureHost();
    const id = "mc-" + ++cardSeq;
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.cid = id;

    const chead = document.createElement("div");
    chead.className = "chead";
    const pi = document.createElement("span");
    pi.className = "pi";
    pi.textContent = opts.plugin || "plugin";
    chead.appendChild(pi);
    if (opts.para) {
      const pc = document.createElement("span");
      pc.className = "pc";
      pc.textContent = opts.para;
      chead.appendChild(pc);
    }
    const cx = document.createElement("span");
    cx.className = "cx";
    cx.title = "close";
    cx.textContent = "×";
    cx.addEventListener("click", () => close(id));
    chead.appendChild(cx);
    el.appendChild(chead);

    let qchip = null;
    if (opts.quote) {
      qchip = document.createElement("div");
      qchip.className = "qchip";
      qchip.title = String(opts.quote);
      qchip.textContent = String(opts.quote).slice(0, 220);
      el.appendChild(qchip);
    }

    const body = document.createElement("div");
    body.className = "cbody";
    // Skeleton only when a stream is expected (ask/retry) — a plain mount
    // with no pending write would otherwise shimmer forever.
    if (opts.skeleton) skeleton(body);
    el.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "cfoot";
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = opts.src || "";
    foot.appendChild(src);
    const gap = document.createElement("span");
    gap.style.flex = "1";
    foot.appendChild(gap);
    el.appendChild(foot);

    const askin = document.createElement("div");
    askin.className = "askin";
    const inp = document.createElement("input");
    inp.placeholder = "Ask a follow-up";
    const sendBtn = document.createElement("button");
    sendBtn.textContent = "↑";
    askin.append(inp, sendBtn);
    el.appendChild(askin);

    const c = {
      id,
      el,
      body,
      qchip,
      plugin: opts.plugin || "",
      title: opts.title || "",
      quote: String(opts.quote || ""),
      para: opts.para || "",
      mini: false,
      pinned: false,
      anchors: opts.anchor ? [opts.anchor] : [],
      markColor: opts.markColor || null,
      chatId: opts.chatId || null,
      texts: "",
      question: opts.question || null,
      selection: opts.selection || null,
    };
    if (c.markColor) el.style.setProperty("--mc", c.markColor);
    if (opts.markColorName && MARK_HUES[opts.markColorName]) {
      c.markColor = MARK_HUES[opts.markColorName];
      el.style.setProperty("--mc", c.markColor);
    }
    cards.set(id, c);
    if (c.chatId) chatCards.set(c.chatId, id);

    // foot actions — ⧉ copy, ↻ retry (ask cards), 📌 pin, 🗑 delete
    const addBtn = (label, tip, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = tip;
      b.addEventListener("click", fn);
      foot.appendChild(b);
      return b;
    };
    addBtn("⧉", "copy", () => {
      navigator.clipboard.writeText(c.texts).catch((err) => logWarn("copy failed", err));
    });
    addBtn("↻", "retry", () => retry(id));
    const pinBtn = addBtn("⊙", "pin", () => {
      c.pinned = !c.pinned;
      pinBtn.classList.toggle("on", c.pinned);
    });
    addBtn("✕", "delete", () => close(id));

    const send = () => {
      const text = inp.value.trim();
      inp.value = "";
      if (!text) return;
      if (c.chatId) {
        followUp(c, text);
      } else {
        const P = bus();
        if (P) P.call(c.plugin, "followUp", id, text);
      }
    };
    sendBtn.addEventListener("click", send);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
      e.stopPropagation();
    });
    inp.addEventListener("keyup", (e) => e.stopPropagation());
    inp.addEventListener("keypress", (e) => e.stopPropagation());

    el.addEventListener("mouseenter", () => setAnchorHover(c, true));
    el.addEventListener("mouseleave", () => setAnchorHover(c, false));
    el.addEventListener("mousedown", () => {
      if (activeId !== id) {
        activeId = id;
        redrawLinks();
      }
    });

    collapseAll(id); // only the newest card stays expanded
    activeId = id;
    box.appendChild(el);
    updateCount();
    renderStrip();
    redrawLinks();
    return { id, el: body };
  }

  function getCard(id) {
    return cards.get(String(id || "")) || null;
  }

  function type(id, text) {
    const c = getCard(id);
    if (!c) return false;
    c.texts += String(text);
    c.body.textContent = c.texts;
    c.body.classList.add("typing");
    return true;
  }

  function setText(id, text) {
    const c = getCard(id);
    if (!c) return false;
    c.texts = String(text);
    c.body.textContent = c.texts;
    c.body.classList.remove("typing");
    return true;
  }

  function cardError(id, msg) {
    const c = getCard(id);
    if (!c) return;
    c.body.classList.remove("typing");
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = String(msg || "error").slice(0, 300);
    c.el.appendChild(e);
  }

  function close(id) {
    const c = getCard(id);
    if (!c) return;
    if (c.chatId) chatCards.delete(c.chatId);
    setAnchorHover(c, false);
    c.el.remove();
    cards.delete(String(id));
    if (activeId === id) activeId = [...cards.keys()].pop() || null;
    updateCount();
    renderStrip();
    redrawLinks();
    if (!cards.size && host) {
      host.remove();
      host = null;
    }
  }

  function focusCard(id) {
    const c = getCard(id);
    if (!c) return;
    activeId = id;
    if (mode === "strip") {
      // Expand as an overlay card sliding in from the right edge.
      for (const o of cards.values()) o.el.classList.remove("open");
      rail.style.display = "flex";
      rail.classList.add("expand");
      c.el.classList.add("open");
      expand(c);
      c.el.scrollIntoView({ block: "nearest" });
      renderStrip();
      redrawLinks();
      return;
    }
    expand(c);
    collapseAll(id);
    c.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    c.el.classList.add("flash");
    setTimeout(() => c.el.classList.remove("flash"), 1200);
    redrawLinks();
  }

  function hoverCard(id, on) {
    const c = getCard(id);
    if (c) c.el.classList.toggle("flash", on);
  }

  function focusInput(id) {
    const c = getCard(id);
    if (c) {
      const inp = c.el.querySelector(".askin input");
      if (inp) inp.focus();
    }
  }

  function addCtx(id, text) {
    const c = getCard(id);
    if (!c) return;
    const chip = document.createElement("div");
    chip.className = "ctx";
    chip.textContent = String(text);
    const x = document.createElement("span");
    x.className = "cx2";
    x.textContent = "×";
    x.addEventListener("click", () => chip.remove());
    chip.append(" ", x);
    c.body.appendChild(chip);
  }

  // ---- strip mode -------------------------------------------------------------

  function renderStrip() {
    if (!stripEl) return;
    stripEl.textContent = "";
    if (mode !== "strip" || !cards.size) {
      stripEl.style.display = "none";
      return;
    }
    for (const [id, c] of cards) {
      const m = document.createElement("div");
      m.className = "mark" + (c.el.classList.contains("open") ? " sel" : "");
      m.style.background = c.markColor || "#a8a29e";
      m.title = miniTitle(c);
      m.addEventListener("click", () => focusCard(id));
      stripEl.appendChild(m);
    }
    stripEl.style.display = cards.size ? "flex" : "none";
  }

  function applyMode() {
    if (!host) return;
    rail.classList.remove("expand");
    rail.style.display = mode === "strip" ? "none" : "flex";
    renderStrip();
    if (mode === "strip") {
      for (const c of cards.values()) c.el.classList.remove("open");
    }
    redrawLinks();
  }

  function setMode(m) {
    if (!["compat", "reader", "strip"].includes(m)) return mode;
    mode = m;
    applyMode();
    return mode;
  }

  // ---- page_ask channel -----------------------------------------------------

  // Mount a card and route the question through the pg-<tabId>-<n> channel;
  // streamed tokens land in cardEvent below.
  function ask(text, opts = {}) {
    const card = mount({
      plugin: opts.plugin || "ask",
      title: opts.title || "",
      quote: opts.quote || (opts.selection && opts.selection.text),
      markColor: opts.markColor,
      anchor: opts.anchor,
      src: opts.src,
      para: opts.para,
      question: String(text || ""),
      selection: opts.selection || null,
      skeleton: true,
    });
    if (!card) return null;
    const c = cards.get(card.id);
    c.body.classList.add("typing");
    sendAsk(c, String(text || ""), null);
    return card;
  }

  function sendAsk(c, text, chatId) {
    chrome.runtime
      .sendMessage({
        target: "sw",
        cmd: "page_ask",
        chatId: chatId || undefined,
        text,
        selection: c.selection || undefined,
        adapter: undefined,
      })
      .then((r) => {
        if (r && r.success && r.chatId) {
          if (!c.chatId) {
            c.chatId = r.chatId;
            chatCards.set(r.chatId, c.id);
          }
        } else {
          cardError(c.id, (r && r.error) || "page_ask failed");
        }
      })
      .catch((err) => {
        logWarn("page_ask send failed", err);
        cardError(c.id, err && err.message);
      });
  }

  // Follow-up / retry: continue the card's existing pg- thread so the hub
  // keeps conversational context; tokens keep streaming into the same card.
  function followUp(c, text) {
    if (!c.chatId) return;
    c.texts += `\n\n› ${text}\n\n`;
    c.body.textContent = c.texts;
    c.body.classList.add("typing");
    expand(c);
    collapseAll(c.id);
    sendAsk(c, text, c.chatId);
  }

  function retry(id) {
    const c = getCard(id);
    if (!c || !c.question) return;
    c.texts = "";
    skeleton(c.body);
    c.body.classList.add("typing");
    expand(c);
    sendAsk(c, c.question, c.chatId);
  }

  function cardEvent(chatId, event) {
    const cid = chatCards.get(String(chatId || ""));
    if (!cid) {
      logWarn("page-ask event for unknown chat", chatId);
      return;
    }
    const kind = event && event.kind;
    if (kind === "token") {
      type(cid, event.text || "");
    } else if (kind === "done") {
      const c = getCard(cid);
      if (c) c.body.classList.remove("typing");
      redrawLinks();
    } else if (kind === "error") {
      cardError(cid, event.message);
    }
    // status/meta/tool events are panel chrome — the card ignores them.
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.target !== "page-ask" || message.cmd !== "event") return;
      if (enabled) cardEvent(message.chatId, message.event);
    });
  } catch (err) {
    logWarn("page-ask listener failed", err);
  }

  // ---- page_reader tool -------------------------------------------------------

  // Score candidate content roots: semantic containers first, else the
  // body child carrying the most readable text.
  function findMain() {
    const sem = document.querySelector(
      "article, main, [role='main'], .post-content, .article-body, #content"
    );
    if (sem && (sem.innerText || "").trim().length > 200) return sem;
    let best = null;
    let bestLen = 0;
    for (const el of document.body.children) {
      const len = ((el.innerText || "").trim()).length;
      if (len > bestLen) {
        bestLen = len;
        best = el;
      }
    }
    return bestLen > 200 ? best : document.body;
  }

  function enterReader() {
    if (!readerMain) readerMain = findMain();
    const main = readerMain;
    if (!main) return { mode, error: "no main content found" };
    // Hide siblings at EVERY level of main's ancestor chain — not just
    // top-level children. Single-root apps (body > div#app > everything)
    // need the walk inside #app or nothing visible changes.
    hiddenEls = [];
    const SKIP_TAGS = new Set(["SCRIPT", "NOSCRIPT", "LINK", "META", "STYLE", "TEMPLATE"]);
    for (let el = main; el && el !== document.body && el !== document.documentElement; ) {
      const parent = el.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib === el) continue;
        if (sib === host || SKIP_TAGS.has(sib.tagName)) continue;
        if (sib.id && sib.id.startsWith("agentbrowser-")) continue;
        if (sib.contains(main)) continue;
        hiddenEls.push([sib, sib.style.display]);
        sib.style.display = "none";
      }
      el = parent;
    }
    // Center the main content so a right margin opens for the rail.
    readerStyle = document.createElement("style");
    readerStyle.textContent =
      "body > *:not([id^='agentbrowser-']) { margin-left: auto !important; margin-right: auto !important; }";
    document.documentElement.appendChild(readerStyle);
    setMode("reader");
    ensureHost();
    updateCount();
    return {
      mode,
      hidden: hiddenEls.length,
      mainChars: (main.innerText || "").trim().length,
    };
  }

  function exitReader() {
    for (const [el, disp] of hiddenEls) el.style.display = disp;
    hiddenEls = [];
    if (readerStyle) {
      readerStyle.remove();
      readerStyle = null;
    }
    readerMain = null;
    if (mode === "reader") setMode("compat");
    return { mode, restored: true };
  }

  function pageReader(args) {
    const action = String((args && args.action) || "status");
    if (action === "enter") return enterReader();
    if (action === "exit") return exitReader();
    return {
      mode,
      cards: cards.size,
      reader: !!readerMain,
      hidden: hiddenEls.length,
    };
  }

  // ---- boot -------------------------------------------------------------------

  async function checkEnabled() {
    try {
      const r = await chrome.runtime.sendMessage({
        target: "sw",
        cmd: "plugin_state",
        id: "margin",
      });
      return !!(r && r.enabled);
    } catch (err) {
      logWarn("plugin_state check failed", err);
      return false;
    }
  }

  checkEnabled().then((on) => {
    enabled = on;
    if (!enabled) return;
    const P = bus();
    if (!P) return;
    P.provide("margin", {
      mount,
      type,
      setText,
      error: cardError,
      close,
      focusCard,
      hoverCard,
      focusInput,
      addCtx,
      collapseAll,
      ask,
      mode: () => mode,
      setMode,
      active: () => activeId,
      cardEl: (id) => (getCard(id) || {}).el || null,
      cards: () => cards.size,
    });
    P.registerPageTool("page_reader", pageReader);
  });
})();
