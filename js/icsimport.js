// icsimport.js — a calendar file (.ics) becomes blocks.
//
// Any calendar can be saved as .ics — Google's export, an Outlook file, a
// club's schedule. This reads the events (the parser is canvas.js's: the
// Canvas feed is the same format) and makes a block of each in one area:
// a timed one is a scheduled block, a whole-day one an all-day plan, and a
// weekly rule becomes a repeat. An event brought in before, by its UID, is
// brought up to date rather than made twice. A link to a live calendar
// needs a server to fetch it; this is the file.

import { state, commit, upsertItem, areaForNew, AREA_CATEGORIES, areasInCategory, repeats, repeatAnchor } from './store.js';
import { parseIcs, icsWhen } from './canvas.js';
import { modal, closeModal, toast } from './ui.js';
import { h, toMin, fmtDate, parseYmd, addDays, diffDays } from './util.js';
import { isRepeatDate } from './repeat.js';
import { pushItem } from './gcal.js';

const DOW_ICS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY = 24 * 60;

/**
 * An RRULE as this planner's repeat rule, or null for one it cannot say.
 *
 * `start` is the event's DTSTART as read here, with `shift`: the days it
 * moved when a UTC time became the clock here. A rule's weekdays are written
 * against the DTSTART as written, so a Monday 21:30 New York class sent as
 * Tuesday 01:30Z has BYDAY=TU, and is a Monday here: the weekdays move with
 * it. A UTC UNTIL is an instant, and becomes the last day here it reaches.
 * @param {string} rrule
 * @param {{ date?: string, time?: string|null, shift?: number }} [start]
 */
export function repeatFromRrule(rrule, start = {}) {
  if (!rrule) return null;
  const p = {};
  for (const bit of String(rrule).split(';')) { const [k, v] = bit.split('='); if (k) p[k.toUpperCase()] = v; }
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[p.FREQ];
  if (!freq) return null;
  const rep = { freq, every: Math.max(1, +p.INTERVAL || 1), until: null, count: null };
  const shift = start.shift || 0;
  if (freq === 'weekly' && p.BYDAY) {
    // "1MO" is the first Monday of a month; only the weekday part is a weekday
    rep.days = p.BYDAY.split(',').map((d) => DOW_ICS[d.slice(-2)]).filter((d) => d !== undefined)
      .map((d) => (((d + shift) % 7) + 7) % 7);
  }
  const until = p.UNTIL ? icsWhen(p.UNTIL) : null;
  if (until) {
    rep.until = until.date;
    // the last day's own time is past the UNTIL: that day is not in it
    if (until.time && start.time && start.time > until.time) rep.until = addDays(until.date, -1);
  } else if (+p.COUNT > 0) rep.count = +p.COUNT;
  return rep;
}

/** The days a UTC DTSTART moved on its way to the clock here: -1, 0 or 1. */
const shiftOf = (ev) => (ev.written && ev.start?.date ? diffDays(ev.written, ev.start.date) : 0);

/** The `repeat.ex` key for a day an event names, if the rule gives that day. */
const ruleDay = (repeat, anchor, when) =>
  (when?.date && isRepeatDate(repeat, anchor, when.date) ? when.date : null);

/** One event's when, as a block: `{ plan, estMins }`. */
function planOf(ev) {
  if (!ev.start.time) return { plan: { date: ev.start.date }, estMins: 60 };
  let mins = 60;
  if (ev.end?.date) {
    const days = Math.round((parseYmd(ev.end.date) - parseYmd(ev.start.date)) / 864e5);
    mins = days * DAY + (toMin(ev.end.time || '00:00') - toMin(ev.start.time));
    if (mins <= 0) mins = 60;
  }
  return { plan: { date: ev.start.date, start: ev.start.time, mins }, estMins: mins };
}

/**
 * One day of a series, as the exception the store keeps for it: cancelled is
 * `{ off: true }`, the way a deleted occurrence is; moved or renamed is the
 * day, the time, the length and the name that differ. Null when it is the
 * day the rule would have drawn anyway.
 */
