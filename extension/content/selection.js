// Content script: watches text selection, shows a floating "Ask" button next
// to it, captures a rich DOM context (enclosing code block, table, heading,
// surrounding paragraphs) and hands everything to the service worker, which
// opens the side panel. Also answers GET_SELECTION_CONTEXT for the
// "Ask AgentBrowser" context-menu item and pre-caches the right-clicked
// element's context so the menu path is fast.
//
// Derived from cola-sk/context-lens (MIT) `content.js`:
// findPrecedingHeading, findEnclosingCodeBlock, findEnclosingTable,
// getSurroundingText, buildSemanticPath, and the floating-button pattern are
// adapted from that implementation; Chrome-API glue (storage, messaging,
// side panel handoff) is ours.

// All content scripts share one isolated world — wrap in an IIFE so
// top-level identifiers can't collide with annotation.js / video-ask.js.
(function () {

const BTN_ID = "agentbrowser-ask-btn";
const MENU_ID = "agentbrowser-sel-menu";
const POP_ID = "agentbrowser-sel-tr-pop";
const CHIP_ID = "agentbrowser-sel-vocab-chip";
const VOCAB_KEY = "abVocab"; // chrome.storage.local: [{w, host, ts}] 生词本
const FLOAT_ASK_KEY = "floatingAskEnabled"; // chrome.storage.local, set by sw
const AUTO_SEL_KEY = "autoSelectionEnabled"; // chrome.storage.local, set by the panel settings
const FLOAT_THEME_KEY = "floatTheme"; // chrome.storage.local, frost | ink | paper
const FLOAT_THEMES = new Set(["frost", "ink", "paper"]);
const SPACE_TR_KEY = "abSpaceTranslate"; // triple-space input-translation toggle
const YIELD_KEY = "abYieldForeign"; // yield our floaters to foreign overlays

let floatBtn = null;
let trPop = null;
let foreignStop = null; // float-guard watcher disarm while the bar is visible
let currentSelectionContext = null; // compiled on selection mouseup
let lastRightClickContext = null; // compiled on contextmenu
let lastRightClickElement = null;
let floatingAskEnabled = true; // cached; kept in sync below
let autoSelectionEnabled = true; // cached; panel 设置开关
let floatTheme = "frost"; // cached; settings select
let spaceTrEnabled = false; // cached; settings checkbox — opt-in
let yieldForeign = true; // cached; settings toggle — foreign overlays win
let spaceRun = 0;
let spaceTimer = null;
let lastSelBounds = null; // viewport rect of the last selection, for the guard

// Editable field the triple-space input translation acts on — input/textarea
// (except passwords) or any contentEditable host.
function editableAt(target) {
  if (!target) return null;
  if (target.isContentEditable) return target;
  const tag = String(target.tagName || "");
  if (tag === "TEXTAREA") return target;
  if (tag === "INPUT" && String(target.type || "").toLowerCase() !== "password") {
    return target;
  }
  return null;
}

function replaceInputText(el, text) {
  try {
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand("insertText", false, text)) {
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      el.setSelectionRange(0, String(el.value || "").length);
      // execCommand keeps the edit undoable; direct assignment is the fallback
      // (dispatch input so framework-controlled fields still see the change).
      if (!document.execCommand("insertText", false, text)) {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  } catch (err) {
    logWarn("input translate replace failed", err);
  }
}

async function translateInput(el) {
  const raw = el.isContentEditable ? el.innerText : el.value;
  const text = String(raw || "").replace(/\s+$/, "");
  if (!text) return;
  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "translate_ask",
      text,
    });
    if (response && response.success && response.text) {
      replaceInputText(el, String(response.text));
    } else {
      logWarn("input translate failed", response && response.error);
    }
  } catch (err) {
    logWarn("input translate send failed", err);
  }
}

// The floating button can clash with other overlays, so it obeys a
// persistent user setting flipped from the right-click menu. Read it once
// at startup and live via storage.onChanged; turning it off hides the
// button immediately.
if (isContextValid()) {
  chrome.storage.local
    .get({
      [FLOAT_ASK_KEY]: true,
      [AUTO_SEL_KEY]: true,
      [FLOAT_THEME_KEY]: "frost",
      [SPACE_TR_KEY]: false,
      [YIELD_KEY]: true,
    })
    .then((r) => {
      floatingAskEnabled = r[FLOAT_ASK_KEY] !== false;
      autoSelectionEnabled = r[AUTO_SEL_KEY] !== false;
      floatTheme = FLOAT_THEMES.has(r[FLOAT_THEME_KEY]) ? r[FLOAT_THEME_KEY] : "frost";
      spaceTrEnabled = r[SPACE_TR_KEY] === true;
      yieldForeign = r[YIELD_KEY] !== false;
    })
    .catch((err) => {
      logWarn("floating-ask setting read failed", err);
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // Each key gates on its own presence — a change to one must not touch the
    // other (reading a key absent from `changes` would throw).
    if (FLOAT_ASK_KEY in changes) {
      floatingAskEnabled = changes[FLOAT_ASK_KEY].newValue !== false;
      if (!floatingAskEnabled) hideButton();
    }
    if (AUTO_SEL_KEY in changes) {
      autoSelectionEnabled = changes[AUTO_SEL_KEY].newValue !== false;
    }
    if (SPACE_TR_KEY in changes) {
      spaceTrEnabled = changes[SPACE_TR_KEY].newValue === true;
    }
    if (YIELD_KEY in changes) {
      yieldForeign = changes[YIELD_KEY].newValue !== false;
    }
    if (FLOAT_THEME_KEY in changes) {
      const v = changes[FLOAT_THEME_KEY].newValue;
      floatTheme = FLOAT_THEMES.has(v) ? v : "frost";
      applyTheme();
    }
  });
}

