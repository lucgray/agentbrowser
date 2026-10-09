// Notes plugin storage service (PROTOCOL v2.23): CRUD, quotes, tags, assets,
// export — each test runs against a fresh AGENTCHAT_NOTES_DIR temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';

const dirs = [];
function freshDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ab-notes-'));
  dirs.push(d);
  process.env.AGENTCHAT_NOTES_DIR = d;
  return d;
}
test.after(() => {
  delete process.env.AGENTCHAT_NOTES_DIR;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const notes = await import('../../server/hub/notes.mjs');
const save = (body) => notes.saveNote(body).note;

test('saveNote creates and updates; listNotes returns summaries', () => {
  freshDir();
  const n = save({ title: 't1', url: 'https://a.com/x', tags: ['web'] });
  assert.equal(n.title, 't1');
  assert.ok(n.id.startsWith('n-'));
  const n2 = notes.saveNote({ id: n.id, title: 't2', tags: ['a', 'b'] }).note;
  assert.equal(n2.id, n.id);
  assert.equal(n2.title, 't2');
  assert.deepEqual(n2.tags, ['a', 'b']);
  // unprovided fields stay
  assert.equal(n2.url, 'https://a.com/x');
  const list = notes.listNotes();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 't2');
  assert.equal(list[0].quoteCount, 0);
});

test('listNotes filters by q/tag/domain/url', () => {
  freshDir();
  save({ title: 'alpha', url: 'https://a.com/1', tags: ['x'] });
  save({ title: 'beta', url: 'https://b.com/2', tags: ['y'], content: 'needle' });
  assert.equal(notes.listNotes({ q: 'needle' }).length, 1);
  assert.equal(notes.listNotes({ q: 'alpha' })[0].domain, 'a.com');
  assert.equal(notes.listNotes({ tag: 'y' })[0].title, 'beta');
  assert.equal(notes.listNotes({ domain: 'a.com' }).length, 1);
  assert.equal(notes.listNotes({ url: 'https://b.com/2' })[0].title, 'beta');
  assert.equal(notes.listNotes({ domain: 'zz' }).length, 0);
});

test('appendContent + appendQuote accumulate; quotesForUrl matches', () => {
  freshDir();
  const n = save({ title: 'n', url: 'https://a.com', content: 'one' });
  const g = notes.appendContent(n.id, 'two').note;
  assert.match(g.content, /one\n\ntwo/);
  const r = notes.appendQuote(n.id, { text: 'q1', url: 'https://a.com', anchor: null });
  assert.equal(r.quote.text, 'q1');
  assert.equal(r.note.quotes.length, 1);
  assert.equal(notes.quotesForUrl('https://a.com').length, 1);
  assert.equal(notes.quotesForUrl('https://other').length, 0);
});

test('appendQuote on missing note errors; deleteNote removes file', () => {
  freshDir();
  const r = notes.appendQuote('n-nope', { text: 'x' });
  assert.ok(r.error);
  const n = save({ title: 'd', url: 'https://a.com' });
  const file = path.join(process.env.AGENTCHAT_NOTES_DIR, n.id + '.json');
  assert.ok(existsSync(file));
  notes.deleteNote(n.id);
  assert.ok(!existsSync(file));
  assert.equal(notes.getNote(n.id), null);
  assert.equal(notes.saveNote({ id: 'n-nope' }).error !== undefined, true);
});

test('listTags counts across notes; stats totals', () => {
  freshDir();
  save({ title: 'a', url: 'u', tags: ['x', 'y'] });
  save({ title: 'b', url: 'u', tags: ['x'] });
  const x = notes.listTags().find((t) => t.tag === 'x');
  assert.equal(x.count, 2);
  const s = notes.notesStats();
  assert.equal(s.notes, 2);
  assert.equal(s.tags, 2);
});

test('addAsset writes a file and returns /notes-assets/ url; readAsset serves mime', () => {
  freshDir();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const r = notes.addAsset('a.png', png);
  assert.ok(r.url.startsWith('/notes-assets/'));
  const fname = r.url.split('/').pop();
  assert.ok(existsSync(path.join(process.env.AGENTCHAT_NOTES_DIR, 'assets', fname)));
  const a = notes.readAsset(fname);
  assert.equal(a.mime, 'image/png');
  // traversal is rejected
  assert.ok(!notes.readAsset('../' + fname));
  assert.ok(!notes.readAsset('../../etc/passwd'));
});

test('exportNote renders markdown with quotes', () => {
  freshDir();
  const n = save({ title: 'exp', url: 'https://a.com', tags: ['t'], content: 'body' });
  notes.appendQuote(n.id, { text: 'quoted', url: 'https://a.com' });
  const md = notes.exportNote(n.id);
  assert.match(md, /# exp/);
  assert.match(md, /> quoted/);
});

test('content over MAX_BODY is rejected', () => {
  freshDir();
  const r = notes.saveNote({ title: 'big', url: 'u', content: 'x'.repeat(300 * 1024) });
  assert.ok(r.error);
});

test('module exposes the service surface hub.mjs calls', () => {
  for (const k of ['listNotes', 'getNote', 'saveNote', 'deleteNote', 'appendContent', 'appendQuote', 'listTags', 'quotesForUrl', 'addAsset', 'readAsset', 'exportNote', 'notesStats', 'notesDir', 'wireNotes']) {
    assert.equal(typeof notes[k], 'function', k);
  }
  notes.wireNotes({ warn: () => {} }); // installs a logger; returns nothing
});
