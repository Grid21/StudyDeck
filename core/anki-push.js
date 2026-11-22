'use strict';
// Turns StudyDeck's own changes (cards you studied, your review history) into the rows Anki's sync expects.
// Plain JavaScript, no Electron code. Only cards that came from an AnkiWeb sync can be sent (we need Anki's own card record).
const sched = require('./scheduler');

const DAY = 86400000;

// Returns { cards: [18 values], revlog: [9 values], sent: { cardIds, reviewIds, snapshots }, skipped: [text] }
function buildPush(pending, { crt, serverUsn, now = Date.now() }) {
  const out = { cards: [], revlog: [], sent: { cardIds: [], reviewIds: [], snapshots: [] }, skipped: [] };
  const mtime = Math.floor(now / 1000);
  const skipIds = new Set();

  for (const r of pending.cards) {
    const a = r.snap;
    if (a.odid) { skipIds.add(r.id); out.skipped.push('a card in a filtered deck'); continue; }
    let fsrs = false;
    try { const d = a.data ? JSON.parse(a.data) : null; fsrs = !!(d && (d.s !== undefined || d.d !== undefined)); } catch { /* not json */ }
    if (fsrs) { skipIds.add(r.id); out.skipped.push('a card that uses FSRS scheduling'); continue; }

    let ctype, queue, due, ivl, factor, left = 0;
    if (r.state === 'review') {
      ctype = 2; queue = 2; due = Math.round((r.due - crt * 1000) / DAY); ivl = Math.max(1, Math.round(r.interval)); factor = Math.round((r.ease || sched.START_EASE) * 1000);
    } else if (r.state === 'learn') {
      const relearn = r.interval > 0;
      ctype = relearn ? 3 : 1; queue = 1; due = Math.floor(r.due / 1000); ivl = relearn ? Math.max(1, Math.round(r.interval)) : 0;
      factor = r.ease ? Math.round(r.ease * 1000) : (relearn ? 2500 : 0);
      const remaining = Math.max(1, (sched.LEARN_STEPS || [1, 10]).length - (r.step || 0)); left = remaining * 1001;
    } else { ctype = 0; queue = a.queue < 0 ? a.queue : 0; due = a.due; ivl = 0; factor = 0; }
    if (a.queue < 0) queue = a.queue;            // suspended or buried in Anki stays that way
    const row = [a.anki_id, a.nid, a.did, a.ord, mtime, serverUsn, ctype, queue, due, ivl, factor, r.reps || 0, r.lapses || 0, left, a.odue || 0, a.odid || 0, a.flags || 0, a.data || ''];
    out.cards.push(row); out.sent.cardIds.push(r.id);
    out.sent.snapshots.push({ card_id: r.id, mtime, usn: serverUsn, ctype, queue, due, ivl, factor, reps: r.reps || 0, lapses: r.lapses || 0, left });
  }

  const used = new Set();
  for (const v of pending.revlog) {
    if (skipIds.has(v.card_id)) { out.sent.reviewIds.push(v.id); continue; }       // history of skipped cards is not sent, and not retried
    let id = v.ts; while (used.has(id)) id++; used.add(id);
    out.revlog.push([id, v.anki_id, serverUsn, v.rating, v.ivl_new, v.ivl_last, v.factor, Math.min(60000, Math.max(0, v.ms || 0)), v.rtype]);
    out.sent.reviewIds.push(v.id);
  }
  return out;
}

module.exports = { buildPush };
