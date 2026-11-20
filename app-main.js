'use strict';
const { app, BrowserWindow, ipcMain, shell, net, dialog, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const pkg = require('./package.json');
const plugins = require('./core/plugins');
const { checkForUpdate, repoFromUrl } = require('./core/updates');
const { Store } = require('./core/store');
const { parseApkg, ImportError } = require('./core/apkg');
const { renderCard } = require('./core/render');
const sched = require('./core/scheduler');
const updatepkg = require('./core/updatepkg');

// Information from the start-up file (main.js). Defaults let this file also run on its own.
const boot = global.studydeckBoot || {
  root: __dirname, baseRoot: __dirname, baseVersion: pkg.version, usingUpdate: false,
  updatesDir: path.join(app.getPath('userData'), 'updates'), markOk() {}
};

const smokeTest = process.argv.includes('--smoke-test');
let pluginList = [];
let store = null;
let chosenUpdate = null;

// Pictures and sounds from decks are served through this address. Nothing else is.
protocol.registerSchemesAsPrivileged([{ scheme: 'sd-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function dataPath(...p) { return path.join(app.getPath('userData'), ...p); }
function pluginsDir() { return dataPath('plugins'); }

function prepareExamplePlugin() {
  try {
    const dest = path.join(pluginsDir(), 'hello');
    if (fs.existsSync(dest)) return;
    const src = path.join(__dirname, 'plugins-example', 'hello');
    if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  } catch (e) { console.error('example plugin copy failed:', e.message); }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 760, minHeight: 540,
    title: 'StudyDeck',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => { boot.markOk(); });
  if (smokeTest) {
    win.webContents.on('did-finish-load', async () => {
      const title = await win.webContents.executeJavaScript('document.querySelector("h1") && document.querySelector("h1").textContent');
      console.log('SMOKE-TEST window loaded, heading =', title, ', plugins =', pluginList.length, ', version =', pkg.version);
      app.exit(title ? 0 : 1);
    });
    win.webContents.on('did-fail-load', () => app.exit(1));
  }
  return win;
}

async function pickFiles(win, options) {
  if (process.env.STUDYDECK_TEST_PICK) return JSON.parse(process.env.STUDYDECK_TEST_PICK);
  const r = await dialog.showOpenDialog(win, options);
  return r.canceled ? [] : r.filePaths;
}

// ---- decks ---------------------------------------------------------------------------------
ipcMain.handle('decks:list', () => store.listDecks());

ipcMain.handle('decks:import', async (e, args = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  let files = Array.isArray(args.paths) && args.paths.length ? args.paths : await pickFiles(win, {
    title: 'Choose Anki deck files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Anki decks', extensions: ['apkg', 'colpkg'] }]
  });
  if (!files.length) return { cancelled: true, results: [] };
  const keepProgress = args.keepProgress !== false;
  const results = [];
  for (const f of files) {
    const name = path.basename(String(f));
    if (!/\.(apkg|colpkg)$/i.test(name)) { results.push({ file: name, ok: false, error: 'This is not an Anki deck file (.apkg or .colpkg).' }); continue; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studydeck-import-'));
    try {
      const parsed = parseApkg(f, tmp);
      const r = store.importCollection(parsed, { name, keepProgress });
      results.push({ file: name, ok: true, ...r });
    } catch (err) {
      results.push({ file: name, ok: false, error: err instanceof ImportError ? err.message : 'The import failed: ' + err.message });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { results };
});

ipcMain.handle('decks:delete', (_e, name) => (typeof name === 'string' ? store.deleteDeckByName(name) : 0));

// ---- studying ------------------------------------------------------------------------------
function studyPayload(deckName) {
  const now = Date.now();
  const ids = store.deckIdsByName(deckName);
  const counts = store.queueCounts(ids, now);
  const id = store.nextCardId(ids, now);
  if (!id) return { done: true, counts };
  const d = store.getCardData(id);
  const r = renderCard(d.ctx, d.importId);
  return {
    done: false, cardId: id, state: d.card.state, deck: d.ctx.deckName, counts,
    question: r.question, answer: r.answer, typeExpected: r.typeExpected,
    labels: sched.previewLabels(d.card, now), shownAt: now
  };
}
ipcMain.handle('study:next', (_e, deckName) => studyPayload(typeof deckName === 'string' ? deckName : null));
ipcMain.handle('study:answer', (_e, a) => {
  if (!a || !Number.isInteger(a.cardId) || ![1, 2, 3, 4].includes(a.rating)) return { error: 'Bad answer.' };
  store.answerCard(a.cardId, a.rating, Number(a.ms) || 0);
  return studyPayload(typeof a.deckName === 'string' ? a.deckName : null);
});

// ---- progress, settings --------------------------------------------------------------------
ipcMain.handle('progress:get', () => store.stats());
ipcMain.handle('settings:get', () => store.settings());
ipcMain.handle('settings:set', (_e, s) => {
  const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 9999;
  if (!s || !ok(s.newPerDay) || !ok(s.reviewsPerDay)) return { ok: false, error: 'Please enter whole numbers from 0 to 9999.' };
  store.setSetting('newPerDay', s.newPerDay); store.setSetting('reviewsPerDay', s.reviewsPerDay);
  return { ok: true };
});

// ---- app, plugins, updates -----------------------------------------------------------------
ipcMain.handle('app:info', () => {
  let problem = '';
  try { problem = fs.readFileSync(boot.problemPath || '', 'utf8').trim(); } catch { /* none */ }
  const state = updatepkg.readState(boot.updatesDir);
  return {
    name: 'StudyDeck', version: pkg.version, baseVersion: boot.baseVersion, usingUpdate: !!boot.usingUpdate,
    pendingUpdate: state && state.version !== pkg.version ? state.version : null,
    platform: process.platform, dataDir: app.getPath('userData'), pluginsDir: pluginsDir(), problem
  };
});
ipcMain.handle('app:restart', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('plugins:list', () => pluginList);
ipcMain.handle('plugins:openFolder', () => { fs.mkdirSync(pluginsDir(), { recursive: true }); return shell.openPath(pluginsDir()); });

ipcMain.handle('updates:choose', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const files = await pickFiles(win, { title: 'Choose a StudyDeck update file', properties: ['openFile'], filters: [{ name: 'StudyDeck update', extensions: ['studyupdate'] }] });
  if (!files.length) return { cancelled: true };
  try {
    const { manifest, files: fm } = updatepkg.readUpdate(files[0]);
    chosenUpdate = files[0];
    return { ok: true, file: path.basename(files[0]), version: manifest.version, notes: manifest.notes, fileCount: fm.size, current: pkg.version };
  } catch (err) { chosenUpdate = null; return { ok: false, error: err.message }; }
});
ipcMain.handle('updates:install', () => {
  if (!chosenUpdate) return { ok: false, error: 'Choose an update file first.' };
  try {
    const m = updatepkg.installUpdate(chosenUpdate, { baseRoot: boot.baseRoot, baseVersion: boot.baseVersion, runningVersion: pkg.version, updatesDir: boot.updatesDir });
    chosenUpdate = null;
    return { ok: true, version: m.version };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('updates:remove', () => { updatepkg.removeUpdates(boot.updatesDir); return { ok: true }; });

// kept for later: asks GitHub for a newer release (not shown in the screen for now)
ipcMain.handle('updates:checkOnline', () => checkForUpdate({
  repo: repoFromUrl(pkg.homepage), currentVersion: pkg.version, fetchFn: (url, opts) => net.fetch(url, opts)
}));

// ---- start ---------------------------------------------------------------------------------
app.whenReady().then(async () => {
  protocol.handle('sd-media', (req) => {
    try {
      const u = new URL(req.url);
      const file = path.join(dataPath('media'), u.hostname, decodeURIComponent(u.pathname.replace(/^\//, '')));
      const rel = path.relative(dataPath('media'), file);
      if (!/^\d+$/.test(u.hostname) || rel.startsWith('..') || path.isAbsolute(rel)) return new Response('Not allowed', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    } catch { return new Response('Bad address', { status: 400 }); }
  });
  store = new Store(dataPath('studydeck.db'), dataPath('media'));
  prepareExamplePlugin();
  pluginList = plugins.loadAll(pluginsDir());
  createWindow();
  await plugins.api.emit('app:ready', {});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (store) store.close(); } catch { /* ignore */ } });
