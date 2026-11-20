'use strict';
// Run with:  node test/core-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/core');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }
const fresh = () => new core.Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-')));

(async () => {
  await t('create deck, add card, reject empty', () => {
    const s = fresh(); const d = core.addDeck(s, 'Korean 1', 'Korean');
    core.addCard(s, d.id, '안녕하세요', 'Hello');
    assert.strictEqual(s.data.decks[0].cards.length, 1);
    assert.throws(() => core.addCard(s, d.id, '', 'x'));
    assert.throws(() => core.addDeck(s, '  ', ''));
  });
  await t('data survives restart', () => {
    const s = fresh(); core.addDeck(s, 'A', 'B');
    const s2 = new core.Store(s.dir); assert.strictEqual(s2.data.decks[0].name, 'A');
  });
  await t('broken data file is kept, not lost', () => {
    const s = fresh(); fs.writeFileSync(s.file, '{oops');
    const s2 = new core.Store(s.dir);
    assert.deepStrictEqual(s2.data.decks, []);
    assert.ok(fs.readdirSync(s.dir).some(f => f.includes('.broken-')));
  });
  await t('scheduling: Again/Good/Easy', () => {
    const base = { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
    const now = 1000000;
    assert.strictEqual(core.schedule(base, 1, now).due, now + 60000);
    assert.strictEqual(core.schedule(base, 3, now).interval, 1);
    assert.strictEqual(core.schedule(base, 4, now).interval, 4);
    const g = core.schedule({ ...base, interval: 4 }, 3, now); assert.strictEqual(g.interval, 10);
    assert.ok(core.schedule({ ...base, interval: 4 }, 1, now).ease < 2.5);
  });
  await t('review updates card and logs it', () => {
    const s = fresh(); const d = core.addDeck(s, 'D', 'Korean'); const c = core.addCard(s, d.id, 'a', 'b');
    core.review(s, d.id, c.id, 3);
    assert.strictEqual(s.data.reviews.length, 1);
    assert.strictEqual(core.dueCards(s.data.decks[0]).length, 0);
  });
  await t('friend code round trip + shared subject', () => {
    const a = fresh(), b = fresh();
    a.data.profile.name = 'Mina'; const da = core.addDeck(a, 'K', 'Korean'); const ca = core.addCard(a, da.id, 'x', 'y'); core.review(a, da.id, ca.id, 3);
    const code = core.makeFriendCode(a);
    const db = core.addDeck(b, 'My Korean', 'korean'); core.addCard(b, db.id, 'q', 'w');
    core.addFriendFromCode(b, code);
    const shared = core.sharedSubjects(b);
    assert.strictEqual(shared.length, 1);
    assert.strictEqual(shared[0].friends[0].name, 'Mina');
    assert.strictEqual(shared[0].friends[0].reviewsToday, 1);
    assert.strictEqual(core.progress(a).streak, 1);
  });
  await t('bad friend codes give friendly errors', () => {
    const s = fresh();
    assert.throws(() => core.addFriendFromCode(s, 'hello'), /friend code/);
    assert.throws(() => core.addFriendFromCode(s, 'SDF1:@@@'), /damaged|not complete/);
    assert.throws(() => core.makeFriendCode(s), /name/);
  });
  await t('CSV and tab import, quotes, BOM', () => {
    const s = fresh();
    let r = core.importCsv(s, 'csv', 'Korean', '﻿hello,"안녕, 하세요"\nbye,잘가\n,\n');
    assert.strictEqual(r.imported, 2); assert.strictEqual(r.deck.cards[0].back, '안녕, 하세요');
    r = core.importCsv(s, 'tsv', '', 'a\tb\nc\td'); assert.strictEqual(r.imported, 2);
    assert.throws(() => core.importCsv(s, 'x', '', 'justonecolumn'), /No cards/);
    assert.strictEqual(s.data.decks.length, 2);
  });
  await t('deck export then import', () => {
    const s = fresh(); const d = core.addDeck(s, 'E', 'Math'); core.addCard(s, d.id, '1+1', '2');
    const r = core.importDeckJson(s, core.exportDeckJson(s, d.id));
    assert.strictEqual(r.imported, 1); assert.throws(() => core.importDeckJson(s, '{"a":1}'));
  });
  await t('version compare', () => {
    assert.strictEqual(core.compareVersions('v0.2.0', '0.1.9'), 1);
    assert.strictEqual(core.compareVersions('0.1.0', '0.1.0'), 0);
    assert.strictEqual(core.compareVersions('0.1.0', '0.10.0'), -1);
  });
  await t('GitHub update check (simulated GitHub)', async () => {
    const fake = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });
    const r = await core.checkForUpdate('me/studydeck', '0.1.0', fake(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/me/studydeck/releases/tag/v0.2.0', assets: [] }));
    assert.strictEqual(r.newer, true);
    await assert.rejects(core.checkForUpdate('me/studydeck', '0.1.0', fake(404, {})), /No release/);
    await assert.rejects(core.checkForUpdate('not a repo', '0.1.0', fake(200, {})), /owner\/name/);
  });
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', SOME FAILED' : ', none failed'));
})();
