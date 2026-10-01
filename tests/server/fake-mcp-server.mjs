// Fake stdio MCP server for mcp-bridge tests: newline-delimited JSON-RPC,
// answers initialize/tools/list/tools/call with a single "echo" tool.

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      answer(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } });
    } else if (msg.method === 'tools/list') {
      answer(msg.id, { tools: [{ name: 'echo', description: 'Echo arguments back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    } else if (msg.method === 'tools/call') {
      answer(msg.id, { content: [{ type: 'text', text: `echo:${(msg.params.arguments || {}).text || ''}` }] });
    }
    // notifications are ignored
  }
});

function answer(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
