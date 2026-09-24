// Browser tool definitions shared by the hub, the SDK adapter, and mcp-proxy.
// Names, args and result shapes come from PROTOCOL.md ("Browser tools").
// Dependency-free on purpose: importable from any module without side effects.

export const TOOLS = [
  {
    name: "tabs_list",
    description: "List open browser tabs. Returns {tabs:[{tabId,url,title,active}]}.",
    args: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "tab_new",
    description: "Open a new browser tab, optionally at a URL. Returns {tabId}.",
    args: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open in the new tab (optional)" }
      },
      required: []
    }
  },
  {
    name: "tab_close",
    description: "Close a tab by id. Returns {closed:true}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Id of the tab to close" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "navigate",
    description: "Navigate a tab to a URL and wait for the load event (20s cap, then returns the current state). Returns {url, title}.",
    args: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["url"]
    }
  },
  {
    name: "read_page",
    description: "Read the visible text of a page (document.body.innerText, capped at maxChars, default 60000). Returns {url, title, text}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" },
        maxChars: { type: "number", description: "Maximum characters of text to return (default 60000)" }
      },
      required: []
    }
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of a tab. Returns {base64, mimeType:\"image/png\"}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "click",
    description: "Click at viewport coordinates using trusted CDP input (left button, single click). Returns {clicked:true}.",
    args: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport x coordinate" },
        y: { type: "number", description: "Viewport y coordinate" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "click_element",
    description: "Click the first element matching a CSS selector: scrolls it into view, resolves its center, then performs a trusted CDP mouse click. Optional dx/dy offset the point. Returns {clicked:true, selector, tag}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click" },
        dx: { type: "number", description: "X offset from the element center (default 0)" },
        dy: { type: "number", description: "Y offset from the element center (default 0)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["selector"]
    }
  },
  {
    name: "type_text",
    description: "Type text into the focused element via CDP Input.insertText (trusted input, works in rich editors). Pass selector to click-focus that element first. Returns {typed:<charcount>}.",
    args: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to insert at the caret" },
        selector: { type: "string", description: "Optional CSS selector; the element is clicked first to focus it" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["text"]
    }
  },
  {
    name: "press_key",
    description: "Press a key or modifier combo, e.g. \"Enter\", \"Tab\", \"Escape\", \"Backspace\", \"ArrowDown\", \"Meta+A\", \"Meta+C\", \"Meta+V\". Returns {pressed:key}.",
    args: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, optionally with modifiers joined by +" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["key"]
    }
  },
  {
    name: "eval_js",
    description: "Evaluate a JavaScript expression in the page (Runtime.evaluate, returnByValue, awaits promises). Returns {value}; page errors come back as a tool error.",
    args: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["expression"]
    }
  },
  {
    name: "annotate",
    description: "Mark text on the page for the user: 'underline' (dashed underline, key terms), 'highlight' (background mark, important sentences) or 'circle' (ellipse around the passage). Use it to point at things while co-reading, e.g. proactively flagging confusing spots. quote must be exact text as it appears on the page (from read_page). comment is the note shown when the user clicks the mark — always explain WHY it was marked. Returns {id, style, quote} or an error when the quote is not found.",
    args: {
      type: "object",
      properties: {
        quote: { type: "string", description: "Exact text to mark, copied from the page" },
        style: { type: "string", description: "underline | highlight | circle" },
        comment: { type: "string", description: "Why this passage is marked — required for proactive marks" },
        color: { type: "string", description: "Optional CSS color override" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["quote", "style"]
    }
  },
  {
    name: "annotate_batch",
    description: "Mark several passages in one call — same as annotate but batched. Each item is {quote, style, comment?, color?} and is applied independently. Returns {results:[{ok:true,id,style,quote} | {ok:false,quote,error}]} so a bad quote does not fail the whole batch.",
    args: {
      type: "object",
      properties: {
        annotations: {
          type: "array",
          description: "Marks to apply: {quote (exact text), style (underline|highlight|circle), comment?, color?}",
          items: {
            type: "object",
            properties: {
              quote: { type: "string" },
              style: { type: "string" },
              comment: { type: "string" },
              color: { type: "string" }
            },
            required: ["quote", "style"]
          }
        },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["annotations"]
    }
  },
  {
    name: "annotations_list",
    description: "List the annotations on a tab, including their comment threads. Returns {annotations:[{id, style, quote, comment, author, replies:[{who,text}]}]}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "annotate_reply",
    description: "Post a reply on an annotation's comment thread — e.g. answering a comment the user left on a mark. Returns {id, replied:true}.",
    args: {
      type: "object",
      properties: {
        id: { type: "string", description: "Annotation id from annotate/annotations_list" },
        text: { type: "string", description: "Reply text" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["id", "text"]
    }
  },
  {
    name: "annotate_clear",
    description: "Remove one annotation by id, or every annotation on the tab when id is omitted. Returns {cleared:<n>}.",
    args: {
      type: "object",
      properties: {
        id: { type: "string", description: "Annotation id; omit to clear all" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "dom_inspect",
    description: "Structured DOM read: return every element matching a CSS selector with tag, id, classes, all attributes, text, bounding rect and computed styles (default subset or the property names in `styles`). Returns {selector, matched, elements:[...]}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to match" },
        all: { type: "boolean", description: "true (default) returns all matches, false only the first" },
        styles: { type: "array", items: { type: "string" }, description: "Computed-style property names to include; omit for the default subset" },
        max: { type: "number", description: "Max elements returned (default 25)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["selector"]
    }
  },
  {
    name: "console_log",
    description: "Read the tab's console buffer: console.* calls, uncaught exceptions and browser Log entries captured since the tool was first used (or since the last navigation). Returns {entries:[{ts,level,source,text,url}]}.",
    args: {
      type: "object",
      properties: {
        level: { type: "string", description: "Filter: log|info|warn|error|exception|..." },
        limit: { type: "number", description: "Max entries, newest last (default 100, cap 500)" },
        clear: { type: "boolean", description: "Empty the buffer after reading" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "network_log",
    description: "Read the tab's network buffer: requests captured since the tool was first used. Returns {entries:[{id,url,method,status,type,mimeType,startTime,duration,size,pending,failed}]} — headers only with includeHeaders (credential headers are always stripped). `har:true` also returns a sanitized HAR 1.2 document.",
    args: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Substring filter on request URL" },
        includeHeaders: { type: "boolean", description: "Include request/response headers (cookie/auth headers always removed)" },
        har: { type: "boolean", description: "Also return {har} as a HAR 1.2 log" },
        limit: { type: "number", description: "Max entries (default 100, cap 500)" },
        clear: { type: "boolean", description: "Empty the buffer after reading" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "a11y_tree",
    description: "Accessibility-tree read of the page (role + name + depth per node, capped at 1000). Falls back to a DOM-derived semantic outline when the CDP Accessibility domain is unavailable. Returns {source:'axtree'|'outline', nodes|...}.",
    args: {
      type: "object",
      properties: {
        maxDepth: { type: "number", description: "Max depth for the outline fallback (default 6)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "dialog_list",
    description: "List JavaScript dialogs (alert/confirm/prompt/beforeunload) seen on the tab. While the debugger is attached dialogs are auto-dismissed after ~5s unless answered sooner with dialog_respond — otherwise the page would hang. Returns {dialogs:[{type,message,url,ts,status}]}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "dialog_respond",
    description: "Answer the currently pending JS dialog before its auto-dismiss fires. Returns {handled:true,type,message} or {handled:false} when nothing is pending.",
    args: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "true accepts (OK), false dismisses (Cancel)" },
        promptText: { type: "string", description: "Text entered into a prompt dialog when accepting" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["accept"]
    }
  },
  {
    name: "patch_apply",
    description: "Apply a reversible live patch to the page — set styles/attributes, insert HTML, or remove elements matching a selector. The pre-change outerHTML is snapshotted so patch_revert can restore it. Returns {patchId, applied, results}.",
    args: {
      type: "object",
      properties: {
        patches: {
          type: "array",
          description: "Patches to apply (max 20 elements each)",
          items: {
            type: "object",
            properties: {
              selector: { type: "string", description: "CSS selector" },
              styles: { type: "object", description: "CSS properties to set, e.g. {\"outline\":\"2px solid red\"}" },
              attributes: { type: "object", description: "Attributes to set; null value removes the attribute" },
              insertAdjacentHTML: { type: "object", description: "{position:'beforebegin'|'afterbegin'|'beforeend'|'afterend', html}" },
              remove: { type: "boolean", description: "Remove the matched element" }
            },
            required: ["selector"]
          }
        },
        label: { type: "string", description: "Human note about what this patch proves" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["patches"]
    }
  },
  {
    name: "patch_revert",
    description: "Restore elements changed by patch_apply to their snapshotted outerHTML (event listeners attached since are lost — snapshot semantics). Returns {reverted, missing}.",
    args: {
      type: "object",
      properties: {
        patchId: { type: "string", description: "patchId from patch_apply" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["patchId"]
    }
  }
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
