'use strict';
const sd = window.studydeck;
const $ = (id) => document.getElementById(id);

// small helper for building screens safely (never inserts text as HTML)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const btn = (label, onclick, cls = '') => h('button', { class: 'btn ' + cls, onclick }, label);
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// ---- navigation ------------------------------------------------------------------------
const renderers = { browse: renderBrowse, home: renderHome, decks: renderDecks, friends: renderFriends, progress: renderProgress, plugins: renderPlugins, settings: renderSettings };
let studyState = null;

function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === name));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $('nav').classList.toggle('hidden', name === 'study');
  if (name !== 'study') studyState = null;
  if (renderers[name]) renderers[name]();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

// ---- decks: tree building -----------------------------------------------------------------
function cmpPath(a, b) {
  const x = a.split('::'), y = b.split('::');
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = x[i].localeCompare(y[i]); if (c) return c; }
  return x.length - y.length;
}
function buildTree(rows) {
  const nodes = new Map();
  const get = (path) => {
    if (!nodes.has(path)) nodes.set(path, { path, label: path.split('::').pop(), depth: path.split('::').length - 1, sum: { total: 0, newCount: 0, learnCount: 0, reviewCount: 0 } });
    return nodes.get(path);
  };
  for (const r of rows) {
    const parts = r.name.split('::');
    for (let i = 1; i <= parts.length; i++) {
      const n = get(parts.slice(0, i).join('::'));
      for (const k of Object.keys(n.sum)) n.sum[k] += r[k];
    }
  }
  return [...nodes.values()].sort((a, b) => cmpPath(a.path, b.path));
}
const num = (cls, n) => h('td', { class: 'num ' + (n ? cls : 'zero') }, n);

// ---- home -----------------------------------------------------------------------------------
async function renderHome() {
  const el = $('home'); el.replaceChildren();
  const [rows, stats, info] = await Promise.all([sd.listDecks(), sd.progress(), sd.info()]);
  const sum = rows.reduce((s, r) => ({ n: s.n + r.newCount, l: s.l + r.learnCount, r: s.r + r.reviewCount }), { n: 0, l: 0, r: 0 });
  const due = sum.n + sum.l + sum.r;
  el.append(h('h1', {}, 'Welcome to StudyDeck'));
  if (info.problem) el.append(h('div', { class: 'card warn' }, info.problem));
  if (!rows.length) {
    el.append(h('div', { class: 'card' },
      h('p', {}, 'You have no decks yet. Import an Anki deck file (.apkg) to start studying.'),
      btn('Import a deck…', () => { showPage('decks'); doImport(); })));
    return;
  }
  el.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'n' }, due), h('div', { class: 'l' }, 'cards to study now')),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, stats.today.reviewed), h('div', { class: 'l' }, 'reviewed today')),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, stats.streak), h('div', { class: 'l' }, stats.streak === 1 ? 'day streak' : 'day streak')),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, stats.cards.total), h('div', { class: 'l' }, 'cards in total'))));
  el.append(h('div', { class: 'card' },
    due
      ? [h('p', {}, h('span', { class: 'c-new' }, `${sum.n} new`), ' · ', h('span', { class: 'c-learn' }, `${sum.l} learning`), ' · ', h('span', { class: 'c-review' }, `${sum.r} to review`)),
        btn('Study all decks', () => startStudy(null))]
      : [h('p', {}, 'Nothing is due right now. Nice work!'), btn('Go to decks', () => showPage('decks'), 'secondary')]));
}

// ---- cards: add, browse, edit ----------------------------------------------------------------
let browseState = { deck: null, search: '', editing: null, offset: 0 };
function openBrowse(deck) { browseState = { deck, search: '', editing: null, offset: 0 }; showPage('browse'); }
const toHtml = (t) => String(t).replace(/\r?\n/g, '<br>');
const fromHtml = (t) => String(t).replace(/<br\s*\/?>/gi, '\n');

// One form for adding (note = null) and editing a card.
function cardForm(note, deck, done) {
  const msg = h('div', { class: 'muted' });
  const type = h('select', {}, h('option', { value: 'basic' }, 'Basic (front and back)'), h('option', { value: 'reversed' }, 'Basic and reversed (two cards)'), h('option', { value: 'cloze' }, 'Cloze (fill in the blank)'));
  const deckIn = h('input', { type: 'text', value: note ? note.deck : deck, style: 'width:100%' });
  const tagsIn = h('input', { type: 'text', value: note ? note.tags : '', placeholder: 'optional, separated by spaces', style: 'width:100%' });
  const fieldBox = h('div', {}); let inputs = [];
  const build = (names, values) => {
    inputs = names.map((nm, i) => h('textarea', { rows: i === 0 ? 3 : 2, style: 'width:100%' }));
    inputs.forEach((t, i) => { t.value = fromHtml(values ? values[i] : ''); });
    fieldBox.replaceChildren(...names.map((nm, i) => h('label', {}, h('div', { class: 'muted' }, nm), inputs[i])));
  };
  const names = { basic: ['Front', 'Back'], reversed: ['Front', 'Back'], cloze: ['Text (write blanks like {{c1::answer}})', 'Extra (shown with the answer, optional)'] };
  if (note) build(note.fieldNames, note.fields); else { build(names.basic); type.onchange = () => build(names[type.value]); }
  const save = async () => {
    const fields = inputs.map((t) => toHtml(t.value));
    const r = note ? await sd.updateNote({ id: note.id, fields, tags: tagsIn.value, deck: deckIn.value })
                   : await sd.addNote({ deck: deckIn.value, type: type.value, fields, tags: tagsIn.value });
    if (!r.ok) { msg.textContent = r.error; msg.className = 'bad-text'; return; }
    if (note) return done();
    msg.textContent = `Added (${plural(r.cards, 'card', 'cards')}). Add another, or press Done.`; msg.className = 'good-text';
    inputs.forEach((t) => { t.value = ''; }); inputs[0].focus(); done(true);
  };
  return h('div', { class: 'card' },
    note ? h('strong', {}, 'Edit card') : h('strong', {}, 'Add a card'),
    note && note.fromAnki ? h('p', { class: 'muted' }, 'This card came from AnkiWeb. Your change stays in StudyDeck only: it is not sent to AnkiWeb, and a later sync will not replace it.') : '',
    note ? h('p', { class: 'muted' }, note.typeName) : h('label', {}, h('div', { class: 'muted' }, 'Card type'), type),
    fieldBox, h('label', {}, h('div', { class: 'muted' }, 'Deck'), deckIn), h('label', {}, h('div', { class: 'muted' }, 'Tags'), tagsIn),
    h('div', { class: 'row' }, btn(note ? 'Save' : 'Add card', save), btn(note ? 'Cancel' : 'Done', () => done(false, true), 'secondary')), msg);
}

