// Adapter interface + registry (PROTOCOL.md v1.2 "Adapter interface").
//
// registry: name -> factory(ctx) where
//   ctx = { callBrowserTool, config, model, getApiKey(provider), tools }
// callBrowserTool(tool, argsObject) -> Promise<result object>; throws Error on ok:false
// model      : requested model id, or null
// getApiKey  : (provider) -> stored key string or null
// tools      : the array from tools.mjs
//
// factory returns an adapter session object:
// {
//   send(text, emit) -> Promise<void>   // emit(event) with the chat_event kinds; done exactly once
//   abort() -> void                      // best-effort
//   dispose() -> void
// }
//
// createSession stays backward compatible: a caller that passes only
// {callBrowserTool, config} — what hub.mjs did before v1.2 — gets
// model/getApiKey/tools filled in here, so no adapter has to defend itself.

import * as claudeAgentSdk from './claude-agent-sdk.mjs';
import * as claudeCli from './claude-cli.mjs';
import * as genericCli from './generic-cli.mjs';
import * as apiAnthropic from './api-anthropic.mjs';
import * as apiOpenAi from './api-openai.mjs';

import { TOOLS } from '../hub/tools.mjs';
import { getKey, hasKey } from './keystore.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONFIG = (() => {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(dir, '..', 'hub', 'config.json'), 'utf8'));
  } catch (err) {
    console.error('[base]', 'config.json unreadable, using defaults:', (err && err.message) || err);
    return {};
  }
})();

const { GENERIC_CLI_NAMES, createGenericCliSession } = genericCli;

const registry = {
  'claude-agent-sdk': claudeAgentSdk.createClaudeAgentSdkSession,
  'claude-cli': claudeCli.createClaudeCliSession,
  'anthropic-api': apiAnthropic.createAnthropicApiSession,
  'openai-api': apiOpenAi.createOpenAiApiSession
};

// Per-turn spawn adapters (codex, opencode, copilot, grok, agy, gemini,
// devin), all driven by the preset table in generic-cli.mjs.
for (const name of GENERIC_CLI_NAMES) {
  registry[name] = (ctx) => createGenericCliSession(name, ctx);
}

export const ADAPTERS = Object.keys(registry);

// The four Claude ids the Claude-backed adapters can switch between.
const CLAUDE_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
];

// Descriptors for the adapter modules this file does not own (they have no
// DESCRIPTOR export yet). `models: []` on the seven generic-CLI adapters is
// deliberate: none of the presets in generic-cli.mjs passes a --model/-m flag
// today, and PROTOCOL v1.2 allows an empty list for adapters with no model
// switch. Fill these in when that plumbing lands.
const FALLBACK_DESCRIPTORS = {
  'claude-agent-sdk': {
    label: 'Claude Agent SDK',
    models: CLAUDE_MODELS,
    defaultModel: 'claude-opus-5',
    provider: null
  },
  'claude-cli': {
    label: 'Claude Code CLI',
    models: CLAUDE_MODELS,
    defaultModel: 'claude-opus-5',
    provider: null
  },
  codex: { label: 'Codex CLI', models: [], defaultModel: null, provider: null },
  opencode: { label: 'opencode', models: [], defaultModel: null, provider: null },
  copilot: { label: 'GitHub Copilot CLI', models: [], defaultModel: null, provider: null },
  grok: { label: 'Grok CLI', models: [], defaultModel: null, provider: null },
  agy: { label: 'Antigravity CLI', models: [], defaultModel: null, provider: null },
  gemini: { label: 'Gemini CLI', models: [], defaultModel: null, provider: null },
  devin: { label: 'Devin CLI', models: [], defaultModel: null, provider: null }
};

const modules = {
  'claude-agent-sdk': claudeAgentSdk,
  'claude-cli': claudeCli,
  'anthropic-api': apiAnthropic,
  'openai-api': apiOpenAi
};
for (const name of GENERIC_CLI_NAMES) modules[name] = genericCli;

function descriptorFor(name) {
  const mod = modules[name];
  // generic-cli.mjs backs seven adapters from one module, so a DESCRIPTOR there
  // could not be per-adapter — those always use the fallback table.
  const exported = mod && !GENERIC_CLI_NAMES.includes(name) ? mod.DESCRIPTOR : null;
  const descriptor = exported || FALLBACK_DESCRIPTORS[name] || {};
  return {
    label: descriptor.label || name,
    models: Array.isArray(descriptor.models) ? descriptor.models : [],
    defaultModel: descriptor.defaultModel || null,
    provider: descriptor.provider || null
  };
}

// name -> {label, models, defaultModel, provider}
export const DESCRIPTORS = Object.fromEntries(
  ADAPTERS.map((name) => [name, descriptorFor(name)])
);

// The `adapters` array for the hub's {type:"capabilities"} message. Only ever
// carries keyConfigured:<bool> — never the key itself.
export function buildCapabilities(keyChecker = hasKey) {
  return ADAPTERS.map((name) => {
    const d = DESCRIPTORS[name];
    return {
      name,
      label: d.label,
      models: d.models,
      defaultModel: d.defaultModel,
      provider: d.provider,
      keyConfigured: d.provider ? Boolean(keyChecker(d.provider)) : false
    };
  });
}

// config.json's single `model` predates per-adapter descriptors, so it can only
// be a default for adapters that actually serve that model. Ranking it above
// descriptor.defaultModel globally sent a Claude id to openai-api, codex and
// gemini. Rule: explicit request > config.model when this adapter lists it >
// the adapter's own default. Kept identical in hub.mjs getSessionEntry.
export function resolveModel(name, requested, config = CONFIG) {
  const descriptor = DESCRIPTORS[name] || {};
  if (requested) return requested;
  const models = Array.isArray(descriptor.models) ? descriptor.models : [];
  const configured = config && config.model;
  if (configured && models.some((m) => m && m.id === configured)) return configured;
  return descriptor.defaultModel || null;
}

export function normalizeCtx(name, ctx) {
  const base = ctx && typeof ctx === 'object' ? ctx : {};
  const config = base.config && typeof base.config === 'object' ? base.config : {};
  return {
    ...base,
    config,
    model: resolveModel(name, base.model, base.config ? config : CONFIG),
    getApiKey: typeof base.getApiKey === 'function' ? base.getApiKey : (p) => getKey(p),
    tools: Array.isArray(base.tools) ? base.tools : TOOLS
  };
}

export function createSession(name, ctx) {
  const factory = registry[name];
  if (!factory) {
    throw new Error(`unknown adapter "${name}" (available: ${ADAPTERS.join(', ')})`);
  }
  return factory(normalizeCtx(name, ctx));
}
