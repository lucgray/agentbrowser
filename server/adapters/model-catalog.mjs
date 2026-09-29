// Live model catalog: real model lists per adapter, probed from the machine.
//
// Sources, best first (all best-effort; a probe that fails yields nothing —
// never a made-up list):
//   codex    ~/.codex/config.toml  → `model = "..."` plus the
//            [tui.model_availability_nux] keys the TUI has actually seen
//   opencode `opencode models`     → one "provider/model" per line
//   gemini   ~/.gemini/settings.json → model-ish keys
//   grok     ~/.grok/settings.json → model-ish keys
//   copilot  ~/.copilot/settings.json → model-ish keys
//   claude   ~/.claude/settings.json → model-ish keys (hub merges its real
//            CLAUDE_MODELS on top)
//
// Results cache to ~/.agentchat/model-catalog.json (TTL 6h) so panel opens
// stay instant; probes refresh in the background on hub start. config.json
// `adapterModels` keeps priority over everything (hub.mjs applies it first).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBin } from "./generic-cli.mjs";

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

function logWarn(context, err) {
  console.error("[model-catalog]", context + ":", (err && err.message) || err);
}

function home() {
  return os.homedir();
}

function cacheFile() {
  return path.join(home(), ".agentchat", "model-catalog.json");
}

function readCache() {
  const file = cacheFile();
  // existsSync probes instead of a throwing readFileSync: a miss is control
  // flow, not an error worth logging.
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.models) return parsed;
  } catch (err) {
    logWarn("cache read failed", err);
  }
  return null;
}

function writeCache(models) {
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true, mode: 0o700 });
    writeFileSync(
      cacheFile(),
      JSON.stringify({ probedAt: Date.now(), models }, null, 2),
      { mode: 0o600 }
    );
  } catch (err) {
    logWarn("cache write failed", err);
  }
}

function readJsonIfPresent(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    logWarn(`cannot parse ${file}`, err);
    return null;
  }
}

function readTextIfPresent(file) {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    logWarn(`cannot read ${file}`, err);
    return null;
  }
}

// First string model-ish key found on an object, checked shallow then one
// level deep over the known per-CLI settings shapes. Nothing invented: only
// keys actually present on disk are returned.
function modelFromSettings(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of keys) {
    const nested = obj[key];
    if (nested && typeof nested === "object") {
      const found = modelFromSettings(nested, keys);
      if (found) return found;
    }
  }
  return null;
}

function toModelList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const id = value.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

// Real Codex models, best source first:
//   1. the model_catalog_json file codex itself points at
//      (default ~/.codex/opencodex-catalog.json) — {models:[{slug,
//      display_name, visibility, priority}...]}; keep the ones the TUI lists
//      (visibility "list"), highest priority first;
//   2. the [tui.model_availability_nux] keys in config.toml — models the TUI
//      has actually offered on this machine;
//   3. the configured `model = "..."`.
function probeCodexConfig() {
  const configPath = path.join(home(), ".codex", "config.toml");
  const text = readTextIfPresent(configPath);
  if (!text) return [];
  const found = [];
  const topLevel = text.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  // Best source: the model_catalog_json file codex itself points at (default
  // ~/.codex/opencodex-catalog.json) — {models:[{slug, display_name,
  // visibility, priority}]}; keep what the TUI lists (visibility "list"),
  // highest priority first.
  const catalogPathMatch = text.match(
    /^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m
  );
  const catalogPaths = [];
  if (catalogPathMatch) catalogPaths.push(catalogPathMatch[1]);
  catalogPaths.push(path.join(home(), ".codex", "opencodex-catalog.json"));
  for (const catalogPath of catalogPaths) {
    const catalog = readJsonIfPresent(catalogPath);
    if (!catalog || !Array.isArray(catalog.models)) continue;
    const listed = catalog.models
      .filter((m) => m && m.slug && (!m.visibility || m.visibility === "list"))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .map((m) => ({ id: String(m.slug), label: String(m.display_name || m.slug) }));
    if (listed.length) {
      // The configured model stays selectable even if the catalog omits it.
      if (topLevel && !listed.some((m) => m.id === topLevel[1])) {
        listed.unshift({ id: topLevel[1], label: topLevel[1] });
      }
      return listed;
    }
  }
  // Fallback: the [tui.model_availability_nux] keys the TUI has actually
  // offered on this machine, then the configured model.
  const section = text.match(
    /\[tui\.model_availability_nux\]([\s\S]*?)(?:\n\[|$)/
  );
  if (section) {
    for (const m of section[1].matchAll(/^\s*"([^"]+)"\s*=/gm)) found.push(m[1]);
  }
  if (topLevel) found.push(topLevel[1]);
  return toModelList(found);
}

async function runCommand(bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
  const binPath = resolveBin(bin);
  const cliShell =
    process.platform === "win32" &&
    (binPath === bin || /\.(cmd|bat)$/i.test(binPath));
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    try {
      child = spawn(binPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: cliShell
      });
    } catch (err) {
      logWarn(`spawn ${bin} failed`, err);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

// `opencode models` prints one "provider/model" per line — the CLI's own
// catalog, real by construction.
async function probeOpencode() {
  const stdout = await runCommand("opencode", ["models"]);
  if (!stdout) return [];
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("/"));
  return toModelList(ids).map((m) => ({
    id: m.id,
    label: m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id
  }));
}

const SETTINGS_MODEL_KEYS = ["model", "defaultModel", "default_model", "selectedModel"];

function probeSettingsModel(dirs, files) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const file of files) {
      const parsed = readJsonIfPresent(path.join(dir, file));
      const model = modelFromSettings(parsed, SETTINGS_MODEL_KEYS);
      if (model) return [model];
    }
  }
  return [];
}