async function renderBrowse() {
  const el = $('browse'); el.replaceChildren();
  const st = browseState; const deck = st.deck;
  el.append(h('div', { class: 'row' }, btn('← Decks', () => showPage('decks'), 'secondary'), h('h2', { style: 'margin:0 0 0 12px' }, deck ? deck : 'All cards')));
  const listBox = h('div', {}); const formBox = h('div', {});
  const refresh = async () => {
    const r = await sd.listNotes({ deck, search: st.search, offset: st.offset });
    if (!r.ok) { listBox.replaceChildren(h('div', { class: 'card bad' }, r.error)); return; }
    if (!r.notes.length) { listBox.replaceChildren(h('div', { class: 'card' }, st.search ? 'No cards match.' : 'No cards here yet. Use “Add a card” above.')); return; }
    listBox.replaceChildren(h('p', { class: 'muted' }, `${plural(r.total, 'card note', 'card notes')}${r.total > r.notes.length + st.offset ? ` (showing ${st.offset + 1}–${st.offset + r.notes.length})` : ''}`),
      h('table', { class: 'decks' }, h('tbody', {}, r.notes.map((n) => h('tr', {},
        h('td', {}, n.front || '(empty)'), h('td', { class: 'muted' }, n.back), h('td', { class: 'muted' }, n.deck),
        h('td', { class: 'actions' }, btn('Edit', () => edit(n.id), 'small'), ' ', btn('Delete', async () => {
          if (!confirm('Delete this card? Its study history stays in Progress.')) return; await sd.deleteNote({ id: n.id }); refresh();
        }, 'small danger')))))),
      st.offset > 0 ? btn('← Newer', () => { st.offset = Math.max(0, st.offset - 100); refresh(); }, 'secondary') : '',
      r.total > st.offset + r.notes.length ? btn('Older →', () => { st.offset += 100; refresh(); }, 'secondary') : '');
  };
  const addForm = () => { formBox.replaceChildren(cardForm(null, deck || '', (added, close) => { if (close) formBox.replaceChildren(); if (added || close) refresh(); })); };
  const edit = async (id) => {
    const r = await sd.getNote({ id }); if (!r.ok) return alert(r.error);
    formBox.replaceChildren(cardForm(r.note, deck || '', () => { formBox.replaceChildren(); refresh(); })); formBox.scrollIntoView();
  };
  const search = h('input', { type: 'search', placeholder: 'Search the cards', value: st.search, style: 'min-width:240px' });
  search.oninput = () => { st.search = search.value; st.offset = 0; refresh(); };
  el.append(h('div', { class: 'row' }, btn('Add a card', addForm), search), formBox, listBox);
  refresh();
}

// ---- decks page -----------------------------------------------------------------------------
async function renderDecks() {
  const el = $('decks');
  if (!el.querySelector('#import-results')) {
    el.replaceChildren(
      h('h2', {}, 'Decks'),
      h('div', { class: 'row' },
        btn('Import deck…', () => doImport()),
        btn('New deck…', async () => {
          const name = prompt('Name of the new deck (write Korean::Verbs for a sub-deck):'); if (!name) return;
          const r = await sd.createDeck({ name }); if (!r.ok) return alert(r.error); openBrowse(r.name);
        }, 'secondary'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'keep-progress', checked: true }), 'Keep my progress from Anki')),
      h('p', { class: 'muted' }, 'You can also drag .apkg or .colpkg files into this window. Importing the same deck again updates its text and keeps your progress here.'),
      h('div', { id: 'anki-sync' }),
      h('div', { id: 'import-results' }),
      h('div', { id: 'deck-list' }));
  }
  renderAnkiSync();
  const list = $('deck-list'); list.replaceChildren();
  const rows = await sd.listDecks();
  if (!rows.length) { list.append(h('div', { class: 'card' }, 'No decks yet. Use “Import deck…” or “New deck…” above.')); return; }
  const table = h('table', { class: 'decks' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Deck'), h('th', { class: 'num' }, 'New'), h('th', { class: 'num' }, 'Learn'), h('th', { class: 'num' }, 'Due'), h('th', {}, ''))),
    h('tbody', {}, buildTree(rows).map((n) => h('tr', {},
      h('td', { style: `padding-left:${12 + n.depth * 22}px` }, n.label, n.sum.total ? h('span', { class: 'muted' }, `  (${n.sum.total})`) : ''),
      num('c-new', n.sum.newCount), num('c-learn', n.sum.learnCount), num('c-review', n.sum.reviewCount),
      h('td', { class: 'actions' },
        btn('Study', () => startStudy(n.path), 'small'), ' ',
        btn('Cards', () => openBrowse(n.path), 'small secondary'), ' ',
        btn('Rename', async () => {
          const to = prompt('New name for “' + n.path + '” (sub-decks go with it):', n.path); if (to === null || to.trim() === n.path) return;
          const r = await sd.renameDeck({ from: n.path, to }); if (!r.ok) alert(r.error); renderDecks();
        }, 'small secondary'), ' ',
        btn('Delete', async () => {
          if (!confirm(`Delete “${n.path}” and everything inside it? Your study history stays in Progress.`)) return;
          await sd.deleteDeck(n.path); renderDecks();
        }, 'small danger'))))));
  list.append(table);
}

