// Plugin registry (PROTOCOL v2.17): feature packs that inject prompt
// fragments and gate tool visibility without touching hub code. A plugin is a
// directory with a plugin.json — built-ins ship under server/plugins/, user
// plugins live in ~/.agentchat/plugins/ and override a built-in of the same id.
//
// plugin.json:
//   { "id": "translate", "name": "Translation assistant",
//     "version": "1.0.0", "description": "...",
//     "prompt": "<system-prompt fragment injected when enabled>",
//     "exposeTools": ["page_translate", ...],   // tool names hidden when off
//     "extraTools": [ <tool schema>, ... ],     // new tools added when on
//     "enabled": true }                          // default; config.plugins wins
//
// Enabled state persists in config.json under `plugins: {<id>: {enabled}}`.

import { readdirSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { TOOLS } from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, "..", "plugins");

// Resolved per call: os.homedir() reflects the process env at call time and
// AGENTCHAT_PLUGINS_DIR lets a test (or a second hub instance) point the user
// plugin dir elsewhere.
function userDir() {
  return process.env.AGENTCHAT_PLUGINS_DIR || path.join(os.homedir(), ".agentchat", "plugins");
}

const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

let logWarn = console.error;
export function wirePlugins({ warn } = {}) {
  if (typeof warn === "function") logWarn = warn;
}

function scanDir(dir, out, builtin) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logWarn(`[plugins] cannot read ${dir}:`, err.message);
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(dir, e.name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      const id = String(m.id || e.name);
      out.set(id, {
        id,
        name: String(m.name || id),
        version: String(m.version || "0.0.0"),
        description: String(m.description || ""),
        prompt: String(m.prompt || ""),
        exposeTools: Array.isArray(m.exposeTools) ? m.exposeTools.map(String) : [],
        extraTools: Array.isArray(m.extraTools) ? m.extraTools : [],
        enabled: m.enabled !== false, // manifest default: on
        builtin,
        dir: path.join(dir, e.name),
      });
    } catch (err) {
      logWarn(`[plugins] bad manifest ${manifestPath}:`, err.message);
    }
  }
}

// Fresh scan every call — plugin dirs are tiny and edits should take effect
// without a hub restart (createPluginRegistry caches per call site).
export function listPlugins() {
  const out = new Map();
  scanDir(BUILTIN_DIR, out, true);
  scanDir(userDir(), out, false); // user copy wins on id collision
  return [...out.values()];
}

export function isEnabled(plugin, config) {
  const cfg = config && config.plugins && config.plugins[plugin.id];
  if (cfg && typeof cfg.enabled === "boolean") return cfg.enabled;
  return plugin.enabled;
}

// Public view for capabilities / admin surfaces.
export function describePlugins(config) {
  return listPlugins().map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    enabled: isEnabled(p, config),
    builtin: p.builtin,
    tools: [...p.exposeTools, ...p.extraTools.map((t) => t && t.name).filter(Boolean)],
  }));
}

// Prompt fragments of every enabled plugin, joined for injection after the
// adapter's systemPromptExtra.
export function pluginPrompt(config) {
  return listPlugins()
    .filter((p) => isEnabled(p, config) && p.prompt.trim())
    .map((p) => `## Plugin: ${p.name}\n\n${p.prompt.trim()}`)
    .join("\n\n");
}

// Tool names a disabled plugin hides (only ones it actually exposes —
// unknown names in a manifest warn once and are skipped).
export function hiddenToolNames(config) {
  const hidden = new Set();
  for (const p of listPlugins()) {
    if (isEnabled(p, config)) continue;
    for (const name of p.exposeTools) {
      if (!KNOWN_TOOL_NAMES.has(name)) {
        logWarn(`[plugins] ${p.id} exposes unknown tool "${name}" — skipped`);
        continue;
      }
      hidden.add(name);
    }
  }
  return hidden;
}

// The tools adapters should see: core table minus disabled-plugin tools,
// plus enabled plugins' extraTools.
export function effectiveTools(config) {
  const hidden = hiddenToolNames(config);
  const extra = [];
  for (const p of listPlugins()) {
    if (!isEnabled(p, config)) continue;
    for (const t of p.extraTools) {
      if (t && typeof t === "object" && t.name) extra.push(t);
    }
  }
  return [...TOOLS.filter((t) => !hidden.has(t.name)), ...extra];
}

// Is this tool currently visible to agents? The hub-answered tools check it
// before intercepting so a disabled plugin's tools stop working everywhere.
export function toolVisible(name, config) {
  return !hiddenToolNames(config).has(String(name));
}
