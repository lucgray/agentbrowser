import fs from "node:fs/promises";
import assert from "node:assert/strict";

const P = new URL("../../extension/panel/markdown.js", import.meta.url);
const src = await fs.readFile(P, "utf8");
const code = src.replace(/^\s*\/\/.*$/gm, "");
for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /createContextualFragment/, /\beval\b/, /new Function/]) {
  assert.ok(!bad.test(code), "markdown.js must not use " + bad);
}
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const { parseMarkdown, renderMarkdown } = mod;
assert.equal(typeof parseMarkdown, "function");
assert.equal(typeof renderMarkdown, "function");

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(name + ": " + (e && e.message));
  }
}

const inlineText = (nodes) =>
  (nodes || [])
    .map((n) =>
      n.type === "text" ? n.value
      : n.type === "code" ? n.value
      : n.type === "br" ? "\n"
      : n.children ? inlineText(n.children)
      : "")
    .join("");

const types = (blocks) => blocks.map((b) => b.type);

// ---------- every construct ----------

t("headings 1..6", () => {
  const b = parseMarkdown("# a\n## b\n### c\n#### d\n##### e\n###### f\n####### g");
  assert.deepEqual(types(b), ["heading", "heading", "heading", "heading", "heading", "heading", "paragraph"]);
  assert.deepEqual(b.map((x) => x.level), [1, 2, 3, 4, 5, 6, undefined]);
  assert.equal(inlineText(b[0].inline), "a");
});

t("closing hashes stripped", () => {
  const b = parseMarkdown("## title ##");
  assert.equal(inlineText(b[0].inline), "title");
});

t("paragraph with soft breaks -> br nodes", () => {
  const b = parseMarkdown("one\ntwo\nthree");
  assert.deepEqual(types(b), ["paragraph"]);
  assert.equal(b[0].inline.filter((n) => n.type === "br").length, 2);
  assert.equal(inlineText(b[0].inline), "one\ntwo\nthree");
});

t("two paragraphs split on blank line", () => {
  assert.deepEqual(types(parseMarkdown("a\n\nb")), ["paragraph", "paragraph"]);
});

t("bold", () => {
  const n = parseMarkdown("a **b c** d")[0].inline;
  const s = n.find((x) => x.type === "strong");
  assert.ok(s, "strong node");
  assert.equal(inlineText(s.children), "b c");
});

t("italic", () => {
  const n = parseMarkdown("a *b* d")[0].inline;
  const e = n.find((x) => x.type === "em");
  assert.ok(e);
  assert.equal(inlineText(e.children), "b");
});

t("bold+italic ***x***", () => {
  const n = parseMarkdown("***x***")[0].inline;
  assert.equal(n[0].type, "strong");
  assert.equal(n[0].children[0].type, "em");
  assert.equal(inlineText(n), "x");
});

t("underscore emphasis and snake_case survival", () => {
  const em = parseMarkdown("_hi_")[0].inline;
  assert.equal(em[0].type, "em");
  const snake = parseMarkdown("some_var_name here")[0].inline;
  assert.equal(snake.length, 1);
  assert.equal(snake[0].type, "text");
  assert.equal(snake[0].value, "some_var_name here");
});

t("inline code, incl. one holding backticks and asterisks", () => {
  const n = parseMarkdown("call `a **b** c` now")[0].inline;
  const c = n.find((x) => x.type === "code");
  assert.equal(c.value, "a **b** c");
  const d = parseMarkdown("``a ` b``")[0].inline;
  assert.equal(d[0].type, "code");
  assert.equal(d[0].value, "a ` b");
});

t("fenced code with language", () => {
  const b = parseMarkdown("```js\nconst a = 1;\nif (a < 2) {}\n```");
  assert.deepEqual(types(b), ["code"]);
  assert.equal(b[0].lang, "js");
  assert.equal(b[0].closed, true);
  assert.equal(b[0].text, "const a = 1;\nif (a < 2) {}");
});

t("fenced code with no language, tilde fence", () => {
  const b = parseMarkdown("~~~\nraw\n~~~");
  assert.equal(b[0].type, "code");
  assert.equal(b[0].lang, "");
  assert.equal(b[0].text, "raw");
});

t("markdown inside a fence stays literal", () => {
  const b = parseMarkdown("```\n# not a heading\n- not a list\n```");
  assert.deepEqual(types(b), ["code"]);
  assert.equal(b[0].text, "# not a heading\n- not a list");
});