function applyTheme() {
  if (floatBtn) floatBtn.dataset.abtheme = floatTheme;
  if (trPop) trPop.dataset.abtheme = floatTheme;
}

function isContextValid() {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.id !== "undefined"
  );
}

function logWarn(...args) {
  console.warn("[agentbrowser]", ...args);
}

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// --- rich DOM context extractors --------------------------------------------

// Nearest preceding heading in document order ("H2: Intro").
function findPrecedingHeading(node) {
  try {
    const headings = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6")
    );
    let closest = null;
    for (const h of headings) {
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        closest = h;
      } else {
        break;
      }
    }
    if (closest) return { tag: closest.tagName, text: closest.innerText.trim() };
    return null;
  } catch (err) {
    logWarn("findPrecedingHeading failed", err);
    return null;
  }
}

// Selection inside <pre>/<code> -> {language, fullCode} for the whole block.
function findEnclosingCodeBlock(node) {
  let current = node;
  while (current && current !== document.documentElement) {
    if (current.tagName === "PRE" || current.tagName === "CODE") {
      let language = "";
      const checkElements = [current];
      if (current.parentElement && current.parentElement.tagName === "PRE") {
        checkElements.push(current.parentElement);
      }
      for (const el of checkElements) {
        for (const cls of Array.from(el.classList)) {
          if (cls.startsWith("language-") || cls.startsWith("lang-")) {
            language = cls.replace("language-", "").replace("lang-", "");
            break;
          }
        }
        if (language) break;
      }
      return {
        language: language || "code",
        fullCode: current.innerText.trim(),
      };
    }
    current = current.parentElement;
  }
  return null;
}

