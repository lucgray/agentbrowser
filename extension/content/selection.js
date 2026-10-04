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
const POP_ID = "agentbrowser-sel-tr-pop";
const FLOAT_ASK_KEY = "floatingAskEnabled"; // chrome.storage.local, set by sw
const AUTO_SEL_KEY = "autoSelectionEnabled"; // chrome.storage.local, set by the panel settings
const FLOAT_THEME_KEY = "floatTheme"; // chrome.storage.local, frost | ink | paper
const FLOAT_THEMES = new Set(["frost", "ink", "paper"]);

let floatBtn = null;
let trPop = null;
let foreignStop = null; // float-guard watcher disarm while the bar is visible
let currentSelectionContext = null; // compiled on selection mouseup
let lastRightClickContext = null; // compiled on contextmenu
let lastRightClickElement = null;
let floatingAskEnabled = true; // cached; kept in sync below
let autoSelectionEnabled = true; // cached; panel 设置开关
let floatTheme = "frost"; // cached; settings select

// The floating button can clash with other overlays, so it obeys a
// persistent user setting flipped from the right-click menu. Read it once
// at startup and live via storage.onChanged; turning it off hides the
// button immediately.
if (isContextValid()) {
  chrome.storage.local
    .get({ [FLOAT_ASK_KEY]: true, [AUTO_SEL_KEY]: true, [FLOAT_THEME_KEY]: "frost" })
    .then((r) => {
      floatingAskEnabled = r[FLOAT_ASK_KEY] !== false;
      autoSelectionEnabled = r[AUTO_SEL_KEY] !== false;
      floatTheme = FLOAT_THEMES.has(r[FLOAT_THEME_KEY]) ? r[FLOAT_THEME_KEY] : "frost";
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
    mkItem(ICONS.copy, "复制", (e) => handleCopyClick(e))
  );
  (document.body || document.documentElement).appendChild(floatBtn);
  return floatBtn;
}

function hideButton() {
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
  if (trPop) {
    trPop.classList.remove("ab-show");
    trPop.style.top = "";
    trPop.style.left = "";
  }
}

// Bar rect estimate before layout: three labelled items ≈ 190x30. After
// showing once we can measure the real box for the guard's probe rect.
function barRectEstimate(left, top) {
  if (floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")) {
    const r = floatBtn.getBoundingClientRect();
    if (r.width > 0) {
      return { left: left - window.scrollX, top: top - window.scrollY, width: r.width, height: r.height };
    }
  }
  return { left: left - window.scrollX, top: top - window.scrollY, width: 190, height: 30 };
}

// returns the foreign overlay at the spot, else null.
function foreignAt(left, top) {
  const g = window.__abFloatGuard;
  if (!g) return null;
  return g.foreignAtRect(barRectEstimate(left, top));
}

// Park beside a foreign overlay instead of stacking on it: probe below,
// right, above, left of its rect (viewport coords) until a slot is free.
function spotBeside(foreignEl, w, h) {
  const g = window.__abFloatGuard;
  if (!g || !foreignEl) return null;
  let r;
  try {
    r = foreignEl.getBoundingClientRect();
  } catch (err) {
    logWarn("foreign rect failed", err);
    return null;
  }
  const cands = [
    { left: r.left, top: r.bottom + 6 },
    { left: r.right + 6, top: r.top },
    { left: r.left, top: r.top - h - 6 },
    { left: r.left - w - 6, top: r.top },
  ];
  for (const c of cands) {
    const left = Math.max(4, Math.min(c.left, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(c.top, window.innerHeight - h - 4));
    if (!g.foreignAtRect({ left, top, width: w, height: h })) return { left, top };
  }
  return null;
}

// A foreign floater appeared over our bar — slide beside it rather than
// hide. Only when every side is taken do we yield by hiding.
function relocateOrHide() {
  const g = window.__abFloatGuard;
  if (!g || !floatBtn) return hideButton();
  const r = floatBtn.getBoundingClientRect();
  const fx = g.foreignAtRect(r);
  if (!fx) return;
  const beside = spotBeside(fx, r.width || 190, r.height || 30);
  if (beside) {
    floatBtn.style.left = `${beside.left + window.scrollX}px`;
    floatBtn.style.top = `${beside.top + window.scrollY}px`;
    return;
  }
  hideButton();
}

function armForeignWatcher() {
  const g = window.__abFloatGuard;
  if (!g || foreignStop) return;
  const r = floatBtn.getBoundingClientRect();
  foreignStop = g.watchForeign(r, relocateOrHide);
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

    const btnWidth = 190;
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
    // Foreign floater at the spot: try the other side of the selection,
    // then park beside the foreign overlay — hide only if everything is
    // taken.
    const fx = foreignAt(left, top);
    if (fx) {
      const firstRect = rects[0] || rect;
      const alt =
        top > rect.top + window.scrollY
          ? firstRect.top + window.scrollY - btnHeight - 8
          : rect.bottom + window.scrollY + 8;
      const fxAlt = foreignAt(left, alt);
      if (fxAlt) {
        const beside =
          spotBeside(fxAlt, btnWidth, btnHeight) ||
          spotBeside(fx, btnWidth, btnHeight);
        if (!beside) return;
        btn.style.left = `${beside.left + window.scrollX}px`;
        btn.style.top = `${beside.top + window.scrollY}px`;
        btn.classList.remove("agentbrowser-hidden");
        requestAnimationFrame(() => btn.classList.add("ab-show"));
        armForeignWatcher();
        return;
      }
      top = alt;
    }

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

function showTrPop(text) {
  if (!trPop) {
    trPop = document.createElement("div");
    trPop.id = POP_ID;
    (document.body || document.documentElement).appendChild(trPop);
  }
  trPop.dataset.abtheme = floatTheme;
  trPop.textContent = text;
  const anchor =
    floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")
      ? floatBtn.getBoundingClientRect()
      : null;
  const left = anchor ? anchor.left + window.scrollX : window.scrollX + 40;
  const top = anchor ? anchor.bottom + window.scrollY + 8 : window.scrollY + 80;
  trPop.style.left = `${Math.min(left, window.innerWidth + window.scrollX - 340 - 16)}px`;
  trPop.style.top = `${top}px`;
  requestAnimationFrame(() => trPop.classList.add("ab-show"));
}

async function handleTranslateClick(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!isContextValid() || !currentSelectionContext) return;
  const text = currentSelectionContext.text;
  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "translate_ask",
      text,
    });
    if (response && response.success && response.text) {
      showTrPop(response.text);
      hideButton();
    } else {
      showTrPop(`翻译失败：${(response && response.error) || "未知错误"}`);
      hideButton();
    }
  } catch (err) {
    logWarn("translate_ask send failed", err);
    showTrPop("翻译不可用：扩展未连接");
    hideButton();
  }
}

async function handleCopyClick(e) {
  e.preventDefault();
  e.stopPropagation();
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
    if (e.target && e.target.closest && e.target.closest(`#${BTN_ID}`)) return;

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
  e.preventDefault();
  e.stopPropagation();

  if (!isContextValid() || !currentSelectionContext) return;

  try {
    const response = await chrome.runtime.sendMessage({
      target: "sw",
      cmd: "selection_ask",
      selection: currentSelectionContext,
    });
    if (response && response.success) {
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

document.addEventListener("mouseup", handleMouseUp);
document.addEventListener("keydown", handleKeyDown);
document.addEventListener("keyup", handleKeyUp);
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("contextmenu", handleContextMenu, true);
window.addEventListener("scroll", handleScroll, { passive: true });

})();
