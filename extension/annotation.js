// Content script: renders page annotations placed through the `annotate`
// browser tool — underline, highlight, circle — and hosts the comment card
// on each mark. A comment the user submits goes to the service worker, which
// runs it as a chat turn (chatId "ann-<id>-<tabId>") on the current adapter;
// streamed tokens come back as 'agentbrowser_ann_event' messages and land in
// the same card, so the thread lives on the page.
//
// Marks are positioned by quoting text: the agent passes an exact quote and
// we find it with a TreeWalker over text nodes (whitespace-normalized
// fallback), then wrap the matching range segment by segment. Underline and
// highlight are styled spans; circle is an ellipse on a full-page SVG layer.
// No code here is derived from ContextLens — the anchor-by-quote approach is
// original to this file (their content.js is only the selection source).

const LAYER_ID = "agentbrowser-ann-layer";
const SVG_NS = "http://www.w3.org/2000/svg";
const STYLES = new Set(["underline", "highlight", "circle"]);
const AGENT_COLOR = "#7c3aed"; // marks placed by the agent
const USER_COLOR = "#d97706"; // reserved for marks the user places later

const annotations = new Map(); // id -> { data, spans:[Element], ellipse, card? }
let seq = 0;
let liveCard = null; // the one open comment card

function logWarn(...args) {
  console.warn("[agentbrowser]", ...args);
}

function isContextValid() {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.id !== "undefined"
  );
}

function sendMessage(msg) {
  if (!isContextValid()) return;
  chrome.runtime
    .sendMessage(msg)
    .catch((err) => logWarn("message failed", err));
}

// --- quote anchoring ---------------------------------------------------------

function textNodes() {
  const out = [];
  if (!document.body) return out;
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        const p = node.parentElement;
        if (!p || p.closest("script,style,noscript,.ab-ann-card")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

// Locate `quote` in the page's text nodes. Returns [{node, start, end}]
// segments in document order, or null. Tries a literal match on the
// concatenated text first, then a whitespace-normalized match.
function findQuote(quote) {
  const nodes = textNodes();
  const ranges = [];
  let pos = 0;
  let hay = "";
  for (const node of nodes) {
    ranges.push({ node, start: pos, end: pos + node.nodeValue.length });
    hay += node.nodeValue;
    pos += node.nodeValue.length;
  }

  let start = hay.indexOf(quote);
  let end = start === -1 ? -1 : start + quote.length;
  if (start === -1) {
    // Collapse runs of whitespace to a single space in both hay and needle,
    // keeping a map from normalized position back to raw position.
    const normChars = [];
    const normMap = [];
    for (let i = 0; i < hay.length; i++) {
      const ch = hay[i];
      if (/\s/.test(ch)) {
        if (normChars.length && normChars[normChars.length - 1] !== " ") {
          normChars.push(" ");
          normMap.push(i);
        }
      } else {
        normChars.push(ch);
        normMap.push(i);
      }
    }
    const normQ = quote.replace(/\s+/g, " ").trim();
    const nStart = normChars.join("").indexOf(normQ);
    if (nStart === -1 || normQ.length === 0) return null;
    start = normMap[nStart];
    end = normMap[nStart + normQ.length - 1] + 1;
  }

  const segments = [];
  for (const rec of ranges) {
    const s = Math.max(start, rec.start);
    const e = Math.min(end, rec.end);
    if (s < e) segments.push({ node: rec.node, start: s - rec.start, end: e - rec.start });
    if (rec.end > end) break;
  }
  return segments.length ? segments : null;
}

// --- mark rendering ----------------------------------------------------------

function ensureLayer() {
  let layer = document.getElementById(LAYER_ID);
  if (layer) return layer.firstElementChild;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  const svg = document.createElementNS(SVG_NS, "svg");
  layer.appendChild(svg);
  (document.documentElement || document.body).appendChild(layer);
  sizeLayer();
  return svg;
}

function sizeLayer() {
  const layer = document.getElementById(LAYER_ID);
  if (!layer) return;
  const w = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0
  );
  const h = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  );
  layer.style.height = h + "px";
  layer.firstElementChild.setAttribute("viewBox", `0 0 ${w} ${h}`);
  layer.firstElementChild.setAttribute("width", w);
  layer.firstElementChild.setAttribute("height", h);
}

// Wrap the [start,end) slice of a single text node in a styled span.
function wrapSegment(node, start, end, cls, id) {
  const mid = node.splitText(start);
  if (end - start < mid.nodeValue.length) {
    mid.splitText(end - start);
  }
  const span = document.createElement("span");
  span.className = `${cls}`;
  span.dataset.abAnn = id;
  mid.parentNode.insertBefore(span, mid);
  span.appendChild(mid);
  return span;
}

