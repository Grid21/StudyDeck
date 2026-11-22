'use strict';
// StudyDeck's own database (one SQLite file). Needs Node.js 24 or newer. No Electron code in here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const sched = require('./scheduler');

const SCHEMA_VERSION = 2;
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
    // version 2: what is needed to send your progress back to AnkiWeb
    const addColumn = (table, col, def) => {
      if (this.db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col)) return false;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); return true;
    };
    addColumn('cards', 'dirty', 'INTEGER DEFAULT 0');
    addColumn('notes', 'edited', 'INTEGER DEFAULT 0');       // changed in StudyDeck: syncing does not overwrite it
    for (const [c, d] of [['rtype', 'INTEGER DEFAULT 0'], ['ivl_new', 'INTEGER DEFAULT 0'], ['ivl_last', 'INTEGER DEFAULT 0'], ['factor', 'INTEGER DEFAULT 0']]) addColumn('reviews', c, d);
    if (addColumn('reviews', 'pushed', 'INTEGER DEFAULT 0')) this.db.exec('UPDATE reviews SET pushed=1');   // older reviews are not sent
    this.db.exec(`CREATE TABLE IF NOT EXISTS anki_cards (card_id INTEGER PRIMARY KEY, anki_id INTEGER UNIQUE, nid INTEGER, did INTEGER, ord INTEGER,
      mtime INTEGER, usn INTEGER, ctype INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER,
      odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`);
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

  // Daily review totals per subject (the top-level deck name, e.g. "Korean"), for the last `days` days.
  // Only totals leave this function: never card contents.
  dailyBySubject(days = 30, now = Date.now()) {
    const start = sched.dayStart(now);
    const rows = this.db.prepare('SELECT r.ts, r.rating, r.ms, d.name FROM reviews r JOIN decks d ON d.id = r.deck_id WHERE r.ts >= ?').all(start - (days - 1) * sched.DAY);
    const out = new Map();
    for (const r of rows) {
      const subject = String(r.name).split('::')[0];
      const off = Math.floor((r.ts - start) / sched.DAY);
      const d = new Date(start + off * sched.DAY + 12 * 3600000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const k = day + '\u0000' + subject;
      const e = out.get(k) || { day, subject, reviews: 0, correct: 0, ms: 0 };
      e.reviews++; if (r.rating >= 2) e.correct++; e.ms += r.ms || 0; out.set(k, e);
    }
    return [...out.values()].map((e) => ({ day: e.day, subject: e.subject, reviews: e.reviews, correct: e.correct, minutes: Math.round(e.ms / 60000) }));
  }
  subjects() { return [...new Set(this.db.prepare('SELECT name FROM decks').all().map((r) => String(r.name).split('::')[0]))].sort((a, b) => a.localeCompare(b)); }

  // ---- import ---------------------------------------------------------------------------
  // `parsed` comes from core/apkg.js
  importCollection(parsed, { name, keepProgress = true, now = Date.now(), sync = false }) {
    const db = this.db;
    let importId;
    const result = { notesAdded: 0, notesUpdated: 0, cardsAdded: 0, cardsSkipped: 0, cardsRefreshed: 0, cardsRemoved: 0, mediaCount: parsed.mediaCount, warnings: [...(parsed.warnings || [])] };
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
          const existing = db.prepare('SELECT id, edited FROM notes WHERE guid=?').get(n.guid);
          if (existing && existing.edited) { noteMap.set(n.id, existing.id); }       // edited here: keep the version made in StudyDeck
          else if (existing) {
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
        const snapIns = db.prepare(`INSERT OR REPLACE INTO anki_cards (card_id, anki_id, nid, did, ord, mtime, usn, ctype, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const snapshot = (cardId, c) => snapIns.run(cardId, c.id, c.nid, c.did, c.ord, c.mod || 0, c.usn || 0, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left || 0, c.odue || 0, c.odid || 0, c.flags || 0, c.data || '');
        const seen = new Set();
        parsed.cards.forEach((c, idx) => {
          const noteId = noteMap.get(c.nid);
          if (!noteId) return;
          const had = find.get(noteId, c.ord);
          if (had) {
            result.cardsSkipped++;
            if (sync) {
              seen.add(had.id);
              const snap = db.prepare('SELECT * FROM anki_cards WHERE card_id=?').get(had.id);
              const cur = db.prepare('SELECT dirty FROM cards WHERE id=?').get(had.id);
              const last = db.prepare('SELECT MAX(ts) t, COUNT(*) n FROM reviews WHERE card_id=?').get(had.id);
              const dirty = !!cur.dirty || (!snap && last.n > 0);       // studied here, never sent: this side is the newer one
              const changed = !snap || snap.mtime !== (c.mod || 0) || snap.due !== c.due || snap.ctype !== c.type || snap.ivl !== c.ivl || snap.reps !== c.reps || snap.queue !== c.queue;
              const take = dirty ? (c.mod || 0) > Math.ceil((last.t || 0) / 1000) : changed;     // when both sides changed, the newer one wins
              if (take) {
                const f = convertCard(c, parsed.crt, now, true, idx);
                db.prepare('UPDATE cards SET deck_id=?, state=?, step=0, due=?, interval=?, ease=?, reps=?, lapses=?, suspended=?, dirty=0 WHERE id=?')
                  .run(getDeck(c.odid || c.did), f.state, f.due, f.interval, f.ease, f.reps, f.lapses, f.suspended, had.id);
                if (changed) result.cardsRefreshed++;
              } else if (dirty) db.prepare('UPDATE cards SET dirty=1 WHERE id=?').run(had.id);
              snapshot(had.id, c);
            }
            return;
          }
          const f = convertCard(c, parsed.crt, now, keepProgress, idx);
          const r = ins.run(noteId, getDeck(c.odid || c.did), c.ord, f.state, 0, f.due, f.interval, f.ease, f.reps, f.lapses, f.suspended, f.new_pos);
          if (sync) { snapshot(Number(r.lastInsertRowid), c); seen.add(Number(r.lastInsertRowid)); }
          result.cardsAdded++;
        });
        if (sync) {      // cards that were deleted on AnkiWeb are removed here too
          for (const row of db.prepare('SELECT card_id FROM anki_cards').all()) {
            if (!seen.has(row.card_id)) { db.prepare('DELETE FROM cards WHERE id=?').run(row.card_id); db.prepare('DELETE FROM anki_cards WHERE card_id=?').run(row.card_id); result.cardsRemoved++; }
          }
        }

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
    db.exec('DELETE FROM anki_cards WHERE card_id NOT IN (SELECT id FROM cards)');
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

  // ---- making and editing decks and cards ----------------------------------------------------
  // Changes made here stay in StudyDeck. They are not sent to AnkiWeb, and notes edited here are not overwritten by a later sync.
  cleanDeckName(name) {
    const parts = String(name == null ? '' : name).split('::').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!parts.length || parts.some((x) => !x)) throw new Error('Please type a deck name. Sub-decks are written like Korean::Verbs.');
    const full = parts.join('::');
    if (full.length > 200) throw new Error('That deck name is too long.');
    return full;
  }
  createDeck(name) {
    const full = this.cleanDeckName(name);
    const row = this.db.prepare('SELECT id FROM decks WHERE name=?').get(full);
    if (row) return { id: Number(row.id), name: full, existed: true };
    return { id: Number(this.db.prepare('INSERT INTO decks(name) VALUES(?)').run(full).lastInsertRowid), name: full, existed: false };
  }
  // renames a deck and everything inside it (Korean -> Hangul also turns Korean::Verbs into Hangul::Verbs)
  renameDeck(oldName, newName) {
    const full = this.cleanDeckName(newName);
    const ids = this.deckIdsByName(oldName);
    if (!ids.length) throw new Error('That deck no longer exists.');
    if (full === oldName) return { name: full };
    if (full.startsWith(oldName + '::')) throw new Error('A deck cannot be moved inside itself.');
    const rows = this.db.prepare(`SELECT id, name FROM decks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const target = (n) => full + n.slice(oldName.length);
    const mine = new Set(rows.map((r) => r.name));
    for (const r of rows) {
      const t = target(r.name);
      if (!mine.has(t) && this.db.prepare('SELECT 1 FROM decks WHERE name=?').get(t)) throw new Error(`A deck called “${t}” already exists. Choose another name.`);
    }
    this.tx(() => { for (const r of rows) this.db.prepare('UPDATE decks SET name=? WHERE id=?').run('\u0001' + target(r.name), r.id); this.db.exec("UPDATE decks SET name=substr(name,2) WHERE substr(name,1,1)=char(1)"); });
    return { name: full };
  }

  localImportId() {
    const r = this.db.prepare("SELECT id FROM imports WHERE name='Created in StudyDeck'").get();
    return Number(r ? r.id : this.db.prepare("INSERT INTO imports(name, ts) VALUES('Created in StudyDeck', ?)").run(Date.now()).lastInsertRowid);
  }
  ensureNotetype(kind) {
    const defs = {
      basic: { name: 'Basic', kind: 'standard', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }] },
      reversed: { name: 'Basic (and reversed card)', kind: 'standard', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }, { name: 'Card 2', qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' }] },
      cloze: { name: 'Cloze', kind: 'cloze', fields: ['Text', 'Back Extra'], templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }] }
    };
    const d = defs[kind]; if (!d) throw new Error('Unknown card type.');
    const css = '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }\n.cloze { font-weight: bold; color: blue; }';
    const body = { name: d.name, kind: d.kind, css, fields: d.fields, templates: d.templates };
    const hash = crypto.createHash('sha1').update('studydeck-local:' + JSON.stringify(body)).digest('hex');
    const row = this.db.prepare('SELECT id FROM notetypes WHERE hash=?').get(hash);
    if (row) return Number(row.id);
    return Number(this.db.prepare('INSERT INTO notetypes(hash,name,kind,css,fields,templates) VALUES(?,?,?,?,?,?)').run(hash, d.name, d.kind, css, JSON.stringify(d.fields), JSON.stringify(d.templates)).lastInsertRowid);
  }
  // which cards a note should have: [ord, ...]
  static cardOrds(kind, fields) {
    if (kind === 'cloze') {
      const nums = new Set(); for (const m of String(fields[0] || '').matchAll(/\{\{c(\d+)::/g)) nums.add(Number(m[1]));
      return [...nums].filter((n) => n >= 1 && n <= 200).sort((a, b) => a - b).map((n) => n - 1);
    }
    return null;
  }
  addNote({ deck, type = 'basic', fields, tags = '' }) {
    if (!Array.isArray(fields)) throw new Error('Nothing to add.');
    const fx = fields.map((x) => String(x == null ? '' : x));
    const ntId = this.ensureNotetype(type);
    const nt = this.db.prepare('SELECT kind, fields, templates FROM notetypes WHERE id=?').get(ntId);
    const names = JSON.parse(nt.fields), tpls = JSON.parse(nt.templates);
    while (fx.length < names.length) fx.push('');
    fx.length = names.length;
    if (!fx[0].replace(/<br\s*\/?>|&nbsp;|\s/gi, '')) throw new Error(`Please fill in “${names[0]}”.`);
    let ords;
    if (nt.kind === 'cloze') { ords = Store.cardOrds('cloze', fx); if (!ords.length) throw new Error('A cloze card needs at least one blank, written like {{c1::answer}}.'); }
    else { if (type === 'basic' && !fx[1].trim()) throw new Error('Please fill in “Back”.'); ords = tpls.map((_, i) => i); if (type === 'reversed' && !fx[1].trim()) throw new Error('Please fill in “Back”.'); }
    const deckId = this.createDeck(deck).id;
    return this.tx(() => {
      const nid = Number(this.db.prepare('INSERT INTO notes(guid,notetype_id,fields,tags,import_id,edited) VALUES(?,?,?,?,?,1)')
        .run(crypto.randomBytes(8).toString('hex'), ntId, JSON.stringify(fx), String(tags || '').trim().replace(/\s+/g, ' '), this.localImportId()).lastInsertRowid);
      let pos = (this.db.prepare('SELECT COALESCE(MAX(new_pos),0) m FROM cards').get().m || 0);
      for (const ord of ords) this.db.prepare("INSERT INTO cards(note_id,deck_id,ord,state,step,due,interval,ease,reps,lapses,suspended,new_pos) VALUES(?,?,?,'new',0,0,0,0,0,0,0,?)").run(nid, deckId, ord, ++pos);
      return { noteId: nid, cards: ords.length };
    });
  }
  getNote(noteId) {
    const n = this.db.prepare('SELECT n.id, n.fields, n.tags, t.name tname, t.kind, t.fields tfields FROM notes n JOIN notetypes t ON t.id=n.notetype_id WHERE n.id=?').get(noteId);
    if (!n) return null;
    const cards = this.db.prepare('SELECT c.id, c.deck_id, d.name dname FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.note_id=? ORDER BY c.ord').all(noteId);
    return { id: Number(n.id), typeName: n.tname, kind: n.kind, fieldNames: JSON.parse(n.tfields), fields: JSON.parse(n.fields), tags: n.tags || '',
      deck: cards[0] ? cards[0].dname : '', cardCount: cards.length, fromAnki: !!this.db.prepare('SELECT 1 FROM anki_cards WHERE card_id IN (SELECT id FROM cards WHERE note_id=?)').get(noteId) };
  }
  updateNote(noteId, { fields, tags, deck }) {
    const n = this.getNote(noteId); if (!n) throw new Error('That card no longer exists.');
    if (!Array.isArray(fields) || fields.length !== n.fieldNames.length) throw new Error('The card could not be saved.');
    const fx = fields.map((x) => String(x == null ? '' : x));
    if (!fx[0].replace(/<br\s*\/?>|&nbsp;|\s/gi, '')) throw new Error(`Please fill in “${n.fieldNames[0]}”.`);
    const ords = Store.cardOrds(n.kind, fx);
    if (n.kind === 'cloze' && !ords.length) throw new Error('A cloze card needs at least one blank, written like {{c1::answer}}.');
    const deckId = deck && deck !== n.deck ? this.createDeck(deck).id : null;
    this.tx(() => {
      this.db.prepare('UPDATE notes SET fields=?, tags=?, edited=1 WHERE id=?').run(JSON.stringify(fx), String(tags || '').trim().replace(/\s+/g, ' '), noteId);
      if (deckId) this.db.prepare('UPDATE cards SET deck_id=? WHERE note_id=?').run(deckId, noteId);
      if (ords) {       // a new blank number (c3) makes a new card
        const have = new Set(this.db.prepare('SELECT ord FROM cards WHERE note_id=?').all(noteId).map((r) => r.ord));
        const into = deckId || this.db.prepare('SELECT deck_id FROM cards WHERE note_id=? LIMIT 1').get(noteId).deck_id;
        let pos = (this.db.prepare('SELECT COALESCE(MAX(new_pos),0) m FROM cards').get().m || 0);
        for (const ord of ords) if (!have.has(ord)) this.db.prepare("INSERT INTO cards(note_id,deck_id,ord,state,step,due,interval,ease,reps,lapses,suspended,new_pos) VALUES(?,?,?,'new',0,0,0,0,0,0,0,?)").run(noteId, into, ord, ++pos);
      }
    });
    return { ok: true };
  }
  deleteNote(noteId) {
    this.tx(() => { this.db.prepare('DELETE FROM cards WHERE note_id=?').run(noteId); this.db.prepare('DELETE FROM notes WHERE id=?').run(noteId); });
    this.cleanup(); return { ok: true };
  }
  // notes of a deck (and its sub-decks), newest first. search: words that must appear in the card text
  listNotes({ deck = null, search = '', limit = 100, offset = 0 } = {}) {
    const ids = this.deckIdsByName(deck); if (!ids.length) return { total: 0, notes: [] };
    const where = [`c.deck_id IN (${ids.map(() => '?').join(',')})`]; const args = [...ids];
    for (const w of String(search || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) { where.push("lower(n.fields) LIKE ? ESCAPE '\\'"); args.push('%' + w.replace(/[\\%_]/g, '\\$&') + '%'); }
    const from = `FROM notes n JOIN cards c ON c.note_id=n.id JOIN decks d ON d.id=c.deck_id WHERE ${where.join(' AND ')}`;
    const total = this.db.prepare(`SELECT COUNT(DISTINCT n.id) c ${from}`).get(...args).c;
    const rows = this.db.prepare(`SELECT n.id, n.fields, MIN(d.name) dname, COUNT(c.id) cards ${from} GROUP BY n.id ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), offset);
    const plain = (x) => String(x || '').replace(/\[sound:[^\]]*\]/g, '🔊').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    return { total, notes: rows.map((r) => { const f = JSON.parse(r.fields); return { id: Number(r.id), front: plain(f[0]), back: plain(f[1]), deck: r.dname, cards: r.cards }; }) };
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
    // what AnkiWeb's review history wants to know about this answer
    const rtype = row.state === 'review' ? 1 : (row.state === 'learn' && row.interval > 0 ? 2 : 0);
    const ivlNew = next.state === 'review' ? Math.max(1, Math.round(next.interval)) : -Math.max(1, Math.round((next.due - now) / 1000));
    const ivlLast = row.state === 'review' ? Math.round(row.interval) : (row.state === 'learn' ? -(row.step ? 600 : 60) : 0);
    const factor = next.state === 'review' || (next.state === 'learn' && next.interval > 0) ? Math.round((next.ease || row.ease || 0) * 1000) : 0;
    this.tx(() => {
      this.db.prepare('UPDATE cards SET state=?, step=?, due=?, interval=?, ease=?, reps=?, lapses=?, dirty=1 WHERE id=?')
        .run(next.state, next.step || 0, next.due, next.interval || 0, next.ease || 0, next.reps, next.lapses || 0, cardId);
      this.db.prepare('INSERT INTO reviews(card_id,deck_id,ts,rating,ms,prev_state,interval_after,rtype,ivl_new,ivl_last,factor,pushed) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)')
        .run(cardId, row.deck_id, now, rating, Math.max(0, Math.min(Math.round(ms || 0), 600000)), row.state, next.interval || 0, rtype, ivlNew, ivlLast, factor);
    });
    return next;
  }


  // ---- sending progress back to AnkiWeb ---------------------------------------------------
  pendingPush() {
    const cards = this.db.prepare('SELECT * FROM cards WHERE dirty=1 AND id IN (SELECT card_id FROM anki_cards)').all()
      .map((c) => ({ ...c, snap: this.db.prepare('SELECT * FROM anki_cards WHERE card_id=?').get(c.id) }));
    const revlog = this.db.prepare('SELECT r.*, a.anki_id FROM reviews r JOIN anki_cards a ON a.card_id=r.card_id WHERE r.pushed=0 ORDER BY r.ts, r.id').all();
    return { cards, revlog };
  }
  markPushed(sent) {
    this.tx(() => {
      for (const id of sent.cardIds) this.db.prepare('UPDATE cards SET dirty=0 WHERE id=?').run(id);
      for (const id of sent.reviewIds) this.db.prepare('UPDATE reviews SET pushed=1 WHERE id=?').run(id);
      for (const s of sent.snapshots) this.db.prepare('UPDATE anki_cards SET mtime=?, usn=?, ctype=?, queue=?, due=?, ivl=?, factor=?, reps=?, lapses=?, left=? WHERE card_id=?')
        .run(s.mtime, s.usn, s.ctype, s.queue, s.due, s.ivl, s.factor, s.reps, s.lapses, s.left, s.card_id);
    });
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
