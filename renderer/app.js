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
const renderers = { home: renderHome, decks: renderDecks, friends: renderFriends, progress: renderProgress, plugins: renderPlugins, settings: renderSettings };
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

// ---- decks page -----------------------------------------------------------------------------
async function renderDecks() {
  const el = $('decks');
  if (!el.querySelector('#import-results')) {
    el.replaceChildren(
      h('h2', {}, 'Decks'),
      h('div', { class: 'row' },
        btn('Import deck…', () => doImport()),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'keep-progress', checked: true }), 'Keep my progress from Anki')),
      h('p', { class: 'muted' }, 'You can also drag .apkg or .colpkg files into this window. Importing the same deck again updates its text and keeps your progress here.'),
      h('div', { id: 'import-results' }),
      h('div', { id: 'deck-list' }));
  }
  const list = $('deck-list'); list.replaceChildren();
  const rows = await sd.listDecks();
  if (!rows.length) { list.append(h('div', { class: 'card' }, 'No decks yet. Use “Import deck…” above.')); return; }
  const table = h('table', { class: 'decks' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Deck'), h('th', { class: 'num' }, 'New'), h('th', { class: 'num' }, 'Learn'), h('th', { class: 'num' }, 'Due'), h('th', {}, ''))),
    h('tbody', {}, buildTree(rows).map((n) => h('tr', {},
      h('td', { style: `padding-left:${12 + n.depth * 22}px` }, n.label, n.sum.total ? h('span', { class: 'muted' }, `  (${n.sum.total})`) : ''),
      num('c-new', n.sum.newCount), num('c-learn', n.sum.learnCount), num('c-review', n.sum.reviewCount),
      h('td', { class: 'actions' },
        btn('Study', () => startStudy(n.path), 'small'), ' ',
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

// ---- studying -------------------------------------------------------------------------------
async function startStudy(deckName) {
  showPage('study');
  studyState = { deckName, busy: false, p: null, side: 'q', shownAt: 0 };
  renderStudy(await sd.studyNext(deckName));
}
function exitStudy() { showPage('decks'); }

function countsBar(c) {
  return h('div', { class: 'counts' }, h('span', { class: 'c-new' }, c.newCount), h('span', { class: 'c-learn' }, c.learnCount), h('span', { class: 'c-review' }, c.reviewCount));
}

function renderStudy(p) {
  const el = $('study'); el.replaceChildren();
  if (!studyState) return;
  studyState.p = p; studyState.side = 'q'; studyState.shownAt = Date.now();
  const top = (title) => h('div', { class: 'study-top' }, btn('← Back', exitStudy, 'secondary small'), h('strong', {}, title), p.counts ? countsBar(p.counts) : '');
  if (p.done) {
    el.append(top(studyState.deckName || 'All decks'),
      h('div', { class: 'done' }, h('h2', {}, 'All done for now 🎉'), h('p', { class: 'muted' }, 'No more cards are due in this deck.'), btn('Back to decks', exitStudy)));
    return;
  }
  const frame = h('iframe', { class: 'card-frame', sandbox: '', title: 'Card' });
  frame.srcdoc = p.question;
  const bottom = h('div', { class: 'study-bottom' });
  el.append(top(p.deck), frame, bottom);
  renderStudyBottom();
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
  if (studyState.side === 'q') {
    if (e.key === 'Enter' || (e.key === ' ' && !typing)) { e.preventDefault(); showAnswer(); }
  } else if (['1', '2', '3', '4'].includes(e.key)) { rate(Number(e.key)); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); rate(3); }
});

// ---- friends --------------------------------------------------------------------------------
function renderFriends() {
  $('friends').replaceChildren(
    h('h2', {}, 'Friends'),
    h('div', { class: 'card' },
      h('p', {}, 'Finding and adding friends needs an online service, and that has not been built yet. It is planned as a later stage.'),
      h('p', { class: 'muted' }, 'Your study progress is already recorded on this computer, so it will be ready to share with friends once the service exists.'),
      btn('See my progress', () => showPage('progress'), 'secondary')));
}

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
    h('div', { class: 'row' }, btn('Open plugins folder', () => sd.openPluginsFolder()), btn('Restart to reload plugins', () => sd.restart(), 'secondary')));
}

// ---- settings -------------------------------------------------------------------------------
async function renderSettings() {
  const el = $('settings'); el.replaceChildren();
  const [info, s] = await Promise.all([sd.info(), sd.getSettings()]);
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
      btn('Install update from file…', () => chooseUpdate(upd)),
      info.pendingUpdate || info.usingUpdate ? btn('Use the built-in version again', async () => {
        if (!confirm('Go back to the version that came with the program? Your decks and progress are not touched.')) return;
        await sd.removeUpdates(); upd.replaceChildren(h('div', { class: 'card ok' }, 'Done. ', btn('Restart now', () => sd.restart())));
      }, 'secondary') : '',
      info.pendingUpdate ? btn('Restart now', () => sd.restart(), 'secondary') : ''),
    upd));

  el.append(h('h3', {}, 'Your data'), h('div', { class: 'card' },
    h('p', { class: 'muted' }, info.dataDir), btn('Open data folder', () => sd.openDataFolder(), 'secondary')));
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
          ? h('div', { class: 'card ok' }, `Version ${x.version} is installed. `, btn('Restart now', () => sd.restart()))
          : h('div', { class: 'card bad' }, h('div', { class: 'bad-text' }, x.error)));
      }),
      btn('Cancel', () => box.replaceChildren(), 'secondary'), status)));
}

showPage('home');
