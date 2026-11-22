'use strict';
// Drives the real program window like a person would. Run with:  bash test/run-ui-test.sh
// Phases:  1 = import / study / progress / plugins / settings / install update,  2 = after restart, the update is in use,
//          3 = go back to the built-in version.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const phase = Number((process.argv.find((a) => a.startsWith('--phase=')) || '--phase=1').split('=')[1]);
process.env.STUDYDECK_USER_DATA = process.env.UI_TEST_DATA;
const fixture = path.join(__dirname, 'fixtures', 'korean-modern.apkg');
require('../main.js');

let failures = 0;
function check(name, cond, extra) { if (cond) console.log('ok   ' + name); else { failures++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100 && !win; i++) { await sleep(100); win = BrowserWindow.getAllWindows()[0]; }
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  const run = (code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
  try {
    if (phase === 1) {
      check('home shows welcome', (await run('await renderHome(); return document.querySelector("#home h1").textContent')) === 'Welcome to StudyDeck');
      process.env.STUDYDECK_TEST_PICK = JSON.stringify([fixture]);
      const imp = await run('showPage("decks"); await doImport(); return document.querySelector("#import-results").textContent');
      check('import reports success', /✓/.test(imp), imp);
      const rows = await run('await renderDecks(); return document.querySelectorAll("#deck-list tbody tr").length');
      check('deck list has rows', rows > 0, String(rows));
      const q = await run('await startStudy(null); await new Promise(r=>setTimeout(r,400)); const f=document.querySelector(".card-frame"); return f ? f.srcdoc.length : -1');
      check('study shows a card', q > 20, String(q));
      // audio: a real sound file must load and be seekable through the sd-media address
      {
        const fs = require('fs');
        const mediaRoot = path.join(process.env.UI_TEST_DATA, 'media');
        const imp = fs.readdirSync(mediaRoot).filter((d) => /^\d+$/.test(d))[0];
        const n = 1600, data = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), i * 2);
        const hd = Buffer.alloc(44); hd.write('RIFF', 0); hd.writeUInt32LE(36 + data.length, 4); hd.write('WAVEfmt ', 8); hd.writeUInt32LE(16, 16); hd.writeUInt16LE(1, 20); hd.writeUInt16LE(1, 22);
        hd.writeUInt32LE(8000, 24); hd.writeUInt32LE(16000, 28); hd.writeUInt16LE(2, 32); hd.writeUInt16LE(16, 34); hd.write('data', 36); hd.writeUInt32LE(data.length, 40);
        fs.writeFileSync(path.join(mediaRoot, imp, 'beep.wav'), Buffer.concat([hd, data]));
        const res = await run(`const a=new Audio('sd-media://i${imp}/beep.wav'); return await new Promise(r=>{a.onloadedmetadata=()=>r('ok '+a.duration); a.onerror=()=>r('error '+(a.error&&a.error.code)); setTimeout(()=>r('timeout'),4000); a.load();})`);
        check('audio file loads in the window', /^ok 0\.\d+/.test(res), res);
        const rr = await require('electron').net.fetch(`sd-media://i${imp}/beep.wav`, { headers: { Range: 'bytes=0-9' } });
        const rg = `${rr.status} ${rr.headers.get('content-type')} ${rr.headers.get('content-range')}`;
        check('seeking (Range) is answered with 206', /^206 audio\/\S+ bytes 0-9\/3244$/.test(rg), rg);
        const bad = (await require('electron').net.fetch(`sd-media://i${imp}/..%2f..%2fstudydeck.db`)).status;
        check('files outside the media folder are refused', bad === 403 || bad === 404, String(bad));
      }
      const a = await run('showAnswer(); await new Promise(r=>setTimeout(r,200)); return document.querySelectorAll(".rate").length');
      check('answer shows 4 rating buttons', a === 4, String(a));
      await run('await rate(3); return 1');
      const prog = await run('return await sd.progress()');
      check('review is counted in progress', prog.today.reviewed === 1, JSON.stringify(prog.today));
      const mk = await run('return await sd.createDeck({ name: "Zed::Sub" })');
      check('new deck can be made', mk.ok === true && mk.name === 'Zed::Sub', JSON.stringify(mk));
      const ad = await run('return await sd.addNote({ deck: "Zed::Sub", type: "basic", fields: ["pear", "배"], tags: "" })');
      check('a card can be added', ad.ok === true && ad.cards === 1, JSON.stringify(ad));
      const bad = await run('return await sd.addNote({ deck: "Zed", type: "basic", fields: ["", "x"] })');
      check('an empty card is refused with a message', bad.ok === false && /Front/.test(bad.error), JSON.stringify(bad));
      await run('await sd.renameDeck({ from: "Zed", to: "Zulu" }); openBrowse("Zulu"); await new Promise(r=>setTimeout(r,500)); return 1');
      const shown = await run('return document.querySelector("#browse").textContent');
      check('Cards screen lists the card in the renamed deck', /pear/.test(shown) && /Zulu/.test(shown), shown.slice(0, 200));
      const ed = await run('const l = await sd.listNotes({ deck: "Zulu" }); const id = l.notes[0].id; const g = await sd.getNote({ id }); const u = await sd.updateNote({ id, fields: ["pear!", g.note.fields[1]], tags: "", deck: "Zulu::Sub" }); return { u, l: (await sd.listNotes({ deck: "Zulu", search: "pear!" })).total }');
      check('a card can be edited and found by search', ed.u.ok === true && ed.l === 1, JSON.stringify(ed));
      await run('return await sd.deleteDeck("Zulu")');
      await run('showPage("progress"); await new Promise(r=>setTimeout(r,300)); return 1');
      check('progress page draws', (await run('return document.querySelectorAll("#progress .stat").length')) === 4);
      // sounds: they play by themselves, one after another, when a side appears and when the answer is shown
      {
        const fsx = require('fs'); const root = path.join(process.env.UI_TEST_DATA, 'media');
        const imp = fsx.readdirSync(root).filter((d) => /^\d+$/.test(d))[0]; const U = `sd-media://i${imp}/beep.wav`;
        const seq = await run(`window.__soundLog.length = 0; await playSounds(['${U}', '${U}']); return window.__soundLog.join(',')`);
        check('two sounds play one after the other', seq === 'start:beep.wav,end:beep.wav,start:beep.wav,end:beep.wav', seq);
        const flow = await run(`window.__soundLog.length = 0; showPage('study');
          studyState = { deckName: null, busy: false, p: null, side: 'q', shownAt: 0 };
          renderStudy({ done: false, deck: 'T', cardId: 0, counts: { newCount: 1, learnCount: 0, reviewCount: 0 }, question: '<p>q</p>', answer: '<p>a</p>', typeExpected: null,
            labels: ['1m', '2m', '3m', '4m'], qSounds: ['${U}'], aSounds: ['${U}', '${U}'] });
          await new Promise((r) => setTimeout(r, 1500)); const afterQuestion = window.__soundLog.join(',');
          showAnswer(); await new Promise((r) => setTimeout(r, 2500));
          return [afterQuestion, window.__soundLog.join(',')];`);
        check('the question\'s sound plays by itself when the card appears', flow[0] === 'start:beep.wav,end:beep.wav', flow[0]);
        check('the answer\'s sounds play when the answer is shown', flow[1] === 'start:beep.wav,end:beep.wav,start:beep.wav,end:beep.wav,start:beep.wav,end:beep.wav', flow[1]);
        await run('showPage("home"); return 1');
      }
      await run('showPage("friends"); return 1');
      check('friends page draws', (await run('return document.querySelector("#friends h2").textContent')) === 'Friends');
      const pl = await run('showPage("plugins"); await new Promise(r=>setTimeout(r,300)); return document.querySelector("#plugins ul").textContent');
      check('plugin list shows example', /Hello/.test(pl), pl);
      const set = await run('return await sd.setSettings({newPerDay:15, reviewsPerDay:100})');
      check('settings save', set.ok === true);
      // Anki sync inside the real window, against Anki's own sync server (skipped when the "anki" Python package is missing)
      {
        const cp = require('child_process'); const fs = require('fs'); const os = require('os'); const net = require('net');
        const PY = process.env.ANKI_PY || 'python3';
        if (cp.spawnSync(PY, ['-c', 'import anki']).status !== 0) console.log('SKIPPED anki sync window test (no "anki" Python package)');
        else {
          const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ankisrv-')); const ep = `http://127.0.0.1:${port}/`;
          const srv = cp.spawn(PY, ['-m', 'anki.syncserver'], { env: { ...process.env, SYNC_USER1: 'u:p', SYNC_PORT: String(port), SYNC_HOST: '127.0.0.1', SYNC_BASE: dir }, stdio: 'ignore' });
          for (let i = 0; i < 50; i++) { try { await fetch(ep); break; } catch { await sleep(200); } }
          cp.spawnSync(PY, [path.join(__dirname, 'sync', 'seed.py'), path.join(dir, 'a.anki2'), ep, 'up']);
          check('Decks screen offers AnkiWeb sync', /Sync with AnkiWeb/.test(await run('showPage("decks"); await renderDecks(); await new Promise(r=>setTimeout(r,300)); return document.querySelector("#anki-sync").textContent')));
          check('wrong AnkiWeb password is explained', /email and password/.test((await run(`return await sd.ankiLogin({user:"u", password:"nope", endpoint:${JSON.stringify(ep)}})`)).error || ''));
          // like AnkiWeb: the address you type answers with a redirect to the server that holds your account (and "405 Not Allowed" to a bare POST)
          const http = require('http');
          const front = http.createServer((q, r) => { if (q.url === '/') { r.writeHead(405, { 'Content-Type': 'text/html' }); return r.end('<center><h1>405 Not Allowed</h1></center>nginx'); } r.writeHead(308, { Location: ep }); r.end(); });
          await new Promise((rs) => front.listen(0, '127.0.0.1', rs)); const frontUrl = `http://127.0.0.1:${front.address().port}/`;
          check('AnkiWeb sign-in works through a redirect (the 405 case)', (await run(`return await sd.ankiLogin({user:"u", password:"p", endpoint:${JSON.stringify(frontUrl)}})`)).ok === true);
          const s1 = await run('return await sd.ankiSync({})');
          check('first sync downloads decks and media', s1.ok && s1.imported && s1.imported.notesAdded >= 2 && s1.mediaDownloaded === 2, JSON.stringify(s1));
          const s2 = await run('return await sd.ankiSync({})');
          check('second sync is a no-op', s2.ok && s2.upToDate, JSON.stringify(s2));
          check('synced deck is in the list', (await run('return (await sd.listDecks()).some(d => /Greetings/.test(d.name))')) === true);
          const peerInspect = () => { const r = cp.spawnSync(PY, [path.join(__dirname, 'sync', 'peer.py'), path.join(dir, 'peer.anki2'), ep, 'inspect'], { encoding: 'utf8' }); const m = /RESULT (.*)/.exec(r.stdout); return m ? JSON.parse(m[1]) : null; };
          const nx = await run('return await sd.studyNext("Korean")');
          await run(`return await sd.studyAnswer({ cardId: ${nx.cardId}, rating: 3, ms: 1500, deckName: "Korean" })`);
          const s3 = await run('return await sd.ankiSync({})');
          check('studying in the window is sent to AnkiWeb', s3.ok && s3.pushed && s3.pushed.reviews === 1 && s3.pushed.cards === 1, JSON.stringify(s3));
          const seen = peerInspect();
          check('AnkiWeb really has the review (checked with the real Anki code)', !!seen && seen.revlog.length === 1 && seen.revlog[0].ease === 3 && seen.cards.some((c) => c.reps === 1), JSON.stringify(seen && seen.revlog));
          const sc = await run('await renderDecks(); await new Promise(r=>setTimeout(r,200)); document.querySelector("#anki-sync .btn").click(); await new Promise(r=>setTimeout(r,3000)); return document.querySelector("#anki-sync").textContent');
          check('Sync button on the Decks screen reports the result', /up to date|Done|sent/i.test(sc), sc.slice(0, 200));
          const g = await run('const p = sd.ankiSync({ force: true }); const [busy, r, w] = await Promise.all([sd.isSyncing(), sd.restart(), sd.downloadInstallUpdate()]); await p; return { busy, r, w, after: await sd.isSyncing() }');
          check('while syncing: the program knows, and restart / update install ask first instead of acting', g.busy === true && g.r && g.r.busy === true && g.w && (g.w.busy === true || g.w.ok === false) && g.after === false, JSON.stringify(g));
          front.close();
          const okImg = await run(`await renderDecks(); return document.querySelector("#anki-sync").textContent`);
          check('screen shows signed-in state', /last sync/.test(okImg), okImg.slice(0, 120));
          await run('await sd.ankiLogout(); return 1');
          srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      // friends: a real server on this computer, two people, sharing a subject, comparing
      const { createApp } = require('../server/server'); const { FriendsClient } = require('../core/friends-client');
      const srv = createApp({ dbPath: ':memory:' }); await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
      const url = 'http://127.0.0.1:' + srv.server.address().port;
      check('friends page asks to sign in', /server/i.test(await run('showPage("friends"); await new Promise(r=>setTimeout(r,300)); return document.querySelector("#friends").textContent')));
      check('server address is saved', (await run(`return await sd.friendsSetServer(${JSON.stringify(url)})`)).ok === true);
      check('account is created in the window', (await run('return await sd.friendsRegister({username:"alice", password:"password-1", displayName:"Alice"})')).ok === true);
      const subject = (await run('return await sd.friendsState()')).localSubjects[0];
      check('a subject can be shared', (await run(`return await sd.friendsSetShares([${JSON.stringify(subject)}])`)).ok === true, subject);
      const bob = new FriendsClient({ baseUrl: url }); await bob.register('bob', 'password-2', 'Bob');
      const code = (await run('return (await sd.friendsState()).me.friendCode'));
      check('friend request is sent by code', (await bob.request(code)).ok === true);
            check('Alice sees the request from Bob', (await run('return (await sd.friendsList()).incoming.length')) === 1);
      const inc = (await run('return (await sd.friendsList()).incoming[0]'));
      check('Alice accepts', (await run(`return await sd.friendsRespond(${inc.id}, true)`)).ok === true);
      await bob.pushProgress({ shares: [subject], days: [{ day: new Date().toISOString().slice(0, 10), subject, reviews: 3, correct: 3, minutes: 1 }], streak: 1 });
      const txt = await run('await renderFriends(); await new Promise(r=>setTimeout(r,500)); return document.querySelector("#friends").textContent');
      check('Friends screen shows Bob and the comparison', /Bob/.test(txt) && /Study together/.test(txt) && /You/.test(txt), txt.slice(0, 200));
      const cmp = await bob.compare(subject);
      check('Bob sees Alice\'s review from the window', cmp.members.some((m) => m.username === 'alice' && m.weekReviews >= 1), JSON.stringify(cmp));
      await srv.close();
      // Discord sign-in through the window, with a pretend Discord and a real friends server
      {
        const { startFakeDiscord } = require('./helpers/fake-discord'); const crypto = require('crypto');
        const fake = await startFakeDiscord();
        const srv2 = createApp({ dbPath: ':memory:', discord: { clientId: 'app-id', clientSecret: 'shh-secret', redirectUri: 'http://127.0.0.1/cb', apiBase: fake.apiBase, authUrl: 'https://discord.com/oauth2/authorize' } });
        await new Promise((r) => srv2.server.listen(0, '127.0.0.1', r)); const url2 = 'http://127.0.0.1:' + srv2.server.address().port;
        process.env.STUDYDECK_TEST_NO_OPEN = '1';
        await run('await sd.friendsLogout(); return 1');
        await run(`return await sd.friendsSetServer(${JSON.stringify(url2)})`);
        const scr = await run('showPage("friends"); await renderFriends(); await new Promise(r=>setTimeout(r,400)); return document.querySelector("#friends").textContent');
        check('sign-in screen offers Discord', /Continue with Discord/.test(scr), scr.slice(0, 150));
        const begin = await run('return await sd.friendsDiscordBegin()');
        check('Discord sign-in starts', begin.ok && /discord\.com\/oauth2\/authorize/.test(begin.url), JSON.stringify(begin));
        check('waiting for the browser', (await run('return await sd.friendsDiscordPoll()')).pending === true);
        await fetch(`${url2}/discord/callback?code=code-ann&state=${new URL(begin.url).searchParams.get('state')}`);   // what Discord's redirect does
        check('window is signed in after Discord approves', (await run('return await sd.friendsDiscordPoll()')).done === true);
        const stt = await run('return await sd.friendsState()');
        check('account is linked to Discord', stt.signedIn && stt.me.discord.linked, JSON.stringify(stt.me));
        check('"let people find me" can be switched on', (await run('return await sd.friendsSetDiscoverable(true)')).ok === true);
        const ben = new FriendsClient({ baseUrl: url2 }); const bp = crypto.randomBytes(32).toString('hex'); const bs = await ben.discordStart(bp);
        await fetch(`${url2}/discord/callback?code=code-ben&state=${new URL(bs.url).searchParams.get('state')}`); await ben.discordPoll(bp); await ben.setDiscoverable(true);
        const people = await run('showPage("friends"); await renderFriends(); await new Promise(r=>setTimeout(r,500)); return document.querySelector("#friends").textContent');
        check('"People you may know" shows Ben', /People you may know/.test(people) && /Ben/.test(people) && /1 shared Discord server/.test(people), people.slice(0, 300));
        await run('await sd.friendsLogout(); return 1');
        await srv2.close(); await fake.close();
      }
      // build an update with a higher version and install it through the real screens
      const fs = require('fs'); const os = require('os'); const cp = require('child_process');
      const root = path.join(__dirname, '..');
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-upd-'));
      const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const [a1, b1, c1] = pk.version.split('.'); const next = `${a1}.${b1}.${Number(c1) + 1}`;
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-src-'));
      for (const e of ['app-main.js', 'preload.js', 'package.json', 'core', 'renderer', 'plugins-example', 'tools']) fs.cpSync(path.join(root, e), path.join(tmpRoot, e), { recursive: true });
      const p2 = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'package.json'), 'utf8')); p2.version = next; fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify(p2));
      const made = cp.execFileSync(process.execPath.includes('electron') ? 'node' : process.execPath, [path.join(tmpRoot, 'tools', 'make-update.js'), '--notes', 'UI test', '--out', out]).toString().trim().split('  ')[0];
      process.env.STUDYDECK_TEST_PICK = JSON.stringify([made]);
      const ch = await run('return await sd.chooseUpdate()');
      check('update file is accepted', ch.ok && ch.version === next, JSON.stringify(ch));
      const ins = await run('return await sd.installUpdate()');
      check('update installs', ins.ok === true, JSON.stringify(ins));
      console.log('NEXT=' + next);
    } else if (phase === 2) {
      const info = await run('return await sd.info()');
      check('restart uses the installed update', info.usingUpdate === true && info.version !== info.baseVersion, JSON.stringify(info));
      check('decks and progress survived', (await run('return (await sd.progress()).today.reviewed')) >= 1);
      await run('await sd.removeUpdates(); return 1');
    } else if (phase === 3) {
      const info = await run('return await sd.info()');
      check('back on the built-in version', info.usingUpdate === false && info.version === info.baseVersion, JSON.stringify(info));
      check('decks still there', (await run('return (await sd.listDecks()).length')) > 0);
    }
  } catch (e) { failures++; console.log('FAIL exception: ' + e.message); }
  console.log(failures ? `UI TEST FAILED (${failures})` : `UI TEST PHASE ${phase} PASSED`);
  app.exit(failures ? 1 : 0);
});
