// store/quickadd.js — one line into a task.
//   "Topology PS3 due fri 5pm 2h !high #Topology plan tue"
// Understands: due <when>, plan <when>, bare dates, times, durations,
// !priority, #area. parseWhen and parseRange are pure; the two that look up
// an area take the state as their first argument, and store.js binds them.

import { today, addDays, fromMin, diffDays } from '../util.js';
import { ITEM_TYPES } from './constants.js';

const DOW_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function nextDow(dow, from = today()) {
  const d = new Date(from + 'T00:00:00');
  const delta = (dow - d.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

/** @returns {{date, time, consumed: string[]}|null} */
export function parseWhen(text) {
  const t = text.toLowerCase();
  const consumed = [];
  let date = null, time = null;

  let m = t.match(/\b(today|tonight|tomorrow|tmr)\b/);
  if (m) { date = m[1] === 'today' || m[1] === 'tonight' ? today() : addDays(today(), 1); consumed.push(m[0]); }

  if (!date) {
    m = t.match(/\bnext\s+(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\b/);
    if (m) { date = addDays(nextDow(DOW_WORDS[m[1]]), 0); consumed.push(m[0]); }
  }
  if (!date) {
    m = t.match(/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(day|s|nesday|rsday|urday)?\b/);
    if (m) { date = nextDow(DOW_WORDS[m[1]]); consumed.push(m[0]); }
  }
  if (!date) {
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
    if (m) {
      const mi = MONTH_WORDS.indexOf(m[1].slice(0, 3));
      const y = new Date().getFullYear();
      const cand = `${y}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
      date = cand < today() && diffDays(cand, today()) > 200 ? `${y + 1}${cand.slice(4)}` : cand;
      consumed.push(m[0]);
    }
  }
  if (!date) {
    m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
      date = `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
      consumed.push(m[0]);
    }
  }

  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let H = +m[1] % 12;
    if (m[3] === 'pm') H += 12;
    time = fromMin(H * 60 + (+m[2] || 0));
    consumed.push(m[0]);
  } else {
    m = t.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
    if (m) { time = fromMin(+m[1] * 60 + +m[2]); consumed.push(m[0]); }
  }

  return date || time ? { date, time, consumed } : null;
}

/**
 * A start–end time range: "12-7", "2:30-4pm", "9 to 11am".
 *
 * Bare hours are read the way a person means them during a day: 7–11 is
 * morning, 12 is noon, 1–6 is afternoon. So "12-7" is noon to seven, and
 * "2-4" is the afternoon. An end that lands before its start is pushed
 * twelve hours, which is what "11-1" means.
 */
export function parseRange(text) {
  const m = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;

  // "read ch 3-4" and "pages 10-20" are ranges of things, not of hours
  const before = text.slice(0, m.index);
  if (/\b(ch|chap|chapters?|p|pp|pg|pages?|problems?|q|questions?|sections?|no|nums?|units?|weeks?|#)\s*\.?\s*$/i.test(before)) {
    return null;
  }

  const daytime = (h) => (h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12);
  const hour = (raw, ampm) => {
    const h = +raw;
    if (!ampm) return daytime(h);
    const base = h % 12;
    return /pm/i.test(ampm) ? base + 12 : base;
  };

  let sh = hour(m[1], m[3]);
  let eh = hour(m[4], m[6] || m[3]);   // "9 to 11am" — a trailing meridiem covers both
  const sm = +(m[2] || 0), em = +(m[5] || 0);
  let start = sh * 60 + sm, end = eh * 60 + em;
  if (end <= start) end += 12 * 60;                       // "11-1"
  if (end <= start || end > 24 * 60) return null;

  return { start: fromMin(start), end: fromMin(end), mins: end - start, consumed: m[0] };
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

export function parseQuickAdd(s, input) {
  let text = ' ' + input.trim() + ' ';
  const out = { title: '', areaId: null, type: 'task', due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60 };

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

  // duration
  const dm = text.match(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i);
  if (dm) {
    const n = parseFloat(dm[1]);
    out.estMins = /^h/i.test(dm[2]) ? Math.round(n * 60) : Math.round(n);
    text = text.replace(dm[0], ' ');
  }

  // area by #tag or @tag — the whole name run together, or the start of it,
  // or the start of any word in it: "#thermo", "@thermo", "@methods" all land
  // — else the area's name written out anywhere in the line
  const am = text.match(/\s[#@]([\w-]+)/);
  if (am) {
    const a = areaByTag(s, am[1]);
    if (a) out.areaId = a.id;
    text = text.replace(am[0], ' ');
  } else {
    for (const a of s.areas) {
      const re = new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
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
    const at = text.toLowerCase().indexOf(range.consumed.toLowerCase());
    if (at >= 0) {
      text = text.slice(0, at) + ' '.repeat(range.consumed.length) + text.slice(at + range.consumed.length);
    }
    out.estMins = range.mins;
  }

  // planned date: "plan <when>" / "work <when>"
  const planIdx = text.search(/\b(plan|work on|work|start)\b/i);
  const dueIdx = text.search(/\bdue\b/i);

  const grab = (from) => {
    const seg = text.slice(from);
    const w = parseWhen(seg);
    if (!w) return null;
    for (const c of w.consumed) {
      const i = text.toLowerCase().indexOf(c, from);
      if (i >= 0) text = text.slice(0, i) + ' '.repeat(c.length) + text.slice(i + c.length);
    }
    return w;
  };

  if (planIdx >= 0) {
    const w = grab(planIdx);
    if (w) out.plan = { date: w.date || today(), start: w.time || null, mins: out.estMins };
    text = text.replace(/\b(plan|work on|work|start)\b/i, ' ');
  }
  if (dueIdx >= 0) {
    const w = grab(dueIdx);
    if (w) { out.due = w.date; out.dueTime = w.time; }
    text = text.replace(/\bdue\b/i, ' ');
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

  out.title = text.replace(/\s+/g, ' ').trim().replace(/^[-–—:]\s*/, '') || 'Untitled';
  return out;
}