function drawEllipse(spans, color) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of spans) {
    for (const r of s.getClientRects()) {
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const svg = ensureLayer();
  const el = document.createElementNS(SVG_NS, "ellipse");
  const cx = (minX + maxX) / 2 + window.scrollX;
  const cy = (minY + maxY) / 2 + window.scrollY;
  el.setAttribute("cx", cx);
  el.setAttribute("cy", cy);
  el.setAttribute("rx", (maxX - minX) / 2 + 8);
  el.setAttribute("ry", (maxY - minY) / 2 + 8);
  el.setAttribute("class", "ab-ann-ellipse");
  el.setAttribute("stroke", color);
  svg.appendChild(el);
  return el;
}

// Circles are absolutely positioned; a resize or layout change moves the
// text under them, so recompute every ellipse.
function redrawCircles() {
  sizeLayer();
  for (const ann of annotations.values()) {
    if (ann.data.style !== "circle" || !ann.ellipse) continue;
    const fresh = drawEllipse(ann.spans, ann.data.color);
    if (fresh) {
      ann.ellipse.remove();
      ann.ellipse = fresh;
    }
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try {
      redrawCircles();
    } catch (err) {
      logWarn("circle redraw failed", err);
    }
  }, 150);
});

// --- annotate / clear --------------------------------------------------------

function addAnnotation({ quote, style, comment, color, author }) {
  if (!STYLES.has(style)) {
    return { ok: false, error: `unknown style "${style}" (underline|highlight|circle)` };
  }
  const segments = findQuote(quote);
  if (!segments) {
    return { ok: false, error: "quote not found on the page" };
  }
  const id = `a${++seq}`;
  const markColor = color || (author === "user" ? USER_COLOR : AGENT_COLOR);
  const cls = `ab-ann ab-ann-${style}`;
  const spans = [];
  for (const seg of segments) {
    try {
      spans.push(wrapSegment(seg.node, seg.start, seg.end, cls, id));
    } catch (err) {
      logWarn("segment wrap failed, skipping", err);
    }
  }
  if (!spans.length) return { ok: false, error: "could not wrap the matched text" };
  for (const s of spans) {
    s.style.setProperty("--ab-ann-color", markColor);
  }
  const ann = {
    data: {
      id,
      style,
      quote: quote.slice(0, 4000),
      comment: comment || "",
      color: markColor,
      author: author || "agent",
      replies: [],
    },
    spans,
    ellipse: null,
  };
  if (style === "circle") {
    ann.ellipse = drawEllipse(spans, markColor);
  }
  for (const s of spans) {
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      openCard(ann, s);
    });
  }
  if (ann.ellipse) {
    ann.ellipse.style.pointerEvents = "stroke";
    ann.ellipse.addEventListener("click", (e) => {
      e.stopPropagation();
      openCard(ann, spans[0]);
    });
  }
  annotations.set(id, ann);
  return { ok: true, id, style, quote: ann.data.quote };
}

function unwrapSpan(span) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  parent.normalize();
}

function clearAnnotation(id) {
  const ann = annotations.get(id);
  if (!ann) return false;
  for (const s of ann.spans) {
    try {
      unwrapSpan(s);
    } catch (err) {
      logWarn("unwrap failed", err);
    }
  }
  if (ann.ellipse) ann.ellipse.remove();
  if (liveCard && liveCard.annId === id) closeCard();
  annotations.delete(id);
  return true;
}

function listAnnotations() {
  return [...annotations.values()].map((a) => ({
    id: a.data.id,
    style: a.data.style,
    quote: a.data.quote,
    comment: a.data.comment,
    author: a.data.author,
    replies: a.data.replies.map((r) => ({ who: r.who, text: r.text })),
  }));
}

// --- comment card ------------------------------------------------------------

function closeCard() {
  if (liveCard) {
    liveCard.el.remove();
    liveCard = null;
  }
}

function openCard(ann, anchorEl) {
  closeCard();
  const card = document.createElement("div");
  card.className = "ab-ann-card";
  card.dataset.annId = ann.data.id;

  const head = document.createElement("div");
  head.className = "ab-ann-card-head";
  head.textContent =
    (ann.data.style === "highlight" ? "Highlighted" :
     ann.data.style === "circle" ? "Circled" : "Underlined") +
    (ann.data.author === "agent" ? " by the agent" : "");
  card.appendChild(head);

  const quote = document.createElement("div");
  quote.className = "ab-ann-card-quote";
  quote.textContent =
    ann.data.quote.length > 160 ? ann.data.quote.slice(0, 160) + "…" : ann.data.quote;
  card.appendChild(quote);

  if (ann.data.comment) {
    const note = document.createElement("div");
    note.className = "ab-ann-card-note";
    note.textContent = ann.data.comment;
    card.appendChild(note);
  }

  const replies = document.createElement("div");
  replies.className = "ab-ann-card-replies";
  for (const r of ann.data.replies) replies.appendChild(replyEl(r));
  card.appendChild(replies);

  const input = document.createElement("textarea");
  input.className = "ab-ann-card-input";
  input.placeholder = "Comment… (Enter to send)";
  input.rows = 2;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      submitComment(ann, text);
    }
    e.stopPropagation();
  });
  card.appendChild(input);

  const rect = anchorEl.getBoundingClientRect();
  card.style.left = Math.min(
    Math.max(8, rect.left + window.scrollX),
    window.scrollX + document.documentElement.clientWidth - 340
  ) + "px";
  card.style.top = rect.bottom + window.scrollY + 8 + "px";
  document.documentElement.appendChild(card);
  liveCard = { el: card, annId: ann.data.id, repliesEl: replies };
  input.focus();
}

