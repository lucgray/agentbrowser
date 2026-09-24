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

const BTN_ID = "agentbrowser-ask-btn";

let floatBtn = null;
let currentSelectionContext = null; // compiled on selection mouseup
let lastRightClickContext = null; // compiled on contextmenu
let lastRightClickElement = null;

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

// --- floating button ---------------------------------------------------------

function createFloatingButton() {
  if (floatBtn) return floatBtn;

  floatBtn = document.createElement("div");
  floatBtn.id = BTN_ID;
  floatBtn.className = "agentbrowser-reset agentbrowser-hidden";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  svg.appendChild(path);

  const label = document.createElement("span");
  label.textContent = "Ask";

  floatBtn.append(svg, label);
  floatBtn.addEventListener("click", handleButtonClick);
  (document.body || document.documentElement).appendChild(floatBtn);
  return floatBtn;
}

function hideButton() {
  if (floatBtn && !floatBtn.classList.contains("agentbrowser-hidden")) {
    floatBtn.classList.add("agentbrowser-hidden");
    floatBtn.style.top = "";
    floatBtn.style.left = "";
  }
}

function showButtonAtSelection(selection) {
  if (selection.rangeCount === 0) return;
  const btn = createFloatingButton();

  try {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    let rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const viewportTop = rect.bottom + window.scrollY + 8;
    const viewportLeft = rect.right + window.scrollX - 30;

    const btnWidth = 64;
    const btnHeight = 26;
    const maxLeft = window.innerWidth + window.scrollX - btnWidth - 16;
    const minLeft = window.scrollX + 16;

    let left = Math.max(minLeft, Math.min(viewportLeft, maxLeft));
    let top = viewportTop;
    if (top + btnHeight > window.innerHeight + window.scrollY - 16) {
      const firstRect = rects[0] || rect;
      top = firstRect.top + window.scrollY - btnHeight - 8;
    }

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.classList.remove("agentbrowser-hidden");
  } catch (err) {
    logWarn("showButtonAtSelection failed", err);
    hideButton();
  }
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

    if (selectedText.length === 0) {
      hideButton();
      return;
    }

    currentSelectionContext = compileRangeContext(selection);
    showButtonAtSelection(selection);
  }, 30);
}

async function handleButtonClick(e) {
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
  if (e.key === "Escape") hideButton();
}

function handleScroll() {
  if (!isContextValid()) {
    window.removeEventListener("scroll", handleScroll);
    return;
  }
  hideButton();
}

function handleMouseDown(e) {
  if (!isContextValid()) {
    document.removeEventListener("mousedown", handleMouseDown);
    return;
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
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("contextmenu", handleContextMenu, true);
window.addEventListener("scroll", handleScroll, { passive: true });
