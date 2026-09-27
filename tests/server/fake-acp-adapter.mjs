// Hub-facing adapter module for manual/e2e testing of the ACP transport:
// AGENTCHAT_ADAPTER_MODULE=<this file> swaps the registry for a single
// "acp-fake" adapter backed by tests/server/fake-acp-agent.mjs. Same export
// surface as adapters/base.mjs.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAcpSpecSession } from '../../server/adapters/acp.mjs';

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
const SPEC = { command: process.execPath, args: [FAKE_AGENT] };

export const ADAPTERS = ['acp-fake'];

export const DESCRIPTORS = {
  'acp-fake': {
    label: 'Fake ACP (test)',
    models: [{ id: 'fake-model', label: 'Fake Model' }],
    defaultModel: 'fake-model',
    provider: null
  }
};

export function resolveModel(name, requested) {
  return requested || 'fake-model';
}

export function probeAdapter() {
  return { status: 'ready' };
}

export function buildCapabilities() {
  return ADAPTERS.map((name) => ({
    name,
    label: DESCRIPTORS[name].label,
    models: DESCRIPTORS[name].models,
    defaultModel: DESCRIPTORS[name].defaultModel,
    provider: null,
    keyConfigured: false,
    status: 'ready'
  }));
}

export function createSession(name, ctx) {
  if (name !== 'acp-fake') throw new Error(`unknown adapter "${name}"`);
  return createAcpSpecSession('acp-fake', SPEC, ctx || {});
}
