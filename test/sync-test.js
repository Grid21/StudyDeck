'use strict';
// Tests the AnkiWeb/Anki-server download sync against Anki's OWN official sync server (run here from the "anki" Python package).
// Needs Python with the "anki" package:  pip install anki   (set ANKI_PY to that python if it is not the default one).
// If it is missing this test says SKIPPED instead of failing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { AnkiSyncClient, pull, SyncError } = require('../core/anki-sync');
const { readCollection } = require('../core/apkg');
const { Store } = require('../core/store');

const PY = process.env.ANKI_PY || 'python3';
if (spawnSync(PY, ['-c', 'import anki']).status !== 0) { console.log('SKIPPED: the "anki" Python package is not installed (pip install anki), so the sync test did not run.'); process.exit(0); }

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function ok(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sync-'));
  const port = await free(); const endpoint = `http://127.0.0.1:${port}/`;
  const server = spawn(PY, ['-m', 'anki.syncserver'], { env: { ...process.env, SYNC_USER1: 'u:p', SYNC_PORT: String(port), SYNC_HOST: '127.0.0.1', SYNC_BASE: path.join(tmp, 'srv') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await sleep(200); } }
  const seed = (mode) => { const r = spawnSync(PY, [path.join(__dirname, 'sync', 'seed.py'), path.join(tmp, 'anki.anki2'), endpoint, mode], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr.slice(-400)); };
  const client = () => new AnkiSyncClient({ endpoint, appVersion: '0.4.0', platform: process.platform });
  const store = new Store(path.join(tmp, 'db.sqlite'), path.join(tmp, 'media'));
  const mediaDir = path.join(tmp, 'cache'); let state = {};
  const sync = async (force) => {
    const c = client(); await c.login('u', 'p');
    const r = await pull(c, { fs, path, mediaDir, state, force });
    let imported = null;
    if (r.dbBytes) {
      const work = fs.mkdtempSync(path.join(tmp, 'w-'));
      if (process.env.SD_DEBUG) console.error('DBG read', r.dbBytes.length);
      const { data, warnings } = readCollection(r.dbBytes, work, 'sync');
      if (process.env.SD_DEBUG) console.error('DBG import', data.notes.length, data.cards.length, process.memoryUsage().rss >> 20);
      imported = store.importCollection({ ...data, mediaDir, mediaCount: r.mediaDownloaded, warnings }, { name: 'sync' });
    }
    if (process.env.SD_DEBUG) console.error('DBG done', JSON.stringify(r.meta), JSON.stringify(state).slice(0,80));
    state = { mod: r.meta.mod, scm: r.meta.scm, mediaUsn: r.mediaUsn, files: r.files };
    return { r, imported };
  };

  try {
    await ok('wrong password gives a friendly message', async () => {
      await assert.rejects(() => client().login('u', 'wrong'), (e) => e instanceof SyncError && /email and password/.test(e.message));
      assert.throws(() => new AnkiSyncClient({ endpoint: 'http://example.com/' }), /https/);
    });
    await ok('empty account is explained', async () => {
      const c = client(); await c.login('u', 'p');
      await assert.rejects(() => pull(c, { fs, path, mediaDir, state: {} }), /no decks yet/);
    });
    seed('up');
    await ok('first sync downloads decks, pictures and sounds', async () => {
      const { r, imported } = await sync();
      assert.ok(r.dbBytes && imported.notesAdded === 2, JSON.stringify(imported));
      assert.strictEqual(r.mediaDownloaded, 2);
      assert.ok(fs.readFileSync(path.join(mediaDir, 'hello.mp3')).toString('latin1').includes('fake-mp3-bytes'));
      assert.strictEqual(fs.readFileSync(path.join(mediaDir, 'dot.png')).subarray(1, 4).toString(), 'PNG');
      assert.ok(store.listDecks().some((d) => d.name.startsWith('Korean')));
    });
    await ok('sound and picture files are available to the imported cards', async () => {
      const importDirs = fs.readdirSync(path.join(tmp, 'media'));
      assert.ok(importDirs.some((d) => fs.existsSync(path.join(tmp, 'media', d, 'hello.mp3')) && fs.existsSync(path.join(tmp, 'media', d, 'dot.png'))));
    });
    let studied;
    await ok('a second sync with no changes does nothing', async () => {
      const ids = store.deckIdsByName('Korean'); studied = store.nextCardId(ids); store.answerCard(studied, 3, 1000);
      const { r } = await sync();
      assert.strictEqual(r.dbBytes, null); assert.strictEqual(r.mediaDownloaded, 0);
    });
    seed('add');
    await ok('new cards from Anki arrive and your StudyDeck progress is kept', async () => {
      const before = store.stats().cards.total;
      const { r, imported } = await sync();
      assert.ok(r.dbBytes); assert.strictEqual(imported.notesAdded, 1, JSON.stringify(imported));
      assert.strictEqual(store.stats().cards.total, before + 1);
      assert.strictEqual(store.stats().today.reviewed, 1, 'review history is kept');
      const d = store.getCardData(studied); assert.notStrictEqual(d.ctx.card ? d.ctx.card.state : 'review', 'new');
    });
  } finally { server.kill(); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
})();
