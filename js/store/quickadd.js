// store/quickadd.js — one line into a task.
//   "Topology PS3 due fri 5pm 2h !high #Topology plan tue"
// Understands: due <when>, by <when>, plan <when>, bare dates, times,
// durations, !priority, #area. parseWhen and parseRange are pure; the two that
// look up an area take the state as their first argument, and store.js binds
// them.

import { today, addDays, fromMin, diffDays, ymd, parseYmd, pad } from '../util.js';
import { ITEM_TYPES } from './constants.js';

const DOW_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

function nextDow(dow, from = today()) {
  const d = new Date(from + 'T00:00:00');
  const delta = (dow - d.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

/** The same day n months on, or the last day of that month when it is shorter. */
function addMonths(from, n) {
  const d = new Date(from + 'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

/** A weekday word, and only a weekday word: "mon" but not "monitor", "thu"
 *  but not "thus". The long forms are stem + ending, so "tuesday" is "tues" +
 *  "day" and "wednesday" is "wed" + "nesday". */
const DOW_WORD = '(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?';
const DOW_RE = '(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?';
/** "mon", "mon and wed", "tue, thu", "sat/sun" */
const DOW_LIST = `${DOW_WORD}(?:\\s*(?:,|and|&|\\/)\\s*${DOW_WORD})*`;

/** A day the calendar has, or null: "3/40" and "feb 30" are words, not dates. */
function realDate(y, mo, d) {
  const cand = `${y}-${pad(mo)}-${pad(d)}`;
  const back = parseYmd(cand);
  return back && ymd(back) === cand ? cand : null;
}

/** A month and day with no year mean this year, unless that day is already
 *  more than two weeks gone — "exam 3/4" typed in September is next March. */
function yearFor(mo, d) {
  const y = +today().slice(0, 4);
  const cand = realDate(y, mo, d);
  if (cand && diffDays(cand, today()) <= 14) return cand;
  return realDate(y + 1, mo, d) || cand;
}

/**
 * Matches run on the text as typed, case folded by the regex and never by
 * `toLowerCase()`: "İstanbul" grows a code unit when lowered, and an index
 * taken from the lowered copy cut the wrong letters out of the title.
 * @returns {{date, time, consumed: string[], spans: [number, number][]}|null}
 */
export function parseWhen(text) {
  const consumed = [], spans = [];
  let date = null, time = null;
  const take = (m) => { consumed.push(m[0]); spans.push([m.index, m.index + m[0].length]); };

  let m = text.match(/\b(today|tonight|tomorrow|tmr|tmrw|tmw|tomorow|yesterday)\b/i);
  if (m) {
    const w = m[1].toLowerCase();
    date = w === 'today' || w === 'tonight' ? today() : w === 'yesterday' ? addDays(today(), -1) : addDays(today(), 1);
    take(m);
  }

  if (!date) {
    // "in 3 days", "in 2 weeks", "in a week", "in a month"
    m = text.match(/\bin\s+(a|an|\d+)\s+(day|week|month)s?\b/i);
    if (m) {
      const n = /^\d/.test(m[1]) ? +m[1] : 1;
      const unit = m[2].toLowerCase();
      date = unit === 'day' ? addDays(today(), n) : unit === 'week' ? addDays(today(), 7 * n) : addMonths(today(), n);
      take(m);
    }
  }
  if (!date) {
    // "next week" is a week from today; "next month" a month
    m = text.match(/\bnext\s+(week|month)\b/i);
    if (m) { date = m[1].toLowerCase() === 'week' ? addDays(today(), 7) : addMonths(today(), 1); take(m); }
  }
  if (!date) {
    m = text.match(new RegExp(`\\bnext\\s+${DOW_RE}\\b`, 'i'));
    if (m) { date = nextDow(DOW_WORDS[m[1].toLowerCase()]); take(m); }
  }
  if (!date) {
    // "fri", "this fri", "friday"
    m = text.match(new RegExp(`\\b(?:this\\s+)?${DOW_RE}\\b`, 'i'));
    if (m) { date = nextDow(DOW_WORDS[m[1].toLowerCase()]); take(m); }
  }
  if (!date) {
    // "sep 12", "Sept. 12th", "sep 12, 2026" — but not "Sep 3-5", a span of days
    m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?(?!\s*[-–/]\s*\d)/i);
    if (m) {
      const mi = MONTH_WORDS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
      const d = m[3] ? realDate(+m[3], mi, +m[2]) : yearFor(mi, +m[2]);
      if (d) { date = d; take(m); }
    }
  }
  if (!date) {
    m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) {
      const d = realDate(+m[1], +m[2], +m[3]);
      if (d) { date = d; take(m); }
    }
  }
  if (!date) {
    m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
      const d = y ? realDate(y, +m[1], +m[2]) : yearFor(+m[1], +m[2]);
      if (d) { date = d; take(m); }
    }
  }

  // a time: "5pm", "at 5:30 pm", "at 14:30", "noon". A clock that does not
  // exist ("25:99", "13pm") is left in the title rather than clamped
  m = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +(m[2] || 0) < 60) {
    let H = +m[1] % 12;
    if (m[3].toLowerCase() === 'pm') H += 12;
    time = fromMin(H * 60 + (+m[2] || 0));
    take(m);
  } else if ((m = text.match(/\bat\s+(\d{1,2}):(\d{2})\b/i)) && +m[1] < 24 && +m[2] < 60) {
    time = fromMin(+m[1] * 60 + +m[2]);
    take(m);
  } else if ((m = text.match(/\bat\s+(noon|midnight)\b/i) || text.match(/\b(noon|midnight)\b/i))) {
    // "at noon" before a bare "noon", so "noon meeting at noon" keeps its
    // name; midnight is the end of the day named, not the start of it
    time = m[1].toLowerCase() === 'noon' ? '12:00' : '23:59';
    take(m);
  }

  return date || time ? { date, time, consumed, spans } : null;
}