// Selection inside <table> -> simplified Markdown of headers + active row.
function findEnclosingTable(node) {
  let current = node;
  while (current && current !== document.documentElement) {
    if (current.tagName === "TABLE") {
      try {
        const ths = Array.from(current.querySelectorAll("th"));
        let headers = ths.map((th) => th.innerText.trim());
        if (headers.length === 0) {
          const firstRow = current.querySelector("tr");
          if (firstRow) {
            headers = Array.from(firstRow.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
          }
        }

        let activeRow = node;
        while (activeRow && activeRow !== current) {
          if (activeRow.tagName === "TR") break;
          activeRow = activeRow.parentElement;
        }

        let rowData = [];
        if (activeRow && activeRow.tagName === "TR") {
          rowData = Array.from(activeRow.querySelectorAll("td, th")).map((td) =>
            td.innerText.trim()
          );
        }

        if (headers.length > 0 || rowData.length > 0) {
          let md =
            "| " +
            (headers.length > 0
              ? headers.join(" | ")
              : rowData.map((_, i) => `Col ${i + 1}`).join(" | ")) +
            " |\n";
          md +=
            "| " +
            (headers.length > 0 ? headers : rowData)
              .map(() => "---")
              .join(" | ") +
            " |\n";
          if (rowData.length > 0) md += "| " + rowData.join(" | ") + " |\n";
          return md.trim();
        }
        return null;
      } catch (err) {
        logWarn("findEnclosingTable failed", err);
        return null;
      }
    }
    current = current.parentElement;
  }
  return null;
}

// Up to charLimit chars of text before and after the selection.
function getSurroundingText(range, charLimit = 800) {
  try {
    const container =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;

    const containerText = container.innerText || "";
    const selectedText = range.toString();

    const startIdx = containerText.indexOf(selectedText);
    if (startIdx === -1) {
      // Selection spans multiple elements: walk siblings instead.
      let beforeText = "";
      let afterText = "";

      let prev = container.previousElementSibling;
      let count = 0;
      while (prev && beforeText.length < charLimit && count < 3) {
        beforeText = prev.innerText + "\n" + beforeText;
        prev = prev.previousElementSibling;
        count++;
      }

      let next = container.nextElementSibling;
      count = 0;
      while (next && afterText.length < charLimit && count < 3) {
        afterText = afterText + "\n" + next.innerText;
        next = next.nextElementSibling;
        count++;
      }

      return {
        before: beforeText
          .substring(Math.max(0, beforeText.length - charLimit))
          .trim(),
        after: afterText.substring(0, charLimit).trim(),
      };
    }

    const before = containerText
      .substring(Math.max(0, startIdx - charLimit), startIdx)
      .trim();
    const after = containerText
      .substring(
        startIdx + selectedText.length,
        Math.min(
          containerText.length,
          startIdx + selectedText.length + charLimit
        )
      )
      .trim();

    return { before, after };
  } catch (err) {
    logWarn("getSurroundingText failed", err);
    return { before: "", after: "" };
  }
}

// Semantic breadcrumb like "main > article > section > h2#intro".
function buildSemanticPath(node) {
  try {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const path = [];
    const semanticTags = [
      "ARTICLE",
      "SECTION",
      "MAIN",
      "HEADER",
      "FOOTER",
      "NAV",
      "ASIDE",
      "FORM",
      "TABLE",
      "UL",
      "OL",
      "DETAILS",
    ];
    while (current && current !== document.body) {
      const tagName = current.tagName;
      if (semanticTags.includes(tagName) || tagName.startsWith("H")) {
        let id = tagName.toLowerCase();
        if (current.id) {
          id += `#${current.id}`;
        } else if (current.className) {
          const firstClass = String(current.className).split(/\s+/)[0];
          if (firstClass && !firstClass.includes("{")) {
            id += `.${firstClass}`;
          }
        }
        path.unshift(id);
      }
      current = current.parentElement;
    }
    return path.join(" > ");
  } catch (err) {
    logWarn("buildSemanticPath failed", err);
    return "";
  }
}

// The selection payload sent to the service worker and, from there, into the
// chat message's context.selection. Kept small on purpose: the harness can
// always read_page for the rest.
function buildContextPayload({
  selectedText,
  node,
  range,
  isSelection,
}) {
  const ancestor = node || range.commonAncestorContainer;
  const enclosingCode = findEnclosingCodeBlock(ancestor);
  const enclosingTable = findEnclosingTable(ancestor);
  const parentHeading = findPrecedingHeading(ancestor);
  const surrounding = range
    ? getSurroundingText(range, 800)
    : { before: "", after: "" };

  let contentType = "text";
  if (enclosingCode) contentType = "code";
  else if (enclosingTable) contentType = "table";

  return {
    text: selectedText,
    contentType,
    surroundingBefore: surrounding.before,
    surroundingAfter: surrounding.after,
    parentHeading: parentHeading ? `${parentHeading.tag}: ${parentHeading.text}` : "",
    semanticPath: buildSemanticPath(ancestor),
    codeBlock: enclosingCode, // {language, fullCode} | null
    tableBlock: enclosingTable, // markdown | null
    pageUrl: window.location.href,
    pageTitle: document.title,
    isSelection: !!isSelection,
  };
}

// Compile context for a text Range (selection path).
function compileRangeContext(selection) {
  if (!selection || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  return buildContextPayload({
    selectedText: text,
    node: range.commonAncestorContainer,
    range,
    isSelection: true,
  });
}

// Compile context for an arbitrary element (right-click path). Uses the live
// text selection when the click lands inside it.
function compileElementContext(element) {
  if (!element) return null;

  let selectedText = element.innerText
    ? element.innerText.trim()
    : (element.textContent || "").trim();

  if (!selectedText && element.tagName === "IMG") {
    selectedText = `[Image: ${element.alt || element.src || "unnamed"}]`;
  } else if (
    !selectedText &&
    (element.tagName === "INPUT" || element.tagName === "TEXTAREA")
  ) {
    selectedText = `[Input Value: ${element.value || ""} | Placeholder: ${
      element.placeholder || ""
    }]`;
  } else if (!selectedText) {
    selectedText = `[Empty ${element.tagName.toLowerCase()}${
      element.id ? `#${element.id}` : ""
    }${
      element.className ? `.${String(element.className).split(" ").join(".")}` : ""
    }]`;
  }

  let surrounding = { before: "", after: "" };
  let range = null;
  try {
    range = document.createRange();
    range.selectNode(element);
    surrounding = getSurroundingText(range, 800);
  } catch (err) {
    logWarn("compileElementContext range failed, sibling fallback", err);
    let beforeText = "";
    let afterText = "";
    let prev = element.previousElementSibling;
    let count = 0;
    while (prev && beforeText.length < 800 && count < 3) {
      beforeText = (prev.innerText || prev.textContent || "") + "\n" + beforeText;
      prev = prev.previousElementSibling;
      count++;
    }
    let next = element.nextElementSibling;
    count = 0;
    while (next && afterText.length < 800 && count < 3) {
      afterText = afterText + "\n" + (next.innerText || next.textContent || "");
      next = next.nextElementSibling;
      count++;
    }
    surrounding = {
      before: beforeText.substring(Math.max(0, beforeText.length - 800)).trim(),
      after: afterText.substring(0, 800).trim(),
    };
    range = null;
  }

  return buildContextPayload({
    selectedText: selectedText,
    node: element,
    range,
    isSelection: false,
  });
}

// --- floating toolbar --------------------------------------------------------
// Selection shows a three-action bar (Ask / translate / copy) styled by
// floatTheme. __abFloatGuard yields the spot to foreign floating UI — we
// never hide theirs, we just don't stack ours on top.

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  ask: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  translate: "M5 8l6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6",
  copy: "M9 9h13v13H9z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
};

function svgIcon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const dd of d.split(" M")) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", (dd.startsWith("M") ? "" : "M") + dd);
    svg.appendChild(path);
  }
  return svg;
}

function mkItem(icon, label, onClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ab-item";
  const text = document.createElement("span");
  text.textContent = label;
  item.append(svgIcon(icon), text);
  item.addEventListener("mousedown", (e) => e.preventDefault());
  item.addEventListener("click", onClick);
  return item;
}

function mkSep() {
  const i = document.createElement("i");
  i.className = "ab-sep";
  return i;
}

// The bar stays lean — everything beyond Ask/translate lives in the ⋯ menu
// (read-frog parks its extra actions in "more" the same way).
let moreMenu = null;

function createMoreMenu() {
  if (moreMenu) return moreMenu;
  moreMenu = document.createElement("div");
  moreMenu.id = MENU_ID;
  const items = [
    ["📋", "复制", () => handleCopyClick()],
    ["🔊", "朗读", () => speakText(currentSelectionContext && currentSelectionContext.text)],
    ["📖", "词典", () => openPopupWith("dict")],
    ["🧩", "长难句", () => openPopupWith("parse")],
  ];
  for (const [ico, label, fn] of items) {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "ab-menu-item";
    it.append(spEl("span", "ab-menu-ico", ico), document.createTextNode(label));
    it.addEventListener("mousedown", (e) => e.preventDefault());
    it.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideMoreMenu();
      fn();
    });
    moreMenu.appendChild(it);
  }
  (document.body || document.documentElement).appendChild(moreMenu);
  return moreMenu;
}

function hideMoreMenu() {
  if (moreMenu) moreMenu.classList.remove("ab-show");
}

function toggleMoreMenu() {
  const m = createMoreMenu();
  m.dataset.abtheme = floatTheme;
  if (m.classList.contains("ab-show")) {
    hideMoreMenu();
    return;
  }
  const r = floatBtn.getBoundingClientRect();
  m.style.left = `${r.left + window.scrollX}px`;
  m.style.top = `${r.bottom + window.scrollY + 6}px`;
  requestAnimationFrame(() => m.classList.add("ab-show"));
}

function createFloatingButton() {
  if (floatBtn) return floatBtn;
  floatBtn = document.createElement("div");
  floatBtn.id = BTN_ID;
  floatBtn.className = "agentbrowser-hidden";
  floatBtn.dataset.abtheme = floatTheme;
  floatBtn.append(
    mkItem(ICONS.ask, "问 AI", (e) => handleAskClick(e)),
    mkSep(),
    mkItem(ICONS.translate, "翻译", (e) => handleTranslateClick(e)),
    mkSep(),
    mkItem(ICONS.more, "更多", () => toggleMoreMenu())
  );
  (document.body || document.documentElement).appendChild(floatBtn);
  return floatBtn;
}

function hideButton() {
  hideMoreMenu();
  if (foreignStop) {
    foreignStop();
    foreignStop = null;
  }
  if (floatBtn) {
    floatBtn.classList.remove("ab-show");
    floatBtn.classList.add("agentbrowser-hidden");
    floatBtn.style.top = "";
    floatBtn.style.left = "";
  }
}

function hideTrPop() {
  hideVocabChip();
  if (trPop) {
    trPop.classList.remove("ab-show");
    trPop.style.top = "";
    trPop.style.left = "";
  }
  if (popSpeaking && window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (err) { logWarn("speech cancel failed", err); }
  }
  popSpeaking = false;
  popBusy = "";
}

// Bar rect estimate before layout: [问AI|翻译|⋯] ≈ 150x30. After
// showing once we can measure the real box for the guard's probe rect.
function barRectEstimate(left, top) {
  if (floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")) {
    const r = floatBtn.getBoundingClientRect();
    if (r.width > 0) {
      return { left: left - window.scrollX, top: top - window.scrollY, width: r.width, height: r.height };
    }
  }
  return { left: left - window.scrollX, top: top - window.scrollY, width: 150, height: 30 };
}

// The guard probes a zone covering the selection plus our bar: another
// extension's toolbar docking onto the same selection counts as a conflict
// even when it doesn't literally overlap our bar's pixels.
function probeRect(left, top) {
  const bar = barRectEstimate(left, top);
  const s = lastSelBounds;
  if (!s) return bar;
  const left2 = Math.min(bar.left, s.left);
  const top2 = Math.min(bar.top, s.top);
  const right2 = Math.max(bar.left + bar.width, s.right);
  const bottom2 = Math.max(bar.top + bar.height, s.bottom);
  return { left: left2, top: top2, width: right2 - left2, height: bottom2 - top2 };
}

// returns true when a foreign overlay already owns the spot.
function foreignBlocks(left, top) {
  if (!yieldForeign) return false;
  const g = window.__abFloatGuard;
  if (!g) return false;
  return !!g.foreignAtRect(probeRect(left, top), 80);
}

function armForeignWatcher() {
  if (!yieldForeign) return;
  const g = window.__abFloatGuard;
  if (!g || foreignStop) return;
  const b = floatBtn.getBoundingClientRect();
  const s = lastSelBounds;
  const r = s
    ? {
        left: Math.min(b.left, s.left),
        top: Math.min(b.top, s.top),
        right: Math.max(b.right, s.right),
        bottom: Math.max(b.bottom, s.bottom),
      }
    : b;
  foreignStop = g.watchForeign(r, hideButton);
}

function showButtonAtSelection(selection) {
  if (selection.rangeCount === 0) return;
  const btn = createFloatingButton();
  btn.dataset.abtheme = floatTheme;

  try {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    let rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    lastSelBounds = range.getBoundingClientRect();

    const btnWidth = 150;
    const btnHeight = 30;
    const maxLeft = window.innerWidth + window.scrollX - btnWidth - 16;
    const minLeft = window.scrollX + 16;
    const left = Math.max(minLeft, Math.min(rect.right + window.scrollX - 30, maxLeft));

    // Preferred spot below the selection end, flipped above when cramped.
    let top = rect.bottom + window.scrollY + 8;
    if (top + btnHeight > window.innerHeight + window.scrollY - 16) {
      const firstRect = rects[0] || rect;
      top = firstRect.top + window.scrollY - btnHeight - 8;
    }
    // Yield to foreign floaters entirely: another extension's overlay at the
    // spot means we stay hidden — never stack on or crowd somebody else's UI.
    if (foreignBlocks(left, top)) return;

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.classList.remove("agentbrowser-hidden");
    requestAnimationFrame(() => btn.classList.add("ab-show"));
    armForeignWatcher();
  } catch (err) {
    logWarn("showButtonAtSelection failed", err);
    hideButton();
  }
}

// --- toolbar actions ----------------------------------------------------------

// --- selection popup ---------------------------------------------------------
// Read-frog-style popover in our own theme: 原文 / 译文 / action row
// (朗读·复制·词典·长难句) / expandable section for dictionary and
// long-sentence analyses, which can also be annotated onto the page.

let popText = "";
let popTranslated = "";
let popSpeaking = false;
let popBusy = ""; // "tr" | "dict" | "parse" | ""
let popExtra = null; // {mode:'dict'|'parse', data, err}
let popMode = "tr"; // "tr" | "dict" | "parse" — which surface opened the popup
const POP_TITLES = { tr: "翻译", dict: "词典", parse: "长难句解析" };

// 生词本：chrome.storage.local abVocab — [{w, host, ts}], newest first,
// deduped case-insensitively, capped at 500.
async function vocabAdd(word) {
  const w = String(word || "").trim();
  if (!w) return false;
  try {
    const r = await chrome.storage.local.get({ [VOCAB_KEY]: [] });
    const list = Array.isArray(r[VOCAB_KEY]) ? r[VOCAB_KEY] : [];
    const lower = w.toLowerCase();
    const rest = list.filter((e) => String(e && e.w).toLowerCase() !== lower);
    rest.unshift({ w, host: location.host, ts: Date.now() });
    await chrome.storage.local.set({ [VOCAB_KEY]: rest.slice(0, 500) });
    return true;
  } catch (err) {
    logWarn("vocab add failed", err);
    return false;
  }
}

async function vocabHas(word) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return false;
  try {
    const r = await chrome.storage.local.get({ [VOCAB_KEY]: [] });
    return (Array.isArray(r[VOCAB_KEY]) ? r[VOCAB_KEY] : []).some(
      (e) => String(e && e.w).toLowerCase() === w
    );
  } catch (err) {
    logWarn("vocab read failed", err);
    return false;
  }
}

// Mini "＋生词" chip that appears when the user selects a word inside the
// popup's 原文/译文 blocks — the "选词添加" path into the dictionary.
let vocabChip = null;

function hideVocabChip() {
  if (vocabChip) vocabChip.classList.remove("ab-show");
}

function showVocabChip(word, rect) {
  if (!vocabChip) {
    vocabChip = document.createElement("button");
    vocabChip.id = CHIP_ID;
    vocabChip.type = "button";
    vocabChip.addEventListener("mousedown", (e) => e.preventDefault());
    vocabChip.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const w = vocabChip.dataset.word || "";
      const ok = await vocabAdd(w);
      vocabChip.textContent = ok ? "✓ 已加入生词本" : "加入失败";
      setTimeout(hideVocabChip, 1100);
    });
    (document.body || document.documentElement).appendChild(vocabChip);
  }
  vocabChip.dataset.abtheme = floatTheme;
  vocabChip.dataset.word = word;
  vocabChip.textContent = "＋ 生词";
  vocabChip.style.left = `${rect.left + window.scrollX}px`;
  vocabChip.style.top = `${rect.bottom + window.scrollY + 4}px`;
  vocabChip.classList.add("ab-show");
}

function spEl(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

// Labels shaped "<emoji> <text>" wrap the emoji in .ab-sp-ico so icon and
// text share one baseline; plain labels stay untouched.
function spBtn(label, title, onClick) {
  const b = spEl("button", "ab-sp-act");
  const m = /^(\S+)\s(.+)$/.exec(String(label || ""));
  if (m && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(m[1])) {
    b.append(spEl("span", "ab-sp-ico", m[1]), document.createTextNode(m[2]));
  } else {
    b.textContent = String(label || "");
  }
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function isWordLike(text) {
  const t = String(text || "").trim();
  return t.length > 0 && t.length <= 60 && t.split(/\s+/).length <= 4 && !/[\n\r]/.test(t);
}

function roleColor(i) {
  const palette = ["#7c3aed", "#2563eb", "#0891b2", "#d97706", "#059669", "#be185d", "#dc2626", "#9333ea"];
  return palette[i % palette.length];
}

function ensureTrPop() {
  // Sites that sweep foreign extension DOM can detach the popup — re-parent
  // the cached element instead of rendering into a disconnected node.
  if (trPop) {
    if (!trPop.isConnected) (document.body || document.documentElement).appendChild(trPop);
    return trPop;
  }
  trPop = document.createElement("div");
  trPop.id = POP_ID;
  const head = spEl("div", "ab-sp-head");
  head.append(spEl("span", "ab-sp-title", POP_TITLES.tr));
  // Selecting a word inside the popup offers a quick path into the
  // vocabulary — check on mouseup within the source/result blocks.
  trPop.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const host = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      if (!host || !trPop.contains(host)) return;
      const text = sel.toString().trim();
      if (!isWordLike(text)) return;
      showVocabChip(text, range.getBoundingClientRect());
    }, 10);
  });
  const close = spBtn("×", "关闭", () => hideTrPop());
  close.classList.add("ab-sp-x");
  head.append(close);
  trPop.append(
    head,
    spEl("div", "ab-sp-src"),
    spEl("div", "ab-sp-tr"),
    spEl("div", "ab-sp-acts"),
    spEl("div", "ab-sp-extra")
  );
  (document.body || document.documentElement).appendChild(trPop);
  return trPop;
}

function renderPop() {
  if (!trPop) return;
  const src = trPop.querySelector(".ab-sp-src");
  const tr = trPop.querySelector(".ab-sp-tr");
  const acts = trPop.querySelector(".ab-sp-acts");
  const extra = trPop.querySelector(".ab-sp-extra");
  const title = trPop.querySelector(".ab-sp-title");
  if (title) title.textContent = POP_TITLES[popMode] || POP_TITLES.tr;
  src.textContent = popText;
  tr.textContent = "";
  tr.classList.remove("ab-sp-err");
  if (popMode === "tr") {
    tr.style.display = "";
    if (popBusy === "tr") {
      tr.append(spEl("span", "ab-sp-loading", "翻译中…"));
    } else if (popTranslated) {
      tr.textContent = popTranslated;
    } else {
      tr.textContent = "—";
    }
  } else {
    // dict/parse popups skip the translation block entirely — the
    // vocabulary/analysis lives in the extra section below.
    tr.style.display = "none";
  }

  acts.textContent = "";
  const speakBtn = spBtn(popSpeaking ? "⏹ 停止" : "🔊 朗读", "朗读", () => toggleSpeak());
  const copyBtn = spBtn("📋 复制", "复制", () => {
    navigator.clipboard.writeText(popTranslated || popText).catch((err) => logWarn("clipboard write failed", err));
  });
  acts.append(speakBtn, copyBtn);
  // Inside a 翻译 popup these expand the extra section instead of switching
  // surfaces — the translation stays on screen (popMode only changes when a
  // surface is opened directly from the ⋯ menu).
  if (isWordLike(popText)) {
    const dictBtn = spBtn(popBusy === "dict" ? "词典…" : "📖 词典", "词典释义", () => runDict());
    if (popBusy === "dict") dictBtn.classList.add("ab-busy");
    acts.append(dictBtn);
  }
  if (popText.trim().length > 15) {
    const parseBtn = spBtn(popBusy === "parse" ? "解析…" : "🧩 长难句", "长难句结构解析", () => runParse());
    if (popBusy === "parse") parseBtn.classList.add("ab-busy");
    acts.append(parseBtn);
  }

  extra.textContent = "";
  extra.style.display = "none";
  if (popExtra) {
    extra.style.display = "block";
    const title = spEl("div", "ab-sp-extra-title", popExtra.mode === "dict" ? "词典" : "长难句解析");
    extra.append(title);
    if (popExtra.err) {
      extra.append(spEl("div", "ab-sp-extra-err", popExtra.err));
    } else if (popExtra.mode === "dict") {
      const body = spEl("div", "ab-sp-dict");
      body.textContent = popExtra.data;
      extra.append(body);
      // 加入生词本 — the dict card doubles as the vocabulary's front door.
      const vb = spBtn("＋ 生词", "加入生词本", async () => {
        vb.disabled = true;
        const ok = await vocabAdd(popText);
        vb.textContent = ok ? "✓ 已加入生词本" : "加入失败";
        if (!ok) vb.disabled = false;
      });
      vb.classList.add("ab-sp-annotate");
      vocabHas(popText).then((has) => {
        if (has) {
          vb.textContent = "✓ 已在生词本";
          vb.disabled = true;
        }
      });
      extra.append(vb);
    } else if (popExtra.mode === "parse" && Array.isArray(popExtra.data)) {
      const list = spEl("div", "ab-sp-parse");
      popExtra.data.forEach((seg, i) => {
        const row = spEl("div", "ab-sp-seg");
        const dot = spEl("span", "ab-sp-dot");
        dot.style.background = roleColor(i);
        row.append(dot, spEl("span", "ab-sp-role", seg.role || `片段${i + 1}`));
        const tx = spEl("span", "ab-sp-segtext", seg.text || "");
        row.append(tx);
        if (seg.zh) row.append(spEl("div", "ab-sp-zh", seg.zh));
        if (seg.note) row.append(spEl("div", "ab-sp-note", seg.note));
        list.append(row);
      });
      extra.append(list);
      if (popExtra.annotated == null) {
        const annotateBtn = spBtn("✎ 标注到页面", "把每个成分画到原句上", () => annotateSegments(popExtra));
        annotateBtn.classList.add("ab-sp-annotate");
        extra.append(annotateBtn);
      } else {
        extra.append(spEl("div", "ab-sp-done", `已在页面标注 ${popExtra.annotated} 处`));
      }
    }
  }
}

function speakText(text) {
  if (!window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
    window.speechSynthesis.speak(u);
  } catch (err) {
    logWarn("speech synthesis failed", err);
  }
}

function toggleSpeak() {
  if (!window.speechSynthesis) return;
  if (popSpeaking) {
    window.speechSynthesis.cancel();
    popSpeaking = false;
    renderPop();
    return;
  }
  const text = popTranslated || popText;
  if (!text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
    u.onend = u.onerror = () => {
      popSpeaking = false;
      renderPop();
    };
    window.speechSynthesis.speak(u);
    popSpeaking = true;
    renderPop();
  } catch (err) {
    logWarn("speech synthesis failed", err);
  }
}

async function analyzeAsk(mode, text) {
  const response = await chrome.runtime.sendMessage({
    target: "sw",
    cmd: "analyze_ask",
    mode,
    text,
  });
  return response;
}

async function runDict() {
  if (popBusy) return;
  popBusy = "dict";
  popExtra = null;
  renderPop();
  try {
    const res = await analyzeAsk("dict", popText);
    popBusy = "";
    if (res && res.success && res.text) {
      popExtra = { mode: "dict", data: String(res.text) };
    } else {
      popExtra = { mode: "dict", data: null, err: `查询失败：${(res && res.error) || "未知错误"}` };
    }
  } catch (err) {
    popBusy = "";
    popExtra = { mode: "dict", data: null, err: "扩展未连接" };
    logWarn("dict analyze failed", err);
  }
  renderPop();
}

async function runParse() {
  if (popBusy) return;
  popBusy = "parse";
  popExtra = null;
  renderPop();
  try {
    const res = await analyzeAsk("parse", popText);
    popBusy = "";
    if (res && res.success && Array.isArray(res.segments) && res.segments.length) {
      popExtra = { mode: "parse", data: res.segments };
    } else {
      popExtra = { mode: "parse", data: null, err: `解析失败：${(res && res.error) || "未返回成分"}` };
    }
  } catch (err) {
    popBusy = "";
    popExtra = { mode: "parse", data: null, err: "扩展未连接" };
    logWarn("parse analyze failed", err);
  }
  renderPop();
}

function annotateSegments(extraState) {
  const api = window.__abAnnotate;
  if (!api || typeof api.add !== "function") {
    logWarn("annotate API unavailable");
    return;
  }
  let done = 0;
  extraState.data.forEach((seg, i) => {
    const quote = String((seg && seg.text) || "").trim();
    if (!quote) return;
    const r = api.add({
      quote,
      style: "underline",
      comment: `${seg.role || "成分"}${seg.note ? " — " + seg.note : ""}`,
      color: roleColor(i),
      author: "agent",
    });
    if (r && r.ok) done++;
  });
  extraState.annotated = done;
  renderPop();
}

// Position the popup: left edge under the selection's left (the read-frog
// anchor), flipped above when the card would not fit below.
function placeTrPop(pop) {
  const selRect = lastSelBounds;
  const anchor =
    floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")
      ? floatBtn.getBoundingClientRect()
      : null;
  const baseLeft = selRect
    ? selRect.left + window.scrollX
    : anchor
      ? anchor.left + window.scrollX
      : window.scrollX + 40;
  let top = anchor ? anchor.bottom + window.scrollY + 8 : selRect ? selRect.bottom + window.scrollY + 8 : window.scrollY + 80;
  const maxH = Math.round(window.innerHeight * 0.62);
  if (top - window.scrollY + maxH > window.innerHeight - 12) {
    const above = (selRect ? selRect.top : anchor ? anchor.top : 200) + window.scrollY - 8 - Math.min(360, maxH);
    if (above > window.scrollY + 8) top = above;
  }
  const popW = Math.min(360, window.innerWidth - 32);
  pop.style.left = `${Math.max(window.scrollX + 12, Math.min(baseLeft, window.innerWidth + window.scrollX - popW - 16))}px`;
  pop.style.top = `${top}px`;
  requestAnimationFrame(() => pop.classList.add("ab-show"));
}

function resetPop(text, mode, busy) {
  popText = String(text || "");
  popTranslated = "";
  popSpeaking = false;
  popBusy = busy;
  popExtra = null;
  popMode = mode;
}

function showTrPop(text) {
  resetPop(text, "tr", "tr");
  const pop = ensureTrPop();
  pop.dataset.abtheme = floatTheme;
  renderPop();
  placeTrPop(pop);
}

// ⋯ menu surfaces: open the popup straight into dict or parse mode — same
// card, different title and no translation block.
function openPopupWith(mode) {
  if (!isContextValid() || !currentSelectionContext) return;
  const text = currentSelectionContext.text;
  resetPop(text, mode === "dict" || mode === "parse" ? mode : "tr", "");
  const pop = ensureTrPop();
  pop.dataset.abtheme = floatTheme;
  renderPop();
  placeTrPop(pop);
  hideButton();
  if (popMode === "dict") runDict();
  else if (popMode === "parse") runParse();
}

async function handleTranslateClick(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (!isContextValid() || !currentSelectionContext) return;
  const text = currentSelectionContext.text;
  showTrPop(text);
  hideButton();
  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "translate_ask",
      text,
    });
    popBusy = "";
    if (response && response.success && response.text) {
      popTranslated = String(response.text);
    } else {
      popTranslated = `翻译失败：${(response && response.error) || "未知错误"}`;
      if (trPop) trPop.querySelector(".ab-sp-tr").classList.add("ab-sp-err");
    }
    renderPop();
  } catch (err) {
    popBusy = "";
    popTranslated = "翻译不可用：扩展未连接";
    renderPop();
    logWarn("translate_ask send failed", err);
  }
}

async function handleCopyClick(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (!currentSelectionContext) return;
  try {
    await navigator.clipboard.writeText(currentSelectionContext.text);
  } catch (err) {
    logWarn("clipboard write failed", err);
  }
  hideButton();
}

// --- events ------------------------------------------------------------------

function handleMouseUp(e) {
  if (!isContextValid()) {
    document.removeEventListener("mouseup", handleMouseUp);
    return;
  }
  setTimeout(() => {
    if (!isContextValid()) return;
    // Selections inside our own surfaces (popup, menu, vocab chip) are the
    // user interacting with the card — never trigger the floating bar.
    if (e.target && e.target.closest && e.target.closest(`#${BTN_ID}, #${POP_ID}, #${MENU_ID}, #${CHIP_ID}`)) return;

    const selection = window.getSelection();
    if (!selection) return;
    const selectedText = selection.toString().trim();

    if (selectedText.length === 0 || !floatingAskEnabled) {
      hideButton();
      return;
    }

    currentSelectionContext = compileRangeContext(selection);

    // Auto context capture runs before the floating-button logic: the
    // selection belongs to the panel context whether or not the Ask button
    // is enabled.
    autoDeliverSelection();

    showButtonAtSelection(selection);
  }, 30);
}

