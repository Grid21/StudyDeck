'use strict';
// Spaced-repetition scheduling (SM-2 style, with learning steps).
// Plain JavaScript, no Electron: can be reused in a phone app.
//
// A card is { state: 'new'|'learn'|'review', step, due (ms), interval (days), ease, reps, lapses }
// Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const LEARN_STEPS = [1, 10];          // minutes
const GRADUATE_DAYS = 1;
const EASY_DAYS = 4;
const START_EASE = 2.5;
const MIN_EASE = 1.3;
const ROLLOVER_HOUR = 4;              // the study day starts at 4 am

// Start of the current study day (local time, 4 am)
function dayStart(now) {
  const d = new Date(now);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  return d.getTime() > now ? d.getTime() - DAY : d.getTime();
}
function dayEnd(now) { return dayStart(now) + DAY; }

function answer(card, rating, now) {
  const c = { ...card };
  c.reps = (card.reps || 0) + 1;
  const wasNew = card.state === 'new';

  if (card.state === 'new' || card.state === 'learn') {
    const relearning = card.state === 'learn' && card.interval > 0;
    let step = wasNew ? 0 : (card.step || 0);
    c.state = 'learn';
    if (rating === 1) {
      c.step = 0; c.due = now + LEARN_STEPS[0] * MIN;
    } else if (rating === 2) {
      c.step = step; c.due = now + Math.max(LEARN_STEPS[step], 1) * MIN;
    } else if (rating === 3) {
      step += 1;
      if (step >= LEARN_STEPS.length) return graduate(c, relearning ? Math.max(1, card.interval) : GRADUATE_DAYS, now, relearning);
      c.step = step; c.due = now + LEARN_STEPS[step] * MIN;
    } else {
      return graduate(c, relearning ? Math.max(2, Math.round(card.interval * 1.5)) : EASY_DAYS, now, relearning);
    }
    return c;
  }

  // review card
  const ease = card.ease || START_EASE;
  const ivl = Math.max(1, card.interval || 1);
  if (rating === 1) {
    c.lapses = (card.lapses || 0) + 1;
    c.ease = Math.max(MIN_EASE, ease - 0.2);
    c.state = 'learn'; c.step = 0;
    c.interval = Math.max(1, Math.round(ivl * 0.3));     // kept for when it is relearned
    c.due = now + LEARN_STEPS[0] * MIN;
    return c;
  }
  let next;
  if (rating === 2) { next = ivl * 1.2; c.ease = Math.max(MIN_EASE, ease - 0.15); }
  else if (rating === 3) { next = ivl * ease; }
  else { next = ivl * ease * 1.3; c.ease = ease + 0.15; }
  const floor = rating === 2 ? ivl + 1 : rating === 3 ? ivl + 1 : ivl + 2;
  c.interval = Math.max(floor, Math.round(next));
  c.state = 'review'; c.step = 0;
  c.due = dayStart(now) + c.interval * DAY;
  return c;
}

function graduate(c, days, now, relearning) {
  c.state = 'review'; c.step = 0; c.interval = days;
  if (!relearning && !c.ease) c.ease = START_EASE;
  if (!c.ease) c.ease = START_EASE;
  c.due = dayStart(now) + days * DAY;
  return c;
}

function formatWait(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  const d = ms / DAY;
  if (d < 30) return Math.round(d) + 'd';
  if (d < 365) return (d / 30.4).toFixed(1).replace(/\.0$/, '') + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}

// Labels shown on the four buttons, e.g. ['1m', '6m', '10m', '4d']
function previewLabels(card, now) {
  return [1, 2, 3, 4].map((r) => {
    const n = answer(card, r, now);
    return formatWait(n.state === 'review' ? n.interval * DAY : n.due - now);
  });
}

// Starting scheduling for a card made new
function newCardFields() { return { state: 'new', step: 0, due: 0, interval: 0, ease: 0, reps: 0, lapses: 0 }; }

module.exports = { answer, previewLabels, dayStart, dayEnd, newCardFields, formatWait, DAY, MIN, START_EASE, LEARN_STEPS };
