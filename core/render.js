'use strict';
// Turns an Anki-style card template + note fields into safe HTML.
// Plain JavaScript, no Electron: can be reused in a phone app.
//
// Cards run no scripts at all (decks are untrusted files). Templates that depend on
// JavaScript will not do anything, but the text and pictures still show.

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function stripHtml(s) {
  return String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

// ---- cloze -------------------------------------------------------------------------------
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

function renderCloze(text, active, isAnswer) {
  return text.replace(CLOZE_RE, (m, n, body, hint) => {
    if (Number(n) === active) {
      return isAnswer
        ? `<span class="cloze">${body}</span>`
        : `<span class="cloze">[${hint ? hint : '...'}]</span>`;
    }
    return body;
  });
}
function clozeNumbers(text) {
  const out = new Set(); let m; const re = new RegExp(CLOZE_RE.source, 'g');
  while ((m = re.exec(text))) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

// ---- japanese readings: "漢字[かんじ]" ---------------------------------------------------
const READING_RE = / ?([^ >]+?)\[(.+?)\]/g;
function furigana(s) { return s.replace(READING_RE, (m, k, r) => (r.startsWith('sound:') ? m : `<ruby><rb>${k}</rb><rt>${r}</rt></ruby>`)); }
function kana(s) { return s.replace(READING_RE, (m, k, r) => (r.startsWith('sound:') ? m : r)); }
function kanji(s) { return s.replace(READING_RE, (m, k, r) => (r.startsWith('sound:') ? m : k)); }

// ---- template parsing --------------------------------------------------------------------
function tokenize(tpl) {
  const tokens = []; const re = /\{\{([\s\S]*?)\}\}/g; let last = 0, m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) tokens.push({ t: 'text', v: tpl.slice(last, m.index) });
    tokens.push({ t: 'tag', v: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < tpl.length) tokens.push({ t: 'text', v: tpl.slice(last) });
  return tokens;
}

function parse(tokens, i = 0, closing = null) {
  const nodes = [];
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.t === 'text') { nodes.push(tk); i++; continue; }
    const v = tk.v;
    if (v[0] === '#' || v[0] === '^') {
      const name = v.slice(1).trim();
      const inner = parse(tokens, i + 1, name);
      nodes.push({ t: v[0] === '#' ? 'if' : 'unless', name, children: inner.nodes });
      i = inner.next; continue;
    }
    if (v[0] === '/') {
      if (closing !== null && v.slice(1).trim() === closing) return { nodes, next: i + 1 };
      i++; continue;                                  // stray closing tag: ignore
    }
    if (v[0] === '!') { i++; continue; }              // comment
    nodes.push({ t: 'field', v }); i++;
  }
  return { nodes, next: i };
}

// ---- main --------------------------------------------------------------------------------
// ctx: { notetype, fields: [..], ord, tags: [..], deckName }
// Returns { html (the card body), typeExpected (string|null) }
function renderSide(ctx, isAnswer, _frontHtml) {
  const { notetype, fields, ord, tags, deckName } = ctx;
  const tpl = notetype.templates[Math.min(ord, notetype.templates.length - 1)] || { qfmt: '', afmt: '', name: '' };
  const map = {};
  notetype.fields.forEach((f, i) => { map[f] = fields[i] == null ? '' : fields[i]; });
  const deckParts = String(deckName || '').split('::');
  const special = {
    Tags: (tags || []).join(' '), Type: notetype.name, Deck: deckName || '', Subdeck: deckParts[deckParts.length - 1] || '',
    Card: tpl.name || ''
  };
  const clozeActive = notetype.kind === 'cloze' ? ord + 1 : 0;
  let typeExpected = null;

  function fieldValue(name) {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    if (Object.prototype.hasOwnProperty.call(special, name)) return special[name];
    return null;
  }

  function evalNodes(nodes) {
    let out = '';
    for (const n of nodes) {
      if (n.t === 'text') { out += n.v; continue; }
      if (n.t === 'if' || n.t === 'unless') {
        const v = fieldValue(n.name);
        const filled = v !== null && stripHtml(v) !== '';
        if ((n.t === 'if') === filled) out += evalNodes(n.children);
        continue;
      }
      // a field tag, maybe with filters:  filter:filter:Field
      const parts = n.v.split(':').map((s) => s.trim());
      const name = parts.pop();
      if (name === 'FrontSide' && parts.length === 0) { out += isAnswer ? (_frontHtml || '') : ''; continue; }
      let val = fieldValue(name);
      if (val === null) { out += `<span class="unknown-field">[unknown field ${esc(name)}]</span>`; continue; }
      for (let i = parts.length - 1; i >= 0; i--) {
        const f = parts[i];
        if (f === 'text') val = stripHtml(val);
        else if (f === 'cloze') val = renderCloze(val, clozeActive, isAnswer);
        else if (f === 'furigana') val = furigana(val);
        else if (f === 'kana') val = kana(val);
        else if (f === 'kanji') val = kanji(val);
        else if (f === 'hint') val = stripHtml(val) ? `<details class="hint"><summary>Show ${esc(name)}</summary>${val}</details>` : '';
        else if (f === 'type') { typeExpected = stripHtml(val); val = isAnswer ? '<div class="typeans-slot"></div>' : ''; }
        // unknown filters are ignored
      }
      out += val;
    }
    return out;
  }

  const ast = parse(tokenize(isAnswer ? tpl.afmt : tpl.qfmt)).nodes;
  return { html: evalNodes(ast), typeExpected };
}

