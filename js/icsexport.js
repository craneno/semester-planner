// @ts-check
// icsexport.js — the planner's work as a calendar file.
//
// Any calendar reads .ics. A stretch of days is between two dates: each
// planned block or all-day plan in it once, and each deadline as an all-day
// "Due". Times go out in UTC, which every reader turns back into its own
// zone; a whole day is a date, its end the morning after, as the format
// asks. Lines fold at 75 octets.

import { itemsPlannedOn, itemsDueOn, areaName } from './store.js';
import { addDays, parseYmd, toMin, pad } from './util.js';

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** A line folded at 75 octets, the rest on lines that begin with a space. */
export function fold(line) {
  const out = [];
  let s = line;
  while (s.length > 75) { out.push(s.slice(0, 75)); s = ' ' + s.slice(75); }
  out.push(s);
  return out.join('\r\n');
}

const stampUtc = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
/** A local day and minutes into it as a UTC stamp; minutes past 24h run into the next day. */
export function utcStamp(date, mins) {
  const d = parseYmd(date);
  d.setHours(0, mins, 0, 0);
  return stampUtc(d);
}
const dateStamp = (date) => date.replace(/-/g, '');

/**
 * The events between two days, both in: `{ uid, title, area, notes, date,
 * start?, mins?, end? }` — a timed one has `start` and `mins`, a whole-day
 * one `end` (its last day).
 */
export function eventsBetween(from, to) {
  const seen = new Set();
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const t of itemsPlannedOn(d)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const base = { uid: t.id, title: t.title, area: t.areaId ? areaName(t.areaId) : '', notes: t.notes || '' };
      out.push(t.plan.start
        ? { ...base, date: t.plan.date, start: t.plan.start, mins: t.plan.mins || t.estMins || 60 }
        : { ...base, date: t.plan.date, end: t.plan.end || t.plan.date });
    }
    for (const t of itemsDueOn(d)) {
      const k = 'due:' + t.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ uid: k, title: `Due · ${t.title}`, area: t.areaId ? areaName(t.areaId) : '', notes: t.notes || '', date: d, end: d });
    }
  }
  return out;
}

/** The file. */
export function icsFor(events, { name = 'Semester Planner', now = new Date() } = {}) {
  const stamp = stampUtc(now);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Semester Planner//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@semester-planner`, `DTSTAMP:${stamp}`);
    if (e.start) {
      const s = toMin(e.start);
      lines.push(`DTSTART:${utcStamp(e.date, s)}`, `DTEND:${utcStamp(e.date, s + (e.mins || 60))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.date)}`, `DTEND;VALUE=DATE:${dateStamp(addDays(e.end || e.date, 1))}`);
    }
    lines.push(`SUMMARY:${esc(e.area ? `${e.area}: ${e.title}` : e.title)}`);
    if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
