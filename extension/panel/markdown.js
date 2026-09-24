// Minimal markdown parser + DOM renderer for the side panel.
//
// Two exports:
//   parseMarkdown(text) -> block tree. Pure: no DOM, no globals, testable in node.
//   renderMarkdown(text) -> DocumentFragment. Uses document, builds nodes only
//                           with createElement/createTextNode.
//
// Security model: the tree carries plain strings and nothing here ever touches
// innerHTML, so model output cannot inject markup by construction. Link hrefs
// are additionally restricted to http(s); anything else stays literal text.
//
// Every scan loop advances its index unconditionally on the failure path, so no
// input can hang it, and no regex uses a quantifier inside a quantifier.

const MAX_INLINE_DEPTH = 6;
const MAX_BLOCK_DEPTH = 4;
const ESCAPABLE = "\\`*_{}[]()#+-.!|>~";

// ----- block tree -----

/**
 * @param {string} text
 * @returns {{type:string}[]} array of block nodes
 */
export function parseMarkdown(text) {
  const src = typeof text === "string" ? text : String(text ?? "");
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines, depth) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      const res = readFence(lines, i, fence);
      blocks.push(res.node);
      i = res.next;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (heading) {
      const body = stripClosingHashes(heading[2] || "");
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inline: parseInline(body, 0),
      });
      i++;
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const res = readBlockquote(lines, i, depth);
      blocks.push(res.node);
      i = res.next;
      continue;
    }

    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1]) && line.includes("|")) {
      const res = readTable(lines, i);
      if (res) {
        blocks.push(res.node);
        i = res.next;
        continue;
      }
    }

    if (matchListItem(line)) {
      const res = readList(lines, i, depth);
      blocks.push(res.node);
      i = res.next;
      continue;
    }

    const res = readParagraph(lines, i);
    if (res.node) blocks.push(res.node);
    i = res.next;
  }
  return blocks;
}

function matchFence(line) {
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
  if (!m) return null;
  const info = m[3].trim();
  // An info string on a backtick fence may not itself contain a backtick.
  if (m[2][0] === "`" && info.includes("`")) return null;
  return { indent: m[1].length, marker: m[2][0], len: m[2].length, info };
}

function readFence(lines, start, fence) {
  const body = [];
  let i = start + 1;
  let closed = false;
  while (i < lines.length) {
    const close = matchFence(lines[i]);
    if (close && close.marker === fence.marker && close.len >= fence.len && close.info === "") {
      closed = true;
      i++;
      break;
    }
    body.push(stripIndent(lines[i], fence.indent));
    i++;
  }
  // Unclosed fence (common while a reply is still streaming) keeps everything
  // collected so far as code rather than falling back to paragraphs.
  const lang = fence.info.split(/\s+/)[0] || "";
  return {
    node: { type: "code", lang, text: body.join("\n"), closed },
    next: i,
  };
}

function stripIndent(line, n) {
  let i = 0;
  while (i < n && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

function stripClosingHashes(s) {
  let out = s.replace(/[ \t]+$/, "");
  let end = out.length;
  while (end > 0 && out[end - 1] === "#") end--;
  if (end === out.length) return out;
  if (end === 0) return "";
  if (out[end - 1] === " " || out[end - 1] === "\t") return out.slice(0, end - 1).replace(/[ \t]+$/, "");
  return out;
}

function isHorizontalRule(line) {
  const s = line.trim();
  if (s.length < 3) return false;
  if (line.length - line.trimStart().length > 3) return false;
  let marker = "";
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " " || c === "\t") continue;
    if (c !== "*" && c !== "-" && c !== "_") return false;
    if (marker === "") marker = c;
    else if (c !== marker) return false;
    count++;
  }
  return count >= 3;
}