/** Words a number range follows when it counts things, not hours. */
const THING_WORDS = /\b(ch|chap|chapters?|p|pp|pg|pages?|problems?|q|questions?|sections?|no|nums?|units?|weeks?|#|sets?|psets?|ps|hw|homework|assignments?|ex|exercises?|parts?|lessons?|items?|steps?|vol|volumes?)\s*\.?\s*$/i;

/**
 * A start–end time range: "12-7", "2:30-4pm", "9 to 11am".
 *
 * Bare hours are read the way a person means them during a day: 7–11 is
 * morning, 12 is noon, 1–6 is afternoon. So "12-7" is noon to seven, and
 * "2-4" is the afternoon. An end that lands before its start is pushed
 * twelve hours, which is what "11-1" means.
 *
 * @returns {{start, end, mins, consumed: string, at: number}|null}
 */
export function parseRange(text) {
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?!\s*[-–/]\s*\d)/gi;
  for (const m of text.matchAll(re)) {
    // "read ch 3-4" and "pages 10-20" are ranges of things, not of hours
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (THING_WORDS.test(before)) continue;
    // "Sep 3-5" is days of a month; "2026-09-04" is one day, not 09:00–16:00
    if (new RegExp(`\\b${MONTH_WORD}\\s*$`, 'i').test(before)) continue;
    if (new RegExp(`^\\s*${MONTH_WORD}\\b`, 'i').test(after)) continue;
    if (/[\d/:-]/.test(before.slice(-1))) continue;

    // with no am/pm and no minutes on either side, both have to be hours
    const bare = !m[2] && !m[3] && !m[5] && !m[6];
    if (bare && !(+m[1] >= 1 && +m[1] <= 24 && +m[4] >= 1 && +m[4] <= 24)) continue;

    const daytime = (h) => (h >= 1 && h <= 6 ? h + 12 : h);
    const hour = (raw, ampm) => {
      const h = +raw;
      if (!ampm) return daytime(h);
      const base = h % 12;
      return /pm/i.test(ampm) ? base + 12 : base;
    };

    const sh = hour(m[1], m[3]);
    const eh = hour(m[4], m[6] || m[3]);   // "9 to 11am" — a trailing meridiem covers both
    const sm = +(m[2] || 0), em = +(m[5] || 0);
    if (sm >= 60 || em >= 60) continue;
    const start = sh * 60 + sm;
    let end = eh * 60 + em;
    if (end <= start) end += 12 * 60;                       // "11-1"
    if (end <= start || end > 24 * 60) continue;

    return { start: fromMin(start), end: fromMin(end), mins: end - start, consumed: m[0], at: m.index };
  }
  return null;
}

/** The area a #tag or @tag means. Exact first, then a prefix, then a word. */
export function areaByTag(s, tag) {
  const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const t = squash(tag);
  if (!t) return null;
  const live = s.areas.filter((a) => !a.archived);
  return live.find((a) => squash(a.name) === t)
    || live.find((a) => squash(a.name).startsWith(t))
    || live.find((a) => a.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w && w.startsWith(t)))
    || null;
}

const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The weekdays named in a run of text, once each, Sunday first. */
const daysIn = (str) => [...new Set(
  [...str.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)/gi)].map((x) => DOW_WORDS[x[1].toLowerCase()])
)].sort((a, b) => a - b);

