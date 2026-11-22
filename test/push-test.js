'use strict';
// Two-way AnkiWeb sync, tested against Anki's OWN official sync server with the real Anki program code as the "other device".
// Also reproduces the "405 Not Allowed" error: AnkiWeb answers with a redirect to your account's server, and that server must be
// reached with the full request address. Needs Python with the "anki" package (set ANKI_PY); says SKIPPED if it is missing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { AnkiSyncClient, SyncError } = require('../core/anki-sync');
const { runSync } = require('../core/anki-run');
const { Store } = require('../core/store');

const PY = process.env.ANKI_PY || 'python3';
if (spawnSync(PY, ['-c', 'import anki']).status !== 0) { console.log('SKIPPED: the "anki" Python package is not installed (pip install anki), so the two-way sync test did not run.'); process.exit(0); }

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function ok(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; } }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-push-'));
  const port = await free(); const endpoint = `http://127.0.0.1:${port}/`;
  const server = spawn(PY, ['-m', 'anki.syncserver'], { env: { ...process.env, SYNC_USER1: 'u:p', SYNC_PORT: String(port), SYNC_HOST: '127.0.0.1', SYNC_BASE: path.join(tmp, 'srv') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await sleep(200); } }

  const peerPy = path.join(__dirname, 'sync', 'peer.py'); const peerColl = path.join(tmp, 'peer.anki2');
  const peer = (mode, ...args) => {
    const r = spawnSync(PY, [peerPy, peerColl, endpoint, mode, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'peer ' + mode + ' failed: ' + (r.stderr || '').slice(-600));
    const m = /RESULT (.*)/.exec(r.stdout); return m ? JSON.parse(m[1]) : null;
  };
  const store = new Store(path.join(tmp, 'db.sqlite'), path.join(tmp, 'media'));
  const mediaDir = path.join(tmp, 'cache'); let state = {};
  const sync = async (opts = {}) => {
    const c = new AnkiSyncClient({ endpoint: opts.endpoint || endpoint, appVersion: '0.5.0', platform: process.platform }); await c.login('u', 'p');
    return runSync({ client: c, store, fs, path, os, mediaDir, state, saveState: (s) => { state = s; }, onRedirect: opts.onRedirect, ...opts.run });
  };
  const cardOf = (front) => store.db.prepare('SELECT c.id FROM cards c JOIN notes n ON n.id=c.note_id WHERE n.fields LIKE ?').get('%' + front + '%').id;
  const noteText = (front) => store.db.prepare('SELECT fields FROM notes WHERE fields LIKE ?').get('%' + front + '%').fields;
  const byFront = (res, front) => res.cards.find((c) => c.front === front);

  try {
    peer('up');
    let first;
    await ok('first sync brings the 3 cards from Anki', async () => {
      first = await sync(); assert.strictEqual(first.imported.notesAdded, 3, JSON.stringify(first)); assert.strictEqual(first.pushed, null);
    });

    await ok('a card studied in StudyDeck is sent to AnkiWeb, with its review history', async () => {
      store.answerCard(cardOf('감사합니다'), 3, 4200);
      const r = await sync(); assert.deepStrictEqual(r.pushed, { cards: 1, reviews: 1 }, JSON.stringify(r));
      const seen = peer('inspect');
      const c = byFront(seen, '감사합니다');
      assert.strictEqual(c.reps, 1); assert.strictEqual(c.queue, 1); assert.strictEqual(c.type, 1);
      assert.ok(Math.abs(c.due - Date.now() / 1000 - 600) < 120, 'due in about 10 minutes, got ' + (c.due - Date.now() / 1000));
      assert.strictEqual(seen.revlog.length, 1); assert.strictEqual(seen.revlog[0].ease, 3); assert.ok(seen.revlog[0].time >= 4000 && seen.revlog[0].time <= 4400);
      assert.strictEqual(byFront(seen, '안녕하세요').reps, 0, 'cards not studied stay as they were');
    });

    await ok('syncing again with nothing new sends nothing', async () => {
      await sync();                                           // the other device's check above changed AnkiWeb's change number: catch up once
      const r = await sync(); assert.strictEqual(r.pushed, null); assert.strictEqual(r.upToDate, true, JSON.stringify(r));
    });
    await ok('right after sending, the next sync does not download everything again', async () => {
      store.answerCard(cardOf('잘 가요'), 2, 500);
      const a = await sync(); assert.deepStrictEqual(a.pushed, { cards: 1, reviews: 1 });
      const b = await sync(); assert.strictEqual(b.upToDate, true, JSON.stringify(b)); assert.strictEqual(b.imported, null);
    });

    await ok('both sides changed different things: both are kept', async () => {
      peer('change');                                         // other device: edits a note, studies "잘 가요"
      store.answerCard(cardOf('안녕하세요'), 4, 2000);        // here: studies "안녕하세요" (Easy)
      const r = await sync();
      assert.deepStrictEqual(r.pushed, { cards: 1, reviews: 1 }, JSON.stringify(r));
      assert.match(noteText('감사합니다'), /edited on the other device/, 'the note edit arrived here');
      assert.strictEqual(store.db.prepare('SELECT reps FROM cards WHERE id=?').get(cardOf('잘 가요')).reps, 2, 'progress made on both sides is combined here');
      assert.strictEqual(store.db.prepare('SELECT reps FROM cards WHERE id=?').get(cardOf('감사합니다')).reps, 1, 'progress made here was not lost');
      const seen = peer('inspect');
      assert.strictEqual(byFront(seen, '안녕하세요').reps, 1); assert.strictEqual(byFront(seen, '잘 가요').reps, 2); assert.strictEqual(byFront(seen, '감사합니다').reps, 1);
      assert.strictEqual(seen.revlog.length, 4); assert.match(byFront(seen, '감사합니다').back, /edited on the other device/, 'the note edit was not undone');
    });

    await ok('several reviews of the same card are all sent in order', async () => {
      const id = cardOf('잘 가요'); store.answerCard(id, 1, 1000); store.answerCard(id, 3, 1000); store.answerCard(id, 3, 1000);
      const r = await sync(); assert.deepStrictEqual(r.pushed, { cards: 1, reviews: 3 }, JSON.stringify(r));
      const seen = peer('inspect');
      assert.strictEqual(seen.revlog.length, 7); assert.strictEqual(byFront(seen, '잘 가요').reps, 5);
      assert.deepStrictEqual(seen.revlog.slice(4).map((x) => x.ease), [1, 3, 3]);
      assert.strictEqual(new Set(seen.revlog.map((x) => x.id)).size, 7, 'every review has its own id');
    });

    await ok('a failed upload leaves AnkiWeb untouched and is retried next time', async () => {
      store.answerCard(cardOf('안녕하세요'), 3, 900);
      const before = peer('inspect');
      const c = new AnkiSyncClient({ endpoint, appVersion: '0.5.0', platform: process.platform }); await c.login('u', 'p');
      const realSend = c.send.bind(c);
      c.send = async (kind, method, body, hops) => { if (method === 'finish') throw new SyncError('pretend the connection broke'); return realSend(kind, method, body, hops); };
      await assert.rejects(() => runSync({ client: c, store, fs, path, os, mediaDir, state, saveState: (s) => { state = s; } }), /pretend/);
      assert.deepStrictEqual(peer('inspect').revlog.length, before.revlog.length, 'nothing was half-applied on AnkiWeb');
      const r = await sync(); assert.deepStrictEqual(r.pushed, { cards: 1, reviews: 1 }, JSON.stringify(r));
      assert.strictEqual(peer('inspect').revlog.length, before.revlog.length + 1);
    });

    // ---- the 405 error: AnkiWeb redirects to the server that holds the account ----
    const front = (mode) => http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') { res.writeHead(405, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>405 Not Allowed</title></head><body><center><h1>405 Not Allowed</h1></center><hr><center>nginx</center></body></html>'); }
      res.writeHead(mode, { Location: mode === 'relative' ? '//' : endpoint }); res.end();       // Location = the other server's BASE address, like AnkiWeb
    });
    for (const code of [308, 307, 302, 301]) {
      await ok(`AnkiWeb-style redirect (${code}) to the account's server is followed correctly`, async () => {
        const f = front(code); await new Promise((r) => f.listen(0, '127.0.0.1', r));
        let told = null;
        try {
          const r = await sync({ endpoint: `http://127.0.0.1:${f.address().port}/`, onRedirect: (u) => { told = u; } });
          assert.ok(r.ok); assert.strictEqual(told, endpoint, 'the new address is reported so it can be remembered');
        } finally { f.close(); }
      });
    }
    await ok('a redirect to a server that is not AnkiWeb is refused', () => {
      const c = new AnkiSyncClient({ endpoint: 'https://sync.ankiweb.net/' });
      assert.throws(() => c.redirectTarget('https://evil.example.com/', 'sync', 'meta'), /not AnkiWeb/);
      assert.strictEqual(c.redirectTarget('https://sync7.ankiweb.net/sync/meta', 'sync', 'meta'), 'https://sync7.ankiweb.net/');
    });
    await ok('an unknown refusal says which server and request it came from', async () => {
      const f = http.createServer((req, res) => { res.writeHead(405, { 'Content-Type': 'text/html' }); res.end('<html><center><h1>405 Not Allowed</h1></center><hr><center>nginx</center></html>'); });
      await new Promise((r) => f.listen(0, '127.0.0.1', r));
      try { await new AnkiSyncClient({ endpoint: `http://127.0.0.1:${f.address().port}/` }).login('u', 'p'); assert.fail('should have thrown'); }
      catch (e) { assert.match(e.message, /405/); assert.match(e.message, /sync\/hostKey/); assert.match(e.message, /127\.0\.0\.1/); } finally { f.close(); }
    });
  } finally { server.kill(); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
})();