async function doImport(paths) {
  const keep = !document.querySelector('#keep-progress') || document.querySelector('#keep-progress').checked;
  const box = document.querySelector('#import-results');
  if (box) box.replaceChildren(h('div', { class: 'card' }, 'Importing… large decks can take a little while.'));
  const r = await sd.importDecks({ paths, keepProgress: keep });
  if (!box) return;
  box.replaceChildren();
  if (r.cancelled) return;
  for (const x of r.results) {
    if (x.ok) {
      const bits = [`${plural(x.notesAdded, 'note', 'notes')} added`, `${plural(x.cardsAdded, 'card', 'cards')}`, `${plural(x.mediaCount, 'media file', 'media files')}`];
      if (x.notesUpdated) bits.push(`${plural(x.notesUpdated, 'note', 'notes')} updated`);
      box.append(h('div', { class: 'card ok' }, h('strong', {}, '✓ ' + x.file), h('div', { class: 'muted' }, bits.join(' · ')), (x.warnings || []).map((w) => h('div', { class: 'muted' }, w))));
    } else box.append(h('div', { class: 'card bad' }, h('strong', {}, x.file), h('div', { class: 'bad-text' }, x.error)));
  }
  renderDecks();
}

// drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  const paths = Array.from(e.dataTransfer.files).map((f) => sd.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  showPage('decks'); doImport(paths);
});

// ---- sounds: every sound on a side plays one after another, like Anki ----------------------------
let soundRun = 0, soundNow = null;
window.__soundLog = [];
function stopSounds() { soundRun++; if (soundNow) soundNow('stop'); soundNow = null; }
async function playSounds(urls) {
  stopSounds();
  const run = soundRun;
  for (const url of urls || []) {
    if (run !== soundRun) return;
    await new Promise((resolve) => {
      const a = new Audio(url);
      const name = decodeURIComponent(url.split('/').pop());
      let finished = false;
      const finish = (why) => { if (finished) return; finished = true; soundNow = null; try { a.pause(); } catch { /* ignore */ } window.__soundLog.push(why + ':' + name); resolve(); };
      soundNow = finish;
      a.addEventListener('ended', () => finish('end'));
      a.addEventListener('error', () => finish('error'));
      window.__soundLog.push('start:' + name);
      a.play().catch(() => finish('blocked'));
    });
  }
}
function replaySounds() { const s = studyState; if (s && s.p && !s.p.done) playSounds(s.side === 'q' ? s.p.qSounds : s.p.aSounds); }

// ---- studying -------------------------------------------------------------------------------
async function startStudy(deckName) {
  showPage('study');
  studyState = { deckName, busy: false, p: null, side: 'q', shownAt: 0 };
  renderStudy(await sd.studyNext(deckName));
}
function exitStudy() { stopSounds(); showPage('decks'); }

function countsBar(c) {
  return h('div', { class: 'counts' }, h('span', { class: 'c-new' }, c.newCount), h('span', { class: 'c-learn' }, c.learnCount), h('span', { class: 'c-review' }, c.reviewCount));
}

function renderStudy(p) {
  const el = $('study'); el.replaceChildren();
  if (!studyState) return;
  studyState.p = p; studyState.side = 'q'; studyState.shownAt = Date.now();
  const top = (title) => h('div', { class: 'study-top' }, btn('← Back', exitStudy, 'secondary small'), h('strong', {}, title), p.counts ? countsBar(p.counts) : '');
  if (p.done) {
    stopSounds();
    el.append(top(studyState.deckName || 'All decks'),
      h('div', { class: 'done' }, h('h2', {}, 'All done for now 🎉'), h('p', { class: 'muted' }, 'No more cards are due in this deck.'), btn('Back to decks', exitStudy)));
    return;
  }
  const frame = h('iframe', { class: 'card-frame', sandbox: '', title: 'Card' });
  frame.srcdoc = p.question;
  const bottom = h('div', { class: 'study-bottom' });
  el.append(top(p.deck), frame, bottom);
  renderStudyBottom();
  playSounds(p.qSounds);
}

function typedCompare(expected, typed) {
  const ok = typed.trim() === expected.trim();
  return h('div', { class: 'typeresult' },
    ok ? h('span', { class: 'good-text' }, '✓ Correct: ' + expected)
      : [h('div', {}, 'You typed: ', h('span', { class: 'bad-text' }, typed || '(nothing)')), h('div', {}, 'Correct answer: ', h('strong', { class: 'good-text' }, expected))]);
}

