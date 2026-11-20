'use strict';
// StudyDeck's own database (one SQLite file). Needs Node.js 24 or newer. No Electron code in here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const sched = require('./scheduler');

const SCHEMA_VERSION = 1;
const LEARN_AHEAD = 20 * sched.MIN;
const DEFAULTS = { newPerDay: 20, reviewsPerDay: 200 };

class Store {
  constructor(dbPath, mediaRoot) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(mediaRoot, { recursive: true });
    this.mediaRoot = mediaRoot;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.migrate();
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS decks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS notetypes (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE, name TEXT, kind TEXT, css TEXT, fields TEXT, templates TEXT);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, notetype_id INTEGER, fields TEXT, tags TEXT, import_id INTEGER);
      CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, deck_id INTEGER NOT NULL, ord INTEGER NOT NULL,
        state TEXT NOT NULL, step INTEGER DEFAULT 0, due INTEGER DEFAULT 0, interval REAL DEFAULT 0, ease REAL DEFAULT 0,
        reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, suspended INTEGER DEFAULT 0, new_pos INTEGER DEFAULT 0, UNIQUE(note_id, ord));
      CREATE INDEX IF NOT EXISTS cards_deck_state ON cards(deck_id, state, due);
      CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER, deck_id INTEGER, ts INTEGER, rating INTEGER, ms INTEGER, prev_state TEXT, interval_after REAL);
      CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts);
    `);
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }

  close() { this.db.close(); }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- settings -------------------------------------------------------------------------
  getSetting(key) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? JSON.parse(r.value) : DEFAULTS[key];
  }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  settings() { return { newPerDay: this.getSetting('newPerDay'), reviewsPerDay: this.getSetting('reviewsPerDay') }; }

  // ---- import ---------------------------------------------------------------------------
  // `parsed` comes from core/apkg.js
  importCollection(parsed, { name, keepProgress = true, now = Date.now() }) {
    const db = this.db;
    let importId;
    const result = { notesAdded: 0, notesUpdated: 0, cardsAdded: 0, cardsSkipped: 0, mediaCount: parsed.mediaCount, warnings: [...(parsed.warnings || [])] };
    const dest = () => path.join(this.mediaRoot, String(importId));
    try {
      this.tx(() => {
        importId = db.prepare('INSERT INTO imports(name, ts) VALUES(?,?)').run(name, now).lastInsertRowid;

        const ntMap = new Map();
        const getNotetype = (mid) => {
          if (ntMap.has(mid)) return ntMap.get(mid);
          const nt = parsed.notetypes.find((x) => x.id === mid);
          if (!nt) { ntMap.set(mid, null); return null; }
          const body = { name: nt.name, kind: nt.kind, css: nt.css, fields: nt.fields, templates: nt.templates };
          const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
          let row = db.prepare('SELECT id FROM notetypes WHERE hash=?').get(hash);
          if (!row) {
            const r = db.prepare('INSERT INTO notetypes(hash,name,kind,css,fields,templates) VALUES(?,?,?,?,?,?)')
              .run(hash, nt.name, nt.kind, nt.css, JSON.stringify(nt.fields), JSON.stringify(nt.templates));
            row = { id: r.lastInsertRowid };
          }
          ntMap.set(mid, row.id);
          return row.id;
        };

        const noteMap = new Map();
        for (const n of parsed.notes) {
          const ntId = getNotetype(n.mid);
          if (ntId === null) continue;
          const existing = db.prepare('SELECT id FROM notes WHERE guid=?').get(n.guid);
          if (existing) {
            db.prepare('UPDATE notes SET notetype_id=?, fields=?, tags=?, import_id=? WHERE id=?')
              .run(ntId, JSON.stringify(n.fields), n.tags.join(' '), importId, existing.id);
            noteMap.set(n.id, existing.id); result.notesUpdated++;
          } else {
            const r = db.prepare('INSERT INTO notes(guid,notetype_id,fields,tags,import_id) VALUES(?,?,?,?,?)')
              .run(n.guid, ntId, JSON.stringify(n.fields), n.tags.join(' '), importId);
            noteMap.set(n.id, r.lastInsertRowid); result.notesAdded++;
          }
        }

        const deckName = new Map(parsed.decks.map((d) => [d.id, d.name]));
        const deckMap = new Map();
        const getDeck = (did) => {
          if (deckMap.has(did)) return deckMap.get(did);
          const nm = deckName.get(did) || 'Imported';
          let row = db.prepare('SELECT id FROM decks WHERE name=?').get(nm);
          if (!row) row = { id: db.prepare('INSERT INTO decks(name) VALUES(?)').run(nm).lastInsertRowid };
          deckMap.set(did, row.id);
          return row.id;
        };

        const find = db.prepare('SELECT id FROM cards WHERE note_id=? AND ord=?');
        const ins = db.prepare('INSERT INTO cards(note_id,deck_id,ord,state,step,due,interval,ease,reps,lapses,suspended,new_pos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
        parsed.cards.forEach((c, idx) => {
          const noteId = noteMap.get(c.nid);
          if (!noteId) return;
          if (find.get(noteId, c.ord)) { result.cardsSkipped++; return; }
          const f = convertCard(c, parsed.crt, now, keepProgress, idx);
          ins.run(noteId, getDeck(c.odid || c.did), c.ord, f.state, 0, f.due, f.interval, f.ease, f.reps, f.lapses, f.suspended, f.new_pos);
          result.cardsAdded++;
        });

        if (parsed.mediaDir && fs.existsSync(parsed.mediaDir)) fs.cpSync(parsed.mediaDir, dest(), { recursive: true });
        db.prepare('UPDATE imports SET name=? WHERE id=?').run(name, importId);
      });
    } catch (e) {
      if (importId) fs.rmSync(dest(), { recursive: true, force: true });
      throw e;
    }
    this.cleanup();
    result.importId = importId;
    return result;
  }

  // removes notes, notetypes and media that nothing uses any more
  cleanup() {
    const db = this.db;
    db.exec('DELETE FROM notes WHERE id NOT IN (SELECT note_id FROM cards)');
    db.exec('DELETE FROM notetypes WHERE id NOT IN (SELECT notetype_id FROM notes)');
    const used = new Set(db.prepare('SELECT DISTINCT import_id FROM notes').all().map((r) => String(r.import_id)));
    for (const e of fs.existsSync(this.mediaRoot) ? fs.readdirSync(this.mediaRoot) : []) {
      if (!used.has(e)) fs.rmSync(path.join(this.mediaRoot, e), { recursive: true, force: true });
    }
    db.exec('DELETE FROM imports WHERE id NOT IN (SELECT DISTINCT import_id FROM notes)');
  }

  // ---- decks ----------------------------------------------------------------------------
  limitsLeft(now) {
    const s = this.settings();
    const start = sched.dayStart(now);
    const introduced = this.db.prepare("SELECT COUNT(*) c FROM reviews WHERE ts>=? AND prev_state='new'").get(start).c;
    const reviewed = this.db.prepare("SELECT COUNT(*) c FROM reviews WHERE ts>=? AND prev_state='review'").get(start).c;
    return { newLeft: Math.max(0, s.newPerDay - introduced), reviewLeft: Math.max(0, s.reviewsPerDay - reviewed) };
  }

  // one row per deck that has cards; the screen builds the tree from the names
  listDecks(now = Date.now()) {
    const { newLeft, reviewLeft } = this.limitsLeft(now);
    const end = sched.dayEnd(now);
    const rows = this.db.prepare(`SELECT d.id, d.name,
        COUNT(c.id) total,
        SUM(CASE WHEN c.state='new' AND c.suspended=0 THEN 1 ELSE 0 END) newc,
        SUM(CASE WHEN c.state='learn' AND c.suspended=0 AND c.due<=? THEN 1 ELSE 0 END) learnc,
        SUM(CASE WHEN c.state='review' AND c.suspended=0 AND c.due<? THEN 1 ELSE 0 END) reviewc
      FROM decks d LEFT JOIN cards c ON c.deck_id=d.id GROUP BY d.id ORDER BY d.name`).all(now + LEARN_AHEAD, end);
    return rows.map((r) => ({
      id: r.id, name: r.name, total: r.total || 0,
      newCount: Math.min(r.newc || 0, newLeft), learnCount: r.learnc || 0, reviewCount: Math.min(r.reviewc || 0, reviewLeft)
    }));
  }

  deckIdsFor(deckId) {
    const d = this.db.prepare('SELECT name FROM decks WHERE id=?').get(deckId);
    if (!d) return [];
    const prefix = d.name + '::';
    return this.db.prepare('SELECT id FROM decks WHERE name=? OR substr(name,1,?)=?').all(d.name, prefix.length, prefix).map((r) => r.id);
  }

  // deckName: full path such as "Korean" (includes sub-decks). null = all decks.
  deckIdsByName(name) {
    if (name === null || name === undefined) return this.db.prepare('SELECT id FROM decks').all().map((r) => r.id);
    const prefix = name + '::';
    return this.db.prepare('SELECT id FROM decks WHERE name=? OR substr(name,1,?)=?').all(name, prefix.length, prefix).map((r) => r.id);
  }

  deleteDeckByName(name) {
    const ids = this.deckIdsByName(name);
    if (!ids.length) return 0;
    this.tx(() => {
      const ph = ids.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM cards WHERE deck_id IN (${ph})`).run(...ids);
      this.db.prepare(`DELETE FROM decks WHERE id IN (${ph})`).run(...ids);
    });
    this.cleanup();
    return ids.length;
  }

  // ---- studying -------------------------------------------------------------------------
  queueCounts(deckIds, now) {
    if (!deckIds.length) return { newCount: 0, learnCount: 0, reviewCount: 0 };
    const ph = deckIds.map(() => '?').join(',');
    const { newLeft, reviewLeft } = this.limitsLeft(now);
    const r = this.db.prepare(`SELECT
        SUM(CASE WHEN state='new' THEN 1 ELSE 0 END) n,
        SUM(CASE WHEN state='learn' AND due<=? THEN 1 ELSE 0 END) l,
        SUM(CASE WHEN state='review' AND due<? THEN 1 ELSE 0 END) r
      FROM cards WHERE suspended=0 AND deck_id IN (${ph})`).get(now + LEARN_AHEAD, sched.dayEnd(now), ...deckIds);
    return { newCount: Math.min(r.n || 0, newLeft), learnCount: r.l || 0, reviewCount: Math.min(r.r || 0, reviewLeft) };
  }

  nextCardId(deckIds, now = Date.now()) {
    if (!deckIds.length) return null;
    const ph = deckIds.map(() => '?').join(',');
    const { newLeft, reviewLeft } = this.limitsLeft(now);
    const base = `SELECT id FROM cards WHERE suspended=0 AND deck_id IN (${ph})`;
    const run = (extra, ...args) => { const r = this.db.prepare(`${base} ${extra} LIMIT 1`).get(...deckIds, ...args); return r ? r.id : null; };
    let id = run("AND state='learn' AND due<=? ORDER BY due", now);
    if (id) return id;
    if (reviewLeft > 0) { id = run("AND state='review' AND due<? ORDER BY due, id", sched.dayEnd(now)); if (id) return id; }
    if (newLeft > 0) { id = run("AND state='new' ORDER BY new_pos, id"); if (id) return id; }
    return run("AND state='learn' AND due<=? ORDER BY due", now + LEARN_AHEAD);
  }

  getCardData(cardId) {
    const r = this.db.prepare(`SELECT c.*, n.fields nfields, n.tags ntags, n.import_id, t.name ntname, t.kind, t.css, t.fields tfields, t.templates ttemplates, d.name deck_name
      FROM cards c JOIN notes n ON n.id=c.note_id JOIN notetypes t ON t.id=n.notetype_id JOIN decks d ON d.id=c.deck_id WHERE c.id=?`).get(cardId);
    if (!r) return null;
    return {
      card: { id: r.id, state: r.state, step: r.step, due: r.due, interval: r.interval, ease: r.ease, reps: r.reps, lapses: r.lapses, ord: r.ord, deck_id: r.deck_id },
      ctx: {
        notetype: { name: r.ntname, kind: r.kind, css: r.css, fields: JSON.parse(r.tfields), templates: JSON.parse(r.ttemplates) },
        fields: JSON.parse(r.nfields), ord: r.ord, tags: r.ntags ? r.ntags.split(' ').filter(Boolean) : [], deckName: r.deck_name
      },
      importId: r.import_id
    };
  }

  answerCard(cardId, rating, ms, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM cards WHERE id=?').get(cardId);
    if (!row) throw new Error('That card no longer exists.');
    const next = sched.answer(row, rating, now);
    this.tx(() => {
      this.db.prepare('UPDATE cards SET state=?, step=?, due=?, interval=?, ease=?, reps=?, lapses=? WHERE id=?')
        .run(next.state, next.step || 0, next.due, next.interval || 0, next.ease || 0, next.reps, next.lapses || 0, cardId);
      this.db.prepare('INSERT INTO reviews(card_id,deck_id,ts,rating,ms,prev_state,interval_after) VALUES(?,?,?,?,?,?,?)')
        .run(cardId, row.deck_id, now, rating, Math.max(0, Math.min(Math.round(ms || 0), 600000)), row.state, next.interval || 0);
    });
    return next;
  }

  // ---- progress -------------------------------------------------------------------------
  stats(now = Date.now()) {
    const db = this.db;
    const start = sched.dayStart(now);
    const DAYMS = sched.DAY;
    const today = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN rating>=2 THEN 1 ELSE 0 END) ok, COALESCE(SUM(ms),0) ms FROM reviews WHERE ts>=?').get(start);
    const perDay = db.prepare(`SELECT ((ts - ? + 400*${DAYMS}) / ${DAYMS}) - 400 AS off, COUNT(*) n FROM reviews WHERE ts >= ? GROUP BY off`).all(start, start - 399 * DAYMS);
    const byOff = new Map(perDay.map((r) => [r.off, r.n]));
    let streak = 0;
    for (let off = byOff.has(0) ? 0 : -1; byOff.has(off); off--) streak++;
    const last30 = []; for (let off = -29; off <= 0; off++) last30.push(byOff.get(off) || 0);
    const r30 = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN rating>=2 THEN 1 ELSE 0 END) ok FROM reviews WHERE ts>=?').get(start - 29 * DAYMS);
    const c = db.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN state='new' THEN 1 ELSE 0 END) newc,
        SUM(CASE WHEN state='learn' THEN 1 ELSE 0 END) learnc,
        SUM(CASE WHEN state='review' AND interval<21 THEN 1 ELSE 0 END) young,
        SUM(CASE WHEN state='review' AND interval>=21 THEN 1 ELSE 0 END) mature,
        SUM(CASE WHEN suspended=1 THEN 1 ELSE 0 END) susp FROM cards`).get();
    const perDeck = db.prepare(`SELECT d.name, COUNT(c.id) total,
        SUM(CASE WHEN c.state='review' AND c.interval>=21 THEN 1 ELSE 0 END) mature,
        SUM(CASE WHEN c.state='review' AND c.interval<21 THEN 1 ELSE 0 END) young,
        SUM(CASE WHEN c.state='learn' THEN 1 ELSE 0 END) learning,
        SUM(CASE WHEN c.state='new' THEN 1 ELSE 0 END) newc
      FROM decks d LEFT JOIN cards c ON c.deck_id=d.id GROUP BY d.id ORDER BY d.name`).all();
    return {
      today: { reviewed: today.n || 0, correct: today.ok || 0, minutes: Math.round((today.ms || 0) / 60000) },
      streak, last30,
      retention30: r30.n ? Math.round((100 * (r30.ok || 0)) / r30.n) : null,
      totalReviews: db.prepare('SELECT COUNT(*) n FROM reviews').get().n,
      cards: { total: c.total || 0, new: c.newc || 0, learning: c.learnc || 0, young: c.young || 0, mature: c.mature || 0, suspended: c.susp || 0 },
      perDeck: perDeck.map((d) => ({ name: d.name, total: d.total || 0, mature: d.mature || 0, young: d.young || 0, learning: d.learning || 0, new: d.newc || 0 }))
    };
  }
}

// Anki scheduling fields -> StudyDeck fields
function convertCard(c, crt, now, keep, idx) {
  const out = { state: 'new', due: 0, interval: 0, ease: 0, reps: 0, lapses: 0, suspended: 0, new_pos: c.type === 0 ? Number(c.due) || idx : idx };
  if (!keep) return out;
  out.suspended = c.queue === -1 ? 1 : 0;
  if (c.type === 0) return out;
  out.reps = c.reps || 0; out.lapses = c.lapses || 0;
  if (c.type === 2) {
    const dueDays = c.odid ? c.odue : c.due;
    out.state = 'review'; out.interval = Math.max(1, c.ivl || 1);
    out.ease = Math.max(1.3, (c.factor || 2500) / 1000);
    out.due = (crt + dueDays * 86400) * 1000;
  } else { // learning or relearning
    out.state = 'learn'; out.due = now; out.interval = c.type === 3 ? Math.max(1, c.ivl || 1) : 0;
    out.ease = c.factor ? Math.max(1.3, c.factor / 1000) : 0;
  }
  return out;
}

module.exports = { Store, convertCard, LEARN_AHEAD };