function exceptionOf(row, ev) {
  if (ev.status === 'CANCELLED') return { off: true };
  const key = ev.recurrenceId.date;
  const { plan } = planOf(ev);
  const title = String(ev.summary || '').trim();
  const ov = {};
  if (plan.date !== key) ov.date = plan.date;
  if ((plan.start || null) !== (row.plan.start || null)) ov.start = plan.start || null;
  if (plan.mins !== undefined && plan.mins !== row.plan.mins) ov.mins = plan.mins;
  if (title && title !== row.title) ov.title = title;
  return Object.keys(ov).length ? ov : null;
}

/**
 * The events as rows a block can be made from: `{ uid, title, location,
 * plan, estMins, repeat }`. One with no start is skipped; a whole-day run of
 * several days is its first day.
 */
export function planIcs(events) {
  const out = [];
  const series = new Map();   // uid -> the row of a series, for its moved days
  const moved = [];
  for (const ev of events) {
    if (!ev.start?.date) continue;
    // one day of a series carries the series' UID: it is an exception to the
    // series, never the series itself
    if (ev.recurrenceId?.date) { moved.push(ev); continue; }
    const title = String(ev.summary || '').trim() || 'Untitled';
    const repeat = repeatFromRrule(ev.rrule, { ...ev.start, shift: shiftOf(ev) });
    const row = { uid: ev.uid, title, location: ev.location || '', repeat, ...planOf(ev) };
    if (repeat) {
      // EXDATE: days the rule skips, kept the way a deleted occurrence is
      for (const x of ev.exdates || []) {
        const key = ruleDay(repeat, row.plan.date, x);
        if (key) (repeat.ex = repeat.ex || {})[key] = { off: true };
      }
      if (ev.uid) series.set(ev.uid, row);
    }
    out.push(row);
  }
  for (const ev of moved) {
    const row = series.get(ev.uid);
    if (row) {
      const key = ruleDay(row.repeat, row.plan.date, ev.recurrenceId);
      const ov = key && exceptionOf(row, ev);
      if (ov) (row.repeat.ex = row.repeat.ex || {})[key] = ov;
      continue;
    }
    // its series is not in this file: a series brought in before takes it as
    // an exception (applyIcs); with none, it is a block of its own, under a
    // uid of its own so it never lands on the series
    if (ev.status === 'CANCELLED') continue;
    out.push({
      uid: ev.uid ? `${ev.uid}#${ev.recurrenceId.date}` : undefined,
      of: ev.uid ? { uid: ev.uid, key: ev.recurrenceId.date, ev } : undefined,
      title: String(ev.summary || '').trim() || 'Untitled', location: ev.location || '', repeat: null, ...planOf(ev)
    });
  }
  return out;
}

/** The file's rule, with the days ticked here still ticked. */
function keepTicks(repeat, was) {
  if (!repeat || !was?.ex) return repeat;
  const ex = { ...(repeat.ex || {}) };
  for (const [key, ov] of Object.entries(was.ex)) {
    if (!ov?.done || ex[key]?.off) continue;
    ex[key] = { ...(ex[key] || {}), done: true, doneAt: ov.doneAt || null };
  }
  return Object.keys(ex).length ? { ...repeat, ex } : repeat;
}

/**
 * Bring rows in. Returns { made, updated }. A row whose uid is here already
 * gets its name and when again and keeps everything else — the area it was
 * moved to, the tick, the notes.
 */
