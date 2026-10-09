// Installs the com.agentbrowser.hub native-messaging host so the extension
// can auto-start the hub when the browser launches. One host serves every
// browser on the machine — the hub dedupes itself via the port probe.
//
//   node server/native/install.mjs <extension-id> [--browser chrome|edge|brave|chromium]
//
// The extension id comes from chrome://extensions (Developer mode on).
// Without --browser we install into every supported browser found on this
// machine (on Windows: into the registry for all four).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEPER = path.join(HERE, "hub-keeper.mjs");
const HOST_NAME = "com.agentbrowser.hub";
const WIN_REG_PREFIX = "HKCU\\Software\\";

// Browser -> per-platform manifest directory (POSIX) / registry key (Windows).
export const BROWSERS = {
  chrome: {
    linux: [".config", "google-chrome", "NativeMessagingHosts"],
    darwin: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
    win32: "Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
  },
  edge: {
    linux: [".config", "microsoft-edge", "NativeMessagingHosts"],
    darwin: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"],
    win32: "Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME,
  },
  brave: {
    linux: [".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
    darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
    win32: "BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + HOST_NAME,
  },
  chromium: {
    linux: [".config", "chromium", "NativeMessagingHosts"],
    darwin: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"],
    win32: "Chromium\\NativeMessagingHosts\\" + HOST_NAME,
  },
};

export function manifestJson(extensionId, launcherPath) {
  return {
    name: HOST_NAME,
    description: "AgentBrowser hub keeper — starts the local hub on demand",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// The launcher wraps `node hub-keeper.mjs` with an absolute node path —
// native hosts are spawned by the browser, not a login shell, so PATH is
// unreliable. POSIX gets an executable shell script; Windows a .bat.
export function launcherSource(platform, nodeExec, keeperPath) {
  if (platform === "win32") {
    return `@echo off\r\n"${nodeExec}" "${keeperPath}"\r\n`;
  }
  return `#!/bin/sh\nexec "${nodeExec}" "${keeperPath}"\n`;
}

function writeLauncher(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === "win32" ? "run-host.bat" : "run-host");
  fs.writeFileSync(file, launcherSource(process.platform, process.execPath, KEEPER));
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

function destDirs(home, platform, browser) {
  const rel = BROWSERS[browser] && BROWSERS[browser][platform];
  return rel ? path.join(home, ...rel) : null;
}

function detectBrowsers(home, platform) {
  const found = [];
  for (const name of Object.keys(BROWSERS)) {
    if (platform === "win32") {
      found.push(name); // registry writes are harmless even if absent
      continue;
    }
    const dir = destDirs(home, platform, name);
    // Install when the browser's config parent exists, or always for chrome —
    // the config dir may not exist until first run.
    const parent = dir && path.dirname(dir);
    if (dir && (name === "chrome" || (parent && fs.existsSync(parent)))) found.push(name);
  }
  return found;
}

function installPosix(home, browser, launcher, manifest) {
  const dir = destDirs(home, process.platform, browser);
  if (!dir) {
    console.error(`[install] ${browser}: unsupported on ${process.platform}`);
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[install] ${browser}: ${file}`);
  return true;
}

function installWindows(browser, launcher, manifest) {
  const dir = path.join(os.homedir(), ".agentchat", "native");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  const key = WIN_REG_PREFIX + BROWSERS[browser].win32;
  const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], {
    stdio: "pipe",
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(`[install] ${browser}: reg add failed — ${r.stderr || r.stdout}`);
    return false;
  }
  console.log(`[install] ${browser}: ${key} -> ${file}`);
  return true;
}

function parseArgs(argv) {
  const browsers = [];
  let extensionId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--browser") {
      i++;
      if (!BROWSERS[argv[i]]) {
        console.error(`unknown browser "${argv[i]}" — choose from ${Object.keys(BROWSERS).join("|")}`);
        process.exit(2);
      }
      browsers.push(argv[i]);
    } else if (!extensionId) {
      extensionId = argv[i];
    }
  }
  return { extensionId, browsers };
}

function main() {
  const { extensionId, browsers } = parseArgs(process.argv.slice(2));
  if (!extensionId) {
    console.error("usage: node server/native/install.mjs <extension-id> [--browser chrome|edge|brave|chromium]");
    console.error("find the id at chrome://extensions with Developer mode on");
    process.exit(2);
  }
  const nativeDir = path.join(os.homedir(), ".agentchat", "native");
  const launcher = writeLauncher(nativeDir);
  const manifest = manifestJson(extensionId, launcher);
  const targets = browsers.length ? browsers : detectBrowsers(os.homedir(), process.platform);
  if (!targets.length) {
    console.error("[install] no supported browsers found — pass --browser explicitly");
    process.exit(1);
  }
  let ok = 0;
  for (const b of targets) {
    const done =
      process.platform === "win32"
        ? installWindows(b, launcher, manifest)
        : installPosix(os.homedir(), b, launcher, manifest);
    if (done) ok++;
  }
  console.log(`[install] launcher: ${launcher}`);
  console.log(`[install] ${ok}/${targets.length} browser(s) registered — restart the browser, the hub will come up on its own`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