function readBlockquote(lines, start, depth) {
  const inner = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^ {0,3}>/.test(line)) {
      inner.push(line.replace(/^ {0,3}> ?/, ""));
      i++;
      continue;
    }
    // Lazy continuation: a plain paragraph line right after a quoted line.
    if (line.trim() !== "" && inner.length > 0 && !matchFence(line) && !isHorizontalRule(line) && !matchListItem(line)) {
      inner.push(line);
      i++;
      continue;
    }
    break;
  }
  const children = depth >= MAX_BLOCK_DEPTH
    ? [{ type: "paragraph", inline: parseInline(inner.join("\n"), 0) }]
    : parseBlocks(inner, depth + 1);
  return { node: { type: "blockquote", children }, next: i };
}

function matchListItem(line) {
  const m = /^( {0,7})(?:([-+*])|(\d{1,9})([.)]))(?:([ \t]+)(.*)|$)/.exec(line);
  if (!m) return null;
  if (isHorizontalRule(line)) return null;
  const ordered = m[3] !== undefined;
  // "-foo" is not a list item; the marker needs whitespace or end of line.
  if (m[5] === undefined && m[6] === undefined && line.trim().length > (ordered ? m[3].length + 1 : 1)) {
    return null;
  }
  return {
    indent: m[1].length,
    ordered,
    start: ordered ? parseInt(m[3], 10) : 1,
    text: m[6] === undefined ? "" : m[6],
  };
}

function readList(lines, start, depth) {
  const base = matchListItem(lines[start]);
  const ordered = base.ordered;
  const baseIndent = base.indent;
  const items = [];
  let cur = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const peek = j < lines.length ? matchListItem(lines[j]) : null;
      if (peek && peek.indent >= baseIndent) {
        i = j;
        continue;
      }
      break;
    }

    const m = matchListItem(line);

    // Outdented item: it belongs to an enclosing list, so stop here.
    if (m && m.indent <= baseIndent - 2) break;

    if (m && m.indent <= baseIndent + 1) {
      if (m.ordered !== ordered) break;
      cur = { text: m.text, inline: [], children: [] };
      items.push(cur);
      i++;
      continue;
    }

    if (m && cur && depth < MAX_BLOCK_DEPTH) {
      const sub = readList(lines, i, depth + 1);
      cur.children.push(sub.node);
      i = sub.next > i ? sub.next : i + 1;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (cur && indent > baseIndent && !matchFence(line) && !isHorizontalRule(line)) {
      cur.text += (cur.text === "" ? "" : "\n") + line.trim();
      i++;
      continue;
    }

    break;
  }

  for (const it of items) it.inline = parseInline(it.text, 0);
  return {
    node: { type: "list", ordered, start: base.start, items },
    next: i > start ? i : start + 1,
  };
}

