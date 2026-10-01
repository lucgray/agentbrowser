import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTIDETECT_SCRIPT, PRELOAD_PRESETS } from '../../extension/background/stealth.js';

test('antidetect preset exists and is a non-empty source string', () => {
  assert.equal(PRELOAD_PRESETS.antidetect, ANTIDETECT_SCRIPT);
  assert.ok(ANTIDETECT_SCRIPT.length > 500);
});

test('ANTIDETECT_SCRIPT compiles as an expression', () => {
  assert.doesNotThrow(() => new Function(ANTIDETECT_SCRIPT));
});

test('ANTIDETECT_SCRIPT covers the probe surfaces', () => {
  for (const needle of [
    'Function.prototype.toString',
    '[native code]',
    'performance.timing',
    'Date.now() - navStart',
    "'table'",
    "'log'",
    'navigator.webdriver',
  ]) {
    assert.ok(ANTIDETECT_SCRIPT.includes(needle), `missing ${needle}`);
  }
  // toString must spoof itself too — the first check a detector runs.
  const idx = ANTIDETECT_SCRIPT.indexOf('this === Function.prototype.toString');
  assert.ok(idx > -1);
});
