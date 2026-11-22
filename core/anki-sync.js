'use strict';
// Downloads your decks from AnkiWeb (or any Anki sync server) using Anki's own sync protocol (version 11).
// One way only: it PULLS. Nothing you do in StudyDeck is sent back to AnkiWeB.
// No Electron code in here. Needs Node.js 24 or newer (zstd).
const zlib = require('zlib');
const crypto = require('crypto');
const fflate = require('./vendor/fflate.js');

const SYNC_VERSION = 11;
const DEFAULT_ENDPOINT = 'https://sync.ankiweb.net/';
const MEDIA_BATCH = 25;

class SyncError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'SyncError'; Object.assign(this, extra); }
}

function normalizeEndpoint(raw) {
  let u;
  try { u = new URL(String(raw || DEFAULT_ENDPOINT).trim()); } catch { throw new SyncError('That server address is not valid.'); }
  if (!/^https?:$/.test(u.protocol)) throw new SyncError('The server address must start with https://');
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  if (u.protocol === 'http:' && !local) throw new SyncError('Use an https:// address, so your password is not sent in the open.');
  return u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/');
}

function safeName(n) { return typeof n === 'string' && n.length > 0 && n.length < 256 && !/[\\/\u0000]/.test(n) && n !== '.' && n !== '..' && !n.startsWith('_meta'); }