// --- auto context capture ----------------------------------------------------
// A committed selection is delivered to the panel context without requiring
// the Ask click: it lands in the same pendingSelection slot the panel already
// watches, so the next message carries it. The slot is single — the latest
// selection wins; identical selections are not re-sent.

let lastAutoSentText = "";
let autoKeyTimer = null;
// selectionStaged tracks whether this tab's live selection currently fills the
// panel's context chip — auto capture or an Ask click. When the selection
// collapses afterwards the chip must collapse with it.
let selectionStaged = false;
let suppressClearOnce = false; // Ask success removes ranges itself
let clearTimer = null;

function handleSelectionChange() {
  if (!isContextValid()) {
    document.removeEventListener("selectionchange", handleSelectionChange);
    return;
  }
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (!isContextValid() || !selectionStaged) return;
    const sel = window.getSelection();
    const empty = !sel || sel.isCollapsed || !sel.toString().trim();
    if (!empty) return;
    if (suppressClearOnce) {
      suppressClearOnce = false;
      return;
    }
    selectionStaged = false;
    lastAutoSentText = "";
    chrome.runtime
      .sendMessage({ target: "sw", cmd: "selection_clear" })
      .catch((err) => logWarn("selection_clear send failed", err));
  }, 120);
}

function autoDeliverSelection() {
  if (!autoSelectionEnabled) return;
  if (!isContextValid()) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const payload = compileRangeContext(selection);
  if (!payload) return;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (text.length < 3 || text === lastAutoSentText) return;
  lastAutoSentText = text;
  selectionStaged = true;
  chrome.runtime
    .sendMessage({ target: "sw", cmd: "selection_auto", selection: payload })
    .catch((err) => logWarn("selection_auto send failed", err));
}

