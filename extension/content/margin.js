// Margin card host (v2.25): a plugin that owns the shared card surface other
// plugins write to. Three display modes, degrading by available space:
//
//   reader  page_reader tool entered reading mode — non-main content is
//           hidden, the rail docks over the freed right margin
//   compat  default — a fixed sticky-note stack pinned to the viewport's
//           right edge
//   strip   collapsed — a thin white strip; each card is a vertical color
//           marker, click expands the card leftward over the page
//
// Card API via __abPlugins.provide('margin'): mount() returns {id, el} and
// the plugin fills el; type()/setText() append stream text; ask() mounts a
// card and routes the question through the page_ask channel (pg-<tab>-<n>
// chatIds) so the reply streams into the card, not the side panel.
//
// Opt-in like every persistent surface: zero DOM until the hub plugin
// 'margin' is enabled AND the first card mounts.

(function () {
  const TAG = "[agentbrowser]";
  const HOST_ID = "agentbrowser-margin";
  const RAIL_W = 300;
  let enabled = false;
  let host = null; // shadow host element
  let root = null; // shadow root
  let rail = null; // card stack element
  let stripEl = null; // strip-mode bar
  let mode = "compat"; // compat | reader | strip
  const cards = new Map(); // id -> {el, body, head, mini, markColor, chatId, texts}
  let cardSeq = 0;
  const chatCards = new Map(); // chatId -> cardId
  // Reader-mode restore: elements we display:none'd + the style tag.
  let hiddenEls = [];
  let readerStyle = null;
  let readerMain = null;

  function logWarn(...a) {
    console.warn(TAG, "margin:", ...a);
  }

  function bus() {
    return window.__abPlugins || null;
  }

  // ---- DOM -----------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .rail {
      position: fixed; top: 0; right: 0; z-index: 2147483645;
      width: ${RAIL_W}px; max-height: 100vh;
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px 10px 12px 0; box-sizing: border-box;
      pointer-events: none; overflow-y: auto;
      font: 400 13px/1.55 ui-sans-serif, system-ui, sans-serif;
    }
    .card {
      pointer-events: auto;
      background: rgba(255,255,255,0.97);
      border: 1px solid rgba(28,25,23,0.12);
      border-left: 3px solid var(--ab-mc, #eab308);
      border-radius: 10px;
      box-shadow: 0 8px 28px -8px rgba(28,25,23,0.28);
      color: #292524; overflow: hidden;
      transition: all .15s ease;
    }
    .card .head {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 10px; font-size: 11.5px; font-weight: 600;
      color: #57534e; background: rgba(28,25,23,0.035);
    }
    .card .head .plugin { flex: none; }
    .card .head .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card .head button {
      all: unset; cursor: pointer; padding: 0 4px; color: #78716c; font-size: 12px;
    }
    .card .head button:hover { color: #292524; }
    .card .quote {
      margin: 8px 10px 0; padding: 5px 8px;
      font-size: 11.5px; color: #57534e;
      border-left: 2px solid var(--ab-mc, #eab308);
      background: rgba(28,25,23,0.04); border-radius: 4px;
      max-height: 3.6em; overflow: hidden;
    }
    .card .body { padding: 9px 11px; white-space: pre-wrap; word-break: break-word; }
    .card .body.streaming::after {
      content: "▌"; color: var(--ab-mc, #eab308);
      animation: ab-blink 1s steps(2) infinite;
    }
    @keyframes ab-blink { 50% { opacity: 0; } }
    .card .err { color: #b91c1c; font-size: 12px; padding: 0 11px 8px; }
    .card.mini .quote, .card.mini .body, .card.mini .err { display: none; }
    .card.mini .head { background: transparent; }
    .strip {
      position: fixed; top: 20vh; right: 0; z-index: 2147483645;
      display: flex; flex-direction: column; gap: 3px;
      width: 12px; padding: 6px 0;
      background: rgba(255,255,255,0.95);
      border: 1px solid rgba(28,25,23,0.14); border-right: none;
      border-radius: 6px 0 0 6px;
      box-shadow: 0 4px 16px -4px rgba(28,25,23,0.25);
    }
    .strip .mark {
      height: 26px; width: 6px; margin: 0 auto;
      border-radius: 3px; cursor: pointer; opacity: 0.75;
    }
    .strip .mark:hover { opacity: 1; }
    .strip .mark.sel { opacity: 1; outline: 1px solid #292524; }
    .expand {
      position: fixed; top: 0; right: 12px; z-index: 2147483645;
      width: ${RAIL_W}px; max-height: 100vh; overflow-y: auto;
      padding: 12px 10px 12px 0; box-sizing: border-box;
      font: 400 13px/1.55 ui-sans-serif, system-ui, sans-serif;
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
    stripEl = document.createElement("div");
    stripEl.className = "strip";
    stripEl.style.display = "none";
    root.append(style, rail, stripEl);
    (document.documentElement || document.body).appendChild(host);
  }

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
      m.style.background = c.markColor || "#eab308";
      m.title = c.title || c.plugin || "card";
      m.addEventListener("click", () => focusCard(id));
      stripEl.appendChild(m);
    }
    stripEl.style.display = cards.size ? "flex" : "none";
  }

  function applyMode() {
    if (!host) return;
    rail.style.display = mode === "strip" ? "none" : "flex";
    renderStrip();
    if (mode === "strip") {
      // Strip mode parks every card; focusCard re-opens one as an overlay.
      for (const c of cards.values()) c.el.classList.remove("open");
    }
  }

  function mount(opts = {}) {
    if (!enabled) return null;
    ensureHost();
    const id = "mc-" + ++cardSeq;
    const el = document.createElement("div");
    el.className = "card";
    const head = document.createElement("div");
    head.className = "head";
    const plugin = document.createElement("span");
    plugin.className = "plugin";
    plugin.textContent = opts.plugin || "plugin";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = opts.title || "";
    const miniBtn = document.createElement("button");
    miniBtn.textContent = "–";
    miniBtn.title = "折叠";
    miniBtn.addEventListener("click", () => {
      el.classList.toggle("mini");
      c.mini = el.classList.contains("mini");
    });
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", () => close(id));
    head.append(plugin, title, miniBtn, closeBtn);
    el.appendChild(head);
    if (opts.quote) {
      const q = document.createElement("div");
      q.className = "quote";
      q.textContent = String(opts.quote).slice(0, 300);
      el.appendChild(q);
    }
    const body = document.createElement("div");
    body.className = "body";
    el.appendChild(body);
    const c = {
      el, body, head,
      title: opts.title || "",
      plugin: opts.plugin || "",
      mini: false,
      markColor: opts.markColor || null,
      chatId: opts.chatId || null,
      texts: "",
    };
    if (c.markColor) el.style.setProperty("--ab-mc", c.markColor);
    cards.set(id, c);
    if (c.chatId) chatCards.set(c.chatId, id);
    rail.appendChild(el);
    // New card arrives → older cards fold to mini rows.
    collapseOthers(id);
    renderStrip();
    return { id, el: body };
  }

  function collapseOthers(keepId) {
    for (const [cid, c] of cards) {
      if (cid !== keepId && !c.mini) {
        c.el.classList.add("mini");
        c.mini = true;
      }
    }
  }

  function getCard(id) {
    const c = cards.get(String(id || ""));
    return c || null;
  }

  function type(id, text) {
    const c = getCard(id);
    if (!c) return false;
    c.texts += String(text);
    c.body.textContent = c.texts;
    c.body.classList.add("streaming");
    return true;
  }

  function setText(id, text) {
    const c = getCard(id);
    if (!c) return false;
    c.texts = String(text);
    c.body.textContent = c.texts;
    c.body.classList.remove("streaming");
    return true;
  }

  function cardError(id, msg) {
    const c = getCard(id);
    if (!c) return;
    c.body.classList.remove("streaming");
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = String(msg || "error").slice(0, 300);
    c.el.appendChild(e);
  }

  function close(id) {
    const c = getCard(id);
    if (!c) return;
    if (c.chatId) chatCards.delete(c.chatId);
    c.el.remove();
    cards.delete(String(id));
    renderStrip();
    if (!cards.size && host) {
      host.remove();
      host = null;
    }
  }

  function focusCard(id) {
    const c = getCard(id);
    if (!c) return;
    if (mode === "strip") {
      // Expand as an overlay card sliding in from the right edge.
      for (const o of cards.values()) o.el.classList.remove("open");
      rail.style.display = "flex";
      rail.classList.add("expand");
      c.el.classList.add("open");
      c.el.classList.remove("mini");
      c.mini = false;
      c.el.scrollIntoView({ block: "nearest" });
      renderStrip();
      return;
    }
    c.el.classList.remove("mini");
    c.mini = false;
    c.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function collapseAll() {
    for (const c of cards.values()) {
      c.el.classList.add("mini");
      c.mini = true;
    }
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
      title: opts.title || "问 AI",
      quote: opts.quote || (opts.selection && opts.selection.text),
      markColor: opts.markColor,
    });
    if (!card) return null;
    card.body.classList.add("streaming");
    chrome.runtime
      .sendMessage({
        target: "sw",
        cmd: "page_ask",
        text: String(text || ""),
        selection: opts.selection || undefined,
        adapter: opts.adapter || undefined,
      })
      .then((r) => {
        if (r && r.success && r.chatId) {
          chatCards.set(r.chatId, card.id);
          cards.get(card.id).chatId = r.chatId;
        } else {
          cardError(card.id, (r && r.error) || "page_ask failed");
        }
      })
      .catch((err) => {
        logWarn("page_ask send failed", err);
        cardError(card.id, err && err.message);
      });
    return card;
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
      if (c) c.body.classList.remove("streaming");
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
    // Hide every body child that isn't the main content or an ancestor of it.
    hiddenEls = [];
    for (const el of document.body.children) {
      if (el === host || el.contains(main) || main.contains(el) || el === main) continue;
      hiddenEls.push([el, el.style.display]);
      el.style.display = "none";
    }
    // Center the main content so a right margin opens for the rail.
    readerStyle = document.createElement("style");
    readerStyle.textContent =
      "body > *:not([id^='agentbrowser-']) { margin-left: auto !important; margin-right: auto !important; }";
    document.documentElement.appendChild(readerStyle);
    setMode("reader");
    ensureHost();
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
    if (mode === "reader") setMode(cards.size ? "compat" : "compat");
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
      collapseAll,
      ask,
      mode: () => mode,
      setMode,
      cards: () => cards.size,
    });
    P.registerPageTool("page_reader", pageReader);
  });
})();
