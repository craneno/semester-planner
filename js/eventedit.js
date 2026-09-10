// eventedit.js — one of Google's own events, changed in place.
//
// A Google event is drawn outlined and stays Google's. This is the small
// door for it: the name and the when, sent to Google through the block
// queue (gcal.js editEvent), and the rest of the event — guests, colour,
// description — left as it was. A block of ours has the task page instead.

import { h, toMin, fromMin } from './util.js';
import { state } from './store.js';
import { modal, closeModal, confirmDialog, toast } from './ui.js';
import { editEvent, removeEvent, canEditEvents } from './gcal.js';

const field = (label, control) => h('div', { class: 'field' }, h('label', {}, label), control);

/**
 * @param {string} id  the Google event id
 * @param {{ after?: () => void }} [opts]  called once a change is made, to redraw
 */
export function openEvent(id, { after } = {}) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  const can = canEditEvents();
  const start0 = e.start || '09:00';
  const draft = { title: e.title, date: e.date, start: start0, end: e.end || fromMin(toMin(start0) + 60), allDay: !!e.allDay };

  const title = h('input', { type: 'text', value: draft.title, oninput: (ev) => { draft.title = ev.target.value; } });
  const date = h('input', { type: 'date', value: draft.date, onchange: (ev) => { draft.date = ev.target.value; } });
  const start = h('input', { type: 'time', value: draft.start, onchange: (ev) => { draft.start = ev.target.value; } });
  const end = h('input', { type: 'time', value: draft.end, onchange: (ev) => { draft.end = ev.target.value; } });
  const times = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
    field('Start', start), field('End', end));
  times.hidden = draft.allDay;
  const allDayBox = h('input', {
    type: 'checkbox', class: 'check', checked: draft.allDay,
    onchange: (ev) => { draft.allDay = ev.target.checked; times.hidden = draft.allDay; }
  });
  const allDay = h('label', { style: { display: 'flex', gap: '10px', alignItems: 'center', cursor: 'pointer', paddingBottom: '8px' } },
    allDayBox, h('span', { style: { fontSize: '13.5px' } }, 'All day'));
  if (!can) for (const c of [title, date, start, end, allDayBox]) c.disabled = true;

  const save = () => {
    if (!draft.title.trim()) { toast('Give it a name first.'); return; }
    if (!draft.date) { toast('It needs a day.'); return; }
    if (!draft.allDay && (!draft.start || !draft.end)) { toast('It needs a start and an end.'); return; }
    const before = { title: e.title, date: e.date, start: e.start, end: e.end, allDay: !!e.allDay };
    const fields = draft.allDay
      ? { title: draft.title.trim(), date: draft.date, allDay: true }
      : { title: draft.title.trim(), date: draft.date, start: draft.start, end: draft.end, allDay: false };
    if (!editEvent(id, fields)) return;
    closeModal();
    after?.();
    toast('Changed, on Google too', { action: 'Undo', onAction: () => { editEvent(id, before); after?.(); } });
  };
  title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });

  modal({
    title: 'On Google Calendar',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      field('Name', title),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' } }, field('Day', date), allDay),
      times,
      e.location ? h('div', { class: 'eyebrow' }, e.location) : null,
      e.recurringEventId ? h('div', { class: 'eyebrow' }, 'One day of a repeating event: only this day changes.') : null,
      !can ? h('div', { class: 'eyebrow' }, 'Two-way sync is off in Settings, so this is read-only here.') : null,
      e.link ? h('a', { href: e.link, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Open in Google Calendar ↗') : null),
    footer: [
      can && h('button', {
        class: 'btn danger', onclick: async () => {
          closeModal();
          if (await confirmDialog('Delete this event?', `${e.title} — from Google Calendar too.`, 'Delete')) {
            removeEvent(id);
            after?.();
            toast('Deleted, on Google too');
          }
        }
      }, 'Delete'),
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      can && h('button', { class: 'btn primary', onclick: save }, 'Save')
    ]
  });
}
