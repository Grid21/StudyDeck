'use strict';
// One complete AnkiWeb sync: bring in what is new on AnkiWeb, then send what was studied here.
// Shared by the program and by the tests. No Electron code. `saveState(state)` is called whenever the sync state changes.
const ankiSync = require('./anki-sync');
const { readCollection } = require('./apkg');
const { buildPush } = require('./anki-push');

async function runSync({ client, store, fs, path, os, mediaDir, state = {}, saveState = () => {}, force = false, onProgress = () => {}, onRedirect = () => {}, onBackup = () => {} }) {
  const out = { ok: true, upToDate: true, imported: null, mediaDownloaded: 0, pushed: null, skipped: [] };
  let mustDownload = force || !state.counts || state.usn === undefined || !state.crt;      // older sync data: download once more
  for (let attempt = 0; attempt < 2; attempt++) {
    // 1. bring in what is new on AnkiWeb
    const r = await ankiSync.pull(client, { fs, path, mediaDir, state, force: mustDownload, onProgress });
    out.mediaDownloaded += r.mediaDownloaded;
    if (client.redirectedTo) onRedirect(client.redirectedTo);      // AnkiWeb told us which of its servers holds this account
    state = { ...state, mod: r.meta.mod, scm: r.meta.scm, usn: r.meta.usn, mediaUsn: r.mediaUsn, files: r.files, lastSync: Date.now() };
    if (r.dbBytes) {
      onBackup(r.dbBytes);      // a copy of AnkiWeb's collection exactly as downloaded, before StudyDeck sends anything
      onProgress('Adding the cards to StudyDeck…');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studydeck-sync-'));
      try {
        const { data, warnings } = readCollection(r.dbBytes, tmp, 'sync');
        const imp = store.importCollection({ ...data, mediaDir, mediaCount: r.mediaDownloaded, warnings }, { name: 'AnkiWeb sync', keepProgress: true, sync: true });
        out.imported = out.imported ? { ...imp, cardsAdded: out.imported.cardsAdded + imp.cardsAdded } : imp;
        out.upToDate = false;
        state.counts = data.serverCounts; state.crt = data.crt;
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    saveState(state);

    // 2. send what was studied here
    const pending = store.pendingPush();
    if (!pending.cards.length && !pending.revlog.length) break;
    const c = state.counts || {};
    if (c.notetypes == null || c.decks == null || c.deckConfig == null) { out.skipped.push('this AnkiWeb collection is in an old format that StudyDeck cannot send to'); break; }
    const built = buildPush(pending, { crt: state.crt, serverUsn: state.usn });
    out.skipped.push(...built.skipped);
    if (!built.cards.length && !built.revlog.length) { store.markPushed(built.sent); break; }
    try {
      const res = await ankiSync.pushChanges(client, { usn: state.usn, serverUsn: state.usn, counts: c, cards: built.cards, revlog: built.revlog, onProgress });
      store.markPushed(built.sent);
      state = { ...state, mod: res.mod, usn: res.usn, counts: { ...c, revlog: c.revlog + built.revlog.length }, lastSync: Date.now() };
      saveState(state);
      out.pushed = { cards: built.cards.length, reviews: built.revlog.length }; out.upToDate = false;
      break;
    } catch (err) {
      if (err instanceof ankiSync.RemoteChanged && attempt === 0) { mustDownload = true; continue; }     // AnkiWeb changed meanwhile: download again, then retry
      if (err instanceof ankiSync.RemoteChanged) throw new ankiSync.SyncError('AnkiWeb changed while syncing. Please press Sync now again.');
      throw err;
    }
  }
  out.skipped = [...new Set(out.skipped)];
  return out;
}

module.exports = { runSync };