function replyEl(r) {
  const el = document.createElement("div");
  el.className = "ab-ann-reply ab-ann-reply-" + r.who;
  const who = document.createElement("span");
  who.className = "ab-ann-reply-who";
  who.textContent = r.who === "user" ? "You" : "Agent";
  const text = document.createElement("span");
  text.textContent = r.text;
  el.appendChild(who);
  el.appendChild(text);
  return el;
}

// User comment → sw → hub chat turn on ann-<id>-<tabId>. The reply streams
// back via 'event' messages and appends into this annotation's replies.
function submitComment(ann, text) {
  const r = { who: "user", text };
  ann.data.replies.push(r);
  if (liveCard && liveCard.annId === ann.data.id) {
    liveCard.repliesEl.appendChild(replyEl(r));
    liveCard.repliesEl.scrollTop = liveCard.repliesEl.scrollHeight;
  }
  sendMessage({
    target: "sw",
    cmd: "annotation_comment",
    annId: ann.data.id,
    text,
    annotation: {
      style: ann.data.style,
      quote: ann.data.quote,
      comment: ann.data.comment,
      author: ann.data.author,
    },
  });
}

// A streamed token from the ann-* chat lands in the replies list; consecutive
// tokens for the same turn accumulate into one agent reply bubble.
function appendAgentToken(ann, text) {
  const replies = ann.data.replies;
  if (replies.length && replies[replies.length - 1].who === "agent" && replies[replies.length - 1].streaming) {
    replies[replies.length - 1].text += text;
  } else {
    replies.push({ who: "agent", text, streaming: true });
  }
  renderReplies(ann);
}

function renderReplies(ann) {
  if (!liveCard || liveCard.annId !== ann.data.id) return;
  liveCard.repliesEl.textContent = "";
  for (const r of ann.data.replies) liveCard.repliesEl.appendChild(replyEl(r));
  liveCard.repliesEl.scrollTop = liveCard.repliesEl.scrollHeight;
}

document.addEventListener("mousedown", (e) => {
  if (liveCard && !liveCard.el.contains(e.target) && !e.target.closest(".ab-ann")) {
    closeCard();
  }
});

// --- message handling --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "annotation") return;
  try {
    if (msg.cmd === "annotate") {
      sendResponse(
        addAnnotation({
          quote: String(msg.quote || ""),
          style: String(msg.style || ""),
          comment: String(msg.comment || ""),
          color: msg.color ? String(msg.color) : "",
          author: msg.author === "user" ? "user" : "agent",
        })
      );
      return true;
    }
    if (msg.cmd === "list") {
      sendResponse({ ok: true, annotations: listAnnotations() });
      return true;
    }
    if (msg.cmd === "reply") {
      const ann = annotations.get(String(msg.id || ""));
      if (!ann) {
        sendResponse({ ok: false, error: `no annotation ${msg.id}` });
        return true;
      }
      ann.data.replies.push({ who: "agent", text: String(msg.text || "") });
      renderReplies(ann);
      sendResponse({ ok: true, id: ann.data.id, replied: true });
      return true;
    }
    if (msg.cmd === "clear") {
      if (msg.id) {
        const removed = clearAnnotation(String(msg.id));
        sendResponse({ ok: true, cleared: removed ? 1 : 0 });
      } else {
        const ids = [...annotations.keys()];
        for (const id of ids) clearAnnotation(id);
        sendResponse({ ok: true, cleared: ids.length });
      }
      return true;
    }
    if (msg.cmd === "event") {
      const ann = annotations.get(String(msg.annId || ""));
      if (!ann || !msg.event) {
        sendResponse({ ok: true });
        return true;
      }
      const ev = msg.event;
      if (ev.kind === "token" && ev.text) {
        appendAgentToken(ann, String(ev.text));
      } else if (ev.kind === "error") {
        ann.data.replies.push({ who: "agent", text: `Error: ${ev.message || "error"}` });
        renderReplies(ann);
      } else if (ev.kind === "done") {
        const last = ann.data.replies[ann.data.replies.length - 1];
        if (last) last.streaming = false;
      }
      sendResponse({ ok: true });
      return true;
    }
  } catch (err) {
    logWarn(`annotation cmd ${msg.cmd} failed`, err);
    sendResponse({ ok: false, error: String((err && err.message) || err) });
    return true;
  }
  return true;
});