t("unordered list", () => {
  const b = parseMarkdown("- one\n- two\n- three");
  assert.deepEqual(types(b), ["list"]);
  assert.equal(b[0].ordered, false);
  assert.equal(b[0].items.length, 3);
  assert.deepEqual(b[0].items.map((i) => inlineText(i.inline)), ["one", "two", "three"]);
});

t("ordered list with start", () => {
  const b = parseMarkdown("3. c\n4. d");
  assert.equal(b[0].ordered, true);
  assert.equal(b[0].start, 3);
  assert.equal(b[0].items.length, 2);
});

t("nested list one level", () => {
  const b = parseMarkdown("- a\n  - a1\n  - a2\n- b");
  assert.deepEqual(types(b), ["list"]);
  assert.equal(b[0].items.length, 2);
  const sub = b[0].items[0].children[0];
  assert.equal(sub.type, "list");
  assert.deepEqual(sub.items.map((i) => inlineText(i.inline)), ["a1", "a2"]);
  assert.equal(b[0].items[1].children.length, 0);
});

t("ordered nested under unordered", () => {
  const b = parseMarkdown("- a\n   1. x\n   2. y");
  const sub = b[0].items[0].children[0];
  assert.equal(sub.ordered, true);
  assert.equal(sub.items.length, 2);
});

t("links", () => {
  const n = parseMarkdown("see [docs](https://example.com/a?b=1) ok")[0].inline;
  const l = n.find((x) => x.type === "link");
  assert.equal(l.href, "https://example.com/a?b=1");
  assert.equal(inlineText(l.children), "docs");
});

t("link with parens in url", () => {
  const n = parseMarkdown("[w](https://en.wikipedia.org/wiki/A_(b))")[0].inline;
  assert.equal(n[0].href, "https://en.wikipedia.org/wiki/A_(b)");
});

t("link with title is trimmed to url", () => {
  const n = parseMarkdown('[t](https://a.test "the title")')[0].inline;
  assert.equal(n[0].href, "https://a.test");
});

t("blockquote", () => {
  const b = parseMarkdown("> quoted **bold**\n> more");
  assert.deepEqual(types(b), ["blockquote"]);
  assert.deepEqual(types(b[0].children), ["paragraph"]);
  assert.equal(inlineText(b[0].children[0].inline), "quoted bold\nmore");
});

t("blockquote containing a list", () => {
  const b = parseMarkdown("> - a\n> - b");
  assert.equal(b[0].type, "blockquote");
  assert.equal(b[0].children[0].type, "list");
  assert.equal(b[0].children[0].items.length, 2);
});

t("horizontal rules", () => {
  for (const s of ["---", "***", "___", "- - -", "*****"]) {
    assert.deepEqual(types(parseMarkdown(s)), ["hr"], s);
  }
  assert.deepEqual(types(parseMarkdown("--")), ["paragraph"]);
});

t("gfm table with alignment", () => {
  const b = parseMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |");
  assert.deepEqual(types(b), ["table"]);
  assert.deepEqual(b[0].align, ["left", "center", "right"]);
  assert.deepEqual(b[0].header.map(inlineText), ["a", "b", "c"]);
  assert.equal(b[0].rows.length, 2);
  assert.deepEqual(b[0].rows[1].map(inlineText), ["4", "5", "6"]);
});

t("table without outer pipes, ragged rows padded/truncated", () => {
  const b = parseMarkdown("a | b\n--- | ---\n1\n1 | 2 | 3");
  assert.equal(b[0].type, "table");
  assert.equal(b[0].rows[0].length, 2);
  assert.equal(b[0].rows[1].length, 2);
  assert.deepEqual(b[0].rows[1].map(inlineText), ["1", "2"]);
});

t("empty table cells", () => {
  const b = parseMarkdown("| a | b |\n|---|---|\n|   |   |\n| x |   |");
  assert.equal(b[0].type, "table");
  assert.deepEqual(b[0].rows[0].map(inlineText), ["", ""]);
  assert.deepEqual(b[0].rows[1].map(inlineText), ["x", ""]);
});

t("delimiter row must match header cell count", () => {
  // "Cost | 5" then "---" is a stat line plus a section break, not a table.
  assert.deepEqual(types(parseMarkdown("Cost | 5\n---\nnext line")), ["paragraph", "hr", "paragraph"]);
  assert.deepEqual(types(parseMarkdown("a | b | c\n--- | ---\n1 | 2 | 3")), ["paragraph"]);
  assert.deepEqual(types(parseMarkdown("a | b\n--- | --- | ---\n1 | 2")), ["paragraph"]);
  // matching counts still work
  assert.deepEqual(types(parseMarkdown("a | b\n--- | ---\n1 | 2")), ["table"]);
});