function renderStudyBottom() {
  const s = studyState; const p = s.p;
  const bottom = document.querySelector('.study-bottom'); bottom.replaceChildren();
  if (s.side === 'q') {
    if (p.typeExpected !== null) {
      bottom.append(h('div', { class: 'typebox' }, h('input', { type: 'text', id: 'typed', placeholder: 'Type the answer, then press Enter', autocomplete: 'off', spellcheck: 'false' })));
      setTimeout(() => { const t = document.getElementById('typed'); if (t) t.focus(); }, 0);
    }
    bottom.append(btn('Show answer  (Space)', showAnswer, 'show-answer'));
  } else {
    if (p.typeExpected !== null) bottom.append(typedCompare(p.typeExpected, s.typed || ''));
    const names = ['Again', 'Hard', 'Good', 'Easy'];
    bottom.append(h('div', { class: 'rates' }, names.map((n, i) =>
      h('button', { class: `rate r${i + 1}`, onclick: () => rate(i + 1) }, `${i + 1}  ${n}`, h('small', {}, p.labels[i])))));
  }
}

function showAnswer() {
  const s = studyState; if (!s || s.busy || s.side !== 'q') return;
  const t = document.getElementById('typed'); s.typed = t ? t.value : '';
  s.side = 'a';
  document.querySelector('.card-frame').srcdoc = s.p.answer;
  renderStudyBottom();
  playSounds(s.p.aSounds);
}

async function rate(r) {
  const s = studyState; if (!s || s.busy || s.side !== 'a') return;
  s.busy = true;
  const ms = Date.now() - s.shownAt;
  const next = await sd.studyAnswer({ cardId: s.p.cardId, rating: r, ms, deckName: s.deckName });
  s.busy = false; s.typed = '';
  renderStudy(next);
}

document.addEventListener('keydown', (e) => {
  if (!studyState || !$('study').classList.contains('active') || studyState.p == null || studyState.p.done) {
    if (e.key === 'Escape' && studyState) exitStudy();
    return;
  }
  if (e.key === 'Escape') { exitStudy(); return; }
  const typing = e.target && e.target.id === 'typed';
  if ((e.key === 'r' || e.key === 'R') && !typing) { replaySounds(); return; }
  if (studyState.side === 'q') {
    if (e.key === 'Enter' || (e.key === ' ' && !typing)) { e.preventDefault(); showAnswer(); }
  } else if (['1', '2', '3', '4'].includes(e.key)) { rate(Number(e.key)); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); rate(3); }
});

// ---- friends --------------------------------------------------------------------------------
const note = (el, ok, text) => { el.textContent = text; el.className = ok ? 'good-text' : 'bad-text'; };
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');

