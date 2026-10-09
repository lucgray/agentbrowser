// Notes plugin content side (v2.23): a pipebox-style fixed markdown sidebar
// in shadow DOM + selection highlights persisted as anchored quotes. Storage
// lives on the hub (~/.agentchat/notes/) — the page never sees a cloud call.
//
// Entry points: context menu "打开笔记侧边栏" / Alt+Shift+N / ⋯menu "存笔记" /
// the optional right-edge handle (chrome.storage.local notesEdgeHandle).
// Everything is gated on the hub's notes plugin being enabled: no hub or a
// disabled plugin leaves zero DOM behind.
//
// Tag/collector conventions: our root is <div id="agentbrowser-notes"> so
// video-ask's mediaCovered "ours" check and float-guard skip it.

(function () {
  if (window.__abNotesLoaded) return; // all_frames + retries: single-run
  window.__abNotesLoaded = true;
  if (window.top !== window) return; // main frame only — one sidebar per page

  const TAG = "[agentbrowser]";
  const HOST_ID = "agentbrowser-notes";
  const HANDLE_KEY = "notesEdgeHandle"; // chrome.storage.local, default false
  const SIDE_KEY = "notesSide"; // 'left'|'right', default right
  const HL_CLASS = "ab-note-hl";
  const SAVE_DEBOUNCE_MS = 800;

  function logWarn(...a) {
    console.warn(TAG, ...a);
  }

  // ---- wire: note_op -> sw -> offscreen -> hub ------------------------------
  let reqSeq = 0;
  const pendingOps = new Map(); // reqId -> {resolve, timer}

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "notes") return;
    if (msg.cmd === "op_result") {
      const p = pendingOps.get(msg.reqId);
      if (!p) return;
      pendingOps.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.resolve({ __error: String(msg.error || "failed") });
    } else if (msg.cmd === "toggle") {
      toggleSidebar();
    } else if (msg.cmd === "collect") {
      collectSelection();
    }
  });

  function noteOp(op, args = {}, timeoutMs = 15000) {
    const reqId = "no-" + ++reqSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingOps.delete(reqId);
        resolve({ __error: "note_op timeout" });
      }, timeoutMs);
      pendingOps.set(reqId, { resolve, timer });
      chrome.runtime
        .sendMessage({ target: "sw", cmd: "note_op", reqId, op, ...args })
        .catch((err) => {
          pendingOps.delete(reqId);
          clearTimeout(timer);
          logWarn("note_op send failed", err);
          resolve({ __error: String(err && err.message) });
        });
    });
  }

  // ---- current note state ---------------------------------------------------
  let note = null; // active note object {id,title,url,tags,content,quotes,...}
  let dirty = false;
  let saveTimer = null;
  let enabled = null; // null = unknown yet

  function pageMeta() {
    return { url: location.href.split("#")[0], title: document.title || location.href };
  }

  // Pick the note the sidebar opens: latest note saved against this URL,
  // else a fresh (unsaved) note object that materializes on first save.
  async function openNote() {
    const meta = pageMeta();
    const r = await noteOp("list", { url: meta.url, limit: 1 });
    if (r.__error) return r;
    const first = (r.notes || [])[0];
    if (first) {
      const g = await noteOp("get", { id: first.id });
      if (!g.__error && g.note) {
        note = g.note;
        return { ok: true };
      }
    }
    note = {
      id: null, title: meta.title, url: meta.url,
      tags: [], content: "", quotes: [], created: 0, updated: 0,
    };
    return { ok: true };
  }

  async function persist() {
    dirty = false;
    if (!note) return;
    setStatus("保存中…");
    const r = await noteOp("save", {
      id: note.id || undefined,
      title: note.title,
      url: note.url,
      domain: note.domain,
      tags: note.tags,
      content: note.content,
    });
    if (r.__error || (r && r.error)) {
      setStatus("保存失败: " + (r.__error || r.error));
      dirty = true;
      return;
    }
    note = r.note;
    setStatus("已保存");
    renderMeta();
  }

  function scheduleSave() {
    dirty = true;
    setStatus("编辑中…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (dirty) persist().catch((e) => logWarn("autosave failed", e));
    }, SAVE_DEBOUNCE_MS);
  }

  // ---- selection highlight --------------------------------------------------
  // Anchor: {xpath,start,end} where start/end are character offsets inside the
  // node's whole text. Restore: resolve xpath → text offset, else scan body
  // text for exact+context.

  function xpathOf(node) {
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1) {
      let i = 1;
      for (let s = n.previousSibling; s; s = s.previousSibling) {
        if (s.nodeType === 1 && s.tagName === n.tagName) i++;
      }
      parts.unshift(n.tagName.toLowerCase() + "[" + i + "]");
      n = n.parentNode;
    }
    return "/" + parts.join("/");
  }

  function nodeByXPath(xp) {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch (err) {
      logWarn("xpath resolve failed", err);
      return null;
    }
  }

  function textNodesIn(root) {
    const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const out = [];
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  function anchorForRange(range) {
    const sc = range.startContainer.nodeType === 3 ? range.startContainer : null;
    const ec = range.endContainer.nodeType === 3 ? range.endContainer : null;
    if (!sc || !ec) return null;
    return {
      xpath: xpathOf(sc.parentElement || sc),
      start: range.startOffset,
      endXpath: xpathOf(ec.parentElement || ec),
      end: range.endOffset,
    };
  }

  // Find [{node, offset}] start/end for a quote: anchor-xpath first, then a
  // whole-document text scan matching exact text with prefix/suffix context.
  function locateQuote(q) {
    if (q.anchor && q.anchor.xpath) {
      const sn = nodeByXPath(q.anchor.xpath);
      const en = nodeByXPath(q.anchor.endXpath || q.anchor.xpath);
      const s = firstTextIn(sn), e = lastTextIn(en);
      if (s && e) {
        const st = { node: s, off: Math.min(q.anchor.start, s.nodeValue.length) };
        const ed = { node: e, off: Math.min(q.anchor.end, e.nodeValue.length) };
        try {
          const r = document.createRange();
          r.setStart(st.node, st.off);
          r.setEnd(ed.node, ed.off);
          if (r.toString() === q.text || r.toString().includes(q.text.slice(0, 40))) return [st, ed];
        } catch (err) {
          logWarn("anchor range failed", err);
        }
      }
    }
    // text scan: build concatenated text with a node-offset index
    const nodes = textNodesIn(document.body);
    let whole = "";
    const bounds = []; // cumulative end offset per node
    for (const n of nodes) {
      whole += n.nodeValue;
      bounds.push(whole.length);
    }
    const hay = whole;
    const needle = q.text;
    const ctx = (q.prefix || "") + needle + (q.suffix || "");
    let idx = ctx && hay.includes(ctx) ? hay.indexOf(ctx) + (q.prefix || "").length : hay.indexOf(needle);
    if (idx < 0) {
      // whitespace-tolerant: collapse spaces on both sides
      const flat = needle.replace(/\s+/g, " ").trim();
      idx = hay.replace(/\s+/g, " ").indexOf(flat);
      if (idx < 0) return null;
    }
    const findNode = (pos) => {
      for (let i = 0; i < nodes.length; i++) {
        const start = i === 0 ? 0 : bounds[i - 1];
        if (pos < bounds[i]) return { node: nodes[i], off: pos - start };
      }
      return { node: nodes[nodes.length - 1], off: nodes[nodes.length - 1].nodeValue.length };
    };
    return [findNode(idx), findNode(Math.min(idx + needle.length, whole.length))];
  }

  function firstTextIn(el) {
    if (!el) return null;
    if (el.nodeType === 3) return el;
    const ns = textNodesIn(el);
    return ns[0] || null;
  }
  function lastTextIn(el) {
    if (!el) return null;
    if (el.nodeType === 3) return el;
    const ns = textNodesIn(el);
    return ns[ns.length - 1] || null;
  }

  // Wrap every text-node segment a range touches in a highlight span.
  function highlightRange(start, end, quoteId) {
    const r = document.createRange();
    r.setStart(start.node, start.off);
    r.setEnd(end.node, end.off);
    const nodes = textNodesIn(r.commonAncestorContainer === document ? document.body : r.commonAncestorContainer);
    const targets = [];
    for (const n of nodes) {
      try {
        if (r.intersectsNode(n)) targets.push(n);
      } catch {
        // detached nodes can't be intersect-tested — skip silently is fine,
        // but log per convention
        logWarn("intersectsNode skipped a node");
      }
    }
    for (const n of targets) {
      const so = n === start.node ? start.off : 0;
      const eo = n === end.node ? end.off : n.nodeValue.length;
      if (eo <= so) continue;
      const mid = n.splitText(so);
      const tail = mid.nodeValue.length > eo - so ? mid.splitText(eo - so) : null;
      const span = document.createElement("span");
      span.className = HL_CLASS;
      span.dataset.quoteId = quoteId || "";
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
      void tail;
    }
  }

  function applyQuote(q) {
    const loc = locateQuote(q);
    if (!loc) return false;
    try {
      highlightRange(loc[0], loc[1], q.id);
      return true;
    } catch (err) {
      logWarn("highlight apply failed", err);
      return false;
    }
  }

  async function restoreHighlights() {
    const meta = pageMeta();
    const r = await noteOp("quotes_for_url", { url: meta.url });
    if (r.__error) return;
    for (const q of r.quotes || []) {
      try {
        applyQuote(q);
      } catch (err) {
        logWarn("quote restore failed", err);
      }
    }
  }

  // 存笔记: highlight the live selection + append it to the note as a quote.
  async function collectSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !String(sel).trim()) return;
    if (!enabled) await checkEnabled();
    if (!enabled) return;
    const range = sel.getRangeAt(0);
    const text = String(sel).trim().slice(0, 4000);
    const anchor = anchorForRange(range);
    const meta = pageMeta();
    // surrounding context for fuzzy re-match
    const pre = range.startContainer.nodeType === 3
      ? range.startContainer.nodeValue.slice(Math.max(0, range.startOffset - 60), range.startOffset)
      : "";
    const post = range.endContainer.nodeType === 3
      ? range.endContainer.nodeValue.slice(range.endOffset, range.endOffset + 60)
      : "";
    if (!note) await openNote();
    if (!note.id) {
      await persist();
      if (!note || !note.id) return;
    }
    const qr = await noteOp("quote", {
      id: note.id, text, url: meta.url, prefix: pre, suffix: post, anchor,
    });
    if (qr.__error) {
      toast(qr.__error);
      return;
    }
    try {
      const qid = qr.quote && qr.quote.id;
      const loc = locateQuote({ text, prefix: pre, suffix: post, anchor });
      if (loc) highlightRange(loc[0], loc[1], qid);
    } catch (err) {
      logWarn("live highlight failed", err);
    }
    note = qr.note;
    sel.removeAllRanges();
    showSidebar();
    renderQuotes();
    toast("已存入笔记");
  }

  // chatGPT/Claude-style export: scrape the conversation into markdown.
  function exportChatDom() {
    const bubbles = document.querySelectorAll(
      "[data-message-author-role], article[data-testid^='conversation-turn'], .message"
    );
    if (!bubbles.length) return null;
    const parts = [];
    bubbles.forEach((b) => {
      const role = b.getAttribute("data-message-author-role") || b.dataset.testid || "turn";
      const txt = (b.innerText || "").trim();
      if (txt) parts.push(`### ${role}\n\n${txt}`);
    });
    return parts.join("\n\n").slice(0, 60000);
  }

  async function exportConversation() {
    const md = exportChatDom();
    if (!md) {
      toast("未找到对话内容");
      return;
    }
    if (!note) await openNote();
    if (!note.id) await persist();
    if (!note.id) return;
    const r = await noteOp("append", { id: note.id, text: `## 对话导出（${pageMeta().title}）\n\n` + md });
    if (r.__error) toast(r.__error);
    else {
      note = r.note;
      renderEditor();
      toast("对话已存入笔记");
    }
  }

  // ---- sidebar DOM ----------------------------------------------------------
  let host = null;
  let shadow = null;
  let els = {}; // cached refs

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(t) {
    if (els.status) els.status.textContent = t;
  }

  function toast(t) {
    setStatus(t);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => setStatus(note && note.id ? "已保存" : ""), 2400);
  }

  function buildSidebar() {
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = NOTES_CSS;
    shadow.appendChild(style);

    const side = (localGet(SIDE_KEY) || "right");
    const wrap = el("div", "abn-wrap " + (side === "left" ? "abn-left" : "abn-right"));

    const head = el("div", "abn-head");
    const titleIn = el("input", "abn-title");
    titleIn.placeholder = "笔记标题";
    titleIn.addEventListener("input", () => {
      if (note) {
        note.title = titleIn.value;
        scheduleSave();
      }
    });
    const btns = el("div", "abn-head-btns");
    const flip = el("button", "abn-ibtn", "⇋");
    flip.title = "换到另一侧";
    flip.addEventListener("click", () => {
      const next = side === "left" ? "right" : "left";
      localSet(SIDE_KEY, next);
      wrap.className = "abn-wrap " + (next === "left" ? "abn-left" : "abn-right");
    });
    const lib = el("button", "abn-ibtn", "▤");
    lib.title = "笔记库";
    lib.addEventListener("click", showLibrary);
    const admin = el("button", "abn-ibtn", "⚙");
    admin.title = "管理后台";
    admin.addEventListener("click", () => window.open("http://127.0.0.1:9010/admin#notes", "_blank"));
    const close = el("button", "abn-ibtn", "✕");
    close.title = "收起";
    close.addEventListener("click", hideSidebar);
    btns.append(flip, lib, admin, close);
    head.append(titleIn, btns);

    const tagsIn = el("input", "abn-tags");
    tagsIn.placeholder = "标签（逗号分隔）";
    tagsIn.addEventListener("change", () => {
      if (note) {
        note.tags = tagsIn.value.split(",").map((s) => s.trim()).filter(Boolean);
        scheduleSave();
      }
    });

    const editor = el("textarea", "abn-editor");
    editor.placeholder = "用 markdown 记录想法…（Ctrl+V 直接粘贴图片）";
    editor.addEventListener("input", () => {
      if (note) {
        note.content = editor.value;
        scheduleSave();
      }
      if (els.preview && els.preview.style.display !== "none") renderPreview();
    });
    editor.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          const f = it.getAsFile();
          const rd = new FileReader();
          rd.onload = async () => {
            const b64 = String(rd.result).split(",")[1] || "";
            const r = await noteOp("asset", { name: f.name || "pasted.png", data: b64 });
            if (!r.__error && r.url) {
              const ins = `![img](http://127.0.0.1:9010${r.url})`;
              const p = editor.selectionStart;
              editor.value = editor.value.slice(0, p) + ins + editor.value.slice(editor.selectionEnd);
              editor.selectionStart = editor.selectionEnd = p + ins.length;
              if (note) {
                note.content = editor.value;
                scheduleSave();
              }
            } else {
              toast("图片上传失败: " + (r.__error || "unknown"));
            }
          };
          rd.readAsDataURL(f);
          break;
        }
      }
    });

    const preview = el("div", "abn-preview");
    preview.style.display = "none";

    const foot = el("div", "abn-foot");
    const prevBtn = el("button", "abn-btn", "预览");
    prevBtn.addEventListener("click", () => {
      const show = preview.style.display === "none";
      preview.style.display = show ? "block" : "none";
      editor.style.display = show ? "none" : "block";
      prevBtn.textContent = show ? "编辑" : "预览";
      if (show) renderPreview();
    });
    const status = el("span", "abn-status", "");
    const collectBtn = el("button", "abn-btn", "📝 收集选中");
    collectBtn.addEventListener("click", collectSelection);
    const chatBtn = el("button", "abn-btn", "导出对话");
    chatBtn.style.display = /chatgpt\.com|openai\.com|claude\.ai|gemini\./.test(location.hostname) ? "" : "none";
    chatBtn.addEventListener("click", exportConversation);
    foot.append(prevBtn, collectBtn, chatBtn, status);

    const quotes = el("div", "abn-quotes");

    const libView = el("div", "abn-lib");
    libView.style.display = "none";

    wrap.append(head, tagsIn, editor, preview, quotes, libView, foot);
    shadow.appendChild(wrap);
    els = { titleIn, tagsIn, editor, preview, status, quotes, libView };
    return host;
  }

  function localGet(k) {
    try {
      return JSON.parse(localStorage.getItem("abn_" + k) || "null");
    } catch (err) {
      logWarn("notes localStorage read failed", err);
      return null;
    }
  }
  function localSet(k, v) {
    try {
      localStorage.setItem("abn_" + k, JSON.stringify(v));
    } catch (err) {
      logWarn("notes localStorage write failed", err);
    }
  }

  function renderMeta() {
    if (!els.titleIn || !note) return;
    if (els.titleIn.value !== note.title) els.titleIn.value = note.title || "";
    els.tagsIn.value = (note.tags || []).join(", ");
    if (els.editor.value !== note.content) els.editor.value = note.content || "";
    renderQuotes();
  }

  function renderEditor() {
    renderMeta();
    if (els.preview && els.preview.style.display !== "none") renderPreview();
  }

  function renderQuotes() {
    const box = els.quotes;
    if (!box) return;
    box.textContent = "";
    const qs = (note && note.quotes) || [];
    if (!qs.length) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    const h = el("div", "abn-q-h", `收集 ${qs.length} 条`);
    box.appendChild(h);
    for (const q of qs) {
      const row = el("div", "abn-q", q.text.slice(0, 140));
      row.title = "定位高亮";
      row.addEventListener("click", () => {
        const sp = document.querySelector(`.${HL_CLASS}[data-quote-id="${q.id}"]`);
        if (sp) sp.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      box.appendChild(row);
    }
  }

  async function showLibrary() {
    const lv = els.libView;
    lv.style.display = lv.style.display === "none" ? "block" : "none";
    if (lv.style.display === "none") return;
    lv.textContent = "加载中…";
    const meta = pageMeta();
    const r = await noteOp("list", { limit: 60 });
    if (r.__error) {
      lv.textContent = "加载失败: " + r.__error;
      return;
    }
    lv.textContent = "";
    const mine = (r.notes || []).filter((n) => n.url === meta.url);
    const others = (r.notes || []).filter((n) => n.url !== meta.url);
    const addRow = (n) => {
      const row = el("div", "abn-lib-row");
      row.append(el("div", "abn-lib-t", n.title || "(无标题)"));
      row.append(el("div", "abn-lib-s", `${n.domain || ""} · ${n.quoteCount} 引 · ${(n.tags || []).map((t) => "#" + t).join(" ")}`));
      row.addEventListener("click", async () => {
        const g = await noteOp("get", { id: n.id });
        if (!g.__error && g.note) {
          note = g.note;
          renderEditor();
          lv.style.display = "none";
        }
      });
      lv.appendChild(row);
    };
    if (mine.length) lv.appendChild(el("div", "abn-lib-h", "本页"));
    mine.forEach(addRow);
    if (others.length) lv.appendChild(el("div", "abn-lib-h", "全部"));
    others.forEach(addRow);
    const newBtn = el("button", "abn-btn abn-new", "＋ 新建本页笔记");
    newBtn.addEventListener("click", () => {
      const meta2 = pageMeta();
      note = { id: null, title: meta2.title, url: meta2.url, tags: [], content: "", quotes: [], created: 0, updated: 0 };
      renderEditor();
      lv.style.display = "none";
      persist().catch((e) => logWarn("create note failed", e));
    });
    lv.appendChild(newBtn);
  }

  // ---- minimal markdown (escaped-first, small subset) ------------------------
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function mdInline(s) {
    let t = esc(s);
    t = t.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2">');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return t;
  }
  function mdRender(src) {
    const out = [];
    let inList = false;
    let inQuote = false;
    let inCode = false;
    let codeBuf = "";
    for (const line of String(src || "").split("\n")) {
      if (/^```/.test(line)) {
        if (inCode) {
          out.push("<pre><code>" + esc(codeBuf) + "</code></pre>");
          codeBuf = "";
        }
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeBuf += line + "\n";
        continue;
      }
      const t = line.trimEnd();
      if (/^#{1,4}\s/.test(t)) {
        const lv = t.match(/^#+/)[0].length;
        out.push(`<h${Math.min(lv + 1, 6)}>${mdInline(t.replace(/^#+\s*/, ""))}</h${Math.min(lv + 1, 6)}>`);
        continue;
      }
      if (/^>\s?/.test(t)) {
        if (!inQuote) {
          out.push("<blockquote>");
          inQuote = true;
        }
        out.push(mdInline(t.replace(/^>\s?/, "")) + "<br>");
        continue;
      }
      if (inQuote) {
        out.push("</blockquote>");
        inQuote = false;
      }
      const li = t.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push("<li>" + mdInline(li[1]) + "</li>");
        continue;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (!t) {
        out.push("<br>");
        continue;
      }
      out.push("<p>" + mdInline(t) + "</p>");
    }
    if (inCode) out.push("<pre><code>" + esc(codeBuf) + "</code></pre>");
    if (inList) out.push("</ul>");
    if (inQuote) out.push("</blockquote>");
    return out.join("\n");
  }

  function renderPreview() {
    els.preview.innerHTML = mdRender(note ? note.content : "");
  }

  function showSidebar() {
    if (!host) {
      host = buildSidebar();
      document.documentElement.appendChild(host);
    }
    host.classList.add("abn-open");
    renderMeta();
  }
  function hideSidebar() {
    if (host) host.classList.remove("abn-open");
  }
  async function toggleSidebar() {
    if (!host || !host.classList.contains("abn-open")) {
      if (!enabled) await checkEnabled();
      if (!enabled) return;
      if (!note) await openNote();
      showSidebar();
      restoreHighlights().catch((e) => logWarn("restore failed", e));
    } else {
      hideSidebar();
    }
  }

  async function checkEnabled() {
    const r = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: "sw", cmd: "notes_state" }, (res) => {
        if (chrome.runtime.lastError) resolve({ enabled: false });
        else resolve(res || { enabled: false });
      });
    });
    enabled = !!r.enabled;
    window.__abNotesEnabled = enabled; // selection.js hides 存笔记 when off
    return enabled;
  }

  // Optional edge handle (default off — nothing persistent on the page unless
  // the user asks for it).
  let handle = null;
  function syncHandle(on) {
    if (on && enabled !== false) {
      if (!handle) {
        handle = document.createElement("div");
        handle.id = "agentbrowser-notes-handle";
        handle.className = "abn-handle";
        handle.textContent = "📝";
        handle.title = "笔记侧边栏";
        handle.addEventListener("click", () => toggleSidebar());
      }
      if (!handle.isConnected) document.documentElement.appendChild(handle);
    } else if (handle && handle.isConnected) {
      handle.remove();
    }
  }

  chrome.storage.local.get({ [HANDLE_KEY]: false }, (r) => {
    if (r[HANDLE_KEY]) syncHandle(true);
  });
  chrome.storage.onChanged.addListener((chg, area) => {
    if (area === "local" && chg[HANDLE_KEY]) syncHandle(!!chg[HANDLE_KEY].newValue);
  });

  window.__abNoteCollect = collectSelection;
  checkEnabled().then((on) => {
    if (on) restoreHighlights().catch((e) => logWarn("initial restore failed", e));
  });

  // ---- styles (kept inline so the sidebar survives sites that strip sheets) --
  const NOTES_CSS = `
:host { all: initial; }
.abn-wrap {
  position: fixed; top: 0; bottom: 0; width: 360px; z-index: 2147483000;
  background: #fff; color: #222; font: 13px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  box-shadow: 0 0 18px rgba(0,0,0,.22); box-sizing: border-box;
  transition: transform .18s ease;
}
.abn-right { right: 0; transform: translateX(105%); border-left: 1px solid #e2e2e2; }
.abn-left { left: 0; transform: translateX(-105%); border-right: 1px solid #e2e2e2; }
:host(.abn-open) .abn-right, :host(.abn-open) .abn-left { transform: none; }
.abn-head { display: flex; gap: 6px; align-items: center; }
.abn-title { flex: 1; border: none; border-bottom: 1px solid #ddd; font-size: 15px; font-weight: 600; padding: 4px 2px; outline: none; }
.abn-head-btns { display: flex; gap: 2px; }
.abn-ibtn { border: none; background: none; cursor: pointer; font-size: 14px; padding: 4px 6px; border-radius: 5px; color: #555; }
.abn-ibtn:hover { background: #f0f0f0; }
.abn-tags { border: 1px solid #e4e4e4; border-radius: 6px; padding: 4px 8px; font-size: 12px; outline: none; }
.abn-editor {
  flex: 1; min-height: 200px; resize: none; border: 1px solid #e4e4e4; border-radius: 8px;
  padding: 10px; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; outline: none;
}
.abn-preview { flex: 1; overflow: auto; border: 1px solid #e4e4e4; border-radius: 8px; padding: 10px; font-size: 13.5px; }
.abn-preview img { max-width: 100%; }
.abn-preview blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid #f0c869; color: #555; background: #fffdf3; }
.abn-preview pre { background: #f6f6f6; padding: 8px; border-radius: 6px; overflow: auto; }
.abn-foot { display: flex; align-items: center; gap: 6px; }
.abn-btn { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.abn-btn:hover { background: #f4f4f4; }
.abn-status { margin-left: auto; color: #999; font-size: 11px; }
.abn-quotes { max-height: 140px; overflow: auto; border-top: 1px dashed #eee; }
.abn-q-h { font-size: 11px; color: #999; padding: 4px 0 2px; }
.abn-q { font-size: 12px; color: #555; padding: 3px 6px; border-left: 3px solid #f0c869; margin: 3px 0; cursor: pointer; background: #fffdf3; }
.abn-q:hover { background: #fff7dd; }
.abn-lib { position: absolute; inset: 46px 0 0 0; background: #fff; overflow: auto; padding: 10px; z-index: 2; }
.abn-lib-h { font-size: 11px; color: #999; margin: 8px 0 4px; text-transform: uppercase; }
.abn-lib-row { padding: 7px 8px; border: 1px solid #eee; border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
.abn-lib-row:hover { border-color: #ccc; background: #fafafa; }
.abn-lib-t { font-weight: 600; font-size: 13px; }
.abn-lib-s { font-size: 11px; color: #999; }
.abn-new { width: 100%; margin-top: 8px; }
`;

  // Handle CSS lives on the light DOM (it's outside the shadow root).
  const handleStyle = document.createElement("style");
  handleStyle.textContent = `
#agentbrowser-notes-handle {
  position: fixed; right: 0; top: 42%; z-index: 2147482999; cursor: pointer;
  background: #fff; border: 1px solid #ddd; border-right: none;
  border-radius: 8px 0 0 8px; padding: 8px 5px 8px 7px; font-size: 14px;
  box-shadow: -2px 0 8px rgba(0,0,0,.12); user-select: none;
}
.${HL_CLASS} {
  background: rgba(255, 212, 80, .45); border-bottom: 2px solid #f0c869;
  cursor: pointer; padding: 0 1px; border-radius: 2px;
}
.${HL_CLASS}:hover { background: rgba(255, 212, 80, .7); }
`;
  document.documentElement.appendChild(handleStyle);
})();
