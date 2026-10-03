// Pure helpers for the page translation pipeline (PROTOCOL v2.14). No DOM or
// chrome.* access so node --test can cover the logic; the page engine is
// injected with these functions prepended (`export ` stripped by the loader).

// Elements whose text is never a translation unit. Covers code surfaces,
// interactive widgets, and embedded media; `rb/rt` stay so ruby annotations
// translate with their host paragraph.
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH',
  'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA',
  'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'IFRAME',
  'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'OBJECT', 'EMBED',
  'AB-TRANS', 'AB-TRANS-UI',
]);

// Elements that always carry their own block box regardless of computed
// display — needed because jsdom-free tests and cheap probes can not afford a
// getComputedStyle per element.
export const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT',
  'TR', 'TD', 'TH', 'DL', 'DT', 'DD', 'FORM', 'FIELDSET', 'HR',
]);

const LETTER_RE = /\p{L}/u;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

// A paragraph unit: an element with at least one direct text child that
// contains a letter and is not entirely whitespace. childNodes is a DOM
// NodeList or a test double [{nodeType, nodeValue}].
export function hasProseChild(childNodes) {
  for (const n of childNodes || []) {
    if (n && n.nodeType === 3 && LETTER_RE.test(String(n.nodeValue || ''))) {
      return true;
    }
  }
  return false;
}

// Cheap script-ratio language heuristic — deliberately crude: it only needs
// to answer "is this already in the target language, so a request would be a
// wasted round trip". Ambiguous paragraphs are translated anyway.
export function looksLikeTargetLang(text, targetLang) {
  const t = String(text || '');
  if (!LETTER_RE.test(t)) return true; // numbers/punctuation only: skip
  const lang = String(targetLang || '').toLowerCase();
  let cjk = 0, latin = 0;
  for (const ch of t) {
    if (CJK_RE.test(ch)) cjk += 1;
    else if (/[a-zA-ZÀ-ɏ]/.test(ch)) latin += 1;
  }
  const total = cjk + latin;
  if (total === 0) return true;
  if (lang.startsWith('zh') || lang === 'ja' || lang === 'ko') {
    return cjk / total > 0.5;
  }
  return latin / total > 0.85;
}

// Whitespace-collapse + length cap before a text enters a request hash.
export function normalizeText(text, maxChars = 6000) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

// "no translation needed" sentinel a provider may return for already-target-
// language text; translated to an empty string so the caller renders nothing.
export const NO_TRANSLATION_SENTINEL = '{{NO_TRANSLATION_NEEDED}}';

export function isNoTranslation(text) {
  return String(text || '').trim() === NO_TRANSLATION_SENTINEL;
}

export const TRANSLATE_MODES = ['bilingual', 'card', 'dim', 'replace', 'ondemand'];

const DEFAULTS = {
  mode: 'bilingual',
  targetLang: 'zh',
  wordHover: false,
  minChars: 2,
  maxItemsPerBatch: 4,
  maxCharsPerBatch: 1200,
  batchFlushMs: 250,
  viewportMargin: '600px',
};

// Merge user config over defaults with validation — every entry point (agent
// tool call, panel toggle, context menu) funnels through the same normalizer.
export function resolveEngineConfig(cfg) {
  const c = { ...DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (!TRANSLATE_MODES.includes(c.mode)) c.mode = DEFAULTS.mode;
  c.targetLang = String(c.targetLang || DEFAULTS.targetLang);
  c.minChars = Math.max(1, Number(c.minChars) || DEFAULTS.minChars);
  c.maxItemsPerBatch = Math.max(1, Number(c.maxItemsPerBatch) || DEFAULTS.maxItemsPerBatch);
  c.maxCharsPerBatch = Math.max(200, Number(c.maxCharsPerBatch) || DEFAULTS.maxCharsPerBatch);
  c.batchFlushMs = Math.max(50, Number(c.batchFlushMs) || DEFAULTS.batchFlushMs);
  c.wordHover = c.wordHover === true;
  return c;
}
