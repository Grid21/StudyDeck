'use strict';
// Tests with REAL Anki deck files (made by Anki itself) and the .studyupdate pipeline. Plain Node, no Electron.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const { Store } = require('../core/store');
const { parseApkg } = require('../core/apkg');
const { renderCard } = require('../core/render');
const updatepkg = require('../core/updatepkg');
const fflate = require('../core/vendor/fflate.js');

let passed = 0;
function ok(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-stage2-'));

for (const fx of ['korean-legacy.apkg', 'korean-modern.apkg']) {
  ok(`import + study + progress: ${fx}`, () => {
    const dir = path.join(tmp, fx); fs.mkdirSync(dir);
    const store = new Store(path.join(dir, 'db.sqlite'), path.join(dir, 'media'));
    const work = fs.mkdtempSync(path.join(tmp, 'w-'));
    const r = store.importCollection(parseApkg(path.join(__dirname, 'fixtures', fx), work), { name: fx });
    assert.ok(r.cardsAdded > 0, 'cards were imported');
    const decks = store.listDecks(); assert.ok(decks.length > 0);
    const again = store.importCollection(parseApkg(path.join(__dirname, 'fixtures', fx), fs.mkdtempSync(path.join(tmp, 'w-'))), { name: fx });
    assert.strictEqual(again.cardsAdded === 0 || again.notesAdded === 0, true, 'importing twice does not duplicate');
    const ids = store.deckIdsFor ? store.deckIdsByName(decks[0].name) : [];
    const id = store.nextCardId(ids);
    assert.ok(id, 'a card is due');
    const d = store.getCardData(id);
    const html = renderCard(d.ctx, d.importId);
    assert.ok(html.question.length > 20 && html.answer.length > 20, 'card renders');
    assert.ok(!/<script/i.test(html.question + html.answer), 'no scripts in cards');
    store.answerCard(id, 3, 1500);
    assert.strictEqual(store.stats().today.reviewed, 1);
    store.close();
  });
}

const upd = path.join(tmp, 'out');
const made = execFileSync('node', [path.join(root, 'tools', 'make-update.js'), '--notes', 'test update', '--out', upd]).toString().trim().split('  ')[0];
const pkgVersion = require('../package.json').version;

ok('.studyupdate: built file is read back', () => {
  const { manifest, files } = updatepkg.readUpdate(made);
  assert.strictEqual(manifest.version, pkgVersion);
  assert.ok(files.has('app-main.js') && files.has('renderer/app.js') && !files.has('main.js'));
});

function tamper(fn) {
  const z = fflate.unzipSync(new Uint8Array(fs.readFileSync(made)));
  fn(z);
  const f = path.join(tmp, 'bad-' + Math.random().toString(36).slice(2) + '.studyupdate');
  fs.writeFileSync(f, fflate.zipSync(z)); return f;
}
const man = (z) => JSON.parse(Buffer.from(z['update.json']).toString());
const setMan = (z, m) => { z['update.json'] = new TextEncoder().encode(JSON.stringify(m)); };

ok('.studyupdate: rejects changed file, bad path, bad type, wrong app, junk', () => {
  assert.throws(() => updatepkg.readUpdate(tamper((z) => { z['files/core/semver.js'] = new TextEncoder().encode('evil'); })), /damaged|checksum/);
  assert.throws(() => updatepkg.readUpdate(tamper((z) => { const m = man(z); m.files[0].path = '../evil.js'; setMan(z, m); })), /unsafe/);
  assert.throws(() => updatepkg.readUpdate(tamper((z) => { const m = man(z); m.files[0].path = 'core/run.exe'; setMan(z, m); })), /not allowed/);
  assert.throws(() => updatepkg.readUpdate(tamper((z) => { const m = man(z); m.app = 'other'; setMan(z, m); })), /not for StudyDeck/);
  assert.throws(() => updatepkg.readUpdate(tamper((z) => { z['files/extra.js'] = new Uint8Array([1]); })), /unlisted/);
  const junk = path.join(tmp, 'junk.studyupdate'); fs.writeFileSync(junk, 'hello');
  assert.throws(() => updatepkg.readUpdate(junk), /not a valid/);
});

ok('.studyupdate: installs only when newer, and can be removed', () => {
  const dir = path.join(tmp, 'updates');
  assert.throws(() => updatepkg.installUpdate(made, { baseRoot: root, baseVersion: pkgVersion, runningVersion: pkgVersion, updatesDir: dir }), /already have/i);
  const m = updatepkg.installUpdate(made, { baseRoot: root, baseVersion: '0.1.0', runningVersion: '0.1.0', updatesDir: dir });
  const st = updatepkg.readState(dir);
  assert.strictEqual(st.version, m.version);
  assert.ok(fs.existsSync(path.join(dir, st.current, 'app-main.js')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, st.current, 'package.json'))).version, pkgVersion);
  updatepkg.removeUpdates(dir);
  assert.strictEqual(updatepkg.readState(dir), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
