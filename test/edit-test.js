'use strict';
// Making and editing decks and cards, and that syncing leaves them alone.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../core/store'); const { parseApkg } = require('../core/apkg'); const { renderCard } = require('../core/render');
let passed = 0; function ok(n, f) { try { f(); passed++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n     ' + e.message); process.exitCode = 1; } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-edit-'));
const store = new Store(path.join(tmp, 'db.sqlite'), path.join(tmp, 'media'));
const names = () => store.listDecks().map((d) => d.name).sort();

ok('create decks, sub-decks; reject empty names', () => {
  store.createDeck('  Spanish  '); store.createDeck('Spanish::Verbs'); assert.deepStrictEqual(names(), ['Spanish', 'Spanish::Verbs']);
  assert.strictEqual(store.createDeck('Spanish').existed, true);
  for (const bad of ['', '   ', 'A::', '::B', 'A::::B']) assert.throws(() => store.createDeck(bad), /deck name/);
});
ok('rename moves sub-decks too, and refuses clashes', () => {
  store.createDeck('Other'); store.renameDeck('Spanish', 'Espanol'); assert.deepStrictEqual(names(), ['Espanol', 'Espanol::Verbs', 'Other']);
  assert.throws(() => store.renameDeck('Other', 'Espanol'), /already exists/);
  assert.throws(() => store.renameDeck('Espanol', 'Espanol::Verbs::X'), /inside itself/);
  assert.throws(() => store.renameDeck('Nope', 'X'), /no longer exists/);
  store.renameDeck('Other', 'Other'); store.renameDeck('Other', 'Espanol::Other'); assert.ok(names().includes('Espanol::Other'));
});
let basic, rev, cloze;
ok('add basic, reversed and cloze cards; they can be studied', () => {
  basic = store.addNote({ deck: 'Espanol', type: 'basic', fields: ['hola', 'hello'], tags: 'greet  common' });
  rev = store.addNote({ deck: 'Espanol::Verbs', type: 'reversed', fields: ['comer', 'to eat'] });
  cloze = store.addNote({ deck: 'Espanol', type: 'cloze', fields: ['Yo {{c1::como}} y {{c2::bebo}} {{c1::mucho}}', ''] });
  assert.deepStrictEqual([basic.cards, rev.cards, cloze.cards], [1, 2, 2]);
  const id = store.nextCardId(store.deckIdsByName('Espanol')); const d = store.getCardData(id); const r = renderCard(d.ctx, d.importId);
  assert.ok(r.question.length > 5 && r.answer.length > 5);
  const cd = store.db.prepare("SELECT c.id FROM cards c WHERE c.note_id=? AND c.ord=0").get(cloze.noteId); const dd = store.getCardData(cd.id);
  assert.match(renderCard(dd.ctx, dd.importId).question, /\[\.\.\.\]|class="cloze"/);
});
ok('missing text is refused', () => {
  assert.throws(() => store.addNote({ deck: 'X', type: 'basic', fields: ['', 'b'] }), /Front/);
  assert.throws(() => store.addNote({ deck: 'X', type: 'basic', fields: ['a', ' '] }), /Back/);
  assert.throws(() => store.addNote({ deck: 'X', type: 'cloze', fields: ['no blanks', ''] }), /blank/);
  assert.ok(!names().includes('X'), 'a refused card does not leave an empty deck behind');
});
ok('browse and search', () => {
  assert.strictEqual(store.listNotes({ deck: 'Espanol' }).total, 3); assert.strictEqual(store.listNotes({ deck: 'Espanol::Verbs' }).total, 1);
  const s = store.listNotes({ deck: null, search: 'EAT' }); assert.strictEqual(s.total, 1); assert.strictEqual(s.notes[0].front, 'comer');
  assert.strictEqual(store.listNotes({ deck: null, search: '100%' }).total, 0, 'percent signs are plain text');
});
ok('edit a note, add a cloze blank (new card), move deck', () => {
  store.updateNote(basic.noteId, { fields: ['hola!', 'hi'], tags: 'x', deck: 'Espanol::Verbs' });
  const n = store.getNote(basic.noteId); assert.deepStrictEqual(n.fields, ['hola!', 'hi']); assert.strictEqual(n.deck, 'Espanol::Verbs');
  store.updateNote(cloze.noteId, { fields: ['{{c1::a}} {{c2::b}} {{c3::c}}', ''], tags: '' }); assert.strictEqual(store.getNote(cloze.noteId).cardCount, 3);
  assert.throws(() => store.updateNote(basic.noteId, { fields: ['', 'x'], tags: '' }), /Front/);
});
ok('delete a note', () => { store.deleteNote(rev.noteId); assert.strictEqual(store.getNote(rev.noteId), null); assert.strictEqual(store.listNotes({ deck: null, search: 'comer' }).total, 0); });
ok('syncing keeps cards and edits made here', () => {
  const fx = path.join(__dirname, 'fixtures', 'korean-modern.apkg');
  const imp = () => store.importCollection({ ...parseApkg(fx, fs.mkdtempSync(path.join(tmp, 'w-'))) }, { name: 'sync', keepProgress: true, sync: true });
  imp(); const k = store.db.prepare("SELECT n.id FROM notes n JOIN notetypes t ON t.id=n.notetype_id WHERE n.edited=0 AND t.kind='standard' LIMIT 1").get();
  store.updateNote(k.id, { fields: store.getNote(k.id).fields.map((x, i) => (i === 0 ? 'EDITED HERE' : x)), tags: '' });
  const r = imp(); assert.strictEqual(r.cardsRemoved, 0, 'cards made here are not removed by a sync');
  assert.strictEqual(store.getNote(k.id).fields[0], 'EDITED HERE', 'an edit made here is not overwritten');
  assert.ok(store.getNote(cloze.noteId) && store.getNote(basic.noteId));
  assert.strictEqual(store.pendingPush().cards.filter((c) => !store.db.prepare('SELECT 1 FROM anki_cards WHERE card_id=?').get(c.id)).length, 0);
  const own = store.db.prepare('SELECT id FROM cards WHERE note_id=?').get(basic.noteId).id; store.answerCard(own, 3, 1000);
  assert.ok(!store.pendingPush().cards.some((c) => c.id === own), 'cards made here are never sent to AnkiWeb');
});
store.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
