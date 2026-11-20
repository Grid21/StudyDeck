// StudyDeck core logic. No Electron in here, so it can be tested on its own.
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- storage: one JSON file, written safely ----------
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.data = { decks: [], friends: [], profile: { name: '' }, settings: { githubRepo: '' }, reviews: [] };
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign(this.data, loaded);
      } catch (e) {
        // keep the broken file instead of losing it
        fs.copyFileSync(this.file, this.file + '.broken-' + Date.now());
      }
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---------- decks and cards ----------
function addDeck(store, name, subject) {
  name = String(name || '').trim();
  if (!name) throw new Error('Please type a deck name.');
  const deck = { id: uid(), name, subject: String(subject || '').trim(), cards: [], created: Date.now() };
  store.data.decks.push(deck);
  store.save();
  return deck;
}

function findDeck(store, id) {
  const d = store.data.decks.find(x => x.id === id);
  if (!d) throw new Error('Deck not found.');
  return d;
}

function deleteDeck(store, id) {
  store.data.decks = store.data.decks.filter(d => d.id !== id);
  store.save();
}

function addCard(store, deckId, front, back) {
  front = String(front || '').trim();
  back = String(back || '').trim();
  if (!front || !back) throw new Error('A card needs both a front and a back.');
  const deck = findDeck(store, deckId);
  const card = { id: uid(), front, back, due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  deck.cards.push(card);
  store.save();
  return card;
}

function deleteCard(store, deckId, cardId) {
  const deck = findDeck(store, deckId);
  deck.cards = deck.cards.filter(c => c.id !== cardId);
  store.save();
}

// ---------- spaced repetition (simple SM-2 style) ----------
// rating: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
function schedule(card, rating, now = Date.now()) {
  const c = Object.assign({}, card);
  if (rating === 1) {
    c.lapses += 1;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = now + 60 * 1000; // see again in a minute
  } else {
    if (c.interval === 0) c.interval = rating === 4 ? 4 : 1;
    else if (rating === 2) { c.interval = Math.max(1, Math.round(c.interval * 1.2)); c.ease = Math.max(1.3, c.ease - 0.15); }
    else if (rating === 3) c.interval = Math.max(1, Math.round(c.interval * c.ease));
    else { c.interval = Math.max(1, Math.round(c.interval * c.ease * 1.3)); c.ease += 0.15; }
    c.due = now + c.interval * DAY;
  }
  c.reps += 1;
  return c;
}

function dueCards(deck, now = Date.now()) {
  return deck.cards.filter(c => c.due <= now);
}

function review(store, deckId, cardId, rating, now = Date.now()) {
  const deck = findDeck(store, deckId);
  const i = deck.cards.findIndex(c => c.id === cardId);
  if (i < 0) throw new Error('Card not found.');
  deck.cards[i] = schedule(deck.cards[i], rating, now);
  store.data.reviews.push({ t: now, deck: deckId, subject: deck.subject, rating });
  store.save();
  return deck.cards[i];
}

// ---------- progress (what friends will see) ----------
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

function progress(store, now = Date.now()) {
  const bySubject = {};
  const today = startOfDay(now);
  for (const d of store.data.decks) {
    const s = d.subject || 'General';
    bySubject[s] = bySubject[s] || { subject: s, cards: 0, learned: 0, reviewsToday: 0, streak: 0 };
    bySubject[s].cards += d.cards.length;
    bySubject[s].learned += d.cards.filter(c => c.interval >= 21).length;
  }
  for (const r of store.data.reviews) {
    const s = r.subject || 'General';
    if (bySubject[s] && r.t >= today) bySubject[s].reviewsToday += 1;
  }
  // streak = consecutive days (ending today or yesterday) with at least one review
  const days = new Set(store.data.reviews.map(r => startOfDay(r.t)));
  let streak = 0, day = days.has(today) ? today : today - DAY;
  while (days.has(day)) { streak++; day -= DAY; }
  return { name: store.data.profile.name, streak, subjects: Object.values(bySubject), updated: now };
}

// ---------- friends ----------
// Stage 1: friends are stored on this computer and their progress is shared by exchanging a small
// "friend code" (a text snippet). Online accounts come in a later stage.
function makeFriendCode(store) {
  const p = progress(store);
  if (!p.name) throw new Error('Set your name first (Friends tab).');
  return 'SDF1:' + Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

function addFriendFromCode(store, code) {
  code = String(code || '').trim();
  if (!code.startsWith('SDF1:')) throw new Error('That is not a friend code. It should start with SDF1:');
  let p;
  try { p = JSON.parse(Buffer.from(code.slice(5), 'base64').toString('utf8')); }
  catch (e) { throw new Error('That friend code is damaged. Ask your friend to copy it again.'); }
  if (!p || typeof p.name !== 'string' || !p.name || !Array.isArray(p.subjects)) throw new Error('That friend code is not complete.');
  const clean = {
    name: p.name.slice(0, 40),
    streak: Number(p.streak) || 0,
    subjects: p.subjects.slice(0, 50).map(s => ({
      subject: String(s.subject || '').slice(0, 60),
      cards: Number(s.cards) || 0,
      learned: Number(s.learned) || 0,
      reviewsToday: Number(s.reviewsToday) || 0
    })),
    updated: Number(p.updated) || Date.now()
  };
  const i = store.data.friends.findIndex(f => f.name.toLowerCase() === clean.name.toLowerCase());
  if (i >= 0) store.data.friends[i] = clean; else store.data.friends.push(clean);
  store.save();
  return clean;
}

function removeFriend(store, name) {
  store.data.friends = store.data.friends.filter(f => f.name !== name);
  store.save();
}

// friends who study the same subject as you
function sharedSubjects(store) {
  const mine = progress(store).subjects;
  const out = [];
  for (const m of mine) {
    const peers = [];
    for (const f of store.data.friends) {
      const s = f.subjects.find(x => x.subject.toLowerCase() === m.subject.toLowerCase());
      if (s) peers.push({ name: f.name, learned: s.learned, cards: s.cards, reviewsToday: s.reviewsToday, streak: f.streak });
    }
    if (peers.length) out.push({ subject: m.subject, me: m, friends: peers });
  }
  return out;
}

// ---------- import / export (simple JSON and CSV; .apkg comes in a later stage) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const delim = text.indexOf('\t') >= 0 && text.indexOf('\t') < (text.indexOf('\n') < 0 ? text.length : text.indexOf('\n')) ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

function importCsv(store, deckName, subject, text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  if (!rows.length) throw new Error('The file is empty.');
  const deck = addDeck(store, deckName, subject);
  let n = 0;
  for (const r of rows) {
    if (r.length >= 2 && r[0].trim() && r[1].trim()) { addCard(store, deck.id, r[0], r[1]); n++; }
  }
  if (!n) { deleteDeck(store, deck.id); throw new Error('No cards found. Each line needs a front and a back, separated by a comma or tab.'); }
  return { deck: findDeck(store, deck.id), imported: n };
}

function exportDeckJson(store, deckId) {
  const d = findDeck(store, deckId);
  return JSON.stringify({ format: 'studydeck-deck', version: 1, name: d.name, subject: d.subject, cards: d.cards.map(c => ({ front: c.front, back: c.back })) }, null, 2);
}

function importDeckJson(store, text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error('That file is not a StudyDeck deck.'); }
  if (!o || o.format !== 'studydeck-deck' || !Array.isArray(o.cards)) throw new Error('That file is not a StudyDeck deck.');
  const deck = addDeck(store, o.name || 'Imported deck', o.subject);
  let n = 0;
  for (const c of o.cards) { if (c && c.front && c.back) { addCard(store, deck.id, c.front, c.back); n++; } }
  return { deck: findDeck(store, deck.id), imported: n };
}

// ---------- updates from GitHub ----------
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
}

// repo looks like "owner/name". fetchFn is injectable so tests do not need the internet.
async function checkForUpdate(repo, currentVersion, fetchFn = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('Type the GitHub address like  owner/name  (for example  yourname/studydeck).');
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'StudyDeck', Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error('No release found on GitHub for ' + repo + ' yet.');
  if (!res.ok) throw new Error('GitHub answered with an error (' + res.status + '). Try again later.');
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  return { current: currentVersion, latest, newer: compareVersions(latest, currentVersion) > 0, page: rel.html_url, notes: rel.body || '', assets: (rel.assets || []).map(a => ({ name: a.name, url: a.browser_download_url })) };
}

module.exports = { Store, addDeck, deleteDeck, addCard, deleteCard, schedule, dueCards, review, progress,
  makeFriendCode, addFriendFromCode, removeFriend, sharedSubjects, parseCsv, importCsv, exportDeckJson,
  importDeckJson, compareVersions, checkForUpdate, findDeck };
