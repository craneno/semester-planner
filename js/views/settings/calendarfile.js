// views/settings/calendarfile.js — an .ics file in, and the planner out as one.

import { h, saveFile, fmtDate } from '../../util.js';
import { state } from '../../store.js';
import { toast } from '../../ui.js';
import { openIcsImport } from '../../icsimport.js';
import { eventsBetween, icsFor } from '../../icsexport.js';
import { section } from './bits.js';

export function renderCalendarFile({ navigate }) {
  const calIn = h('input', {
    type: 'file', accept: '.ics,text/calendar', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files?.[0];
      if (f) openIcsImport(await f.text(), { navigate });
      e.target.value = '';
    }
  });
  const exFrom = h('input', { type: 'date', value: state.semester.start, 'aria-label': 'From' });
  const exTo = h('input', { type: 'date', value: state.semester.end, 'aria-label': 'To' });
  const exportIcs = () => {
    const from = exFrom.value, to = exTo.value;
    if (!from || !to || to < from) { toast('Pick a first day and a last day.'); return; }
    const events = eventsBetween(from, to);
    if (!events.length) { toast('Nothing planned or due between those days.'); return; }
    saveFile(new Blob([icsFor(events, { name: state.semester.name })], { type: 'text/calendar' }), `planner-${from}-${to}.ics`);
    toast(`${events.length} ${events.length === 1 ? 'event' : 'events'} saved, ${fmtDate(from)} – ${fmtDate(to)}.`);
  };
  return section('Calendar file', [
    h('p', { class: 'help', style: { margin: '0 0 12px' } },
      'Any calendar saved as an .ics file — Google\u2019s export, a club\u2019s schedule — becomes blocks in one area. Weekly rules repeat; an event brought in before is brought up to date, not made twice. Or drop the file on the Week.'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('button', { class: 'btn', onclick: () => calIn.click() }, 'Import a calendar file'), calIn),
    h('p', { class: 'help', style: { margin: '8px 0 0' } },
      'And the other way: the blocks, all-day plans and due dates between two days as an .ics file any calendar can read.'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      exFrom, h('span', { class: 'eyebrow' }, 'to'), exTo,
      h('button', { class: 'btn', onclick: exportIcs }, 'Export as a calendar file'))
  ]);
}
