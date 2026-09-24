// API key storage for the native API adapters (PROTOCOL.md v1.2 "Keys").
//
// Keys live in ~/.agentchat/keys.json as {"anthropic":"...","openai":"..."}.
// Directory mode 0700, file mode 0600, enforced with an explicit chmod after
// create (mkdir/writeFile modes are masked by umask and do not tighten an
// existing path).
//
// Nothing here ever logs, returns or throws key material: getKey returns the
// string to its caller, every other path returns booleans or provider names.
// A missing file is not an error — it reads as "no keys configured".

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROVIDERS = ['anthropic', 'openai'];

const DIR = path.join(os.homedir(), '.agentchat');
const FILE = path.join(DIR, 'keys.json');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Error messages only — never the store's contents.
function logWarn(context, err) {
  console.error('[keystore]', context + ':', (err && err.message) || err);
}

function isProvider(provider) {
  return PROVIDERS.includes(provider);
}

// Reads the store. Never throws: a missing, unreadable or malformed file is
// an empty store. Values that are not non-empty strings are dropped.
export function readStore() {
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    logWarn('key file unreadable, treating as empty', err);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn('key file malformed, treating as empty', err);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const provider of PROVIDERS) {
    const value = parsed[provider];
    if (typeof value === 'string' && value.length > 0) out[provider] = value;
  }
  return out;
}

function ensureDir() {
  mkdirSync(DIR, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(DIR, DIR_MODE);
  } catch (err) {
    // best effort: a pre-existing dir we cannot chmod still works
    logWarn('dir chmod failed (continuing)', err);
  }
}

// Atomic write: temp file (chmod'd before it holds the key... it is created by
// writeFileSync with mode 0600, then chmod'd again in case umask interfered)
// then rename over the real path, which preserves the mode.
function writeStore(store) {
  ensureDir();
  const tmp = `${FILE}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE });
    try {
      chmodSync(tmp, FILE_MODE);
    } catch (err) {
      // best effort
      logWarn('tmp file chmod failed (continuing)', err);
    }
    renameSync(tmp, FILE);
    try {
      chmodSync(FILE, FILE_MODE);
    } catch (err) {
      // best effort
      logWarn('key file chmod failed (continuing)', err);
    }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch (cleanupErr) {
      logWarn('temp file cleanup failed', cleanupErr);
    }
    // Re-thrown with a generic message: the original may embed the path but
    // never the key, and we keep it that way.
    throw new Error(`could not write key store: ${err && err.code ? err.code : 'error'}`);
  }
}

// Returns the stored key string, or null.
export function getKey(provider) {
  if (!isProvider(provider)) return null;
  const store = readStore();
  return store[provider] || null;
}

// setKey(provider, key) stores it; setKey(provider, null) clears it.
// Returns true when the store changed shape (set or cleared), false when the
// provider is unknown.
export function setKey(provider, keyOrNull) {
  if (!isProvider(provider)) return false;
  const store = readStore();
  if (keyOrNull === null || keyOrNull === undefined || keyOrNull === '') {
    if (!(provider in store)) return true;
    delete store[provider];
    writeStore(store);
    return true;
  }
  if (typeof keyOrNull !== 'string') return false;
  store[provider] = keyOrNull.trim();
  writeStore(store);
  return true;
}

export function hasKey(provider) {
  return getKey(provider) !== null;
}

// {anthropic:<bool>, openai:<bool>} — safe to send to a client.
export function keyStatus() {
  const store = readStore();
  const out = {};
  for (const provider of PROVIDERS) out[provider] = Boolean(store[provider]);
  return out;
}

export const KEYS_PATH = FILE;
export const KEYS_DIR = DIR;