// ---- cleaning & media --------------------------------------------------------------------
function sanitize(html) {
  return String(html)
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form|frame|frameset)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

function isLocal(u) { return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u); }

// The address host is "i<number>", not a bare number: browsers read "1" as the IP address 0.0.0.1.
function mediaUrl(name, importId) { return `sd-media://i${importId}/${encodeURIComponent(name)}`; }

function rewriteMedia(html, importId) {
  let out = html.replace(/\[sound:([^\]]+)\]/g, (m, f) => `<audio controls preload="none" src="${mediaUrl(f, importId)}"></audio>`);
  out = out.replace(/(<(?:img|audio|video|source)\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, src) => {
    let name = src;
    try { name = decodeURIComponent(src); } catch { /* keep */ }
    return isLocal(src) ? `${pre}${q}${mediaUrl(name, importId)}${q}` : m;
  });
  return out;
}

// The sounds of one side of a card, in order, as sd-media addresses: [sound:file] tags and <audio>/<source> tags.
// On the answer side, sounds that belong to the question (above the answer divider) are left out, like Anki does,
// so the question is not read out a second time.
function soundsOf(html, importId, answerSide) {
  let part = html;
  if (answerSide) { const m = /<hr\s+id=["']?answer["']?\s*\/?>/i.exec(html); if (m) part = html.slice(m.index + m[0].length); }
  const found = [];
  const re = /\[sound:([^\]]+)\]|<(?:audio|source)\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\2/gi;
  let m;
  while ((m = re.exec(part))) {
    let name = m[1] !== undefined ? m[1] : m[3];
    if (m[1] === undefined) { if (!isLocal(name)) continue; try { name = decodeURIComponent(name); } catch { /* keep */ } }
    found.push(mediaUrl(name, importId));
  }
  return found;
}

function rewriteCss(css, importId) {
  return String(css).replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (m, q, u) => (isLocal(u) ? `url("${mediaUrl(u, importId)}")` : m));
}

const BASE_CSS = 'html,body{margin:0}body{padding:16px;word-wrap:break-word}img{max-width:100%;height:auto}' +
  '.cloze{font-weight:bold;color:#2563eb}.unknown-field{color:#b91c1c}audio{max-width:100%}hr#answer{margin:14px 0}' +
  '.hint summary{cursor:pointer;color:#2563eb}';

const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src sd-media: data:; media-src sd-media:; font-src sd-media:";

// Full HTML page for a sandboxed frame.
function renderCard(ctx, importId) {
  const q = renderSide(ctx, false);
  const a = renderSide(ctx, true, q.html);
  const css = rewriteCss(ctx.notetype.css || '', importId);
  const wrap = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<style>${BASE_CSS}${css.replace(/<\/style/gi, '')}</style></head><body class="card card${ctx.ord + 1}"><div class="card">` +
    `${rewriteMedia(sanitize(body), importId)}</div></body></html>`;
  return { question: wrap(q.html), answer: wrap(a.html), qSounds: soundsOf(sanitize(q.html), importId, false), aSounds: soundsOf(sanitize(a.html), importId, true), typeExpected: q.typeExpected !== null ? q.typeExpected : a.typeExpected };
}

// Short plain-text preview of a note (first field), for lists
function preview(fields) { return stripHtml((fields && fields[0]) || '').slice(0, 120); }

module.exports = { soundsOf, renderCard, renderSide, renderCloze, clozeNumbers, sanitize, rewriteMedia, stripHtml, preview, esc };