t("inline markup inside table cells", () => {
  const b = parseMarkdown("| x | y |\n|---|---|\n| **b** | `c` |");
  assert.equal(b[0].rows[0][0][0].type, "strong");
  assert.equal(b[0].rows[0][1][0].type, "code");
});

t("escapes", () => {
  const n = parseMarkdown("\\*not italic\\* and \\# not heading")[0].inline;
  assert.equal(n.length, 1);
  assert.equal(n[0].value, "*not italic* and # not heading");
});

// ---------- hostile input ----------

t("unclosed fence still yields a code block", () => {
  const b = parseMarkdown("text\n\n```py\nprint(1)\nprint(2)");
  assert.deepEqual(types(b), ["paragraph", "code"]);
  assert.equal(b[1].closed, false);
  assert.equal(b[1].lang, "py");
  assert.equal(b[1].text, "print(1)\nprint(2)");
});

t("bare opening fence (streaming first token)", () => {
  const b = parseMarkdown("```");
  assert.deepEqual(types(b), ["code"]);
  assert.equal(b[0].text, "");
});

t("script tags stay text, never markup", () => {
  const raw = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
  const b = parseMarkdown(raw);
  assert.deepEqual(types(b), ["paragraph"]);
  assert.equal(inlineText(b[0].inline), raw);
});

t("javascript: link renders as plain text", () => {
  const b = parseMarkdown("[click](javascript:alert(1))");
  assert.deepEqual(types(b), ["paragraph"]);
  assert.ok(!b[0].inline.some((n) => n.type === "link"), "no link node");
  assert.equal(inlineText(b[0].inline), "[click](javascript:alert(1))");
});

t("other hostile / non-http schemes rejected", () => {
  const bad = [
    "[a](JaVaScRiPt:alert(1))",
    "[a](java\tscript:alert(1))",
    "[a](data:text/html;base64,PHNjcmlwdD4=)",
    "[a](vbscript:msgbox)",
    "[a](//evil.test/x)",
    "[a](/relative/path)",
    "[a](file:///etc/passwd)",
    "[a](chrome-extension://abc/x)",
    "[a]( javascript:alert(1) )",
    "[a](#anchor)",
    "[a]()",
  ];
  for (const s of bad) {
    const inline = parseMarkdown(s)[0].inline;
    assert.ok(!inline.some((n) => n.type === "link"), "should not link: " + s);
  }
  // and the good ones still work
  for (const s of ["[a](http://x.test/p)", "[a](HTTPS://X.test/p)"]) {
    assert.ok(parseMarkdown(s)[0].inline.some((n) => n.type === "link"), s);
  }
});

t("**** and other degenerate emphasis do not hang or throw", () => {
  for (const s of ["****", "**", "*", "___", "**a", "*a**b*", "**********", "_ _ _ _", "*_*_*_*", "a**b*c**d*e"]) {
    const b = parseMarkdown(s);
    assert.ok(Array.isArray(b), s);
  }
  const four = parseMarkdown("x**** y")[0].inline;
  assert.equal(inlineText(four), "x**** y");
});

t("unbalanced brackets/parens", () => {
  for (const s of ["[a](", "[a", "](b)", "[[[[[[[[[[a", "[a](b", "[a][b]", "![img](https://x.test/i.png)"]) {
    assert.ok(Array.isArray(parseMarkdown(s)), s);
  }
});

t("10k-char single line is fast and lossless", () => {
  const line = "a".repeat(10000);
  const t0 = Date.now();
  const b = parseMarkdown(line);
  const ms = Date.now() - t0;
  assert.deepEqual(types(b), ["paragraph"]);
  assert.equal(inlineText(b[0].inline).length, 10000);
  assert.ok(ms < 1000, "took " + ms + "ms");
});

t("10k chars of adversarial delimiters is fast", () => {
  for (const unit of ["*", "**", "*_`[", "[a](", "`", "**a"]) {
    const s = unit.repeat(Math.ceil(10000 / unit.length));
    const t0 = Date.now();
    parseMarkdown(s);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, unit + " took " + ms + "ms");
  }
});