function isTableDelimiter(line) {
  if (!line || !line.includes("-")) return false;
  const cells = splitCells(line);
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return false;
  }
  return true;
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function readTable(lines, start) {
  const header = splitCells(lines[start]);
  const delims = splitCells(lines[start + 1]);
  // GFM: the delimiter row must have exactly as many cells as the header.
  // Without this, "Cost | 5" followed by "---" would swallow a section break.
  if (header.length === 0 || delims.length !== header.length) return null;

  const align = delims.map((d) => {
    const left = d.startsWith(":");
    const right = d.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const width = header.length;
  const rows = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    // A table body runs until a blank line or the start of another block.
    if (line.trim() === "") break;
    if (matchFence(line)) break;
    if (/^ {0,3}(#{1,6})(?:[ \t]+|$)/.test(line)) break;
    if (/^ {0,3}>/.test(line)) break;
    if (isHorizontalRule(line)) break;
    if (matchListItem(line)) break;
    rows.push(fitRow(splitCells(line), width));
    i++;
  }

  return {
    node: {
      type: "table",
      align: fitRow(align, width),
      header: header.map((c) => parseInline(c, 0)),
      rows: rows.map((r) => r.map((c) => parseInline(c || "", 0))),
    },
    next: i,
  };
}

function fitRow(cells, width) {
  const out = cells.slice(0, width);
  while (out.length < width) out.push(null);
  return out;
}

function readParagraph(lines, start) {
  const buf = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (i > start) {
      if (matchFence(line)) break;
      if (/^ {0,3}(#{1,6})(?:[ \t]+|$)/.test(line)) break;
      if (isHorizontalRule(line)) break;
      if (/^ {0,3}>/.test(line)) break;
      if (matchListItem(line)) break;
      if (i + 1 < lines.length && isTableDelimiter(lines[i + 1]) && line.includes("|")) break;
    }
    buf.push(line.trim());
    i++;
  }
  if (i === start) i = start + 1; // never stall
  const text = buf.join("\n");
  return {
    node: text === "" ? null : { type: "paragraph", inline: parseInline(text, 0) },
    next: i,
  };
}

// ----- inline tree -----

function parseInline(text, depth) {
  const out = [];
  const s = typeof text === "string" ? text : "";
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf !== "") {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };

  while (i < s.length) {
    const c = s[i];

    if (c === "\n") {
      flush();
      out.push({ type: "br" });
      i++;
      continue;
    }

    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const res = scanCode(s, i);
      if (res) {
        flush();
        out.push(res.node);
        i = res.next;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if ((c === "*" || c === "_") && depth < MAX_INLINE_DEPTH) {
      const res = scanEmphasis(s, i, c, depth);
      if (res) {
        flush();
        out.push(res.node);
        i = res.next;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (c === "[" && depth < MAX_INLINE_DEPTH) {
      const res = scanLink(s, i, depth);
      if (res) {
        flush();
        out.push(res.node);
        i = res.next;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

function scanCode(s, start) {
  let run = 0;
  while (start + run < s.length && s[start + run] === "`") run++;
  const ticks = s.slice(start, start + run);
  let from = start + run;
  // Find a closing run of exactly the same length.
  while (from <= s.length) {
    const at = s.indexOf(ticks, from);
    if (at === -1) return null;
    if (s[at + run] === "`") {
      // Longer run: skip past it and keep looking.
      let k = at;
      while (k < s.length && s[k] === "`") k++;
      from = k;
      continue;
    }
    let value = s.slice(start + run, at).replace(/\n/g, " ");
    if (value.length > 1 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") {
      value = value.slice(1, -1);
    }
    return { node: { type: "code", value }, next: at + run };
  }
  return null;
}

function isWordChar(c) {
  return c !== undefined && /[0-9A-Za-z]/.test(c);
}

function scanEmphasis(s, start, marker, depth) {
  let run = 0;
  while (start + run < s.length && s[start + run] === marker) run++;

  // Underscores only open at a non-word boundary, so snake_case_names survive.
  if (marker === "_" && isWordChar(s[start - 1])) return null;

  const tries = run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1];
  for (const width of tries) {
    const delim = marker.repeat(width);
    const contentStart = start + width;
    if (s[contentStart] === " " || s[contentStart] === undefined) continue;
    let from = contentStart;
    while (from < s.length) {
      const at = s.indexOf(delim, from);
      if (at === -1) break;
      if (at === contentStart) break; // empty content, e.g. ****
      if (s[at - 1] === " " || s[at - 1] === "\\") {
        from = at + 1;
        continue;
      }
      if (width === 1 && s[at + 1] === marker) {
        from = at + 1;
        continue;
      }
      if (marker === "_" && isWordChar(s[at + width])) {
        from = at + 1;
        continue;
      }
      const children = parseInline(s.slice(contentStart, at), depth + 1);
      const node = width === 3
        ? { type: "strong", children: [{ type: "em", children }] }
        : { type: width === 2 ? "strong" : "em", children };
      return { node, next: at + width };
    }
  }
  return null;
}

function scanLink(s, start, depth) {
  let i = start + 1;
  let bracket = 1;
  while (i < s.length && bracket > 0) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") bracket++;
    else if (c === "]") bracket--;
    if (bracket === 0) break;
    i++;
  }
  if (bracket !== 0) return null;
  const labelEnd = i;
  if (s[labelEnd + 1] !== "(") return null;

  let j = labelEnd + 2;
  let paren = 1;
  while (j < s.length && paren > 0) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "(") paren++;
    else if (c === ")") paren--;
    if (paren === 0) break;
    if (c === "\n") return null;
    j++;
  }
  if (paren !== 0) return null;

  const dest = s.slice(labelEnd + 2, j).trim();
  const href = normalizeHref(dest);
  if (!href) return null;

  return {
    node: {
      type: "link",
      href,
      children: parseInline(s.slice(start + 1, labelEnd), depth + 1),
    },
    next: j + 1,
  };
}

// Only absolute http(s) URLs become links. javascript:, data:, vbscript:,
// protocol-relative //host and relative paths all return null, which makes the
// caller emit the original text literally. new URL() is deliberately not used:
// relative URLs would resolve against the chrome-extension:// origin and pass.
function normalizeHref(dest) {
  let raw = dest;
  const angle = /^<([^<>]*)>/.exec(raw);
  if (angle) raw = angle[1];
  else {
    const sp = raw.search(/[ \t]/);
    if (sp !== -1) raw = raw.slice(0, sp); // drop the optional title
  }
  raw = raw.trim();
  if (raw === "") return null;
  // Strip control characters that could hide the scheme.
  raw = raw.replace(/[\u0000-\u0020\u007f]/g, "");
  if (!/^https?:\/\/[^\s]/i.test(raw)) return null;
  return raw;
}

// ----- DOM rendering -----

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  return renderBlocks(parseMarkdown(text));
}

function renderBlocks(blocks) {
  const frag = document.createDocumentFragment();
  for (const block of blocks) {
    const el = renderBlock(block);
    if (el) frag.appendChild(el);
  }
  return frag;
}

function renderBlock(block) {
  switch (block.type) {
    case "heading": {
      const el = document.createElement("h" + block.level);
      appendInline(el, block.inline);
      return el;
    }
    case "paragraph": {
      const el = document.createElement("p");
      appendInline(el, block.inline);
      return el;
    }
    case "code": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.lang) code.className = "language-" + block.lang.replace(/[^\w.+-]/g, "");
      code.textContent = block.text;
      pre.appendChild(code);
      return pre;
    }
    case "hr":
      return document.createElement("hr");
    case "blockquote": {
      const el = document.createElement("blockquote");
      el.appendChild(renderBlocks(block.children));
      return el;
    }
    case "list": {
      const el = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) el.start = block.start;
      for (const item of block.items) {
        const li = document.createElement("li");
        appendInline(li, item.inline);
        for (const child of item.children) {
          const sub = renderBlock(child);
          if (sub) li.appendChild(sub);
        }
        el.appendChild(li);
      }
      return el;
    }
    case "table": {
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hrow = document.createElement("tr");
      block.header.forEach((cell, idx) => {
        const th = document.createElement("th");
        if (block.align[idx]) th.style.textAlign = block.align[idx];
        appendInline(th, cell);
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        row.forEach((cell, idx) => {
          const td = document.createElement("td");
          if (block.align[idx]) td.style.textAlign = block.align[idx];
          if (cell) appendInline(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }
    default:
      return null;
  }
}

function appendInline(parent, nodes) {
  for (const node of nodes || []) {
    switch (node.type) {
      case "text":
        parent.appendChild(document.createTextNode(node.value));
        break;
      case "br":
        parent.appendChild(document.createElement("br"));
        break;
      case "code": {
        const el = document.createElement("code");
        el.textContent = node.value;
        parent.appendChild(el);
        break;
      }
      case "strong": {
        const el = document.createElement("strong");
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      case "em": {
        const el = document.createElement("em");
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      case "link": {
        const el = document.createElement("a");
        el.href = node.href;
        el.target = "_blank";
        el.rel = "noopener";
        appendInline(el, node.children);
        parent.appendChild(el);
        break;
      }
      default:
        break;
    }
  }
}