async function renderFriends() {
  const el = $('friends');
  const st = await sd.friendsState();
  el.replaceChildren(h('h2', {}, 'Friends'));
  if (!st.signedIn) return renderFriendsSignIn(el, st);

  const rr = await sd.friendsSync();            // send my latest numbers first
  if (rr.signedOut) return renderFriends();
  const list = await sd.friendsList();
  if (!list.ok) { el.append(h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, list.error), btn('Try again', () => renderFriends(), 'secondary'))); return; }
  const msg = h('span', { class: 'muted' });

  el.append(h('div', { class: 'card' },
    h('div', { class: 'row space' },
      h('div', {}, h('strong', {}, st.me.displayName), h('span', { class: 'muted' }, `  @${st.me.username}`), h('div', { class: 'muted' }, 'Your friend code (share it so friends can add you):')),
      h('div', { class: 'row' }, h('code', { class: 'code' }, st.me.friendCode),
        btn('Copy', async (e) => { try { await navigator.clipboard.writeText(st.me.friendCode); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; } }, 'secondary small'))),
    h('div', { class: 'row', style: 'margin-top:10px' },
      btn('Sync now', async () => { const r = await sd.friendsSync(); note(msg, r.ok, r.ok ? 'Your progress is up to date.' : r.error); }, 'secondary small'),
      btn('Sign out', async () => { await sd.friendsLogout(); renderFriends(); }, 'secondary small'), msg)));

  // add a friend
  const addIn = h('input', { type: 'text', placeholder: 'Friend code (ABCD-2345), username or Discord name', class: 'text' });
  const addMsg = h('span', {});
  const add = async () => {
    const r = await sd.friendsRequest(addIn.value);
    if (!r.ok) return note(addMsg, false, r.error);
    addIn.value = ''; renderFriends();
  };
  addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  el.append(h('h3', {}, 'Add a friend'), h('div', { class: 'card' }, h('div', { class: 'row' }, addIn, btn('Send request', add), addMsg)));

  // Discord: let people find me, and people I may know
  if (st.me.discord && st.me.discord.linked) {
    const dBox = h('div', { class: 'card' });
    const dMsg = h('span', {});
    const agree = h('input', { type: 'checkbox', checked: st.me.discoverable });
    agree.addEventListener('change', async () => { const r = await sd.friendsSetDiscoverable(agree.checked); note(dMsg, r.ok, r.ok ? 'Saved.' : r.error); renderFriends(); });
    dBox.append(h('div', { class: 'muted' }, `Signed in with Discord as ${st.me.discord.name}.`),
      h('label', { class: 'row check' }, agree, 'Let people find me through Discord (by my Discord name, or because we share a Discord server)'), dMsg,
      h('div', { class: 'muted' }, 'You and the other person both need this switched on. Nobody sees which servers you are in, only how many you share.'));
    const sg = await sd.friendsSuggestions();
    if (sg.ok && sg.enabled) {
      dBox.append(h('h3', {}, 'People you may know'));
      if (!sg.suggestions.length) dBox.append(h('div', { class: 'muted' }, 'No one yet. Friends who use StudyDeck, share a Discord server with you and have switched this on will show up here.'));
      else dBox.append(h('ul', { class: 'plain' }, sg.suggestions.map((p) => h('li', { class: 'row space' },
        h('span', {}, h('strong', {}, p.displayName), h('span', { class: 'muted' }, `  ${p.discordName} · ${p.sharedServers} shared Discord server${p.sharedServers === 1 ? '' : 's'}`)),
        btn('Add friend', async () => { const r = await sd.friendsRequest(p.username); if (!r.ok) return note(dMsg, false, r.error); renderFriends(); }, 'small')))));
    }
    el.append(h('h3', {}, 'Discord'), dBox);
  }

  if (list.incoming.length || list.outgoing.length) {
    el.append(h('h3', {}, 'Requests'), h('ul', { class: 'plain' },
      list.incoming.map((r) => h('li', { class: 'row space' }, h('span', {}, h('strong', {}, r.displayName), `  @${r.username} wants to be your friend`),
        h('span', { class: 'row' }, btn('Accept', async () => { await sd.friendsRespond(r.id, true); renderFriends(); }, 'small'), btn('Decline', async () => { await sd.friendsRespond(r.id, false); renderFriends(); }, 'secondary small')))),
      list.outgoing.map((r) => h('li', { class: 'muted' }, `Waiting for ${r.displayName} (@${r.username}) to accept`))));
  }

  // what I share
  const boxes = st.localSubjects.map((s) => h('label', { class: 'row check' }, h('input', { type: 'checkbox', value: s, checked: st.shares.includes(s) }), s));
  const shareMsg = h('span', {});
  el.append(h('h3', {}, 'What you share'), h('div', { class: 'card' },
    h('p', { class: 'muted' }, 'Friends see only how many cards you reviewed per day in the subjects you tick (and your streak). Never your cards or notes. Unticking a subject removes it from the server.'),
    boxes.length ? boxes : h('p', {}, 'Import a deck first. Each top-level deck, such as “Korean”, becomes a subject.'),
    boxes.length ? h('div', { class: 'row' }, btn('Save sharing', async () => {
      const chosen = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      const r = await sd.friendsSetShares(chosen); note(shareMsg, r.ok, r.ok ? 'Saved.' : r.error); if (r.ok) renderFriends();
    }), shareMsg) : ''));

  // friends list
  el.append(h('h3', {}, 'Your friends'));
  if (!list.friends.length) el.append(h('div', { class: 'card muted' }, 'No friends yet. Send your friend code to someone, or add theirs above.'));
  else el.append(h('table', { class: 'decks' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Friend'), h('th', { class: 'num' }, 'Streak'), h('th', { class: 'num' }, 'Today'), h('th', { class: 'num' }, '7 days'), h('th', {}, 'Shares'), h('th', {}, ''))),
    h('tbody', {}, list.friends.map((f) => h('tr', {},
      h('td', {}, f.displayName, h('span', { class: 'muted' }, `  @${f.username}`)),
      h('td', { class: 'num' }, f.streak), h('td', { class: 'num' }, f.todayReviews), h('td', { class: 'num' }, f.weekReviews),
      h('td', { class: 'muted' }, f.subjects.join(', ') || 'nothing yet'),
      h('td', { class: 'actions' }, btn('Remove', async () => { if (confirm(`Remove ${f.displayName} from your friends?`)) { await sd.friendsRemove(f.username); renderFriends(); } }, 'small danger')))))));

  // study together
  const subj = await sd.friendsSubjects();
  const box = h('div', {});
  el.append(h('h3', {}, 'Study together'));
  const together = (subj.subjects || []).filter((x) => x.people > 1);
  if (!together.length) { el.append(h('div', { class: 'card muted' }, 'When you and a friend both share the same subject (Korean, for example), your progress is compared here.')); return; }
  const pick = h('select', {}, together.map((x) => h('option', { value: x.subject }, `${x.subject} (${x.people} people)`)));
  const show = async () => {
    const r = await sd.friendsCompare(pick.value); box.replaceChildren();
    if (!r.ok) { box.append(h('div', { class: 'bad-text' }, r.error)); return; }
    box.append(h('table', { class: 'decks' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Name'), h('th', { class: 'num' }, 'Today'), h('th', { class: 'num' }, '7 days'), h('th', { class: 'num' }, 'Correct'), h('th', { class: 'num' }, 'Days'), h('th', { class: 'num' }, 'Streak'))),
      h('tbody', {}, r.members.map((m, i) => h('tr', { class: m.you ? 'me' : '' }, h('td', {}, i + 1), h('td', {}, m.you ? 'You' : m.displayName),
        h('td', { class: 'num' }, m.todayReviews), h('td', { class: 'num' }, m.weekReviews), h('td', { class: 'num' }, pct(m.weekCorrect, m.weekReviews)), h('td', { class: 'num' }, `${m.weekDays}/7`), h('td', { class: 'num' }, m.streak))))));
  };
  pick.addEventListener('change', show);
  el.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('label', {}, 'Subject  '), pick), box));
  show();
}