t("deep nesting terminates", () => {
  assert.ok(Array.isArray(parseMarkdown("> ".repeat(200) + "x")));
  let s = "";
  for (let i = 0; i < 50; i++) s += " ".repeat(i * 2) + "- item " + i + "\n";
  assert.ok(Array.isArray(parseMarkdown(s)));
});

t("odd inputs do not throw", () => {
  for (const v of ["", "\n\n\n", "\r\n\r\n", null, undefined, 42, {}, "|||\n|---|\n|||", "   ", "\t\t", "|", "---|---"]) {
    assert.ok(Array.isArray(parseMarkdown(v)), String(v));
  }
});

t("newline styles normalize", () => {
  assert.deepEqual(types(parseMarkdown("a\r\n\r\nb")), ["paragraph", "paragraph"]);
});

// ---------- one gnarly end-to-end document ----------

const DOC = `# AgentChat report

Intro line one
line two with **bold**, *italic*, \`code\`, and a [link](https://example.com/x).

## Details ##

1. first
2. second
   - nested a
   - nested b
3. third

- [ ] loose bullet with a <script>alert(1)</script> in it
- another with a [bad link](javascript:alert(1))

> A quote with \`inline\` code
> and a second line.
>
> - quoted list item

---

| tool | args | ok |
|:-----|:----:|---:|
| click | {x:1,y:2} | yes |
|  |  |  |
| eval_js | \`1+1\` | **no** |

\`\`\`js
const x = "a > b && c < d";
if (x) { console.log("<script>"); }
\`\`\`

Trailing paragraph with ****, an unclosed fence next.

\`\`\`sh
echo hi`;

t("gnarly document parses to the expected block sequence", () => {
  const b = parseMarkdown(DOC);
  assert.deepEqual(types(b), [
    "heading",     // # AgentChat report
    "paragraph",   // intro
    "heading",     // ## Details
    "list",        // ordered
    "list",        // unordered
    "blockquote",
    "hr",
    "table",
    "code",        // js fence
    "paragraph",
    "code",        // unclosed sh fence
  ]);
  assert.equal(b[0].level, 1);
  assert.equal(inlineText(b[2].inline), "Details");

  const ol = b[3];
  assert.equal(ol.ordered, true);
  assert.equal(ol.items.length, 3);
  assert.equal(ol.items[1].children[0].items.length, 2);

  const ul = b[4];
  assert.equal(ul.ordered, false);
  assert.ok(inlineText(ul.items[0].inline).includes("<script>alert(1)</script>"));
  assert.ok(!ul.items[1].inline.some((n) => n.type === "link"), "javascript: must not become a link");

  const bq = b[5];
  assert.deepEqual(types(bq.children), ["paragraph", "list"]);

  const table = b[7];
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.deepEqual(table.header.map(inlineText), ["tool", "args", "ok"]);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[1].map(inlineText), ["", "", ""]);
  assert.equal(table.rows[2][1][0].type, "code");
  assert.equal(table.rows[2][2][0].type, "strong");

  assert.equal(b[8].lang, "js");
  assert.equal(b[8].closed, true);
  assert.ok(b[8].text.includes('"<script>"'));

  assert.equal(b[10].lang, "sh");
  assert.equal(b[10].closed, false);
  assert.equal(b[10].text, "echo hi");
});

t("every prefix of the gnarly doc parses (streaming re-render)", () => {
  for (let i = 0; i <= DOC.length; i += 7) {
    const b = parseMarkdown(DOC.slice(0, i));
    assert.ok(Array.isArray(b), "prefix " + i);
  }
});

t("no link node anywhere in the doc has a non-http href", () => {
  const seen = [];
  const walkInline = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === "link") seen.push(n.href);
      if (n.children) walkInline(n.children);
    }
  };
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.inline) walkInline(b.inline);
      if (b.children) walk(b.children);
      if (b.items) for (const it of b.items) { walkInline(it.inline); walk(it.children); }
      if (b.header) { for (const c of b.header) walkInline(c); for (const r of b.rows) for (const c of r) walkInline(c || []); }
    }
  };
  walk(parseMarkdown(DOC));
  assert.equal(seen.length, 1);
  assert.ok(/^https?:\/\//i.test(seen[0]));
});

t("renderMarkdown throws without a DOM rather than silently no-op", () => {
  // Confirms the module has no top-level document access (import succeeded)
  // and that rendering is the only DOM-touching path.
  assert.equal(typeof globalThis.document, "undefined");
  assert.throws(() => renderMarkdown("# hi"));
});

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
