// Pure-function coverage for the subtitle core: site detection, srv3 /
// bilibili caption parsing, entity decoding, cue lookup and send order.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSite,
  decodeEntities,
  parseSrv3,
  parseBilibili,
  cueAt,
  sendOrder,
  fmtTs,
  buildSrt,
  sampleTranscript,
} from '../../extension/page/subtitle-core.js';

test('detectSite recognises youtube and bilibili urls', () => {
  assert.equal(detectSite('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(detectSite('https://youtu.be/abc'), 'youtube');
  assert.equal(detectSite('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
  assert.equal(detectSite('https://b23.tv/xyz'), 'bilibili');
  assert.equal(detectSite('https://x.com/user/status/123'), 'x');
  assert.equal(detectSite('https://mobile.twitter.com/user/status/123'), 'x');
  assert.equal(detectSite('https://example.com'), null);
  assert.equal(detectSite('https://notx.com/video/1'), null);
});

test('decodeEntities maps named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;'), 'a & b < c > d "e" \'f\'');
  assert.equal(decodeEntities('un&#x27;known &bogus; stays'), "un'known &bogus; stays");
});

test('parseSrv3 reads start/dur/text, strips tags, sorts', () => {
  const xml = `<?xml version="1.0"?>
<timedtext><body>
<text start="5.5" dur="2.0">second &amp; line</text>
<text start="1.0" dur="3.0"><s>first</s> <s>words</s></text>
<text start="9.0" dur="1.0">   </text>
</body></timedtext>`;
  const cues = parseSrv3(xml);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1.0, end: 4.0, text: 'first words' });
  assert.deepEqual(cues[1], { start: 5.5, end: 7.5, text: 'second & line' });
});

test('parseSrv3 tolerates attribute order and returns [] on junk', () => {
  assert.equal(parseSrv3('').length, 0);
  assert.equal(parseSrv3('not xml').length, 0);
  const cues = parseSrv3('<text dur="2" start="4">late attrs</text>');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 4);
});

test('parseBilibili maps body entries to cues', () => {
  const cues = parseBilibili({
    font_size: 0.4,
    body: [
      { from: 3.2, to: 5.1, content: '第二句', location: 2 },
      { from: 0.5, to: 2.0, content: '第一句' },
      { from: 'x', to: 1, content: 'bad' },
    ],
  });
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0.5, end: 2.0, text: '第一句' });
  assert.equal(cues[1].text, '第二句');
  assert.equal(parseBilibili({}).length, 0);
});

test('cueAt finds the active cue by time', () => {
  const cues = [
    { start: 0, end: 2, text: 'a' },
    { start: 2, end: 4, text: 'b' },
    { start: 6, end: 8, text: 'c' },
  ];
  assert.equal(cueAt(cues, -1), -1);
  assert.equal(cueAt(cues, 0.5), 0);
  assert.equal(cueAt(cues, 2), 1); // boundary goes to the next cue
  assert.equal(cueAt(cues, 5), -1); // gap between cues
  assert.equal(cueAt(cues, 7), 2);
  assert.equal(cueAt(cues, 99), -1);
});

test('sendOrder is playback-first then wraps to the prefix', () => {
  assert.deepEqual(sendOrder(5, 2), [2, 3, 4, 0, 1]);
  assert.deepEqual(sendOrder(3, 0), [0, 1, 2]);
  assert.deepEqual(sendOrder(4, -1), [0, 1, 2, 3]);
});

test('fmtTs renders MM:SS and H:MM:SS', () => {
  assert.equal(fmtTs(0), '0:00');
  assert.equal(fmtTs(65.9), '1:05');
  assert.equal(fmtTs(3725), '1:02:05');
  assert.equal(fmtTs(-3), '0:00');
  assert.equal(fmtTs('90'), '1:30');
});

test('buildSrt emits numbered cue blocks with SRT timestamps', () => {
  const cues = [
    { start: 0.5, end: 2, text: 'Hello there', translated: '你好' },
    { start: 3725.25, end: 3727, text: 'second line', translated: null },
  ];
  const srt = buildSrt(cues);
  const blocks = srt.trim().split(/\n\n/);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^1\n00:00:00,500 --> 00:00:02,000\nHello there\n你好$/);
  // untranslated cues export the source line only
  assert.match(blocks[1], /^2\n01:02:05,250 --> 01:02:07,000\nsecond line$/);
});

test('sampleTranscript joins short tracks, windows long ones', () => {
  const short = [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }];
  assert.equal(sampleTranscript(short), 'a\nb');
  assert.equal(sampleTranscript([]), '');
  assert.equal(sampleTranscript(null), '');

  const long = [];
  for (let i = 0; i < 80; i++) long.push({ start: i, end: i + 1, text: 'x'.repeat(500) });
  const sampled = sampleTranscript(long, 20000);
  assert.ok(sampled.length <= 20000);
  assert.ok(sampled.length < long.length * 500); // windows sampled, not joined whole
  assert.ok(sampled.includes('\n\n')); // window separator
});
