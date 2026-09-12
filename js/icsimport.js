// icsimport.js — a calendar file (.ics) becomes blocks.
//
// Any calendar can be saved as .ics — Google's export, an Outlook file, a
// club's schedule. This reads the events (the parser is canvas.js's: the
// Canvas feed is the same format) and makes a block of each in one area:
// a timed one is a scheduled block, a whole-day one an all-day plan, and a
// weekly rule becomes a repeat. An event brought in before, by its UID, is
// brought up to date rather than made twice. A link to a live calendar
// needs a server to fetch it; this is the file.

import { state, commit, upsertItem, areaForNew, AREA_CATEGORIES, areasInCategory } from './store.js';
import { parseIcs } from './canvas.js';
import { modal, closeModal, toast } from './ui.js';
import { h, toMin, fmtDate, parseYmd } from './util.js';
import { pushItem } from './gcal.js';

const DOW_ICS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY = 24 * 60;

/** An RRULE as this planner's repeat rule, or null for one it cannot say. */
export function repeatFromRrule(rrule) {
  if (!rrule) return null;
  const p = {};
  for (const bit of String(rrule).split(';')) { const [k, v] = bit.split('='); if (k) p[k.toUpperCase()] = v; }
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[p.FREQ];
  if (!freq) return null;
  const rep = { freq, every: Math.max(1, +p.INTERVAL || 1), until: null, count: null };
  if (freq === 'weekly' && p.BYDAY) {
    // "1MO" is the first Monday of a month; only the weekday part is a weekday
    rep.days = p.BYDAY.split(',').map((d) => DOW_ICS[d.slice(-2)]).filter((d) => d !== undefined);
  }
  const until = p.UNTIL?.match(/^(\d{4})(\d{2})(\d{2})/);
  if (until) rep.until = `${until[1]}-${until[2]}-${until[3]}`;
  else if (+p.COUNT > 0) rep.count = +p.COUNT;
  return rep;
}

/**
 * The events as rows a block can be made from: `{ uid, title, location,
 * plan, estMins, repeat }`. One with no start is skipped; a whole-day run of
 * several days is its first day.
 */
export function planIcs(events) {
  const out = [];
  for (const ev of events) {
    if (!ev.start?.date) continue;
    const title = String(ev.summary || '').trim() || 'Untitled';
    const repeat = repeatFromRrule(ev.rrule);
    if (ev.start.time) {
      let mins = 60;
      if (ev.end?.date) {
        const days = Math.round((parseYmd(ev.end.date) - parseYmd(ev.start.date)) / 864e5);
        mins = days * DAY + (toMin(ev.end.time || '00:00') - toMin(ev.start.time));
        if (mins <= 0) mins = 60;
      }
      out.push({ uid: ev.uid, title, location: ev.location || '', repeat,
        plan: { date: ev.start.date, start: ev.start.time, mins }, estMins: mins });
    } else {
      out.push({ uid: ev.uid, title, location: ev.location || '', repeat, plan: { date: ev.start.date }, estMins: 60 });
    }
  }
  return out;
}

/**
 * Bring rows in. Returns { made, updated }. A row whose uid is here already
 * gets its name and when again and keeps everything else — the area it was
 * moved to, the tick, the notes.
 */
export function applyIcs(rows, areaId) {
  const res = { made: 0, updated: 0, ids: [] };
  for (const r of rows) {
    const had = r.uid ? state.items.find((t) => t.icsUid === r.uid) : null;
    if (had) {
      upsertItem({ id: had.id, title: r.title, plan: r.plan, estMins: r.estMins, repeat: r.repeat });
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

/** Wire a host so an .ics dropped on it opens the import. */
export function acceptIcsDrop(host, { navigate } = {}) {
  host.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  host.addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (!isIcsFile(f)) { toast('Drop a calendar file (.ics) to import it.'); return; }
    openIcsImport(await f.text(), { navigate });
  });
}
