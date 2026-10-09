// Notes plugin content side (v2.23): fixed sidebar in shadow DOM +
// user-painted page highlights ("marks") with per-mark annotation notes.
// Storage lives on the hub (~/.agentchat/notes/) — marks.json for marks,
// one JSON file per note; a note with markId set is that mark's 批注.
// The page never sees a cloud call.
//
// Entry points: context menu "打开笔记侧边栏" / Alt+Shift+N / ⋯menu
// (高亮 / 批注 / 高亮色) / clicking a mark / the optional right-edge handle
// (chrome.storage.local notesEdgeHandle).
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
  const COLOR_KEY = "notesHlColor";
  const MARK_CLASS = "ab-mark";
  const SAVE_DEBOUNCE_MS = 800;
  const COLORS = {
    yellow: "#ffdb3c", green: "#8ce99a", blue: "#74c0fc",
    pink: "#faa2c1", purple: "#b197fc",
  };
  const COLOR_NAMES = { yellow: "黄", green: "绿", blue: "蓝", pink: "粉", purple: "紫" };

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
      brushSelection(true);
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

  // ---- state -----------------------------------------------------------------
  let pageNote = null; // {id,title,url,tags,content,...} — the page-level note
  const marks = new Map(); // markId -> {id,url,text,anchor,color,ts,noted}
  const markNotes = new Map(); // markId -> note (loaded lazily)
  let editing = null; // {kind:'page'|'mark', markId} | null
  let dirty = false;
  let saveTimer = null;
  let enabled = null; // null = unknown yet
  let curColor = localGet(COLOR_KEY) || "yellow";
  if (!COLORS[curColor]) curColor = "yellow";

  function pageMeta() {
    return { url: location.href.split("#")[0], title: document.title || location.href };
  }

  // The page note = latest note saved against this URL that isn't bound to a
  // mark; else a fresh unsaved stub that materializes on first save.
  async function openPageNote() {
    const meta = pageMeta();
    const r = await noteOp("list", { url: meta.url, limit: 20 });
    if (r.__error) return r;
    const first = (r.notes || []).find((n) => !n.markId);
    if (first) {
      const g = await noteOp("get", { id: first.id });
      if (!g.__error && g.note) {
        pageNote = g.note;
        return { ok: true };
      }
    }
    pageNote = {
      id: null, title: meta.title, url: meta.url,
      tags: [], content: "", markId: null, created: 0, updated: 0,
    };
    return { ok: true };
  }

  async function persist() {
    dirty = false;
    const n = editingTarget();
    if (!n) return;
    setStatus("保存中…");
    const args = {
      title: n.title, url: n.url, domain: n.domain, tags: n.tags, content: n.content,
    };
    if (n.id) args.id = n.id;
    if (n.markId) args.markId = n.markId;
    const r = await noteOp("save", args);
    if (r.__error || (r && r.error)) {
      setStatus("保存失败: " + (r.__error || r.error));
      dirty = true;
      return;
    }
    const saved = r.note;
    if (editing && editing.kind === "mark" && editing.markId) {
      markNotes.set(editing.markId, saved);
      syncMarkDom(editing.markId);
    } else {
      pageNote = saved;
    }
    setStatus("已保存");
    renderHead();
  }

  function editingTarget() {
    if (!editing) return pageNote;
    if (editing.kind === "page") return pageNote;
    return markNotes.get(editing.markId) || null;
  }

  function scheduleSave() {
    dirty = true;
    setStatus("编辑中…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (dirty) persist().catch((e) => logWarn("autosave failed", e));
    }, SAVE_DEBOUNCE_MS);
  }

  // ---- anchors + highlight painting -------------------------------------------
  // Anchor: {xpath,start,endXpath,end,prefix,suffix} — xpath+offsets first,
  // whole-document text scan with context as fallback.

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
    let host = root || document.body;
    if (host === document) host = document.body;
    if (host && host.nodeType === 3) host = host.parentNode;
    if (!host || host.nodeType !== 1) host = document.body;
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
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
      prefix: sc.nodeValue.slice(Math.max(0, range.startOffset - 60), range.startOffset),
      suffix: ec.nodeValue.slice(range.endOffset, range.endOffset + 60),
    };
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

  // Find [{node, off}] start/end for a mark: anchor-xpath first, then a
  // whole-document text scan matching exact text with prefix/suffix context.
  function locateMark(m) {
    const a = m.anchor || {};
    if (a.xpath) {
      const sn = nodeByXPath(a.xpath);
      const en = nodeByXPath(a.endXpath || a.xpath);
      const s = firstTextIn(sn), e = lastTextIn(en);
      if (s && e) {
        const st = { node: s, off: Math.min(a.start || 0, s.nodeValue.length) };
        const ed = { node: e, off: Math.min(a.end || 0, e.nodeValue.length) };
        try {
          const r = document.createRange();
          r.setStart(st.node, st.off);
          r.setEnd(ed.node, ed.off);
          const got = r.toString();
          if (got === m.text || got.includes(m.text.slice(0, 40))) return [st, ed];
        } catch (err) {
          logWarn("anchor range failed", err);
        }
      }
    }
    const nodes = textNodesIn(document.body);
    let whole = "";
    const bounds = [];
    for (const n of nodes) {
      whole += n.nodeValue;
      bounds.push(whole.length);
    }
    const needle = m.text;
    const ctx = (a.prefix || "") + needle + (a.suffix || "");
    let idx = ctx && whole.includes(ctx) ? whole.indexOf(ctx) + (a.prefix || "").length : whole.indexOf(needle);
    if (idx < 0) {
      const flat = needle.replace(/\s+/g, " ").trim();
      const flatHay = whole.replace(/\s+/g, " ");
      idx = flatHay.indexOf(flat);
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

  // Wrap every text-node segment a range touches in a colored mark span.
  function paintRange(start, end, mark) {
    const r = document.createRange();
    r.setStart(start.node, start.off);
    r.setEnd(end.node, end.off);
    const nodes = textNodesIn(r.commonAncestorContainer);
    const targets = [];
    for (const n of nodes) {
      try {
        if (r.intersectsNode(n)) targets.push(n);
      } catch (err) {
        logWarn("intersectsNode skipped a node", err);
      }
    }
    for (const n of targets) {
      const so = n === start.node ? start.off : 0;
      const eo = n === end.node ? end.off : n.nodeValue.length;
      if (eo <= so) continue;
      const mid = n.splitText(so);
      if (mid.nodeValue.length > eo - so) mid.splitText(eo - so);
      const span = document.createElement("span");
      span.className = MARK_CLASS;
      span.dataset.mid = mark.id;
      span.dataset.c = mark.color || "yellow";
      span.dataset.noted = markNotes.has(mark.id) || mark.noted ? "1" : "";
      span.title = "高亮 · 点击查看批注";
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
    }
  }

  function paintMark(m) {
    if (document.querySelector(`.${MARK_CLASS}[data-mid="${m.id}"]`)) return true;
    const loc = locateMark(m);
    if (!loc) return false;
    try {
      paintRange(loc[0], loc[1], m);
      return true;
    } catch (err) {
      logWarn("mark paint failed", err);
      return false;
    }
  }

  function unpaintMark(mid) {
    document.querySelectorAll(`.${MARK_CLASS}[data-mid="${mid}"]`).forEach((s) => {
      s.replaceWith(...s.childNodes);
    });
  }

  // Page-side style follows note state: painted spans re-tint/edge-outline as
  // soon as a mark gains/loses its 批注 (and on recolor).
  function syncMarkDom(mid) {
    const m = marks.get(mid);
    document.querySelectorAll(`.${MARK_CLASS}[data-mid="${mid}"]`).forEach((sp) => {
      if (m) sp.dataset.c = m.color;
      sp.dataset.noted = markNotes.get(mid) && String(markNotes.get(mid).content || "").trim() ? "1" : "";
    });
  }

  async function refreshMarks() {
    const meta = pageMeta();
    const r = await noteOp("marks_for_url", { url: meta.url });
    if (r.__error) return;
    marks.clear();
    for (const m of r.marks || []) {
      marks.set(m.id, m);
      if (m.noted) {
        const g = await noteOp("note_for_mark", { markId: m.id });
        if (!g.__error && g.note) markNotes.set(m.id, g.note);
      }
      try {
        paintMark(m);
      } catch (err) {
        logWarn("mark restore failed", err);
      }
    }
  }

  // ---- selection actions -------------------------------------------------------
  // 🖌 高亮 = mark only; 📝 批注 = mark + open its annotation editor.
  async function brushSelection(withNote, opts = {}) {
    const sel = getSelection();
    let range = opts.range || null;
    if (!range && sel && !sel.isCollapsed && String(sel).trim()) range = sel.getRangeAt(0);
    if (!range) return;
    if (!enabled) await checkEnabled();
    if (!enabled) return;
    const text = String(range).trim().slice(0, 4000);
    const anchor = anchorForRange(range);
    const meta = pageMeta();
    const r = await noteOp("mark_save", {
      url: meta.url, text, anchor, color: COLORS[opts.color] ? opts.color : curColor,
    });
    if (r.__error || (r && r.error)) {
      toast("高亮失败: " + (r.__error || r.error));
      return;
    }
    const m = r.mark;
    marks.set(m.id, m);
    if (sel && !opts.range) sel.removeAllRanges();
    try {
      paintMark(m);
    } catch (err) {
      logWarn("live paint failed", err);
    }
    if (withNote) {
      showSidebar();
      openEditor("mark", m.id);
    } else {
      toast(`已高亮（${COLOR_NAMES[m.color] || m.color}）`);
    }
    renderList();
    renderHead();
  }

  // Click a painted mark -> open its annotation in the sidebar.
  document.addEventListener("click", (e) => {
    if (!enabled) return;
    const sp = e.target && e.target.closest ? e.target.closest("." + MARK_CLASS) : null;
    if (!sp || !sp.dataset.mid) return;
    showSidebar();
    openEditor("mark", sp.dataset.mid);
  });

  // chatGPT/Claude-style export: scrape the conversation into the page note.
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
    if (!pageNote) await openPageNote();
    if (!pageNote.id) await persist();
    if (!pageNote.id) return;
    const r = await noteOp("append", { id: pageNote.id, text: `## 对话导出（${pageMeta().title}）\n\n` + md });
    if (r.__error) toast(r.__error);
    else {
      pageNote = r.note;
      render();
      toast("对话已存入本页笔记");
    }
  }

  // ---- sidebar DOM -------------------------------------------------------------
  let host = null;
  let shadow = null;
  let els = {};

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
    toast._t = setTimeout(() => setStatus(""), 2400);
  }

  function buildSidebar() {
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = NOTES_CSS;
    shadow.appendChild(style);

    const side = localGet(SIDE_KEY) || "right";
    const wrap = el("div", "abn-wrap " + (side === "left" ? "abn-left" : "abn-right"));

    // headbar: 📝 | 保存 | 管理页 | ⚙导出 | ⇋ | …grow… | 关闭(far right)
    const head = el("div", "abn-head");
    const logo = el("span", "abn-logo", "📝");
    const saveBtn = el("button", "abn-hbtn", "保存");
    saveBtn.addEventListener("click", () => persist());
    const lib = el("button", "abn-hbtn", "文档库");
    lib.addEventListener("click", () => window.open("http://127.0.0.1:9010/admin#notes", "_blank"));
    const flip = el("button", "abn-hbtn", "⇋");
    flip.title = "换到另一侧";
    flip.addEventListener("click", () => {
      const next = side === "left" ? "right" : "left";
      localSet(SIDE_KEY, next);
      wrap.className = "abn-wrap " + (next === "left" ? "abn-left" : "abn-right");
    });
    const grow = el("span", "abn-grow");
    const close = el("button", "abn-hbtn", "关闭");
    close.addEventListener("click", hideSidebar);
    head.append(logo, saveBtn, lib, flip, grow, close);

    // body: infocard + 本页笔记 card + 高亮列表
    const body = el("div", "abn-body");
    const info = el("div", "abn-info");
    const iTitle = el("div", "abn-info-t");
    const iUrl = el("div", "abn-info-u");
    const iMeta = el("div", "abn-info-m");
    const iTags = el("span", "");
    const iCount = el("span", "");
    iMeta.append(iTags, iCount);
    info.append(iTitle, iUrl, iMeta);

    body.append(info, el("div", "abn-sec", "本页笔记"));
    const pageCard = el("div", "abn-pnote");
    pageCard.addEventListener("click", () => openEditor("page", null));
    body.appendChild(pageCard);

    const msec = el("div", "abn-sec", "高亮 ");
    const mCount = el("span", "");
    msec.appendChild(mCount);
    body.appendChild(msec);
    const mList = el("div", "abn-mlist");
    body.appendChild(mList);

    // editor overlay (returns via ←)
    const edView = el("div", "abn-edit");
    const edHead = el("div", "abn-ed-head");
    const edBack = el("button", "abn-ibtn", "←");
    edBack.addEventListener("click", closeEditor);
    const edFor = el("span", "abn-ed-for");
    const edUnmark = el("button", "abn-hbtn abn-danger", "取消高亮");
    edUnmark.addEventListener("click", removeMark);
    const edDel = el("button", "abn-hbtn abn-danger", "删批注");
    edDel.addEventListener("click", deleteAnnotation);
    const edGrow = el("span", "abn-grow");
    const edStatus = el("span", "abn-status", "");
    edHead.append(edBack, edFor, edGrow, edUnmark, edDel, edStatus);

    const edQuote = el("div", "abn-ed-quote");
    const edColors = el("div", "abn-ed-colors");
    const edTitle = el("input", "abn-ed-title");
    edTitle.placeholder = "批注标题";
    edTitle.addEventListener("input", () => {
      const n = editingTarget();
      if (n) {
        n.title = edTitle.value;
        scheduleSave();
      }
    });
    const edTags = el("input", "abn-ed-tags");
    edTags.placeholder = "标签（逗号分隔）";
    edTags.addEventListener("change", () => {
      const n = editingTarget();
      if (n) {
        n.tags = edTags.value.split(",").map((s) => s.trim()).filter(Boolean);
        scheduleSave();
      }
    });
    const edTa = el("textarea", "abn-ed-ta");
    edTa.placeholder = "写批注（markdown，Ctrl+V 直接粘贴图片）…";
    edTa.addEventListener("input", () => {
      const n = editingTarget();
      if (n) {
        n.content = edTa.value;
        if (editing && editing.kind === "mark") syncMarkDom(editing.markId);
        scheduleSave();
      }
      if (els.preview && els.preview.style.display !== "none") renderPreview();
    });
    edTa.addEventListener("paste", (e) => {
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
              const p = edTa.selectionStart;
              edTa.value = edTa.value.slice(0, p) + ins + edTa.value.slice(edTa.selectionEnd);
              edTa.selectionStart = edTa.selectionEnd = p + ins.length;
              const n = editingTarget();
              if (n) {
                n.content = edTa.value;
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
    const edPrev = el("div", "abn-preview");
    edPrev.style.display = "none";
    const edFoot = el("div", "abn-ed-foot");
    const prevBtn = el("button", "abn-btn", "预览");
    prevBtn.addEventListener("click", () => {
      const show = edPrev.style.display === "none";
      edPrev.style.display = show ? "block" : "none";
      edTa.style.display = show ? "none" : "block";
      prevBtn.textContent = show ? "编辑" : "预览";
      if (show) renderPreview();
    });
    const chatBtn = el("button", "abn-btn", "导出对话");
    chatBtn.style.display = /chatgpt\.com|openai\.com|claude\.ai|gemini\./.test(location.hostname) ? "" : "none";
    chatBtn.addEventListener("click", exportConversation);
    edFoot.append(prevBtn, chatBtn);
    edView.append(edHead, edQuote, edColors, edTitle, edTags, edTa, edPrev, edFoot);

    wrap.append(head, body, edView);
    shadow.appendChild(wrap);
    els = {
      iTitle, iUrl, iTags, iCount, mCount, mList, pageCard,
      edView, edFor, edQuote, edColors, edTitle, edTags, edTa,
      preview: edPrev, status: edStatus, edUnmark, edDel, saveBtn,
    };
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

  function renderHead() {
    if (!els.iTitle) return;
    const meta = pageMeta();
    els.iTitle.textContent = (pageNote && pageNote.title) || meta.title;
    els.iUrl.textContent = meta.url;
    els.iTags.textContent = pageNote && pageNote.tags && pageNote.tags.length
      ? pageNote.tags.map((t) => "#" + t).join(" ")
      : "未标标签";
    const noted = [...marks.keys()].filter((id) => {
      const n = markNotes.get(id);
      return n && String(n.content || "").trim();
    }).length;
    els.iCount.textContent = `${marks.size} 个高亮 · ${noted} 条批注`;
    els.mCount.textContent = marks.size ? String(marks.size) : "";
  }

  function render() {
    renderHead();
    renderList();
    const pn = els.pageCard;
    pn.textContent = "";
    const t = el("div", "abn-pnote-t");
    t.append(el("span", "", (pageNote && pageNote.title) || "本页笔记"), el("span", "abn-pnote-go", "›"));
    pn.appendChild(t);
    const c = pageNote && String(pageNote.content || "").trim();
    pn.appendChild(
      c
        ? el("div", "abn-pnote-s", c.slice(0, 180))
        : el("div", "abn-pnote-e", "整页笔记/摘要…（汇总下方高亮批注）")
    );
  }

  function renderList() {
    const list = els.mList;
    if (!list) return;
    list.textContent = "";
    if (!marks.size) {
      list.appendChild(el("div", "abn-empty", "还没有高亮——选中页面文字用 ⋯ 菜单里的 🖌/📝"));
      return;
    }
    for (const m of marks.values()) {
      const mn = markNotes.get(m.id);
      const row = el("div", "abn-mrow");
      row.style.setProperty("--hlc", COLORS[m.color] || COLORS.yellow);
      row.appendChild(el("div", "abn-mt", m.text.slice(0, 120)));
      row.appendChild(
        mn && String(mn.content || "").trim()
          ? el("div", "abn-mn", String(mn.content).slice(0, 140))
          : el("div", "abn-mn-none", "点击添加批注")
      );
      const foot = el("div", "abn-mfoot");
      foot.append(
        el("span", "", mn ? "📝 已批注" : "○ 仅高亮"),
        el("span", "", new Date(m.ts).toLocaleTimeString())
      );
      row.appendChild(foot);
      row.addEventListener("click", () => openEditor("mark", m.id));
      list.appendChild(row);
    }
  }

  // ---- editor overlay -----------------------------------------------------------
  async function openEditor(kind, markId) {
    if (!els.edView) return;
    editing = { kind, markId };
    const isPage = kind === "page";
    let n;
    if (isPage) {
      if (!pageNote) await openPageNote();
      n = pageNote;
    } else {
      if (!markNotes.has(markId)) {
        const g = await noteOp("note_for_mark", { markId });
        if (!g.__error && g.note) markNotes.set(markId, g.note);
      }
      if (!markNotes.has(markId)) {
        const meta = pageMeta();
        markNotes.set(markId, {
          id: null, markId, title: "", url: meta.url,
          tags: [], content: "", created: 0, updated: 0,
        });
      }
      n = markNotes.get(markId);
    }
    els.edFor.textContent = isPage ? "本页笔记" : "高亮批注";
    els.edQuote.classList.toggle("on", !isPage);
    if (!isPage) {
      const m = marks.get(markId);
      els.edQuote.textContent = m ? m.text.slice(0, 200) : "";
      els.edQuote.style.setProperty("--hlc", COLORS[(m && m.color) || "yellow"] || COLORS.yellow);
    }
    els.edTitle.value = n.title || "";
    els.edTags.value = (n.tags || []).join(", ");
    els.edTa.value = n.content || "";
    renderEdColors(isPage ? null : (marks.get(markId) || {}).color || "yellow");
    els.edUnmark.style.display = isPage ? "none" : "";
    els.edDel.style.display = isPage ? "none" : "";
    els.edView.classList.add("on");
    els.edTa.focus();
  }

  function closeEditor() {
    els.edView.classList.remove("on");
    editing = null;
    render();
  }

  function renderEdColors(cur) {
    const box = els.edColors;
    box.textContent = "";
    box.appendChild(el("span", "", "颜色"));
    if (cur == null) {
      box.style.display = "none";
      return;
    }
    box.style.display = "flex";
    for (const c of Object.keys(COLORS)) {
      const d = el("span", "abn-cdot" + (c === cur ? " sel" : ""));
      d.style.background = COLORS[c];
      d.title = COLOR_NAMES[c];
      d.addEventListener("click", async () => {
        if (!editing || editing.kind !== "mark") return;
        const m = marks.get(editing.markId);
        if (!m) return;
        m.color = c;
        syncMarkDom(m.id);
        renderEdColors(c);
        renderList();
        const r = await noteOp("mark_update", { id: m.id, color: c });
        if (r.__error) toast("改色失败: " + r.__error);
      });
      box.appendChild(d);
    }
  }

  async function deleteAnnotation() {
    if (!editing || editing.kind !== "mark") return;
    const mid = editing.markId;
    const n = markNotes.get(mid);
    if (n && n.id) {
      const r = await noteOp("delete", { id: n.id });
      if (r.__error) {
        toast("删除失败: " + r.__error);
        return;
      }
    }
    markNotes.delete(mid);
    syncMarkDom(mid);
    closeEditor();
    toast("已删批注（高亮保留）");
  }

  async function removeMark() {
    if (!editing || editing.kind !== "mark") return;
    const mid = editing.markId;
    const r = await noteOp("mark_remove", { id: mid });
    if (r.__error) {
      toast("取消失败: " + r.__error);
      return;
    }
    unpaintMark(mid);
    marks.delete(mid);
    markNotes.delete(mid);
    closeEditor();
    toast("已取消高亮");
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
    const n = editingTarget();
    els.preview.innerHTML = mdRender(n ? n.content : "");
  }

  function showSidebar() {
    if (!host) {
      host = buildSidebar();
      document.documentElement.appendChild(host);
    }
    host.classList.add("abn-open");
    render();
  }
  function hideSidebar() {
    if (host) host.classList.remove("abn-open");
  }
  async function toggleSidebar() {
    if (!host || !host.classList.contains("abn-open")) {
      if (!enabled) await checkEnabled();
      if (!enabled) return;
      if (!pageNote) await openPageNote();
      showSidebar();
      refreshMarks().catch((e) => logWarn("marks restore failed", e));
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
    window.__abNotesEnabled = enabled; // selection.js hides note items when off
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

  // Plugin contract (v2.24): register toolbar slots on the shared bus and
  // expose the marks engine as a service — AI annotation, 长难句 and other
  // plugins reuse the same anchors/paints via __abPlugins.call('marks', ...).
  function registerPlugin() {
    const P = window.__abPlugins;
    if (!P) return;
    P.setToolbarActions("notes", [
      { plugin: "notes", id: "hl", icon: "🖌", label: "高亮", run: () => brushSelection(false) },
      { plugin: "notes", id: "annotate", icon: "📝", label: "批注", run: () => brushSelection(true) },
      {
        plugin: "notes", id: "color", kind: "palette", icon: "🎨", label: "高亮色 ",
        colors: COLORS, get: () => curColor,
        run: (c) => {
          if (!COLORS[c]) return;
          curColor = c;
          localSet(COLOR_KEY, c);
        },
      },
    ]);
    P.provide("marks", {
      // other plugins: paint the live selection or a range as a mark
      paint: (range, opts = {}) =>
        brushSelection(false, { color: opts.color, range }),
      list: () => [...marks.values()],
      get: (id) => marks.get(id) || null,
      setNoted: (id) => {
        const n = markNotes.get(id);
        if (!n) markNotes.set(id, { id: null, markId: id, content: " " });
        syncMarkDom(id);
      },
      remove: (id) => removeMarkById(id),
      openAnnotation: (id) => {
        showSidebar();
        openEditor("mark", id);
      },
      colors: () => ({ ...COLORS }),
    });
  }

  // removeMark is bound to the editor; this is the service-facing variant.
  async function removeMarkById(mid) {
    const r = await noteOp("mark_remove", { id: mid });
    if (r.__error) return r;
    unpaintMark(mid);
    marks.delete(mid);
    markNotes.delete(mid);
    render();
    return { deleted: mid };
  }

  checkEnabled().then((on) => {
    if (on) {
      registerPlugin();
      refreshMarks().catch((e) => logWarn("initial marks restore failed", e));
    }
  });

  // ---- styles (kept inline so the sidebar survives sites that strip sheets) --
  const NOTES_CSS = `
:host { all: initial; }
.abn-wrap {
  position: fixed; top: 0; bottom: 0; width: 380px; z-index: 2147483000;
  background: #fff; color: #222; font: 13px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  box-shadow: 0 0 18px rgba(0,0,0,.22);
  transition: transform .18s ease;
}
.abn-right { right: 0; transform: translateX(105%); border-left: 1px solid #e2e2e2; }
.abn-left { left: 0; transform: translateX(-105%); border-right: 1px solid #e2e2e2; }
:host(.abn-open) .abn-right, :host(.abn-open) .abn-left { transform: none; }
.abn-head { display: flex; gap: 2px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.abn-logo { font-size: 15px; margin-right: 4px; }
.abn-hbtn { border: none; background: none; font: inherit; font-size: 12.5px; padding: 4px 8px; border-radius: 6px; cursor: pointer; color: #555; white-space: nowrap; }
.abn-hbtn:hover { background: #ececec; }
.abn-hbtn.abn-danger { color: #c00; }
.abn-grow { flex: 1; }
.abn-body { flex: 1; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.abn-info { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; background: #fafafa; }
.abn-info-t { font-size: 14px; font-weight: 600; line-height: 1.4; }
.abn-info-u { font-size: 11px; color: #999; word-break: break-all; margin-top: 2px; }
.abn-info-m { display: flex; justify-content: space-between; font-size: 11.5px; color: #4f46e5; margin-top: 6px; }
.abn-sec { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: .04em; }
.abn-pnote { border: 1px solid #e9d8a6; background: #fffdf3; border-radius: 10px; padding: 9px 11px; cursor: pointer; }
.abn-pnote:hover { border-color: #d9c07a; }
.abn-pnote-t { font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; }
.abn-pnote-go { color: #bbb; }
.abn-pnote-s { font-size: 12px; color: #666; margin-top: 3px; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.abn-pnote-e { color: #aaa; font-size: 12.5px; margin-top: 3px; }
.abn-mlist { display: flex; flex-direction: column; gap: 8px; }
.abn-empty { color: #bbb; font-size: 12px; padding: 4px 2px; }
.abn-mrow { border: 1px solid #eee; border-radius: 9px; padding: 8px 10px; cursor: pointer; }
.abn-mrow:hover { border-color: #ccc; background: #fafafa; }
.abn-mt { font-size: 12.5px; color: #444; border-left: 3px solid var(--hlc, #ffdb3c); padding-left: 7px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.abn-mn { font-size: 12px; color: #666; margin-top: 5px; padding: 6px 8px; background: #f4f4ff; border-radius: 6px; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.abn-mn-none { font-size: 11.5px; color: #aaa; margin-top: 5px; }
.abn-mfoot { display: flex; justify-content: space-between; font-size: 11px; color: #bbb; margin-top: 5px; }
.abn-edit { position: absolute; inset: 0; background: #fff; display: none; flex-direction: column; z-index: 3; }
.abn-edit.on { display: flex; }
.abn-ed-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.abn-ibtn { border: none; background: none; cursor: pointer; font-size: 14px; padding: 4px 6px; border-radius: 5px; color: #555; }
.abn-ibtn:hover { background: #ececec; }
.abn-ed-for { font-size: 12px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.abn-ed-quote { margin: 10px 12px 0; padding: 7px 10px; border-left: 3px solid var(--hlc, #ffdb3c); background: #fafafa; font-size: 12px; color: #666; border-radius: 0 6px 6px 0; display: none; }
.abn-ed-quote.on { display: block; }
.abn-ed-colors { display: flex; gap: 6px; margin: 8px 12px 0; align-items: center; font-size: 11px; color: #999; }
.abn-cdot { width: 16px; height: 16px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
.abn-cdot.sel { border-color: #333; }
.abn-ed-title { margin: 8px 12px 0; border: none; border-bottom: 1px solid #ddd; font-size: 14.5px; font-weight: 600; padding: 4px 2px; outline: none; }
.abn-ed-tags { margin: 8px 12px 0; border: 1px solid #e4e4e4; border-radius: 6px; padding: 4px 8px; font-size: 12px; outline: none; }
.abn-ed-ta { flex: 1; margin: 8px 12px; min-height: 0; resize: none; border: 1px solid #e4e4e4; border-radius: 8px; padding: 10px; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; outline: none; }
.abn-preview { flex: 1; margin: 8px 12px; overflow: auto; border: 1px solid #e4e4e4; border-radius: 8px; padding: 10px; font-size: 13.5px; }
.abn-preview img { max-width: 100%; }
.abn-preview blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid #f0c869; color: #555; background: #fffdf3; }
.abn-preview pre { background: #f6f6f6; padding: 8px; border-radius: 6px; overflow: auto; }
.abn-ed-foot { display: flex; align-items: center; gap: 6px; padding: 0 12px 10px; }
.abn-btn { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.abn-btn:hover { background: #f4f4f4; }
.abn-status { color: #999; font-size: 11px; }
`;

  // Handle + mark CSS live on the light DOM (they're outside the shadow root).
  const handleStyle = document.createElement("style");
  handleStyle.textContent = `
#agentbrowser-notes-handle {
  position: fixed; right: 0; top: 42%; z-index: 2147482999; cursor: pointer;
  background: #fff; border: 1px solid #ddd; border-right: none;
  border-radius: 8px 0 0 8px; padding: 8px 5px 8px 7px; font-size: 14px;
  box-shadow: -2px 0 8px rgba(0,0,0,.12); user-select: none;
}
.${MARK_CLASS} { padding: 0 1px; border-radius: 2px; cursor: pointer; transition: background .15s; }
.${MARK_CLASS}[data-c="yellow"] { background: rgba(255,219,60,.4); }
.${MARK_CLASS}[data-c="green"] { background: rgba(140,233,154,.4); }
.${MARK_CLASS}[data-c="blue"] { background: rgba(116,192,252,.4); }
.${MARK_CLASS}[data-c="pink"] { background: rgba(250,162,193,.4); }
.${MARK_CLASS}[data-c="purple"] { background: rgba(177,151,252,.4); }
.${MARK_CLASS}[data-c="yellow"]:hover { background: rgba(255,219,60,.65); }
.${MARK_CLASS}[data-c="green"]:hover { background: rgba(140,233,154,.65); }
.${MARK_CLASS}[data-c="blue"]:hover { background: rgba(116,192,252,.65); }
.${MARK_CLASS}[data-c="pink"]:hover { background: rgba(250,162,193,.65); }
.${MARK_CLASS}[data-c="purple"]:hover { background: rgba(177,151,252,.65); }
.${MARK_CLASS}[data-noted="1"] { outline: 1.6px dashed #4f46e5; outline-offset: 1px; }
.${MARK_CLASS}[data-noted="1"]::after { content: "📝"; font-size: .62em; vertical-align: super; opacity: .75; }
`;
  document.documentElement.appendChild(handleStyle);
})();
