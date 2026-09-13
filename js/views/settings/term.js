// views/settings/term.js — the term and the calendar's first day.

import { h, debounce, tz, zoneLabel, zoneShift, fmtDuration } from '../../util.js';
import { state, commit, scheduleZones, shiftSchedules, stampSchedules } from '../../store.js';
import { toast } from '../../ui.js';
import * as G from '../../gcal.js';
import { section, field } from './bits.js';

export function renderTerm({ navigate }) {
  return [
    section('Semester', [
      field('Name', h('input', {
        type: 'text', value: state.semester.name,
        oninput: debounce((e) => commit(() => { state.semester.name = e.target.value; }), 400)
      })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        field('First day', h('input', {
          type: 'date', value: state.semester.start,
          onchange: (e) => setTerm('start', e.target.value, navigate)
        })),
        field('Last day', h('input', {
          type: 'date', value: state.semester.end,
          onchange: (e) => setTerm('end', e.target.value, navigate)
        }))),
      h('div', { class: 'eyebrow' }, 'Only courses follow these days: when classes meet, the chart, the Canvas import. A course can set its own on its page.'),
      zoneRow(navigate)
    ]),
    section('Calendar', [
      field('First day', h('input', {
        type: 'date', value: state.calendar.start,
        onchange: (e) => setCalendarStart(e.target.value, navigate)
      })),
      h('div', { class: 'eyebrow' }, 'The day the planner began. Google Calendar is read from here on, a year ahead, whatever the term says.')
    ])
  ];
}

/* A term with no last day, or one before the first, made every class vanish
   from Week and Overview with nothing said: `classesOn` is empty outside the
   term. So the edit is refused and the box put back. */
function setTerm(key, value, navigate) {
  const next = { ...state.semester, [key]: value };
  const bad = !next.start || !next.end ? 'The term needs both days.'
    : next.end < next.start ? 'The last day has to come after the first.' : '';
  if (bad) { toast(bad); navigate(); return; }
  commit(() => { state.semester[key] = value; });
  navigate();
}

/* The day the calendar began. Google is read from it on, so a change reads
   the lot again: the sync token only knows the window it was made under. */
function setCalendarStart(value, navigate) {
  if (!value) { toast('The calendar needs a first day.'); navigate(); return; }
  commit(() => { state.calendar.start = value; });
  G.sync();
  navigate();
}

/* The zone a class schedule is written in.
   The app asks by itself when a device turns up somewhere new, but that only
   works for times it saw stamped. Anything imported before there was a stamp
   claims whichever zone first read it, so this is where a wrong claim is put
   right — and where a shift can be made on purpose, without moving house. */
function zoneRow(navigate) {
  const claimed = scheduleZones();
  if (!claimed.length) return null;
  const from = claimed[0];
  const options = [...new Set([...claimed, tz(), ...zoneChoices()])];
  const note = h('div', { class: 'eyebrow', style: { marginTop: '6px' } });
  const paint = (pick) => {
    const mins = zoneShift(pick, tz());
    note.textContent = pick === from
      ? `Shown as written. This device is on ${zoneLabel(tz())}.`
      : mins
        ? `Every class moves ${fmtDuration(Math.abs(mins))} ${mins > 0 ? 'later' : 'earlier'}.`
        : 'Same clock — nothing moves.';
  };
  paint(from);

  const pick = h('select', {
    onchange: (e) => {
      /* Two steps, and the order is the whole of it: first agree that the
         times mean `said` — a relabel, nothing moves — and only then read
         them here, which is the shift. Doing it the other way round would
         move times that were never in the zone they were leaving. */
      const said = e.target.value;
      const moved = zoneShift(said, tz());
      commit(() => { stampSchedules(said); shiftSchedules(said, tz()); });
      toast(moved
        ? `Class times moved ${fmtDuration(Math.abs(moved))} ${moved > 0 ? 'later' : 'earlier'}.`
        : 'Class times unchanged.', {
        action: 'Undo',
        onAction: () => {
          commit(() => { shiftSchedules(tz(), said); stampSchedules(from); });
          navigate();
        }
      });
      navigate();
    }
  }, ...options.map((z) => h('option', { value: z, selected: z === from }, zoneLabel(z) + ' — ' + z)));
  pick.addEventListener('input', (e) => paint(e.target.value));

  return h('div', {}, field('Class times were set in', pick), note);
}

/** A short list to choose from where the browser will not enumerate them. */
function zoneChoices() {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    if (all && all.length) return all;
  } catch { /* older browsers answer with the ones people actually move between */ }
  return [
    'America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago',
    'America/New_York', 'America/Halifax', 'Europe/London', 'Europe/Paris',
    'Europe/Berlin', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC'
  ];
}
