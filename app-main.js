'use strict';
const { app, BrowserWindow, ipcMain, shell, net, dialog, protocol, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const pkg = require('./package.json');
const plugins = require('./core/plugins');
const { checkForUpdate, repoFromUrl } = require('./core/updates');
const ghUpdates = require('./core/gh-updates');
const { Store } = require('./core/store');
const { parseApkg, readCollection, ImportError } = require('./core/apkg');
const ankiSync = require('./core/anki-sync');
const { makeFetch } = require('./core/net-request-fetch');
const { runSync } = require('./core/anki-run');
const { renderCard } = require('./core/render');
const sched = require('./core/scheduler');
const updatepkg = require('./core/updatepkg');
const { FriendsClient, checkServerUrl } = require('./core/friends-client');

// Information from the start-up file (main.js). Defaults let this file also run on its own.
const boot = global.studydeckBoot || {
  root: __dirname, baseRoot: __dirname, baseVersion: pkg.version, usingUpdate: false,
  updatesDir: path.join(app.getPath('userData'), 'updates'), markOk() {}
};

const smokeTest = process.argv.includes('--smoke-test');
let pluginList = [];
let store = null;
let chosenUpdate = null;
let forceClose = false;

// Pictures and sounds from decks are served through this address. Nothing else is.
protocol.registerSchemesAsPrivileged([{ scheme: 'sd-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Keeps the last 3 copies of the collection as downloaded from AnkiWeb (before StudyDeck sends anything back). Never stops a sync.
function saveAnkiBackup(bytes) {
  try {
    const dir = dataPath('anki-backups'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ankiweb-' + new Date().toISOString().replace(/[:.]/g, '-') + '.anki2'), bytes);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.anki2')).sort().slice(0, -3);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* a failed backup must not block syncing */ }
}
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
      contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  win.setMenuBarVisibility(false);
  win.on('close', (ev) => {      // closing while decks are syncing: ask first
    if (!ankiBusy || forceClose) return;
    ev.preventDefault();
    const c = dialog.showMessageBoxSync(win, { type: 'question', title: 'StudyDeck', message: 'Your decks are syncing with AnkiWeb right now.',
      detail: 'Closing now could interrupt the sync. What would you like to do?', buttons: ['Wait for the sync, then close', 'Close anyway', 'Keep StudyDeck open'], defaultId: 0, cancelId: 2 });
    if (c === 0) afterSync.push(() => { forceClose = true; win.close(); });
    else if (c === 1) { forceClose = true; win.close(); }
  });
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
    question: r.question, answer: r.answer, typeExpected: r.typeExpected, qSounds: r.qSounds, aSounds: r.aSounds,
    labels: sched.previewLabels(d.card, now), shownAt: now
  };
}
ipcMain.handle('study:next', (_e, deckName) => studyPayload(typeof deckName === 'string' ? deckName : null));
ipcMain.handle('study:answer', (_e, a) => {
  if (!a || !Number.isInteger(a.cardId) || ![1, 2, 3, 4].includes(a.rating)) return { error: 'Bad answer.' };
  store.answerCard(a.cardId, a.rating, Number(a.ms) || 0);
  syncSoon();
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

// ---- making and editing decks and cards ----
const guard = (fn) => (_e, a) => { try { return { ok: true, ...(fn(a || {}) || {}) }; } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('decks:create', guard((a) => store.createDeck(a.name)));
ipcMain.handle('decks:rename', guard((a) => store.renameDeck(String(a.from), a.to)));
ipcMain.handle('notes:add', guard((a) => store.addNote({ deck: a.deck, type: String(a.type), fields: a.fields, tags: a.tags })));
ipcMain.handle('notes:list', guard((a) => store.listNotes({ deck: typeof a.deck === 'string' ? a.deck : null, search: String(a.search || ''), offset: Number(a.offset) || 0 })));
ipcMain.handle('notes:get', guard((a) => { const n = store.getNote(Number(a.id)); if (!n) throw new Error('That card no longer exists.'); return { note: n }; }));
ipcMain.handle('notes:update', guard((a) => store.updateNote(Number(a.id), { fields: a.fields, tags: a.tags, deck: a.deck })));
ipcMain.handle('notes:delete', guard((a) => store.deleteNote(Number(a.id))));

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
const restartNow = () => { forceClose = true; app.relaunch(); app.exit(0); };
ipcMain.handle('app:restart', (_e, o) => { if (ankiBusy && !(o && o.force)) return { busy: true }; restartNow(); return { ok: true }; });
ipcMain.handle('app:restartWhenSynced', () => { if (!ankiBusy) { restartNow(); return { ok: true }; } afterSync.push(restartNow); return { ok: true, waiting: true }; });
ipcMain.handle('app:syncing', () => ankiBusy);
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

// ---- updates from GitHub: check, download + install, restart ----
let foundUpdate = null;
ipcMain.handle('updates:check', async () => {
  const r = await ghUpdates.findUpdate({ currentVersion: pkg.version, fetchFn: (u, o) => net.fetch(u, o) });
  foundUpdate = r.updateAvailable ? r.file : null;
  if (r.ok) store.setSetting('updates.lastCheck', Date.now());
  return r;
});
async function installFoundUpdate() {
  if (!foundUpdate) return { ok: false, error: 'Check for updates first.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studydeck-dl-'));
  try {
    const f = await ghUpdates.downloadUpdate({ file: foundUpdate, dest: path.join(dir, foundUpdate.name), fetchFn: (u, o) => net.fetch(u, o), fs });
    const m = updatepkg.installUpdate(f, { baseRoot: boot.baseRoot, baseVersion: boot.baseVersion, runningVersion: pkg.version, updatesDir: boot.updatesDir });
    foundUpdate = null;
    return { ok: true, version: m.version, autoRestart: store.getSetting('updates.autoRestart') === true };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// o.now: install even though a sync is running. o.waitForSync: install when it has finished. Neither, during a sync: ask the person.
ipcMain.handle('updates:downloadInstall', async (e, o = {}) => {
  if (ankiBusy && !o.now) {
    if (!o.waitForSync) return { busy: true };
    const sender = e.sender;
    afterSync.push(async () => { const r = await installFoundUpdate(); try { sender.send('updates:installed', r); } catch { /* window closed */ } });
    return { ok: true, waiting: true };
  }
  return installFoundUpdate();
});
ipcMain.handle('updates:getPrefs', () => ({ autoRestart: store.getSetting('updates.autoRestart') === true, autoCheck: store.getSetting('updates.autoCheck') !== false }));
ipcMain.handle('updates:setPrefs', (_e, p) => { if (p && typeof p.autoRestart === 'boolean') store.setSetting('updates.autoRestart', p.autoRestart); if (p && typeof p.autoCheck === 'boolean') store.setSetting('updates.autoCheck', p.autoCheck); return { ok: true }; });

// kept for later: asks GitHub for a newer release (not shown in the screen for now)
ipcMain.handle('updates:checkOnline', () => checkForUpdate({
  repo: repoFromUrl(pkg.homepage), currentVersion: pkg.version, fetchFn: (url, opts) => net.fetch(url, opts)
}));

// ---- friends and shared progress -------------------------------------------------------------
// Only daily totals for subjects you tick are sent. Cards and notes never leave this computer.
function saveToken(t) {
  if (!t) return store.setSetting('friends.token', '');
  const enc = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(t).toString('base64') : 'plain:' + t;
  store.setSetting('friends.token', enc);
}
function loadToken() {
  const v = store.getSetting('friends.token') || '';
  try { return v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.replace(/^plain:/, ''); } catch { return ''; }
}
function friendsClient() {
  const server = store.getSetting('friends.server') || '';
  return server ? new FriendsClient({ baseUrl: server, token: loadToken(), fetchFn: (u, o) => net.fetch(u, o) }) : null;
}
const shares = () => (Array.isArray(store.getSetting('friends.shares')) ? store.getSetting('friends.shares') : []);
async function pushProgress(c) {
  const list = shares();
  const days = store.dailyBySubject(30).filter((d) => list.includes(d.subject));
  return c.pushProgress({ shares: list, days, streak: store.stats().streak });
}
let syncTimer = null;
function syncSoon() {
  if (syncTimer || !store || !store.getSetting('friends.token')) return;
  syncTimer = setTimeout(async () => { syncTimer = null; try { const c = friendsClient(); if (c && c.token) await pushProgress(c); } catch { /* try again later */ } }, 15000);
}
const needClient = () => { const c = friendsClient(); return c && c.token ? c : null; };
const NOT_IN = { ok: false, error: 'You are not signed in.' };
async function signedIn(fn) {
  const c = needClient(); if (!c) return NOT_IN;
  const r = await fn(c);
  if (r && r.status === 401) { saveToken(''); return { ok: false, error: 'Your sign-in expired. Please sign in again.', signedOut: true }; }
  return r;
}

ipcMain.handle('friends:state', async () => {
  const server = store.getSetting('friends.server') || '';
  const c = needClient();
  const base = { server, signedIn: false, localSubjects: store.subjects(), shares: shares() };
  if (!c) return base;
  const me = await c.me();
  if (!me.ok) { if (me.status === 401) saveToken(''); return { ...base, error: me.error }; }
  return { ...base, signedIn: true, me: { username: me.username, displayName: me.displayName, friendCode: me.friendCode, discord: me.discord, discoverable: !!me.discoverable } };
});
ipcMain.handle('friends:setServer', (_e, url) => {
  const r = checkServerUrl(url); if (!r.ok) return r;
  if (r.url !== store.getSetting('friends.server')) { saveToken(''); store.setSetting('friends.server', r.url); }
  return { ok: true, url: r.url };
});
async function authenticate(kind, a) {
  const c = friendsClient(); if (!c) return { ok: false, error: 'Enter the friends server address first.' };
  const r = kind === 'register' ? await c.register(String(a.username || ''), String(a.password || ''), String(a.displayName || '')) : await c.login(String(a.username || ''), String(a.password || ''));
  if (!r.ok) return r;
  saveToken(c.token); syncSoon();
  return { ok: true };
}
ipcMain.handle('friends:register', (_e, a) => authenticate('register', a || {}));
ipcMain.handle('friends:login', (_e, a) => authenticate('login', a || {}));
ipcMain.handle('friends:logout', async () => { const c = needClient(); if (c) await c.logout(); saveToken(''); return { ok: true }; });
ipcMain.handle('friends:list', () => signedIn((c) => c.friends()));
ipcMain.handle('friends:request', (_e, to) => signedIn((c) => c.request(String(to || ''))));
ipcMain.handle('friends:respond', (_e, id, accept) => signedIn((c) => c.respond(Number(id), accept === true)));
ipcMain.handle('friends:remove', (_e, username) => signedIn((c) => c.remove(String(username || ''))));
ipcMain.handle('friends:setShares', (_e, list) => {
  const local = new Set(store.subjects());
  store.setSetting('friends.shares', (Array.isArray(list) ? list : []).filter((s) => local.has(s)));
  return signedIn((c) => pushProgress(c));
});
ipcMain.handle('friends:sync', () => signedIn((c) => pushProgress(c)));
ipcMain.handle('friends:compare', (_e, subject) => signedIn((c) => c.compare(String(subject || ''))));
ipcMain.handle('friends:subjects', () => signedIn((c) => c.subjects()));
let discordPollSecret = null;
ipcMain.handle('friends:discordConfig', async () => { const c = friendsClient(); if (!c) return { enabled: false }; const r = await c.discordConfig(); return { enabled: !!(r.ok && r.enabled) }; });
ipcMain.handle('friends:discordBegin', async () => {
  const c = friendsClient(); if (!c) return { ok: false, error: 'Enter the friends server address first.' };
  const secret = require('crypto').randomBytes(32).toString('hex');
  const r = await c.discordStart(secret); if (!r.ok) return r;
  if (!/^https:\/\/(discord|discordapp)\.com\//.test(String(r.url))) return { ok: false, error: 'The server sent an unexpected Discord address.' };
  discordPollSecret = secret;
  if (!process.env.STUDYDECK_TEST_NO_OPEN) shell.openExternal(r.url);
  return { ok: true, url: r.url };
});
ipcMain.handle('friends:discordPoll', async () => {
  const c = friendsClient(); if (!c || !discordPollSecret) return { ok: false, error: 'Start the Discord sign-in first.' };
  const r = await c.discordPoll(discordPollSecret);
  if (r.ok && r.token) { saveToken(c.token); discordPollSecret = null; syncSoon(); return { ok: true, done: true }; }
  if (r.ok && r.pending) return { ok: true, pending: true };
  discordPollSecret = null; return { ok: false, error: r.error || 'Discord sign-in did not finish.' };
});
ipcMain.handle('friends:setDiscoverable', (_e, on) => signedIn((c) => c.setDiscoverable(on === true)));
ipcMain.handle('friends:suggestions', () => signedIn((c) => c.discordSuggestions()));
ipcMain.handle('friends:deleteAccount', async (_e, password) => { const r = await signedIn((c) => c.deleteAccount(String(password || ''), password === 'DELETE' ? 'DELETE' : undefined)); if (r.ok) saveToken(''); return r; });

// ---- pictures and sounds from decks -------------------------------------------------------------
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
  mp4: 'video/mp4', ogv: 'video/ogg', mov: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
// Serves a file with a content type and "Range" support. Sound players need both to start and to seek.
async function mediaResponse(req) {
  try {
    const u = new URL(req.url);
    const root = dataPath('media');
    const id = /^i(\d+)$/.exec(u.hostname);
    if (!id) return new Response('Not allowed', { status: 403 });
    const file = path.join(root, id[1], decodeURIComponent(u.pathname.replace(/^\//, '')));
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return new Response('Not allowed', { status: 403 });
    let st; try { st = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
    if (!st.isFile()) return new Response('Not found', { status: 404 });
    const headers = { 'Content-Type': MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = st.size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); } else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = String(st.size ? end - start + 1 : 0);
    if (!st.size) return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
  } catch { return new Response('Bad address', { status: 400 }); }
}

// ---- Anki sync (download from AnkiWeb) ----------------------------------------------------------
// StudyDeck stores only the sign-in key AnkiWeb gives back, never your password. One way: AnkiWeb -> StudyDeck.
function saveSecret(key, v) {
  if (!v) return store.setSetting(key, '');
  store.setSetting(key, (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(v).toString('base64') : 'plain:' + v));
}
function loadSecret(key) {
  const v = store.getSetting(key) || '';
  try { return v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.replace(/^plain:/, ''); } catch { return ''; }
}
const ankiFetch = makeFetch(net);     // sees AnkiWeb's redirects (Electron's net.fetch loses the request path when it follows one)
const newAnkiClient = (endpoint, hkey) => new ankiSync.AnkiSyncClient({ endpoint, hkey, fetchFn: ankiFetch, appVersion: pkg.version, platform: process.platform });
let ankiBusy = false;
const afterSync = [];      // things to do when the running sync has finished (restart, close, install)
function runAfterSync() { if (ankiBusy) return; while (afterSync.length) { try { afterSync.shift()(); } catch { /* ignore */ } } }

ipcMain.handle('anki:state', () => {
  const st = store.getSetting('anki.state') || {};
  return { signedIn: !!loadSecret('anki.hkey'), user: store.getSetting('anki.user') || '', endpoint: store.getSetting('anki.endpoint') || ankiSync.DEFAULT_ENDPOINT, defaultEndpoint: ankiSync.DEFAULT_ENDPOINT, lastSync: st.lastSync || 0 };
});
ipcMain.handle('anki:login', async (_e, a = {}) => {
  try {
    const c = newAnkiClient(String(a.endpoint || '').trim() || ankiSync.DEFAULT_ENDPOINT, '');
    const key = await c.login(String(a.user || '').trim(), String(a.password || ''));
    saveSecret('anki.hkey', key); store.setSetting('anki.user', String(a.user).trim()); store.setSetting('anki.endpoint', c.endpoint); store.setSetting('anki.redirect', ''); store.setSetting('anki.state', {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('anki:logout', () => { saveSecret('anki.hkey', ''); store.setSetting('anki.state', {}); store.setSetting('anki.redirect', ''); return { ok: true }; });
ipcMain.handle('anki:sync', async (e, opts = {}) => {
  const key = loadSecret('anki.hkey');
  if (!key) return { ok: false, error: 'You are not signed in to AnkiWeb.' };
  if (ankiBusy) return { ok: false, error: 'A sync is already running.' };
  ankiBusy = true;
  const send = (m) => { try { e.sender.send('anki:progress', m); } catch { /* window closed */ } };
  try {
    const client = newAnkiClient(store.getSetting('anki.redirect') || store.getSetting('anki.endpoint') || ankiSync.DEFAULT_ENDPOINT, key);
    const out = await runSync({ client, store, fs, path, os, mediaDir: dataPath('anki-media'), state: store.getSetting('anki.state') || {},
      saveState: (s) => store.setSetting('anki.state', s), force: opts.force === true, onProgress: send, onRedirect: (u) => store.setSetting('anki.redirect', u), onBackup: saveAnkiBackup });
    await plugins.api.emit('deck:imported', { source: 'anki-sync' });
    return out;
  } catch (err) {
    if (err.authExpired) saveSecret('anki.hkey', '');
    return { ok: false, error: err.message || 'The sync failed.', signedOut: !!err.authExpired };
  } finally { ankiBusy = false; runAfterSync(); }
});

// ---- start ---------------------------------------------------------------------------------
app.whenReady().then(async () => {
  protocol.handle('sd-media', mediaResponse);
  store = new Store(dataPath('studydeck.db'), dataPath('media'));
  prepareExamplePlugin();
  syncSoon();
  pluginList = plugins.loadAll(pluginsDir());
  createWindow();
  await plugins.api.emit('app:ready', {});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (store) store.close(); } catch { /* ignore */ } });
