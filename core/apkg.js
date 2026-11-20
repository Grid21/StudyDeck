'use strict';
// Reads Anki deck files (.apkg and .colpkg), old and new format, into a plain structure.
// Needs Node.js 24 or newer (built-in SQLite and zstd). No Electron code in here.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const fflate = require('./vendor/fflate.js');
const pb = require('./protobuf');

class ImportError extends Error {}

const SMALL = new Set(['meta', 'media', 'collection.anki2', 'collection.anki21', 'collection.anki21b']);

function isZstd(b) { return b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd; }
function unzstd(b) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new ImportError('This deck needs Node.js 24 or newer to be read.');
  return zlib.zstdDecompressSync(b);
}
function maybeZstd(b) { return isZstd(b) ? unzstd(b) : b; }

// Streams the zip: small important files are kept in memory, numbered media files go straight to disk.
function extractZip(file, rawDir) {
  const small = {};
  let failure = null;
  const uz = new fflate.Unzip();
  uz.register(fflate.UnzipInflate);
  uz.onfile = (f) => {
    const name = f.name;
    if (name.endsWith('/')) return;
    const isSmall = SMALL.has(name);
    if (!isSmall && !/^\d+$/.test(name)) return;
    const chunks = [];
    const out = isSmall ? null : fs.openSync(path.join(rawDir, name), 'w');
    f.ondata = (err, chunk, final) => {
      if (err) { failure = err; return; }
      if (isSmall) chunks.push(Buffer.from(chunk)); else fs.writeSync(out, chunk);
      if (final) { if (isSmall) small[name] = Buffer.concat(chunks); else fs.closeSync(out); }
    };
    f.start();
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      uz.push(new Uint8Array(buf.subarray(0, n)), n === 0);
      if (n === 0) break;
    }
  } catch (e) {
    throw new ImportError('This file is not a valid Anki deck (' + e.message + ').');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (failure) throw new ImportError('This file is damaged (' + failure.message + ').');
  return small;
}

// New Anki files use a custom text-sorting rule (unicase) that built-in SQLite does not know.
// On our private temporary copy we swap it for the built-in one so the tables can be read.
function openCollection(bytes, tmpDir) {
  const p = path.join(tmpDir, 'collection.db');
  // Swap the rule's name inside the file itself ("unicase" -> "nocase " has the same length, so nothing else
  // in the file moves). This also works inside Electron, whose SQLite does not allow editing the schema.
  const buf = Buffer.from(bytes);
  const from = Buffer.from('unicase'), to = Buffer.from('nocase ');
  let patched = false;
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 7)) { to.copy(buf, i); patched = true; }
  fs.writeFileSync(p, buf);
  const db = new DatabaseSync(p);
  try {
    if (patched) db.exec('REINDEX');
  } catch (e) { try { db.close(); } catch { /* ignore */ } throw new ImportError('The deck database could not be opened (' + e.message + ').'); }
  return db;
}

function splitTags(s) { return String(s || '').split(/\s+/).filter(Boolean); }
function deckName(n) { return String(n).replace(/\x1f/g, '::'); }

function readModern(db) {
  const notetypes = db.prepare('select id,name,config from notetypes order by id').all().map((nt) => {
    const cfg = pb.readFields(Buffer.from(nt.config));
    const kind = pb.firstField(cfg, 1) === 1 ? 'cloze' : 'standard';
    const fields = db.prepare('select name from fields where ntid=? order by ord').all(nt.id).map((r) => r.name);
    const templates = db.prepare('select name,config from templates where ntid=? order by ord').all(nt.id).map((t) => {
      const c = pb.readFields(Buffer.from(t.config));
      return { name: t.name, qfmt: pb.str(pb.firstField(c, 1)), afmt: pb.str(pb.firstField(c, 2)) };
    });
    return { id: nt.id, name: nt.name, kind, css: pb.str(pb.firstField(cfg, 3)), fields, templates };
  });
  const decks = db.prepare('select id,name from decks').all().map((d) => ({ id: d.id, name: deckName(d.name) }));
  return { notetypes, decks };
}