function handleKeyUp(e) {
  if (!isContextValid()) {
    document.removeEventListener("keyup", handleKeyUp);
    return;
  }
  if (e.key === "Escape") return;
  // Keyboard selections (Shift+arrows) commit key-by-key; wait for the burst
  // to settle, then capture like a mouse selection.
  clearTimeout(autoKeyTimer);
  autoKeyTimer = setTimeout(autoDeliverSelection, 350);
}

async function handleAskClick(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (!isContextValid() || !currentSelectionContext) return;

  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "selection_ask",
      selection: currentSelectionContext,
    });
    if (response && response.success) {
      selectionStaged = true;
      suppressClearOnce = true; // our own removeAllRanges must not clear the chip
      window.getSelection().removeAllRanges();
      hideButton();
    }
  } catch (err) {
    // Extension reloaded between script injection and click.
    logWarn("selection_ask send failed", err);
    hideButton();
  }
}

function handleKeyDown(e) {
  if (!isContextValid()) {
    document.removeEventListener("keydown", handleKeyDown);
    return;
  }
  if (e.key === "Escape") {
    hideButton();
    hideTrPop();
    return;
  }
  // Triple-space inside an editable field translates what was typed, in
  // place. Space anywhere else is not a command.
  if (e.code !== "Space" || e.repeat || !spaceTrEnabled) return;
  const field = editableAt(e.target);
  if (!field) {
    spaceRun = 0;
    return;
  }
  spaceRun += 1;
  clearTimeout(spaceTimer);
  spaceTimer = setTimeout(() => {
    spaceRun = 0;
  }, 800);
  if (spaceRun >= 3) {
    spaceRun = 0;
    e.preventDefault();
    translateInput(field);
  }
}

