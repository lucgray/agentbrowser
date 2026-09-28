import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../server/proxy/agentbrowser-cli.mjs';
import { createHubClient, parseCommand, pickBase64, saveBase64, splitLine } from '../../server/proxy/cli-lib.mjs';

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('pickBase64: extracts payload + mimeType from a screenshot-shaped result', () => {
  const got = pickBase64({ base64: PNG_B64, mimeType: 'image/png' });
  assert.equal(got.mimeType, 'image/png');
  assert.equal(got.base64, PNG_B64);
});

test('pickBase64: defaults the mimeType when the result omits it', () => {
  assert.equal(pickBase64({ base64: PNG_B64 }).mimeType, 'application/octet-stream');
});

test('pickBase64: null for results without a base64 payload', () => {
  assert.equal(pickBase64({ url: 'x' }), null);
  assert.equal(pickBase64(null), null);
  assert.equal(pickBase64({ base64: '' }), null);
});

test('saveBase64: writes a decodable file (PNG magic), returns metadata without the payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cli-test-'));
  try {
    const out = join(dir, 'nested', 'shot.png');
    const meta = saveBase64({ base64: PNG_B64, mimeType: 'image/png' }, out);
    assert.equal(meta.mimeType, 'image/png');
    assert.equal(meta.bytes, Buffer.from(PNG_B64, 'base64').length);
    assert.ok(meta.saved.endsWith('shot.png'));
    assert.ok(!('base64' in meta));
    const buf = readFileSync(out);
    assert.deepEqual([...buf.subarray(0, 8)], PNG_MAGIC);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveBase64: null for results without base64 (flag falls through to the normal print)', () => {
  assert.equal(saveBase64({ title: 'x' }, join(tmpdir(), 'unused.bin')), null);
});

test('parseArgs: --output and -o land in opts, positionals stay intact', () => {
  const long = parseArgs(['screenshot', '{}', '--output', 'a.png']);
  assert.equal(long.opts.output, 'a.png');
  assert.deepEqual(long.positional, ['screenshot', '{}']);
  const short = parseArgs(['screenshot', '{}', '-o', 'b.png', '--timeout', '500']);
  assert.equal(short.opts.output, 'b.png');
  assert.equal(short.opts.timeout, 500);
  assert.equal(short.opts.hub, 'ws://127.0.0.1:9010');
});

test('createHubClient: fails fast (and rejects, not hangs) when the hub is unreachable', async () => {
  const client = createHubClient('ws://127.0.0.1:1'); // nothing listens on port 1
  await assert.rejects(() => client.call('tabs_list', {}, 1000));
  client.close();
});

test('splitLine: quote-aware tokenizing keeps JSON and flag values intact', () => {
  assert.deepEqual(splitLine('screenshot {}'), ['screenshot', '{}']);
  assert.deepEqual(splitLine("tabs_list '{\"tabId\":123}'"), ['tabs_list', '{"tabId":123}']);
  assert.deepEqual(
    splitLine("read_page '{\"maxChars\": 100}' --output out.txt"),
    ['read_page', '{"maxChars": 100}', '--output', 'out.txt']
  );
  assert.deepEqual(splitLine('  # just a comment  '), ['#', 'just', 'a', 'comment']);
  assert.deepEqual(splitLine(''), []);
});

test('parseCommand: splits tool, per-line flags, and joined JSON args', () => {
  const got = parseCommand("screenshot '{\"tabId\":1}' --output a.png --timeout 5000");
  assert.equal(got.tool, 'screenshot');
  assert.equal(got.argsJson, '{"tabId":1}');
  assert.equal(got.flags.output, 'a.png');
  assert.equal(got.flags.timeout, 5000);
  const short = parseCommand('screenshot {} -o b.png');
  assert.equal(short.flags.output, 'b.png');
  assert.equal(short.argsJson, '{}');
  assert.equal(parseCommand('   '), null);
});
