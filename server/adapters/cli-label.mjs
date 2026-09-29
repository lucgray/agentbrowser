// Shared chip-label extraction for adapter event mapping.
// Shell-tool events from CLI harnesses arrive under generic titles like
// "run script". When the command is an `agentbrowser <tool> '<json>'` call,
// its own "label" arg names the real intent — lift it so the chip shows the
// action, not the harness noun.
export function labelFromAgentbrowser(command) {
  if (typeof command !== 'string' || !/\bagentbrowser(?:-cli\.mjs)?\b/.test(command)) return undefined;
  const m = command.match(/"label"\s*:\s*"([^"\\]*)"/);
  return m && m[1].trim() ? m[1].trim().slice(0, 80) : undefined;
}
