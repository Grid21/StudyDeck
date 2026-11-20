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
      const a = await run('showAnswer(); await new Promise(r=>setTimeout(r,200)); return document.querySelectorAll(".rate").length');
      check('answer shows 4 rating buttons', a === 4, String(a));
      await run('await rate(3); return 1');
      const prog = await run('return await sd.progress()');
      check('review is counted in progress', prog.today.reviewed === 1, JSON.stringify(prog.today));
      await run('showPage("progress"); await new Promise(r=>setTimeout(r,300)); return 1');
      check('progress page draws', (await run('return document.querySelectorAll("#progress .stat").length')) === 4);
      await run('showPage("friends"); return 1');
      check('friends page draws', (await run('return document.querySelector("#friends h2").textContent')) === 'Friends');
      const pl = await run('showPage("plugins"); await new Promise(r=>setTimeout(r,300)); return document.querySelector("#plugins ul").textContent');
      check('plugin list shows example', /Hello/.test(pl), pl);
      const set = await run('return await sd.setSettings({newPerDay:15, reviewsPerDay:100})');
      check('settings save', set.ok === true);
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
      check('decks and progress survived', (await run('return (await sd.progress()).today.reviewed')) === 1);
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
