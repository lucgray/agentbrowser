// Page-translation core helpers — pure functions shared by the injected
// engine and unit tests (PROTOCOL v2.14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP_TAGS,
  BLOCK_TAGS,
  hasProseChild,
  looksLikeTargetLang,
  normalizeText,
  NO_TRANSLATION_SENTINEL,
  isNoTranslation,
  TRANSLATE_MODES,
  resolveEngineConfig,
} from '../../extension/page/translate-core.js';

const text = (v) => ({ nodeType: 3, nodeValue: v });
const elem = () => ({ nodeType: 1, nodeValue: null });

test('hasProseChild: a direct text child with a letter qualifies', () => {
  assert.equal(hasProseChild([text('hello world')]), true);
  assert.equal(hasProseChild([elem(), text('  你好  ')]), true);
  assert.equal(hasProseChild([text('   \n\t  ')]), false);
  assert.equal(hasProseChild([text('12345 !!!')]), false);
  assert.equal(hasProseChild([elem(), elem()]), false);
  assert.equal(hasProseChild([]), false);
  assert.equal(hasProseChild(null), false);
});

test('looksLikeTargetLang: script-ratio heuristic', () => {
  assert.equal(looksLikeTargetLang('This is a long english paragraph.', 'zh'), false);
  assert.equal(looksLikeTargetLang('这是一段很长的中文段落。', 'zh'), true);
  assert.equal(looksLikeTargetLang('This is a long english paragraph.', 'en'), true);
  assert.equal(looksLikeTargetLang('这是一段很长的中文段落。', 'en'), false);
  // Numbers and punctuation only — nothing to translate.
  assert.equal(looksLikeTargetLang('2024-01-01 12:00', 'zh'), true);
  // Mixed but mostly CJK still counts as target for zh.
  assert.equal(looksLikeTargetLang('中文字符占了大半 latin', 'zh'), true);
});

test('normalizeText collapses whitespace and caps length', () => {
  assert.equal(normalizeText('  a  b\n\nc   '), 'a b c');
  assert.equal(normalizeText('abcdef', 3), 'abc');
  assert.equal(normalizeText(''), '');
});

test('isNoTranslation matches the sentinel only', () => {
  assert.equal(isNoTranslation(NO_TRANSLATION_SENTINEL), true);
  assert.equal(isNoTranslation(` ${NO_TRANSLATION_SENTINEL} `), true);
  assert.equal(isNoTranslation('hello'), false);
  assert.equal(isNoTranslation(''), false);
});

test('resolveEngineConfig: defaults, validation, coercion', () => {
  const d = resolveEngineConfig();
  assert.equal(d.mode, 'bilingual');
  assert.equal(d.targetLang, 'zh');
  assert.equal(d.wordHover, false);
  assert.equal(d.maxItemsPerBatch, 4);

  const c = resolveEngineConfig({ mode: 'ondemand', targetLang: 'ja', wordHover: true, minChars: 9 });
  assert.equal(c.mode, 'ondemand');
  assert.equal(c.targetLang, 'ja');
  assert.equal(c.wordHover, true);
  assert.equal(c.minChars, 9);

  // Unknown mode falls back rather than breaking the engine.
  assert.equal(resolveEngineConfig({ mode: 'nope' }).mode, 'bilingual');
  // Numbers are coerced and floored at sane minimums.
  const n = resolveEngineConfig({ maxItemsPerBatch: 0, batchFlushMs: 1 });
  assert.equal(n.maxItemsPerBatch, 4);
  assert.equal(n.batchFlushMs, 50);
});

test('tag sets cover the expected exclusions and modes list is complete', () => {
  for (const tag of ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'SVG', 'AB-TRANS']) {
    assert.ok(SKIP_TAGS.has(tag), tag);
  }
  for (const tag of ['P', 'DIV', 'LI', 'BLOCKQUOTE', 'TD']) {
    assert.ok(BLOCK_TAGS.has(tag), tag);
  }
  assert.deepEqual(TRANSLATE_MODES, ['bilingual', 'card', 'dim', 'replace', 'ondemand']);
});