export function applyIcs(rows, areaId) {
  const res = { made: 0, updated: 0, ids: [] };
  for (const r of rows) {
    // a moved day whose series came in from an earlier file joins that series
    const parent = r.of ? state.items.find((t) => t.icsUid === r.of.uid && repeats(t)) : null;
    if (parent) {
      const key = ruleDay(parent.repeat, repeatAnchor(parent), { date: r.of.key });
      const ov = key && parent.plan && exceptionOf(parent, r.of.ev);
      if (ov) {
        const ex = { ...(parent.repeat.ex || {}) };
        ex[key] = { ...ov, ...(ex[key]?.done ? { done: true, doneAt: ex[key].doneAt } : {}) };
        upsertItem({ id: parent.id, repeat: { ...parent.repeat, ex } });
        res.updated++;
        res.ids.push(parent.id);
      }
      continue;
    }
    const had = r.uid ? state.items.find((t) => t.icsUid === r.uid) : null;
    if (had) {
      upsertItem({ id: had.id, title: r.title, plan: r.plan, estMins: r.estMins, repeat: keepTicks(r.repeat, had.repeat) });
      res.updated++;
      res.ids.push(had.id);
    } else {
      const made = upsertItem({
        title: r.title, type: 'event', areaId, plan: r.plan, estMins: r.estMins, repeat: r.repeat,
        ...(r.uid ? { icsUid: r.uid } : {}), ...(r.location ? { notes: r.location } : {})
      });
      res.made++;
      res.ids.push(made.id);
    }
  }
  return res;
}

/** The dialog: what is in the file, which area, and Import. */
export function openIcsImport(text, { navigate } = {}) {
  let rows;
  try { rows = planIcs(parseIcs(text)); } catch { rows = []; }
  if (!rows.length) { toast('No events in that file.'); return; }
  const dates = rows.map((r) => r.plan.date).sort();
  const known = rows.filter((r) => r.uid && state.items.some((t) => t.icsUid === r.uid)).length;
  let areaId = areaForNew();

  const areaIn = h('select', { 'aria-label': 'Area', onchange: (e) => { areaId = e.target.value || null; } },
    h('option', { value: '', selected: !areaId }, 'No area'),
    ...AREA_CATEGORIES.map((c) => {
      const mine = areasInCategory(c.id);
      return mine.length
        ? h('optgroup', { label: c.label },
          ...mine.map((a) => h('option', { value: a.id, selected: a.id === areaId }, a.name)))
        : null;
    }));

  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' } },
    ...rows.slice(0, 8).map((r) => h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
      h('span', { class: 'eyebrow num', style: { minWidth: '76px' } }, fmtDate(r.plan.date)),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        r.title + (r.repeat ? ' · repeats' : '')))),
    rows.length > 8 ? h('div', { class: 'eyebrow' }, `and ${rows.length - 8} more`) : null);

  const doImport = () => {
    let res;
    commit(() => { res = applyIcs(rows, areaId); });
    closeModal();
    for (const id of res.ids) pushItem(id).catch(() => {});
    toast(`Imported ${res.made}${res.updated ? ` · ${res.updated} brought up to date` : ''}`);
    navigate?.();
  };

  modal({
    title: 'Import a calendar file',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'eyebrow' },
        `${rows.length} ${rows.length === 1 ? 'event' : 'events'} · ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`
        + (known ? ` · ${known} here already, brought up to date` : '')),
      list,
      h('div', { class: 'field' }, h('label', {}, 'Area'), areaIn)),
    footer: [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: doImport }, `Import ${rows.length}`)
    ]
  });
}

/** True for a dropped file that reads as a calendar. */
export const isIcsFile = (f) => !!f && (/\.ics$/i.test(f.name) || f.type === 'text/calendar');

/** Hosts already wired, each with the latest `navigate` it was handed. */
const wired = new WeakMap();

/**
 * Wire a host so an .ics dropped on it opens the import. Safe to call on
 * every draw: the Week redraws into the same #view each time, and a pair of
 * listeners per draw opened one dialog per draw for one dropped file. The
 * listeners go on once; a later call only hands them its `navigate`.
 */
export function acceptIcsDrop(host, { navigate } = {}) {
  const had = wired.get(host);
  if (had) { had.navigate = navigate; return; }
  const ctx = { navigate };
  wired.set(host, ctx);
  host.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  host.addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (!isIcsFile(f)) { toast('Drop a calendar file (.ics) to import it.'); return; }
    openIcsImport(await f.text(), { navigate: ctx.navigate });
  });
}