function handleScroll() {
  if (!isContextValid()) {
    window.removeEventListener("scroll", handleScroll);
    return;
  }
  hideButton();
  hideTrPop();
}

function handleMouseDown(e) {
  if (!isContextValid()) {
    document.removeEventListener("mousedown", handleMouseDown);
    return;
  }
  if (vocabChip && (!e.target.closest || !e.target.closest(`#${CHIP_ID}`))) hideVocabChip();
  if (moreMenu && (!e.target.closest || !e.target.closest(`#${MENU_ID}, #${BTN_ID}`))) hideMoreMenu();
  if (trPop && !trPop.classList.contains("agentbrowser-hidden") && trPop.classList.contains("ab-show")) {
    if (!e.target.closest || !e.target.closest(`#${POP_ID}`)) hideTrPop();
  }
  if (floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")) {
    if (!e.target.closest || !e.target.closest(`#${BTN_ID}`)) {
      setTimeout(() => {
        if (!isContextValid()) return;
        const selection = window.getSelection();
        if (!selection || selection.toString().trim().length === 0) {
          hideButton();
        }
      }, 50);
    }
  }
}

// Right-click: compile the clicked element's context eagerly so the context
// menu handler in the service worker never has to wait on a round trip.
function handleContextMenu(e) {
  if (!isContextValid()) {
    document.removeEventListener("contextmenu", handleContextMenu, true);
    return;
  }

  lastRightClickElement = e.target;
  lastRightClickContext = compileElementContext(e.target);

  const selection = window.getSelection();
  const hasSelection = selection && selection.toString().trim().length > 0;
  let contextData = lastRightClickContext;
  let isSelection = false;

  if (hasSelection && currentSelectionContext) {
    if (selection.rangeCount > 0) {
      try {
        const range = selection.getRangeAt(0);
        if (
          range.intersectsNode(e.target) ||
          e.target.contains(range.commonAncestorContainer)
        ) {
          isSelection = true;
          contextData = currentSelectionContext;
        }
      } catch (err) {
        logWarn("selection/range check failed, using selection context", err);
        isSelection = true;
        contextData = currentSelectionContext;
      }
    } else {
      isSelection = true;
      contextData = currentSelectionContext;
    }
  }

  chrome.runtime
    .sendMessage({
      target: "sw",
      cmd: "selection_context_cache",
      selection: contextData,
      isSelection,
    })
    .catch((err) => logWarn("selection_context_cache send failed", err));
}