class AnkiSyncClient {
  // appVersion: StudyDeck's own version. platform: process.platform
  constructor({ endpoint, hkey = '', fetchFn, appVersion = '0.0.0', platform = 'linux' }) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.hkey = hkey;
    this.fetchFn = fetchFn || fetch;
    this.appVersion = appVersion;
    this.platform = platform;
    this.session = crypto.randomBytes(6).toString('base64url').slice(0, 6);
  }

  header() {
    return JSON.stringify({ v: SYNC_VERSION, k: this.hkey, c: this.clientVersion(), s: this.session });
  }

  // Sends one request. `body` is an object (sent as JSON) or bytes. Returns the unpacked reply bytes.
  // AnkiWeb answers its first request with a redirect (308) to the server that holds your account. The Location it sends is
  // that server's BASE address, so redirects are never followed blindly (a blind follow posts to the bare address, and the
  // web server answers "405 Not Allowed"). The new base is remembered in `this.endpoint` and the request is sent again.
  async send(kind, method, body, hops = 0) {
    const plain = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body === undefined ? {} : body));
    let res;
    try {
      res = await this.fetchFn(`${this.endpoint}${kind}/${method}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'anki-sync': this.header(), 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(zlib.zstdCompressSync(plain))
      });
    } catch { throw new SyncError('Could not reach the Anki sync server. Check your internet connection.'); }
    if ((res.status >= 301 && res.status <= 308 && res.status !== 304) || res.type === 'opaqueredirect') {
      const loc = res.headers && res.headers.get && res.headers.get('location');
      if (!loc || hops >= 3) throw new SyncError('The Anki sync server sent StudyDeck to another address it could not follow.');
      this.endpoint = this.redirectTarget(loc, kind, method);
      this.redirectedTo = this.endpoint;
      return this.send(kind, method, body, hops + 1);
    }
    let buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let text = ''; try { text = (buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 ? zlib.zstdDecompressSync(buf) : buf).toString('utf8').slice(0, 200); } catch { /* ignore */ }
      if (res.status === 403) throw new SyncError(method === 'hostKey' ? 'AnkiWeb did not accept that email and password.' : 'AnkiWeb refused the request. Sign in again.', { authExpired: method !== 'hostKey', status: 403 });
      if (res.status === 401) throw new SyncError('Your AnkiWeb sign-in expired. Please sign in again.', { authExpired: true, status: 401 });
      if (res.status === 429) throw new SyncError('AnkiWeb says there were too many tries. Wait a few minutes and try again.', { status: 429 });
      if (res.status >= 500) throw new SyncError('AnkiWeb had a problem. Please try again later.', { status: res.status });
      const plainText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new SyncError(`The Anki sync server refused the request (${res.status}) for ${new URL(this.endpoint).host} /${kind}/${method}. ${plainText}`.trim(), { status: res.status });
    }
    if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) buf = zlib.zstdDecompressSync(buf);
    return buf;
  }

  // The address AnkiWeb redirects to is a base address. Be forgiving if it is a full request address.
  redirectTarget(loc, kind, method) {
    let u;
    try { u = new URL(loc, this.endpoint); } catch { throw new SyncError('The Anki sync server sent an address StudyDeck could not read.'); }
    const suffix = `${kind}/${method}`;
    if (u.pathname.endsWith('/' + suffix)) u.pathname = u.pathname.slice(0, -suffix.length);
    u.search = ''; u.hash = '';
    const next = normalizeEndpoint(u.toString());
    const host = (h) => new URL(h).hostname;
    if (/(^|\.)ankiweb\.net$/.test(host(this.endpoint)) && !/(^|\.)ankiweb\.net$/.test(host(next))) throw new SyncError('AnkiWeb sent StudyDeck to an address that is not AnkiWeb. It was not followed.');
    return next;
  }

  async json(kind, method, body) {
    const out = await this.send(kind, method, body);
    try { return JSON.parse(out.toString('utf8')); } catch { throw new SyncError('The Anki sync server sent an answer StudyDeck does not understand.'); }
  }

  async login(user, password) {
    const r = await this.json('sync', 'hostKey', { u: String(user), p: String(password) });
    if (!r || typeof r.key !== 'string' || !r.key) throw new SyncError('AnkiWeb did not accept that email and password.');
    this.hkey = r.key;
    return r.key;
  }

  // AnkiWeb checks this text and answers "400" to versions it does not recognise, so it is written the way Anki writes it.
  clientVersion() { const p = { win32: 'win', darwin: 'mac', linux: 'lin' }[this.platform] || 'lin'; return `anki,25.02.5 (3c2e1f4a),${p}`; }
  meta() { return this.json('sync', 'meta', { v: SYNC_VERSION, cv: this.clientVersion() }); }
  download() { return this.send('sync', 'download', { _pad: null }); }

  async mediaChanges(lastUsn) {
    const r = await this.json('msync', 'mediaChanges', { lastUsn });
    if (r.err) throw new SyncError('Media list failed: ' + r.err);
    return r.data || [];
  }

  // Returns Map(name -> bytes) for the requested files
  async downloadFiles(names) {
    const zip = fflate.unzipSync(new Uint8Array(await this.send('msync', 'downloadFiles', { files: names })));
    const meta = zip._meta ? JSON.parse(Buffer.from(zip._meta).toString('utf8')) : {};
    const out = new Map();
    const pairs = Array.isArray(meta) ? meta : Object.entries(meta);          // either [name, index] or index: name
    for (const [x, y] of pairs) {
      const [name, idx] = zip[String(y)] !== undefined && names.includes(x) ? [x, y] : [y, x];
      if (zip[String(idx)] !== undefined) out.set(name, Buffer.from(zip[String(idx)]));
    }
    return out;
  }
}

// Brings the local media cache up to date. `files` is { name: sha1 } of what is already in `fs` cache dir `dir`.
async function syncMedia(client, { fs, path, dir, usn = 0, files = {}, onProgress = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const have = { ...files };
  let lastUsn = usn, downloaded = 0, skipped = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const changes = await client.mediaChanges(lastUsn);
    if (!changes.length) break;
    const want = [];
    for (const [name, entryUsn, sha1] of changes) {
      lastUsn = Math.max(lastUsn, Number(entryUsn) || 0);
      if (!safeName(name)) { skipped++; continue; }
      if (!sha1) { delete have[name]; fs.rmSync(path.join(dir, name), { force: true }); continue; }     // deleted on the server
      if (have[name] === sha1 && fs.existsSync(path.join(dir, name))) continue;
      want.push([name, sha1]);
    }
    for (let i = 0; i < want.length; i += MEDIA_BATCH) {
      const batch = want.slice(i, i + MEDIA_BATCH);
      onProgress(`Downloading pictures and sounds… ${downloaded + batch.length} of ${downloaded + want.length - i}`);
      const got = await client.downloadFiles(batch.map((b) => b[0]));
      for (const [name, sha1] of batch) {
        if (!got.has(name)) { skipped++; continue; }
        fs.writeFileSync(path.join(dir, name), got.get(name));
        have[name] = sha1; downloaded++;
      }
    }
  }
  return { usn: lastUsn, files: have, downloaded, skipped };
}

// The whole "pull": returns { meta, dbBytes (null if nothing changed), mediaUsn, files, mediaDownloaded, skipped }
async function pull(client, { fs, path, mediaDir, state = {}, force = false, onProgress = () => {} }) {
  onProgress('Checking AnkiWeb…');
  const meta = await client.meta();
  if (meta.cont === false) throw new SyncError(meta.msg || 'AnkiWeb asked this app to stop. Try again later.');
  if (meta.empty) throw new SyncError('Your AnkiWeb account has no decks yet. Sync from Anki on a computer or phone first.');
  const media = await syncMedia(client, { fs, path, dir: mediaDir, usn: state.mediaUsn || 0, files: state.files || {}, onProgress });
  const changed = force || meta.mod !== state.mod || meta.scm !== state.scm;
  let dbBytes = null, after = meta;
  if (changed) {
    onProgress('Downloading your decks…');
    dbBytes = await client.download();
    after = await client.meta();       // downloading makes the server bump its change number, so remember the new one
  }
  return { meta: after, dbBytes, mediaUsn: media.usn, files: media.files, mediaDownloaded: media.downloaded, skipped: media.skipped };
}


class RemoteChanged extends SyncError {}

const hasItems = (x) => !!x && ((x.cards || []).length || (x.notes || []).length || (x.revlog || []).length || (x.decks || []).length);

// Sends StudyDeck's changes (cards you studied and their review history) with Anki's normal sync steps.
// `cards` are 18-value rows and `revlog` 9-value rows (see core/anki-push.js). Anything the server wants to tell us first
// (someone else changed things) stops the push with RemoteChanged: the caller downloads again and retries.
async function pushChanges(client, { usn, serverUsn, counts, cards, revlog, onProgress = () => {} }) {
  let started = false;
  const stamp = { _pad: null };
  try {
    onProgress('Sending your progress to AnkiWeb…');
    const graves = await client.json('sync', 'start', { minUsn: usn, lnewer: false, graves: null });
    started = true;
    if (hasItems(graves)) throw new RemoteChanged('AnkiWeb has newer changes.');
    const ch = await client.json('sync', 'applyChanges', { changes: { models: [], decks: [[], []], tags: [] } });
    const dc = ch && ch.decks;
    if (ch && ((ch.models || []).length || (ch.tags || []).length || (Array.isArray(dc) && ((dc[0] || []).length || (dc[1] || []).length)))) throw new RemoteChanged('AnkiWeb has newer changes.');
    for (let i = 0; i < 200; i++) {
      const c = await client.json('sync', 'chunk', stamp);
      if (hasItems(c)) throw new RemoteChanged('AnkiWeb has newer changes.');
      if (c.done !== false) break;
    }
    const rows = [...revlog.map((r) => ['revlog', r]), ...cards.map((c) => ['cards', c])];
    const SIZE = 250;
    for (let i = 0; i === 0 || i < rows.length; i += SIZE) {
      const part = rows.slice(i, i + SIZE);
      const done = i + SIZE >= rows.length;
      await client.send('sync', 'applyChunk', { chunk: { done, revlog: part.filter((p) => p[0] === 'revlog').map((p) => p[1]), cards: part.filter((p) => p[0] === 'cards').map((p) => p[1]) } });
    }
    const san = await client.json('sync', 'sanityCheck2', { client: [[0, 0, 0], counts.cards, counts.notes, counts.revlog + revlog.length, 0, counts.notetypes, counts.decks, counts.deckConfig] });
    if (!san || san.status !== 'ok') throw new SyncError('AnkiWeb\'s safety check of the changes failed, so nothing was changed on AnkiWeb. Use "Re-download everything" and sync again.', { sanity: true });
    const mod = Number(await client.json('sync', 'finish', stamp));
    started = false;
    return { mod, usn: serverUsn + 1 };
  } catch (e) {
    if (started) { try { await client.send('sync', 'abort', stamp); } catch { /* ignore */ } }
    throw e;
  }
}

module.exports = { pushChanges, RemoteChanged, AnkiSyncClient, SyncError, pull, syncMedia, normalizeEndpoint, DEFAULT_ENDPOINT };