function readLegacy(db) {
  const col = db.prepare('select models,decks from col').get();
  const models = JSON.parse(col.models || '{}');
  const decksJson = JSON.parse(col.decks || '{}');
  const notetypes = Object.values(models).map((m) => ({
    id: Number(m.id),
    name: m.name,
    kind: m.type === 1 ? 'cloze' : 'standard',
    css: m.css || '',
    fields: [...(m.flds || [])].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    templates: [...(m.tmpls || [])].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt || '', afmt: t.afmt || '' }))
  }));
  const decks = Object.values(decksJson).map((d) => ({ id: Number(d.id), name: deckName(d.name) }));
  return { notetypes, decks };
}

function safeMediaName(n) {
  return typeof n === 'string' && n.length > 0 && n.length < 250 && !/[\\/\0]/.test(n) && n !== '.' && n !== '..';
}

function mediaMap(small) {
  if (!small.media) return {};
  const b = maybeZstd(small.media);
  const text = b.toString('utf8');
  if (text.trimStart().startsWith('{')) { try { return JSON.parse(text); } catch { /* fall through */ } }
  const map = {};
  pb.readFields(b).filter((f) => f.field === 1 && Buffer.isBuffer(f.value)).forEach((f, i) => {
    map[i] = pb.str(pb.firstField(pb.readFields(f.value), 1));
  });
  return map;
}

// Parses a deck file. `tmpDir` must be an empty folder that you remove afterwards.
// Media files are written to tmpDir/media with their real names.
function parseApkg(file, tmpDir) {
  const rawDir = path.join(tmpDir, 'raw');
  const mediaDir = path.join(tmpDir, 'media');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const small = extractZip(file, rawDir);

  const dbName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => small[n]);
  if (!dbName) throw new ImportError('This file does not contain an Anki collection. Is it an .apkg or .colpkg file?');
  const db = openCollection(maybeZstd(small[dbName]), tmpDir);
  const warnings = [];
  let data;
  try {
    const tables = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    const base = tables.has('notetypes') ? readModern(db) : readLegacy(db);
    const crt = Number(db.prepare('select crt from col').get().crt) || 0;
    const notes = db.prepare('select id,guid,mid,tags,flds from notes').all().map((n) => ({
      id: n.id, guid: String(n.guid), mid: n.mid, tags: splitTags(n.tags), fields: String(n.flds).split('\x1f')
    }));
    const cards = db.prepare('select id,nid,did,ord,type,queue,due,ivl,factor,reps,lapses,odid,odue from cards').all().map((c) => ({ ...c }));
    data = { ...base, notes, cards, crt };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('The deck could not be read (' + e.message + ').');
  } finally { db.close(); }

  if (dbName === 'collection.anki2' && data.notes.length === 1 && /update to the latest Anki/i.test(data.notes[0].fields.join(' '))) {
    throw new ImportError('This deck was saved by a newer Anki without the new data inside. In Anki, export it again.');
  }
  if (!data.notes.length) throw new ImportError('This deck has no cards in it.');

  let mediaCount = 0;
  const map = mediaMap(small);
  for (const [idx, name] of Object.entries(map)) {
    const raw = path.join(rawDir, String(idx));
    if (!fs.existsSync(raw)) continue;
    if (!safeMediaName(name)) { warnings.push(`Skipped a media file with an unsafe name.`); continue; }
    let bytes = fs.readFileSync(raw);
    if (isZstd(bytes)) bytes = unzstd(bytes);
    fs.writeFileSync(path.join(mediaDir, name), bytes);
    mediaCount++;
  }
  fs.rmSync(rawDir, { recursive: true, force: true });
  return { ...data, mediaDir, mediaCount, warnings, format: dbName };
}

module.exports = { parseApkg, ImportError };