// Service worker asks for fresh context when the context-menu path finds no
// usable cache (e.g. the page was loaded before the extension was).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "agentbrowser_get_selection_context") return;

  const selection = window.getSelection();
  const hasSelection = selection && selection.toString().trim().length > 0;

  let useSelection = false;
  if (hasSelection && currentSelectionContext) {
    if (selection.rangeCount > 0 && lastRightClickElement) {
      try {
        const range = selection.getRangeAt(0);
        if (
          range.intersectsNode(lastRightClickElement) ||
          lastRightClickElement.contains(range.commonAncestorContainer)
        ) {
          useSelection = true;
        }
      } catch (err) {
        logWarn("range/right-click element check failed", err);
        useSelection = true;
      }
    } else {
      useSelection = true;
    }
  }

  const fresh = useSelection
    ? currentSelectionContext
    : compileRangeContext(selection) || lastRightClickContext;

  if (fresh) sendResponse({ success: true, selection: fresh });
  else sendResponse({ success: false });
  return true;
});

document.addEventListener("selectionchange", handleSelectionChange);
document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("keydown", handleKeyDown);
document.addEventListener("keyup", handleKeyUp);
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("contextmenu", handleContextMenu, true);
window.addEventListener("scroll", handleScroll, { passive: true });

})();