async function renderFriendsSignIn(el, st) {
  const server = h('input', { type: 'text', class: 'text wide', placeholder: 'https://your-friends-server.example.com', value: st.server });
  const user = h('input', { type: 'text', class: 'text', placeholder: 'Username', autocomplete: 'username' });
  const pass = h('input', { type: 'password', class: 'text', placeholder: 'Password (8+ characters)', autocomplete: 'current-password' });
  const name = h('input', { type: 'text', class: 'text', placeholder: 'Display name (optional)' });
  const msg = h('div', {});
  const go = async (kind) => {
    const s = await sd.friendsSetServer(server.value); if (!s.ok) return note(msg, false, s.error);
    note(msg, true, 'Working…');
    const r = await (kind === 'register' ? sd.friendsRegister : sd.friendsLogin)({ username: user.value, password: pass.value, displayName: name.value });
    if (!r.ok) return note(msg, false, r.error);
    renderFriends();
  };
  const dc = st.server ? await sd.friendsDiscordConfig() : { enabled: false };
  const discordBtn = dc.enabled ? btn('Continue with Discord', async () => {
    const s = await sd.friendsSetServer(server.value); if (!s.ok) return note(msg, false, s.error);
    const b = await sd.friendsDiscordBegin(); if (!b.ok) return note(msg, false, b.error);
    note(msg, true, 'Finish signing in with Discord in your web browser, then come back here…');
    for (let i = 0; i < 150 && $('friends').classList.contains('active'); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await sd.friendsDiscordPoll();
      if (!p.ok) return note(msg, false, p.error);
      if (p.done) return renderFriends();
    }
  }, 'secondary') : '';
  el.append(
    h('p', {}, 'Add friends and compare study progress on the same subject. This needs a friends server (a small program that connects friends). It is open source: see the server folder to run your own, or use an address someone gives you.'),
    st.error ? h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, st.error)) : '',
    h('div', { class: 'card' }, h('label', { class: 'field' }, 'Friends server address', server)),
    h('div', { class: 'card' }, h('div', { class: 'row' }, user, pass, name), h('div', { class: 'row', style: 'margin-top:10px' }, btn('Create account', () => go('register')), btn('Sign in', () => go('login'), 'secondary'), discordBtn), msg));
}


// ---- AnkiWeb sync -----------------------------------------------------------------------------
async function renderAnkiSync() {
  const box = $('anki-sync'); if (!box) return;
  const st = await sd.ankiState();
  const msg = h('div', {});
  if (st.signedIn) {
    const when = st.lastSync ? new Date(st.lastSync).toLocaleString() : 'never';
    const sync = async (force) => {
      const note2 = (ok, t) => note(msg, ok, t);
      note2(true, 'Syncing…');
      const r = await sd.ankiSync({ force });
      if (!r.ok) { note2(false, r.error); if (r.signedOut) renderAnkiSync(); return; }
      const i = r.imported;
      const parts = [];
      if (i) parts.push(`${plural(i.cardsAdded, 'new card', 'new cards')}, ${plural(i.cardsRefreshed || 0, 'card', 'cards')} updated from AnkiWeb${i.cardsRemoved ? `, ${i.cardsRemoved} removed` : ''}`);
      if (r.mediaDownloaded) parts.push(`${plural(r.mediaDownloaded, 'picture or sound', 'pictures and sounds')}`);
      if (r.pushed) parts.push(`sent ${plural(r.pushed.reviews, 'review', 'reviews')} and ${plural(r.pushed.cards, 'card', 'cards')} to AnkiWeb`);
      const skip = r.skipped && r.skipped.length ? ` Not sent: ${r.skipped.join('; ')}.` : '';
      note2(true, (parts.length ? 'Done: ' + parts.join('; ') + '.' : 'Already up to date.') + skip);
      window.__ankiMsg = msg.textContent; renderDecks();
    };
    box.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row space' }, h('div', {}, h('strong', {}, 'AnkiWeb'), h('span', { class: 'muted' }, `  ${st.user}  ·  last sync: ${when}`)),
        h('div', { class: 'row' }, btn('Sync now', () => sync(false), 'small'), btn('Re-download everything', () => sync(true), 'secondary small'), btn('Sign out', async () => { await sd.ankiLogout(); renderAnkiSync(); }, 'secondary small'))),
      h('div', { class: 'muted' }, 'Two-way: new and changed cards, pictures and sounds come from AnkiWeb, and the cards you study here (with their review history) are sent back. Adding or editing cards here is not possible yet.'), msg));
    if (window.__ankiMsg) { msg.textContent = window.__ankiMsg; window.__ankiMsg = ''; }
    return;
  }
  const user = h('input', { type: 'text', class: 'text', placeholder: 'AnkiWeb email', autocomplete: 'username' });
  const pass = h('input', { type: 'password', class: 'text', placeholder: 'AnkiWeb password', autocomplete: 'current-password' });
  const server = h('input', { type: 'text', class: 'text wide', placeholder: st.defaultEndpoint, value: st.endpoint === st.defaultEndpoint ? '' : st.endpoint });
  const go = async () => {
    note(msg, true, 'Signing in…');
    const r = await sd.ankiLogin({ user: user.value, password: pass.value, endpoint: server.value });
    if (!r.ok) return note(msg, false, r.error);
    pass.value = ''; window.__ankiMsg = 'Signed in. Press “Sync now” to download your decks.'; renderAnkiSync();
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  box.replaceChildren(h('details', { class: 'card' },
    h('summary', {}, h('strong', {}, 'Sync with AnkiWeb')),
    h('p', { class: 'muted' }, 'Sign in with your AnkiWeb account to sync your decks, pictures and sounds both ways (a backup of your AnkiWeb collection is saved first). StudyDeck keeps only the sign-in key AnkiWeb returns, not your password.'),
    h('div', { class: 'row' }, user, pass, btn('Sign in', go)),
    h('details', {}, h('summary', { class: 'muted' }, 'Advanced: use a different Anki sync server'), h('div', { style: 'margin-top:8px' }, server)), msg));
}
sd.onAnkiProgress((m) => { const el = document.querySelector('#anki-sync .good-text, #anki-sync .bad-text'); if (el) { el.textContent = m; el.className = 'good-text'; } });

