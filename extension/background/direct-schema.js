// Tool schemas for hubless direct mode. A curated subset of the hub's full
// tool table (server/hub/tools.mjs) — the names/args must stay in sync with
// the executors in sw.js's TOOLS map, since those are what actually run.

const TABID = { type: 'integer', description: 'Tab to act on; omit for the current tab' };
const LABEL = {
  type: 'string',
  description: 'Short user-facing action name, in the user\'s language (e.g. "fill the login form")',
};

export const DIRECT_TOOLS = [
  {
    name: 'tabs_list',
    description: 'List open tabs: tabId, url, title, active.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tab_new',
    description: 'Open a new tab.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tab_close',
    description: 'Close a tab.',
    input_schema: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for load.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description: 'Extract the page\'s readable text (title, headings, main content).',
    input_schema: {
      type: 'object',
      properties: { tabId: TABID, maxChars: { type: 'integer' }, label: LABEL },
      additionalProperties: false,
    },
  },
  {
    name: 'page_snapshot',
    description:
      'Compact map of interactive elements with stable nodeIds — feed {"nodeId":"n12"} straight to click_element.',
    input_schema: {
      type: 'object',
      properties: { tabId: TABID, selector: { type: 'string' }, label: LABEL },
      additionalProperties: false,
    },
  },
  {
    name: 'dom_inspect',
    description: 'Structured read of elements matching a CSS selector: attrs, text, box, styles.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the tab viewport as an image.',
    input_schema: {
      type: 'object',
      properties: { tabId: TABID, label: LABEL },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click at viewport coordinates.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, tabId: TABID, label: LABEL },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'click_element',
    description: 'Click an element by CSS selector or a page_snapshot nodeId.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        nodeId: { type: 'string' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        tabId: TABID,
        label: LABEL,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hover',
    description: 'Hover at coordinates or over a selector.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, tabId: TABID, label: LABEL },
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page (dy>0 down, dx>0 right).',
    input_schema: {
      type: 'object',
      properties: { dx: { type: 'number' }, dy: { type: 'number' }, selector: { type: 'string' }, tabId: TABID, label: LABEL },
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Type text — into the focused element, or the one matching selector first.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, selector: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key (Enter, Tab, Escape, ArrowDown, …).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'eval_js',
    description: 'Evaluate a JavaScript expression in the page and return the result.',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Fill an input (focus + clear + type), optionally submit.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
        tabId: TABID,
        label: LABEL,
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until a selector exists / is visible, or text appears.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'integer' },
        tabId: TABID,
        label: LABEL,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_elements',
    description: 'Extract a list of elements under a selector scope (text + key attrs).',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, tabId: TABID, label: LABEL },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'batch',
    description:
      'Run sequential tool calls in one shot: {"steps":[{"tool":"click_element","args":{...}},...]}. Stops on first failure unless stopOnError:false.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' } },
            required: ['tool'],
          },
        },
        stopOnError: { type: 'boolean' },
        tabId: TABID,
        label: LABEL,
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
];
