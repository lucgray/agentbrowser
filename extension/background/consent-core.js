// Pure policy helpers for the consent gate (PROTOCOL v1.7). No chrome.* or
// DOM access here so node --test can cover the decision logic; the side-effect
// parts (page card, notifications, describe evaluation) live in consent.js.
//
// Policy shape (all fields optional; an absent `permissions` object means the
// gate is off entirely):
//   {
//     allowAll: true,                      // explicit opt-out: trust the agent
//     requireConsent: [...tool names...]   // default: WRITE_TOOLS
//     trustedDomains:  ["localhost", ...]  // never ask on these hosts
//     sensitiveDomains: ["bank.com", ...]  // always ask; session memory ignored
//   }
// Domain lists match a hostname exactly or at a dot boundary
// ("example.com" matches "app.example.com", not "notexample.com").

// Tools that change page state, input, or visuals. Reads and purely
// informational tools never gate.
export const WRITE_TOOLS = [
  'click', 'click_element', 'type_text', 'press_key', 'navigate',
  'eval_js', 'patch_apply', 'fill',
  'annotate', 'annotate_batch', 'annotate_reply', 'annotate_clear',
  // `batch` is intentionally absent: it gates every inner step under that
  // step's own tool name instead, so nothing double-asks.
];

// "Allow on this domain for this session" grants live for the service
// worker's lifetime. Keyed by origin+tool so a click grant does not cover
// eval_js.
const sessionAllows = new Set();

export function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    return new URL(String(url || '')).origin;
  } catch {
    return '';
  }
}

export function domainMatches(host, patterns) {
  const h = String(host || '').toLowerCase();
  if (!h || !Array.isArray(patterns)) return false;
  return patterns.some((raw) => {
    const d = String(raw || '').toLowerCase().trim();
    return d !== '' && (h === d || h.endsWith('.' + d));
  });
}

export function requiredTools(policy) {
  return Array.isArray(policy && policy.requireConsent)
    ? policy.requireConsent.map(String)
    : WRITE_TOOLS;
}

// Fast pre-check: does this tool fall under the gate at all? False skips the
// tab lookup entirely. `allowAll: true` is the explicit "trust the agent"
// switch — it turns the whole gate off while keeping the block present.
export function shouldCheck(tool, policy) {
  if (!policy || typeof policy !== 'object' || policy.allowAll === true) {
    return false;
  }
  return requiredTools(policy).includes(tool);
}

// Pure decision, unit-testable: is this call on this tab subject to a user
// prompt? False means "execute immediately".
export function needsConsent(tool, tabUrl, policy) {
  if (!shouldCheck(tool, policy)) return false;
  const host = hostOf(tabUrl);
  if (!host) return false; // no card surface and no domain to attribute
  if (domainMatches(host, policy.sensitiveDomains)) {
    return true; // always ask; memory and trusted lists skipped
  }
  if (domainMatches(host, policy.trustedDomains)) return false;
  if (sessionAllows.has(`${originOf(tabUrl)}|${tool}`)) return false;
  return true;
}

export function rememberSessionAllow(origin, tool) {
  sessionAllows.add(`${origin}|${tool}`);
}

// Grants are persisted to chrome.storage.session by consent.js so they
// survive service-worker suspension; hydrate restores them on wakeup.
export function hydrateSessionAllows(entries) {
  for (const e of entries || []) sessionAllows.add(String(e));
}

export function sessionAllowsKeys() {
  return [...sessionAllows];
}

// Test hook: a fresh worker must not inherit earlier grants.
export function resetSessionAllows() {
  sessionAllows.clear();
}

// One-line human summary for the card and notification. Element labels are
// appended by consent.js's describeTarget when a page evaluation can name the
// target; this function is the pure-args fallback.
export function summarizeArgs(tool, a = {}) {
  // An agent-chosen label names the call in the user's words (v2.2); show it
  // ahead of the args summary so the card reads as an action, not a payload.
  const base = summarize(tool, a);
  return typeof a.label === 'string' && a.label ? `${a.label} — ${base}` : base;
}

function summarize(tool, a) {
  switch (tool) {
    case 'click':
      return `click at (${Math.round(a.x || 0)}, ${Math.round(a.y || 0)})`;
    case 'click_element':
      return `click '${String(a.selector || '')}'`;
    case 'type_text':
      return `type "${clip(a.text)}"` + (a.selector ? ` into '${a.selector}'` : '');
    case 'navigate':
      return `navigate → ${String(a.url || '')}`;
    case 'press_key':
      return `press ${String(a.key || '?')}`;
    case 'eval_js':
      return `run JavaScript (${String(a.expression || '').length} chars)`;
    case 'patch_apply':
      return `live-patch ${Array.isArray(a.patches) ? a.patches.length : 0} node(s)`;
    case 'fill':
      return `fill '${String(a.selector || '')}' with "${clip(a.text)}"`;
    case 'batch':
      return `run ${Array.isArray(a.steps) ? a.steps.length : 0} step(s)`;
    case 'annotate':
      return `annotate (${String(a.style || 'underline')}) "${clip(a.quote)}"`;
    case 'annotate_batch':
      return `annotate ${Array.isArray(a.annotations) ? a.annotations.length : 0} passage(s)`;
    case 'annotate_reply':
      return `reply on annotation ${String(a.id || '?')}`;
    case 'annotate_clear':
      return a.id ? `remove annotation ${a.id}` : 'remove all annotations';
    default:
      return tool;
  }
}

function clip(s, n = 60) {
  const v = String(s || '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}