// ---- progress -------------------------------------------------------------------------------
async function renderProgress() {
  const el = $('progress'); el.replaceChildren();
  const st = await sd.progress();
  el.append(h('h2', {}, 'Progress'));
  const acc = st.today.reviewed ? Math.round((100 * st.today.correct) / st.today.reviewed) + '% correct' : 'no reviews yet';
  el.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'n' }, st.today.reviewed), h('div', { class: 'l' }, `reviewed today (${acc})`)),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, st.streak), h('div', { class: 'l' }, 'day streak')),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, st.retention30 == null ? '–' : st.retention30 + '%'), h('div', { class: 'l' }, 'remembered, last 30 days')),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, st.totalReviews), h('div', { class: 'l' }, 'reviews in total'))));

  const max = Math.max(1, ...st.last30);
  el.append(h('h3', {}, 'Reviews per day, last 30 days'),
    h('div', { class: 'card' }, h('div', { class: 'bars' }, st.last30.map((n, i) =>
      h('div', { class: n ? '' : 'empty', style: `height:${Math.max(2, Math.round((n / max) * 100))}%`, title: `${n} reviews, ${i === 29 ? 'today' : (29 - i) + ' days ago'}` })))));

  const seg = (c, total) => ['new', 'learning', 'young', 'mature'].map((k) =>
    h('span', { style: `width:${total ? (100 * (c[k] || 0)) / total : 0}%;background:var(--c-${k === 'learning' ? 'learn' : k})`, title: `${k}: ${c[k] || 0}` }));
  el.append(h('h3', {}, 'Your cards'),
    h('div', { class: 'card' }, h('div', { class: 'stack' }, seg(st.cards, st.cards.total)),
      h('div', { class: 'legend' },
        ['new', 'learning', 'young', 'mature'].map((k) => h('span', {}, h('i', { style: `background:var(--c-${k === 'learning' ? 'learn' : k})` }), `${k} ${st.cards[k]}`)),
        st.cards.suspended ? h('span', {}, `suspended ${st.cards.suspended}`) : '')),
    h('p', { class: 'muted' }, 'Mature means an interval of 21 days or more.'));

  if (st.perDeck.length) {
    el.append(h('h3', {}, 'By deck'), h('div', {}, st.perDeck.map((d) =>
      h('div', { class: 'card' }, h('div', { class: 'row space' }, h('strong', {}, d.name), h('span', { class: 'muted' }, plural(d.total, 'card', 'cards'))),
        h('div', { class: 'stack', style: 'margin-top:8px' }, seg(d, d.total))))));
  }
  el.append(h('p', { class: 'muted' }, 'Sharing progress with friends comes after the Friends stage.'));
}

// ---- plugins --------------------------------------------------------------------------------
async function renderPlugins() {
  const el = $('plugins'); el.replaceChildren();
  const list = await sd.listPlugins();
  el.append(h('h2', {}, 'Plugins'),
    h('p', { class: 'muted' }, 'A plugin can do anything the program can do. Only install plugins you trust.'),
    h('ul', { class: 'plain' }, list.length ? list.map((p) =>
      h('li', {}, h('strong', {}, `${p.name}${p.version ? ' ' + p.version : ''}`),
        p.loaded ? h('div', { class: 'muted' }, p.description || 'Loaded.') : h('div', { class: 'bad-text' }, 'Not loaded: ' + p.error)))
      : h('li', {}, 'No plugins installed.')),
    h('div', { class: 'row' }, btn('Open plugins folder', () => sd.openPluginsFolder()), btn('Restart to reload plugins', () => restartApp(), 'secondary')));
}

// ---- settings -------------------------------------------------------------------------------
async function renderSettings() {
  const el = $('settings'); el.replaceChildren();
  const [info, s, up] = await Promise.all([sd.info(), sd.getSettings(), sd.getUpdatePrefs()]);
  el.append(h('h2', {}, 'Settings'));

  const msg = h('span', { class: 'muted' });
  const newIn = h('input', { type: 'number', min: 0, max: 9999, value: s.newPerDay });
  const revIn = h('input', { type: 'number', min: 0, max: 9999, value: s.reviewsPerDay });
  el.append(h('h3', {}, 'Daily limits'), h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'New cards per day', newIn),
      h('label', { class: 'field' }, 'Reviews per day', revIn),
      btn('Save', async () => {
        const r = await sd.setSettings({ newPerDay: Number(newIn.value), reviewsPerDay: Number(revIn.value) });
        msg.textContent = r.ok ? 'Saved.' : r.error; msg.className = r.ok ? 'good-text' : 'bad-text';
      }), msg)));

  // updates
  const upd = h('div', {});
  const ver = `Version ${info.version}` + (info.usingUpdate ? ` (installed update; built-in version is ${info.baseVersion})` : '');
  el.append(h('h3', {}, 'Updates'), h('div', { class: 'card' }, h('p', {}, ver),
    info.pendingUpdate ? h('p', { class: 'good-text' }, `Update ${info.pendingUpdate} is installed and will be used after a restart.`) : '',
    info.problem ? h('p', { class: 'bad-text' }, info.problem) : '',
    h('div', { class: 'row' },
      btn('Check for updates', async (e) => { e.target.disabled = true; await checkUpdates(upd, false); e.target.disabled = false; }),
      btn('Install update from file…', () => chooseUpdate(upd)),
      info.pendingUpdate || info.usingUpdate ? btn('Use the built-in version again', async () => {
        if (!confirm('Go back to the version that came with the program? Your decks and progress are not touched.')) return;
        await sd.removeUpdates(); upd.replaceChildren(h('div', { class: 'card ok' }, 'Done. ', btn('Restart now', () => restartApp())));
      }, 'secondary') : '',
      info.pendingUpdate ? btn('Restart now', () => restartApp(), 'secondary') : ''),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: up.autoCheck, onchange: (e) => sd.setUpdatePrefs({ autoCheck: e.target.checked }) }), ' Check for updates when the program starts'),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: up.autoRestart, onchange: (e) => sd.setUpdatePrefs({ autoRestart: e.target.checked }) }), ' Restart automatically after an update is installed'),
    upd));

  el.append(h('h3', {}, 'Your data'), h('div', { class: 'card' },
    h('p', { class: 'muted' }, info.dataDir), btn('Open data folder', () => sd.openDataFolder(), 'secondary')));
}