// ~/.grok/config.toml defines the models the Grok TUI actually offers as
// [model.<key>] tables (model = "...", name = "OCX ..."); [ui]
// fork_secondary_model is a real model reference too.
function probeGrokConfig() {
  const text = readTextIfPresent(path.join(home(), ".grok", "config.toml"));
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (id, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label || id });
  };
  const sections = text.match(/^\[model\.[A-Za-z0-9_.-]+\][^\[]*/gm) || [];
  for (const section of sections) {
    const model = section.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (!model) continue;
    const name = section.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    push(model[1], name ? name[1] : model[1]);
  }
  const fork = text.match(/^\s*fork_secondary_model\s*=\s*["']([^"']+)["']/m);
  if (fork) push(fork[1], fork[1]);
  return out;
}

// `devin models list` prints family headers ("SWE-2 (swe-2)"), alias lines,
// and 2-space-indented model rows: "<id>  <Label>  [<pricing/context>]".
function probeDevinModels() {
  return runCommand("devin", ["models", "list"]).then((stdout) => {
    if (!stdout) return [];
    const out = [];
    const seen = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!/^\s/.test(line)) continue; // family headers are not indented
      const trimmed = line.trim();
      if (/^aliases:/i.test(trimmed)) continue;
      const m = trimmed.match(/^([a-z0-9][a-z0-9._-]*)\s\s+(.+)$/i);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      // Label is the human name before the [pricing/context] bracket.
      const label = m[2].replace(/\s*\[[^\]]*\]\s*$/, "").trim() || id;
      out.push({ id, label });
    }
    return out;
  });
}

const PROBES = {
  codex: () => probeCodexConfig(),
  opencode: () => probeOpencode(),
  devin: () => probeDevinModels(),
  // Same binary, same catalog — the lookup is keyed by adapter name.
  'acp-devin': () => probeDevinModels(),
  grok: () => probeGrokConfig(),
  gemini: () =>
    toModelList(
      probeSettingsModel([path.join(home(), ".gemini")], ["settings.json"])
    ),
  copilot: () =>
    toModelList(
      probeSettingsModel([path.join(home(), ".copilot")], [
        "settings.json",
        "config.json"
      ])
    ),
  claude: () =>
    toModelList(
      probeSettingsModel([path.join(home(), ".claude")], ["settings.json"])
    )
};

export async function loadCatalog({ force = false } = {}) {
  if (!force) {
    const cache = readCache();
    if (cache && Date.now() - cache.probedAt < CATALOG_TTL_MS) {
      return cache.models;
    }
  }
  const names = Object.keys(PROBES);
  const settled = await Promise.allSettled(names.map((n) => PROBES[n]()));
  const models = {};
  for (let i = 0; i < names.length; i++) {
    const result = settled[i];
    models[names[i]] = result.status === "fulfilled" ? result.value : [];
  }
  // A stale cache beats an empty probe (flaky shell, machine asleep): keep
  // whatever the last successful run found for families that came back empty.
  const cache = readCache();
  if (cache && cache.models) {
    for (const name of names) {
      if ((!models[name] || models[name].length === 0) && Array.isArray(cache.models[name])) {
        models[name] = cache.models[name];
      }
    }
  }
  writeCache(models);
  return models;
}
