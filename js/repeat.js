// repeat.js — a repeating item is a rule, not fifty copies of itself.
//
// Everything here is pure date arithmetic on that rule: give it a shape and a
// window and it tells you which days the thing lands on. Nothing reads state,
// nothing writes it, so the awkward parts — a monthly on the 31st, a yearly on
// the 29th of February, an interval counted from the right week — are testable
// on their own.
//
// The shape, stored on the item as `repeat`:
//
//   freq   'daily' | 'weekly' | 'monthly' | 'yearly'
//   every  interval, 1 = every one of them
//   days   weekly only: weekdays it lands on, 0 Sunday … 6 Saturday
//   until  last date it may fall on, or null
//   count  how many there are in total, or null
//   ex     { 'YYYY-MM-DD': override } — one occurrence's own business
//
// `until` and `count` are alternatives, not both; the editor only ever sets
// one. An occurrence is named by the date the *rule* put it on, so moving one
// does not lose its place in the series.

import { ymd, parseYmd, addDays, DOW } from './util.js';

export const REPEAT_FREQ = ['daily', 'weekly', 'monthly', 'yearly'];

/** Steps taken before we assume the window is unreachable and give up. */
const MAX_STEPS = 4000;
/** Occurrences returned for one window, however long the window is. */
const MAX_DATES = 750;

export const isRepeat = (rep) => !!(rep && REPEAT_FREQ.includes(rep.freq));

/** How many in all, or null: 0, a blank and nonsense all mean no limit. */
const countOf = (rep) => (Number(rep.count) > 0 ? Math.floor(Number(rep.count)) : null);

/** The weekdays a weekly rule names, once each, as numbers 0–6 — a `"1"` from
 *  a form or a sync would otherwise concatenate its way through addDays.
 *  Only a number or a string of one counts: `Number(null)` is 0, not Sunday. */
const asDay = (d) => (typeof d === 'number' || (typeof d === 'string' && d.trim()) ? Number(d) : NaN);
const weekdaysOf = (rep) => [...new Set((Array.isArray(rep.days) ? rep.days : []).map(asDay))]
  .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  .sort((x, y) => x - y);

/**
 * Every day the rule lands on, in order, for ever.
 *
 * The anchor is the first one. A weekly rule with weekdays chosen runs from
 * the anchor's own week, so "every other Tuesday and Thursday" alternates the
 * weeks the anchor is in rather than the weeks the year happens to start on.
 */
function* points(rep, anchor) {
  const every = Math.max(1, Math.round(rep.every || 1));
  const a = parseYmd(anchor);
  if (!a) return;

  if (rep.freq === 'daily') {
    for (let k = 0; ; k++) yield addDays(anchor, k * every);
    return;
  }

  if (rep.freq === 'weekly') {
    const chosen = weekdaysOf(rep);
    const days = chosen.length ? chosen : [a.getDay()];
    const sunday = addDays(anchor, -a.getDay());
    for (let w = 0; ; w += every) {
      const base = addDays(sunday, w * 7);
      for (const d of days) {
        const date = addDays(base, d);
        // the first week is only half a week: nothing before the anchor
        if (date >= anchor) yield date;
      }
    }
  }

  if (rep.freq === 'monthly') {
    // the 31st simply has no January-to-February counterpart; a month without
    // the day is skipped rather than pulled back to its last one, which is
    // what a calendar does and what "monthly on the 31st" means
    const dom = a.getDate();
    for (let k = 0; ; k++) {
      const m = new Date(a.getFullYear(), a.getMonth() + k * every, 1);
      const last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      if (dom <= last) yield ymd(new Date(m.getFullYear(), m.getMonth(), dom));
    }
  }

  if (rep.freq === 'yearly') {
    // and the same for the 29th of February, which is a real date three years
    // in four short of one
    for (let k = 0; ; k++) {
      const d = new Date(a.getFullYear() + k * every, a.getMonth(), a.getDate());
      if (d.getMonth() === a.getMonth()) yield ymd(d);
    }
  }
}

/**
 * The days this rule lands on inside `[from, to]`, both ends included.
 *
 * `count` is counted from the anchor, not from the window, so asking about
 * December still knows the series ran out in October.
 */
export function repeatDates(rep, anchor, from, to) {
  if (!isRepeat(rep) || !anchor || !from || !to || from > to) return [];
  const out = [];
  const count = countOf(rep);
  let made = 0, steps = 0;
  for (const d of points(rep, anchor)) {
    if (++steps > MAX_STEPS) break;
    if (rep.until && d > rep.until) break;
    if (count && made >= count) break;
    made++;
    if (d > to) break;
    if (d >= from) out.push(d);
    if (out.length >= MAX_DATES) break;
  }
  return out;
}

/** Whether the rule itself puts an occurrence on this exact day. */
export const isRepeatDate = (rep, anchor, date) =>
  repeatDates(rep, anchor, date, date).length > 0;

/** The first day on or after `from` that the rule lands on, or null. */
export function nextRepeat(rep, anchor, from, within = 400) {
  const hit = repeatDates(rep, anchor, from, addDays(from, within));
  return hit.length ? hit[0] : null;
}

const ORDINAL = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
};

const listOf = (words) => (words.length < 2
  ? words.join('')
  : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);

/** The rule as a sentence, for the panel and the block's tooltip. */
export function describeRepeat(rep, anchor) {
  if (!isRepeat(rep)) return '';
  const every = Math.max(1, Math.round(rep.every || 1));
  const a = anchor ? parseYmd(anchor) : null;
  let s;

  if (rep.freq === 'daily') {
    s = every === 1 ? 'Every day' : `Every ${every} days`;
  } else if (rep.freq === 'weekly') {
    const chosen = weekdaysOf(rep);
    const days = (chosen.length ? chosen : (a ? [a.getDay()] : [])).map((d) => DOW[d]);
    const when = days.length ? ' on ' + listOf(days) : '';
    s = (every === 1 ? 'Every week' : `Every ${every} weeks`) + when;
  } else if (rep.freq === 'monthly') {
    const on = a ? ` on the ${ORDINAL(a.getDate())}` : '';
    s = (every === 1 ? 'Every month' : `Every ${every} months`) + on;
  } else {
    s = every === 1 ? 'Every year' : `Every ${every} years`;
  }

  const count = countOf(rep);
  if (count) s += `, ${count} times`;
  else if (rep.until) s += `, until ${rep.until}`;
  return s;
}