// Asks GitHub for a newer version and shows the answer in `box`. quiet: say nothing when there is nothing new (start-up check).
let waitingBox = null, installedHook = null;
sd.onUpdateInstalled((r) => { if (waitingBox && installedHook) installedHook(r); });
// Restart, but never in the middle of an AnkiWeb sync without asking.
async function restartApp() {
  const r = await sd.restart();
  if (!r || !r.busy) return;
  const box = $('update-banner');
  box.replaceChildren(h('div', { class: 'card warn' }, h('p', {}, h('strong', {}, 'Your decks are syncing with AnkiWeb right now. '), 'Restarting now could interrupt the sync.'),
    h('div', { class: 'row' },
      btn('Wait for the sync, then restart', async () => { await sd.restartWhenSynced(); box.replaceChildren(h('div', { class: 'card' }, 'Waiting for the sync to finish. StudyDeck will restart by itself.')); }),
      btn('Restart anyway', () => sd.restart({ force: true }), 'secondary'),
      btn('Cancel', () => box.replaceChildren(), 'secondary'))));
}

async function checkUpdates(box, quiet) {
  if (!quiet) box.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
  const r = await sd.checkUpdate();
  if (!r.ok) { box.replaceChildren(quiet ? '' : h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, r.error))); return; }
  if (!r.updateAvailable) { box.replaceChildren(quiet ? '' : h('div', { class: 'card ok' }, r.note || `You have the newest version (${r.currentVersion}).`)); return; }
  const done = (x) => {
    if (!x.ok) return box.replaceChildren(h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, x.error)));
    if (x.autoRestart) { box.replaceChildren(h('div', { class: 'card ok' }, `Version ${x.version} is installed. Restarting…`)); setTimeout(() => restartApp(), 1500); return; }
    box.replaceChildren(h('div', { class: 'card ok' }, `Version ${x.version} is installed. Restart to start using it. `, btn('Restart now', () => restartApp()), btn('Later', () => box.replaceChildren(), 'secondary')));
  };
  box.replaceChildren(h('div', { class: 'card warn' }, h('strong', {}, `Version ${r.latestVersion} is available`), h('span', { class: 'muted' }, ` (you have ${r.currentVersion}). `),
    btn('Download and install', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Downloading…';
      const x = await sd.downloadInstallUpdate();
      if (!x.busy) return done(x);
      box.replaceChildren(h('div', { class: 'card warn' }, h('p', {}, h('strong', {}, 'Your decks are syncing with AnkiWeb right now. '), 'Installing the update does not stop the sync, but the program has to restart afterwards. What would you like to do?'),
        h('div', { class: 'row' },
          btn('Install now', async () => { box.replaceChildren(h('p', { class: 'muted' }, 'Installing…')); done(await sd.downloadInstallUpdate({ now: true })); }),
          btn('Wait until the sync has finished', async () => { const w = await sd.downloadInstallUpdate({ waitForSync: true }); waitingBox = box; done = done; box.replaceChildren(h('div', { class: 'card' }, w.waiting ? 'Waiting for the sync to finish. The update will be installed after that.' : 'Installing…')); if (!w.waiting) done(w); }, 'secondary'),
          btn('Not now', () => box.replaceChildren(), 'secondary'))));
      installedHook = done;
    }),
    btn('Not now', () => box.replaceChildren(), 'secondary')));
}

async function chooseUpdate(box) {
  box.replaceChildren();
  const r = await sd.chooseUpdate();
  if (r.cancelled) return;
  if (!r.ok) { box.append(h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, r.error))); return; }
  const status = h('span', {});
  box.append(h('div', { class: 'card warn' },
    h('strong', {}, `${r.file}: version ${r.version}`),
    h('p', { class: 'muted' }, `${plural(r.fileCount, 'file', 'files')}. You now have version ${r.current}.`),
    r.notes ? h('p', {}, r.notes) : '',
    h('p', {}, 'Only install updates from someone you trust. An update can change everything the program does.'),
    h('div', { class: 'row' },
      btn('Install this update', async (e) => {
        e.target.disabled = true;
        const x = await sd.installUpdate();
        box.replaceChildren(x.ok
          ? h('div', { class: 'card ok' }, `Version ${x.version} is installed. `, btn('Restart now', () => restartApp()))
          : h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, x.error)));
      }),
      btn('Cancel', () => box.replaceChildren(), 'secondary'), status)));
}

showPage('home');
sd.getUpdatePrefs().then((p) => { if (p.autoCheck) setTimeout(() => checkUpdates($('update-banner'), true).catch(() => {}), 3000); }).catch(() => {});
