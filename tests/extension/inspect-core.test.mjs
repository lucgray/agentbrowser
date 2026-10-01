import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate,
  consoleArgsToText,
  sanitizeHeaders,
  buildHar,
  summarizeCallFrames,
  domInspectExpression,
  outlineExpression,
  patchApplyExpression,
  patchRevertExpression,
  pageSnapshotExpression,
  elementCheckExpression,
  elementPointExpression,
} from '../../extension/background/inspect-core.js';

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
    pageSnapshotExpression({ max: 10, maxChars: 40 }),
    pageSnapshotExpression({}),
    pageSnapshotExpression({ full: true }),
    elementCheckExpression({ selector: '.a > .b' }),
    elementCheckExpression({ selector: '">escape"', max: 5 }),
    elementPointExpression({ selector: '#x', index: 3 }),
  ];
  for (const expr of exprs) {
    assert.doesNotThrow(() => new Function('return ' + expr), expr.slice(0, 80));
  }
});

test('element probes report matches, gates and stable paths', () => {
  const check = elementCheckExpression({ selector: '.item' });
  assert.ok(check.includes('querySelectorAll'));
  assert.ok(check.includes('elementFromPoint'));
  assert.ok(check.includes('abCssPath(el)'));
  const point = elementPointExpression({ selector: '.item', index: 2 });
  assert.ok(point.includes('scrollIntoView'));
  assert.ok(point.includes('[2]'));
});

test('page_snapshot carries path/href/value and honors full', () => {
  const viewport = pageSnapshotExpression({});
  assert.ok(viewport.includes('path: abCssPath(el)'));
  assert.ok(viewport.includes('href:'));
  assert.ok(viewport.includes('value:'));
  assert.ok(viewport.includes('r.bottom < 0'));
  const full = pageSnapshotExpression({ full: true });
  assert.ok(full.includes('!true &&')); // viewport filter disabled
});

test('summarizeCallFrames maps CDP frames to a compact stack', () => {
  const scripts = new Map([['s1', 'https://ex.com/app.js']]);
  const frames = summarizeCallFrames(
    [
      {
        callFrameId: 'cf1',
        functionName: 'onClick',
        location: { scriptId: 's1', lineNumber: 42, columnNumber: 7 },
      },
      {
        callFrameId: 'cf2',
        functionName: '',
        url: 'https://ex.com/inline.html',
        location: { scriptId: 's2', lineNumber: 0, columnNumber: 0 },
      },
    ],
    scripts
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].functionName, 'onClick');
  assert.equal(frames[0].url, 'https://ex.com/app.js'); // resolved via scriptId
  assert.equal(frames[0].lineNumber, 42);
  assert.equal(frames[1].functionName, '(anonymous)');
  assert.equal(frames[1].url, 'https://ex.com/inline.html'); // f.url fallback
  assert.equal(summarizeCallFrames(null, scripts).length, 0);
  // Unknown scriptId -> empty url, no throw.
  const orphan = summarizeCallFrames(
    [{ callFrameId: 'x', location: { scriptId: 'nope', lineNumber: 1 } }],
    scripts
  );
  assert.equal(orphan[0].url, '');
});