export function parseQuickAdd(s, input) {
  const raw = String(input ?? '').trim();
  let text = ' ' + raw + ' ';
  const out = { title: '', areaId: null, type: 'task', due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60 };
  /** Take a run out of the text without moving what follows it, so an index
   *  found earlier still points where it did. */
  const blank = (at, len) => { text = text.slice(0, at) + ' '.repeat(len) + text.slice(at + len); };

  // priority
  const pm = text.match(/\s!(high|low|normal|h|l)\b/i);
  if (pm) {
    const v = pm[1].toLowerCase();
    out.priority = v.startsWith('h') ? 'high' : v.startsWith('l') ? 'low' : 'normal';
    text = text.replace(pm[0], ' ');
  }

  // "all day" — a date to itself, no time in it. Taken out first so nothing
  // downstream reads "day" as a word in the title or "all day" as a range.
  const allDayRe = /\ball[\s-]?day\b/i;
  const allDay = allDayRe.test(text);
  if (allDay) text = text.replace(allDayRe, ' ');

  // A repeat: "every mon", "every mon and wed", "every other week", "every 2
  // weeks", "every weekday", "daily", "weekly on sat and sun". The rule sits
  // on the item; its first day is worked out at the end, once the date words
  // have had their say. Taken out of the text here, or "mon" would be read as
  // a one-off next Monday.
  const onDays = `(?:\\s+on\\s+${DOW_LIST})?`;
  const everyRe = new RegExp(
    `\\bevery\\s+(?:(other)\\s+|(\\d+)\\s+)?(weekdays?|days?|weeks?${onDays}|months?|years?|${DOW_LIST})\\b`, 'i');
  const wordRe = new RegExp(`\\b(daily|weekly${onDays}|monthly|yearly|annually)\\b`, 'i');
  let repeat = null;
  let rm = text.match(everyRe);
  if (rm) {
    const every = rm[1] ? 2 : rm[2] ? Math.max(1, +rm[2]) : 1;
    const what = rm[3].toLowerCase();
    if (what.startsWith('weekday')) repeat = { freq: 'weekly', every, days: [1, 2, 3, 4, 5] };
    else if (what.startsWith('day')) repeat = { freq: 'daily', every };
    else if (what.startsWith('week')) repeat = { freq: 'weekly', every };
    else if (what.startsWith('month')) repeat = { freq: 'monthly', every };
    else if (what.startsWith('year')) repeat = { freq: 'yearly', every };
    else repeat = { freq: 'weekly', every, days: daysIn(what) };
    if (what.startsWith('week') && daysIn(what).length) repeat.days = daysIn(what);
    text = text.replace(rm[0], ' ');
  } else if ((rm = text.match(wordRe))) {
    const w = rm[1].toLowerCase();
    const freq = w.startsWith('daily') ? 'daily' : w.startsWith('weekly') ? 'weekly' : w.startsWith('monthly') ? 'monthly' : 'yearly';
    repeat = { freq, every: 1 };
    if (freq === 'weekly' && daysIn(w).length) repeat.days = daysIn(w);
    text = text.replace(rm[0], ' ');
  }

  // duration
  const dm = text.match(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i);
  if (dm) {
    const n = parseFloat(dm[1]);
    out.estMins = /^h/i.test(dm[2]) ? Math.round(n * 60) : Math.round(n);
    text = text.replace(dm[0], ' ');
  }

  // area by #tag or @tag — the whole name run together, or the start of it,
  // or the start of any word in it: "#thermo", "@thermo", "@methods" all land
  // — else the area's name written out anywhere in the line, the longest
  // name first so "CS 101" beats "CS". Not `\b` around the name: "C++" ends
  // in no word character, and `\b` after it would never match.
  const am = text.match(/\s[#@]([\w-]+)/);
  if (am) {
    const a = areaByTag(s, am[1]);
    if (a) out.areaId = a.id;
    text = text.replace(am[0], ' ');
  } else {
    const named = s.areas
      .filter((a) => !a.archived && String(a.name || '').trim())
      .sort((a, b) => b.name.trim().length - a.name.trim().length);
    for (const a of named) {
      const re = new RegExp(`(?:^|[^\\w])${escapeRe(a.name.trim())}(?![\\w])`, 'i');
      if (re.test(text)) { out.areaId = a.id; break; }
    }
  }

  // type: first specific hint wins, else the bare type word, else task
  const TYPE_HINTS = [
    [/\b(meet|meeting|call|1:1|sync|standup|office\s*hours)\b/i, 'meeting'],
    [/\b(hw|homework|problem\s?set|pset|ps\s*\d|assignment|quiz|paper|essay|report|memo|proposal|draft|abstract|read|reading|chapter|ch\.)\b/i, 'homework'],
    [/\b(midterm|final\s+exam|exam|test|present|presentation|talk|demo|lecture|class|flight|fly|appointment)\b/i, 'event'],
    [/\b(email|form|register|submit|admin|errand)\b/i, 'task']
  ];
  const hinted = TYPE_HINTS.find(([re]) => re.test(text));
  if (hinted) out.type = hinted[1];
  else {
    for (const ty of ITEM_TYPES) {
      if (new RegExp(`\\b${ty}\\b`, 'i').test(text)) { out.type = ty; break; }
    }
  }

  // A start-end range makes this a scheduled thing rather than a deadline.
  // Take it out of the text before anything else looks for a time: otherwise
  // parseWhen() claims one half as a due time and the other half is left
  // stranded in the title — "fly to boston aug 29 12-7" became "fly to boston
  // 12 to", due 7pm.
  const range = parseRange(text);
  if (range) {
    blank(range.at, range.consumed.length);
    out.estMins = range.mins;
  }

  // planned date: "plan <when>" / "work on <when>"; due date: "due <when>",
  // or "by <when>" — "by" alone is a word, and only counts with a when right
  // after it, so "essay by kant fri" is still due Friday and still by Kant
  const planKey = text.match(/\b(plan|work on|work|start)\b/i);
  let dueKey = text.match(/\bdue\b/i);
  if (!dueKey) {
    for (const m of text.matchAll(/\bby\b/gi)) {
      const seg = text.slice(m.index + m[0].length);
      const w = parseWhen(seg);
      if (w && w.spans.some(([a]) => !seg.slice(0, a).trim())) { dueKey = m; break; }
    }
  }
  const planIdx = planKey ? planKey.index : -1;
  const dueIdx = dueKey ? dueKey.index : -1;
  // each clause runs to the next keyword, so "plan mon due fri 5pm" does not
  // hand Friday's time to Monday
  const endOf = (from) => {
    const next = [planIdx, dueIdx].filter((i) => i > from);
    return next.length ? Math.min(...next) : text.length;
  };

  let dated = false;   // a day was named, as against defaulted to today
  const grab = (from, to = text.length) => {
    const w = parseWhen(text.slice(from, to));
    if (!w) return null;
    if (w.date) dated = true;
    for (const [a, b] of w.spans) blank(from + a, b - a);
    return w;
  };

  if (planKey) {
    blank(planIdx, planKey[0].length);
    const w = grab(planIdx, endOf(planIdx));
    if (w) out.plan = { date: w.date || today(), start: w.time || null, mins: out.estMins };
  }
  if (dueKey) {
    blank(dueIdx, dueKey[0].length);
    const w = grab(dueIdx, endOf(dueIdx));
    if (w) { out.due = w.date; out.dueTime = w.time; }
  }
  if (!out.due && !out.plan) {
    const w = grab(0);
    if (w) { out.due = w.date; out.dueTime = w.time; }
  }

  if (range) {
    out.plan = { date: out.due || out.plan?.date || today(), start: range.start, mins: range.mins };
    out.due = null;
    out.dueTime = null;
    if (!hinted) out.type = 'event';
  }

  // "all day" wins over any time that came with the date: whichever day was
  // named is the whole of it, and a deadline for that day becomes the day
  if (allDay) {
    out.plan = { date: out.plan?.date || out.due || today(), start: null, mins: 0 };
    out.due = null;
    out.dueTime = null;
    if (!hinted) out.type = 'event';
  }

  if (repeat) {
    out.repeat = { until: null, count: null, ex: {}, ...repeat };
    // the first day: the one named, else today if the rule lands on it, else
    // the nearest day it does — "every mon" typed on a Wednesday starts Monday
    const first = () => {
      const t0 = today();
      if (repeat.freq !== 'weekly' || !repeat.days?.length) return t0;
      const dow = new Date(t0 + 'T00:00:00').getDay();
      if (repeat.days.includes(dow)) return t0;
      return repeat.days.map((d) => nextDow(d, t0)).sort()[0];
    };
    if (out.plan) { if (!dated) out.plan.date = first(); }
    else if (!out.due) out.due = first();
  }

  // a line that was all date — "12-7" — keeps what was typed as its name,
  // and what was read from it stays read
  const title = text.replace(/\s+/g, ' ').trim().replace(/^[-–—:]\s*/, '');
  out.title = (title || raw || 'Untitled').slice(0, 500);
  return out;
}
