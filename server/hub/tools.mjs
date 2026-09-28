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
    description: "Navigate a tab to a URL and wait for the load event (20s cap, then returns the current state). settleMs adds an SPA-friendly settle wait after load: returns when the document is complete and no new network request has started for settleMs (15s hard cap). Returns {url, title, settled?} — settled is present only when settleMs was given.",
    args: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" },
        settleMs: { type: "number", description: "Post-load settle wait: ms of network silence (plus document complete) before returning; use ~1500-3000 for SPAs. Omit for the old load-event-only behavior." }
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
    description: "Click at viewport coordinates using trusted CDP input. button picks left (default), right (context menu), or middle; clickCount 2/3 gives double/triple click. Returns {clicked:true, button, clickCount}.",
    args: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport x coordinate" },
        y: { type: "number", description: "Viewport y coordinate" },
        button: { type: "string", description: "left | right | middle (default left)" },
        clickCount: { type: "number", description: "1 single, 2 double, 3 triple (default 1)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["x", "y"]
    }
  },
  {
    name: "click_element",
    description: "Click the first element matching a CSS selector (or a nodeId stamped by page_snapshot): scrolls it into view, resolves its center, then performs a trusted CDP mouse click. Optional dx/dy offset the point; button/clickCount work like click. frame scopes into a cross-origin iframe. Returns {clicked:true, selector, tag}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click (or pass nodeId)" },
        nodeId: { type: "string", description: "data-ab-node id from page_snapshot — clicks that element (v2.7)" },
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; scopes this call into that frame (v2.7)" },
        dx: { type: "number", description: "X offset from the element center (default 0)" },
        dy: { type: "number", description: "Y offset from the element center (default 0)" },
        button: { type: "string", description: "left | right | middle (default left)" },
        clickCount: { type: "number", description: "1 single, 2 double, 3 triple (default 1)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "hover",
    description: "Move the pointer without pressing — opens hover menus, tooltips and hover previews. Pass selector to hover an element's center, or x/y for coordinates. Returns {hovered:true}.",
    args: {
      type: "object",
      properties: {
        x: { type: "number", description: "Viewport x coordinate" },
        y: { type: "number", description: "Viewport y coordinate" },
        selector: { type: "string", description: "CSS selector — hovers the element center instead of x/y" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "scroll",
    description: "Real scroll gesture via Input.synthesizeScrollGesture — drives lazy loading, scroll listeners and nested scroll containers that window.scrollTo cannot reach. x/y anchor the gesture (element under the point scrolls); omit for viewport center. Positive yDistance scrolls up, negative scrolls down. Returns {scrolled:true}.",
    args: {
      type: "object",
      properties: {
        x: { type: "number", description: "Gesture anchor x (default viewport center)" },
        y: { type: "number", description: "Gesture anchor y (default viewport center)" },
        xDistance: { type: "number", description: "Horizontal gesture distance in px" },
        yDistance: { type: "number", description: "Vertical gesture distance in px; negative = scroll down, positive = scroll up" },
        speed: { type: "number", description: "Gesture speed px/s (default 800)" },
        repeatCount: { type: "number", description: "Repeat the gesture N times (default 0 = once)" },
        repeatDelayMs: { type: "number", description: "Delay between repeats in ms" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "drag",
    description: "Drag from one point to another. mode 'mouse' (default): press-move-release — for sliders, mouse-event sortables, canvas strokes. mode 'html5': Input.dispatchDragEvent — fires the HTML5 dragstart/dragover/drop family for draggable lists and drop targets. Returns {dragged:true, mode}.",
    args: {
      type: "object",
      properties: {
        from: { type: "object", description: "{x,y} drag start" },
        to: { type: "object", description: "{x,y} drag end" },
        mode: { type: "string", description: "mouse | html5 (default mouse)" },
        steps: { type: "number", description: "Intermediate moves in mouse mode (default 10)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "select_text",
    description: "Create a real page text selection — either selector (selects the element's text via Range/Selection) or from/to coordinates (click-drag). The committed selection reaches the panel as chat context, same as a user drag-select. Returns {selected:true, text}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector — select this element's text" },
        from: { type: "object", description: "{x,y} selection start (coordinate mode)" },
        to: { type: "object", description: "{x,y} selection end (coordinate mode)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
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
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; focuses via a frame-aware click, then types (selector required, v2.7)" },
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
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; scopes this call into that frame (v2.7)" },
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
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; scopes this call into that frame (v2.7)" },
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
  },

  // --- debugger tools (v2.6): CDP Debugger domain — breakpoints pause page JS,
  // so the typical flow is breakpoint_set -> trigger the code path -> debug_wait
  // -> debug_eval to read locals -> debug_resume. While paused the page's JS is
  // frozen; give breakpoint_set an autoResumeMs when the agent only needs to
  // snapshot state and move on.

  {
    name: "breakpoint_set",
    description: "Set a JS breakpoint by URL (or urlRegex) + lineNumber, optional columnNumber/condition. autoResumeMs auto-resumes the page that many ms after this breakpoint hits — set it (e.g. 1000) whenever you only need to snapshot state, so a forgotten debug_resume can't wedge the tab. Returns {breakpoint:{id,url,lineNumber,locations:[{url,lineNumber}]}}.",
    args: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact script URL to break in" },
        urlRegex: { type: "string", description: "Regex matching script URL(s) — use when the URL is hashed/minified" },
        lineNumber: { type: "number", description: "0-based line number" },
        columnNumber: { type: "number", description: "0-based column (optional; defaults to the line's first position)" },
        condition: { type: "string", description: "Optional JS expression — the break fires only when it is truthy" },
        autoResumeMs: { type: "number", description: "Auto-resume the page N ms after this breakpoint hits; 0/omitted = stay paused until debug_resume" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["lineNumber"]
    }
  },
  {
    name: "breakpoint_list",
    description: "List the tab's active breakpoints and whether the page is currently paused. Returns {breakpoints, paused}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "breakpoint_remove",
    description: "Remove a breakpoint by the id from breakpoint_set. Returns {removed:true}.",
    args: {
      type: "object",
      properties: {
        id: { type: "string", description: "breakpointId" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["id"]
    }
  },
  {
    name: "debug_wait",
    description: "Wait for the page to pause on a breakpoint (or return immediately if already paused). Returns {paused:true, reason, hitBreakpoints, callFrames:[{functionName,url,lineNumber}], topCallFrameId} or {paused:false, reason:'timeout'}.",
    args: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Max wait in ms (default 30000, cap 300000). You choose this — how long to keep the page waiting for the break to hit." },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "debug_eval",
    description: "Evaluate an expression in the paused call frame — reads locals, args, this. Only valid while the page is paused (after debug_wait/breakpoint_list reports paused). Returns {result} or {error}.",
    args: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JS expression evaluated in the paused frame's scope" },
        callFrameId: { type: "string", description: "Frame to eval in; omit for the top frame" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["expression"]
    }
  },
  {
    name: "debug_resume",
    description: "Unpause the page: action 'resume' (default), 'stepOver', 'stepInto' or 'stepOut'. Always call this when done inspecting unless the breakpoint had autoResumeMs. Returns {resumed:true, action}.",
    args: {
      type: "object",
      properties: {
        action: { type: "string", description: "resume | stepOver | stepInto | stepOut (default resume)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },


  // --- files, downloads, print (v2.6)

  {
    name: "set_file_input",
    description: "Set local file path(s) on an <input type=file> via DOM.setFileInputFiles — no OS file picker is opened; the page's change/input events fire normally. Paths are absolute paths on the user's machine. Returns {set:true, files}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the file input (default 'input[type=file]')" },
        files: { type: "array", items: { type: "string" }, description: "Absolute file paths to assign" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["files"]
    }
  },
  {
    name: "download_configure",
    description: "Opt the tab into auto-accepted downloads: Page.setDownloadBehavior 'allow' (browser default dir) or 'allowAndName' with a directory. Call before clicking download links — then watch progress with downloads_list. Returns {configured:true, directory}.",
    args: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Absolute directory for downloads; omit for the browser default" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "downloads_list",
    description: "List downloads observed since download_configure was called: {guid,url,suggestedFilename,state,receivedBytes,totalBytes,ts}. Returns {downloads:[...]}.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "print_pdf",
    description: "Render the page to PDF via Page.printToPDF. Returns {base64, mimeType:'application/pdf'} — write it to a file yourself. Optional landscape/scale/printBackground.",
    args: {
      type: "object",
      properties: {
        landscape: { type: "boolean" },
        scale: { type: "number", description: "0.1–2.0" },
        printBackground: { type: "boolean" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },

  // --- OOPIF frame tools (v2.6): reach inside cross-origin iframes (payment
  // widgets, chat embeds, editors). `frame` is a sessionId or url substring
  // from frames_list. Same-origin iframes are already reachable via normal
  // selectors/eval_js — these are for OOPIFs.

  {
    name: "frames_list",
    description: "List cross-origin iframe sessions on the tab (flattened CDP auto-attach). Returns {frames:[{sessionId,targetId,url}]} — pass sessionId or a url substring as `frame` to the other frame_* tools.",
    args: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "frame_eval",
    description: "Runtime.evaluate inside a cross-origin iframe's own context — reads its DOM, globals, form values. Returns {value}.",
    args: {
      type: "object",
      properties: {
        frame: { type: "string", description: "sessionId or url substring from frames_list" },
        expression: { type: "string", description: "JS expression evaluated inside the iframe" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["frame", "expression"]
    }
  },
  {
    name: "frame_dom_inspect",
    description: "dom_inspect inside a cross-origin iframe: {selector, all?, styles?, max?} — same shape as dom_inspect, scoped to the frame's document.",
    args: {
      type: "object",
      properties: {
        frame: { type: "string", description: "sessionId or url substring from frames_list" },
        selector: { type: "string", description: "CSS selector inside the iframe" },
        all: { type: "boolean", description: "All matches (default true)" },
        styles: { type: "array", items: { type: "string" }, description: "Computed-style properties to read" },
        max: { type: "number", description: "Max elements (default 25)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["frame", "selector"]
    }
  },
  {
    name: "frame_click_element",
    description: "Click an element inside a cross-origin iframe: resolves the element's frame-local rect, offsets by the iframe's box in the top document, and sends trusted viewport-space input. dx/dy/button/clickCount as in click_element.",
    args: {
      type: "object",
      properties: {
        frame: { type: "string", description: "sessionId or url substring from frames_list" },
        selector: { type: "string", description: "CSS selector inside the iframe" },
        dx: { type: "number" },
        dy: { type: "number" },
        button: { type: "string", description: "left | right | middle (default left)" },
        clickCount: { type: "number", description: "1 single, 2 double, 3 triple" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["frame", "selector"]
    }
  },
  {
    // viewport_emulate (v2.7): Emulation.setDeviceMetricsOverride swaps the
    // tab's layout viewport without resizing the window — responsive
    // breakpoints and mobile layouts become testable. clear restores it.
    name: "viewport_emulate",
    description: "Override the tab's layout viewport: {width, height, mobile?, deviceScaleFactor?} emulates a device screen (mobile:true also enables touch); {clear:true} restores the real window viewport. Returns {emulated, width?, height?, mobile?} or {cleared:true}.",
    args: {
      type: "object",
      properties: {
        width: { type: "number", description: "Viewport width in CSS px (required unless clear)" },
        height: { type: "number", description: "Viewport height in CSS px (required unless clear)" },
        mobile: { type: "boolean", description: "Emulate a mobile viewport and enable touch (default false)" },
        deviceScaleFactor: { type: "number", description: "Device pixel ratio override (default 1)" },
        clear: { type: "boolean", description: "Clear the override and restore the real viewport" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      }
    }
  },
  {
    // page_snapshot (v2.7): one evaluate maps the visible interactive layer —
    // {node, tag, role, name, text, x, y, w, h}[] — the "clickable map" an
    // agent needs without probing dom_inspect. Each element is stamped
    // data-ab-node, so click_element {nodeId} addresses it directly.
    name: "page_snapshot",
    description: "Snapshot the page's visible interactive elements (links, buttons, inputs, [role], [onclick], [tabindex]): returns {url, count, nodes:[{node, tag, role, name, text, x, y, w, h}]}. node is a data-ab-node stamp on the element — pass it as click_element's nodeId to click without a selector. frame scopes into a cross-origin iframe.",
    args: {
      type: "object",
      properties: {
        max: { type: "number", description: "Max elements returned (default 300, cap 1000)" },
        maxChars: { type: "number", description: "Max chars per element's text (default 80, cap 500)" },
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; snapshots inside that frame (v2.7)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },

  // --- composite wrappers (v2.2): one call replaces several, so the model
  // spends fewer tokens on tool envelopes and the user sees fewer chips.

  {
    name: "fill",
    description: "Focus an input and type text in one call: click_element + type_text fused. submit:true also presses Enter after typing. Returns {filled:true, typed, submitted}.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the field to fill" },
        text: { type: "string", description: "Text to type into the field" },
        submit: { type: "boolean", description: "Press Enter after typing (default false)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["selector", "text"]
    }
  },
  {
    name: "wait_for",
    description: "Wait until a CSS selector exists or text appears on the page — instead of polling read_page/screenshot (token-heavy). Returns {found, waited}. Times out gracefully: check found rather than treating timeout as an error.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        text: { type: "string", description: "Text to wait for (page innerText match)" },
        timeoutMs: { type: "number", description: "Max wait in ms (default 10000, cap 60000)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: []
    }
  },
  {
    name: "read_elements",
    description: "Read only the elements matching a selector — a compact alternative to read_page when you already know what you need. Returns {count, elements:[{text, value?}]} with value from attr when attr is passed.",
    args: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the elements to read" },
        frame: { type: "string", description: "Cross-origin iframe: sessionId or url substring from frames_list; scopes this call into that frame (v2.7)" },
        attr: { type: "string", description: "Optional attribute to include as value (e.g. 'href', 'value')" },
        max: { type: "number", description: "Max elements to return (default 50, cap 200)" },
        maxChars: { type: "number", description: "Max chars per element's text (default 300, cap 2000)" },
        tabId: { type: "number", description: "Target tab id; omit for the active tab" }
      },
      required: ["selector"]
    }
  },
  {
    name: "batch",
    description: "Run several tool calls in one request, sequentially: steps is an array of {tool, args}. Stops at the first failing step unless stopOnError:false. Nesting batch inside batch is rejected. Returns {results:[{step, ok, result|error}], completed, total}.",
    args: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Sequential calls: [{tool: '<tool name>', args: {...}}]",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              args: { type: "object" }
            },
            required: ["tool"]
          }
        },
        stopOnError: { type: "boolean", description: "Stop after the first failed step (default true)" },
        tabId: { type: "number", description: "Default tab id for steps that omit one" }
      },
      required: ["steps"]
    }
  }
];

// `label` (v2.2): an optional, agent-chosen display name for a call — the
// side panel shows it on the chip instead of the raw tool name, so the user
// reads "搜索订单接口" rather than "eval_js {...}". Injected on every tool.
const LABEL_ARG = {
  label: {
    type: "string",
    description:
      "Optional short name for this call, shown to the user in the side panel (e.g. 'search issues for flaky login'). Keep it under ~8 words.",
  },
};

for (const t of TOOLS) {
  t.args = t.args || { type: "object", properties: {}, required: [] };
  t.args.properties = Object.assign({}, LABEL_ARG, t.args.properties);
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);
