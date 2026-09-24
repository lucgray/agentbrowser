import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate,
  consoleArgsToText,
  sanitizeHeaders,
  buildHar,
  domInspectExpression,
  outlineExpression,
  patchApplyExpression,
  patchRevertExpression,
} from './inspect-core.js';

test('truncate caps length', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3).length, 4); // 3 chars + ellipsis
  assert.equal(truncate(null, 5), '');
});

test('consoleArgsToText renders values, descriptions and types', () => {
  assert.equal(
    consoleArgsToText([{ value: 'hi' }, { value: 42 }]),
    'hi 42'
  );
  assert.equal(consoleArgsToText([{ type: 'object', description: 'HTMLDivElement' }]), 'HTMLDivElement');
  assert.equal(consoleArgsToText('nope'), '');
  assert.equal(consoleArgsToText([{ unserializableValue: NaN }]), 'NaN');
});

test('sanitizeHeaders drops credential headers', () => {
  const out = sanitizeHeaders({
    Cookie: 'a=b',
    Authorization: 'Bearer x',
    'Set-Cookie': 's=1',
    'Content-Type': 'text/html',
    'x-custom': 'ok',
  });
  assert.deepEqual(out, { 'Content-Type': 'text/html', 'x-custom': 'ok' });
  assert.deepEqual(sanitizeHeaders(null), {});
});

test('buildHar produces HAR 1.2 shape and sanitizes headers', () => {
  const har = buildHar(
    [
      {
        url: 'https://ex.com/api',
        method: 'POST',
        status: 200,
        mimeType: 'application/json',
        startTime: 1700000000000,
        duration: 42,
        size: 128,
        requestHeaders: { Cookie: 'secret=1', Accept: '*/*' },
        responseHeaders: { 'Set-Cookie': 's=1', Server: 'nginx' },
      },
    ],
    { title: 't' }
  );
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 1);
  const e = har.log.entries[0];
  assert.equal(e.request.method, 'POST');
  assert.equal(e.response.status, 200);
  const reqNames = e.request.headers.map((h) => h.name);
  const resNames = e.response.headers.map((h) => h.name);
  assert.ok(!reqNames.includes('Cookie'));
  assert.ok(!resNames.includes('Set-Cookie'));
  assert.ok(resNames.includes('Server'));
});

test('page-side expressions are valid JavaScript', () => {
  const exprs = [
    domInspectExpression({ selector: 'div.a', styles: ['color'] }),
    domInspectExpression({ selector: '">escape"', all: false }),
    outlineExpression(3),
    patchApplyExpression([
      { selector: 'p', styles: { color: 'red' }, attributes: { 'data-x': '1' } },
      { selector: 'q', remove: true },
    ]),
    patchRevertExpression([{ path: 'html>body>p', outerHTML: '<p>x</p>' }]),
  ];
  for (const expr of exprs) {
    assert.doesNotThrow(() => new Function('return ' + expr), expr.slice(0, 80));
  }
});
