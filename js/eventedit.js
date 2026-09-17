// eventedit.js — the small doors: one of Google's events, or one day of a class.
//
// Both are borrowed things. A Google event is drawn outlined and stays
// Google's: this dialog changes its name and its when, sends that to Google
// through the block queue (gcal.js editEvent), and leaves the rest of it —
// guests, colour, description — as it was. A class is the area's rule: this
// dialog is the one day of it, moved, in another room, or cancelled, kept
// as an exception on the slot the way an item's repeat keeps one day. A
// block of ours has the task page instead.

import { h, toMin, fromMin, fmtDate, fmtTime } from './util.js';
import { state, commit, areaById, setClassDay } from './store.js';
import { modal, closeModal, confirmDialog, toast, timeInput } from './ui.js';
import { editEvent, removeEvent, canEditEvents } from './gcal.js';
import { openAreaEditor } from './views/areas.js';

const field = (label, control) => h('div', { class: 'field' }, h('label', {}, label), control);
const grid = (...cells) => h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: '12px' } }, ...cells);

/** Two ways to mean an edit, as the task page has them: this one, or all of them. */
function scopeRow(scope, onPick) {
  const btn = (key, label) => h('button', {
    class: 'mode' + (scope === key ? ' on' : ''), type: 'button', 'aria-pressed': String(scope === key),
    onclick: () => onPick(key)
  }, label);
  // the same toggle the task page has, so the one picked is filled in
  return h('div', { class: 'mode-toggle' }, btn('one', 'Only this day'), btn('all', 'Every time'));
}

/* ---------------- one of Google's events ---------------- */

/**
 * @param {string} id  the Google event id
 * @param {{ after?: () => void }} [opts]  called once a change is made, to redraw
 */
export function openEvent(id, { after } = {}) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  const can = canEditEvents();
  const repeating = !!e.recurringEventId;
  let scope = 'one';
  const start0 = e.start || '09:00';
  const draft = { title: e.title, date: e.date, start: start0, end: e.end || fromMin(toMin(start0) + 60), allDay: !!e.allDay };

  const title = h('input', { type: 'text', value: draft.title, oninput: (ev) => { draft.title = ev.target.value; } });
  const date = h('input', { type: 'date', value: draft.date, onchange: (ev) => { draft.date = ev.target.value; } });
  const start = timeInput({ value: draft.start, onchange: (ev) => { draft.start = ev.target.value; } });
  const end = timeInput({ value: draft.end, onchange: (ev) => { draft.end = ev.target.value; } });
  const times = grid(field('Start', start), field('End', end));
  times.hidden = draft.allDay;
  const allDayBox = h('input', {
    type: 'checkbox', class: 'check', checked: draft.allDay,
    onchange: (ev) => { draft.allDay = ev.target.checked; times.hidden = draft.allDay; }
  });
  const allDay = h('label', { style: { display: 'flex', gap: '10px', alignItems: 'center', cursor: 'pointer', paddingBottom: '8px' } },
    allDayBox, h('span', { style: { fontSize: '13.5px' } }, 'All day'));
  const scopeNote = h('div', { class: 'eyebrow' });
  const scopeHost = h('div', {});
  // every time: the name and the time of day travel; the day and all-day
  // are each time's own, so those two are left alone
  const paintScope = () => {
    if (!repeating) return;
    scopeHost.replaceChildren(scopeRow(scope, (k) => { scope = k; paintScope(); }));
    date.disabled = !can || scope === 'all';
    allDayBox.disabled = !can || scope === 'all';
    scopeNote.textContent = scope === 'all'
      ? 'Every time it repeats gets this name and time of day. The day and all-day stay each time’s own.'
      : 'One day of a repeating event: only this day changes.';
  };
  if (!can) for (const c of [title, date, start, end, allDayBox]) c.disabled = true;
  paintScope();

  const save = () => {
    if (!draft.title.trim()) { toast('Give it a name first.'); return; }
    if (!draft.date) { toast('It needs a day.'); return; }
    if (!draft.allDay && (!draft.start || !draft.end)) { toast('It needs a start and an end.'); return; }
    const all = repeating && scope === 'all';
    const before = { title: e.title, date: e.date, start: e.start, end: e.end, allDay: !!e.allDay };
    const fields = all
      ? { title: draft.title.trim(), start: draft.start, end: draft.end }
      : draft.allDay
        ? { title: draft.title.trim(), date: draft.date, allDay: true }
        : { title: draft.title.trim(), date: draft.date, start: draft.start, end: draft.end, allDay: false };
    if (!editEvent(id, fields, { all })) return;
    closeModal();
    after?.();
    toast(all ? 'Changed every time, on Google too' : 'Changed, on Google too', {
      action: 'Undo', onAction: () => { editEvent(id, all ? { title: before.title, start: before.start, end: before.end } : before, { all }); after?.(); }
    });
  };
  title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });

  modal({
    title: 'On Google Calendar',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      repeating ? scopeHost : null,
      field('Name', title),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' } }, field('Day', date), allDay),
      times,
      e.location ? h('div', { class: 'eyebrow' }, e.location) : null,
      repeating ? scopeNote : null,
      !can ? h('div', { class: 'eyebrow' }, 'Two-way sync is off in Settings, so this is read-only here.') : null,
      e.link ? h('a', { href: e.link, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Open in Google Calendar ↗') : null),
    footer: [
      can && h('button', {
        class: 'btn danger', onclick: async () => {
          const all = repeating && scope === 'all';
          closeModal();
          const what = all ? `${e.title}, every time it repeats — from Google Calendar too.` : `${e.title} — from Google Calendar too.`;
          if (await confirmDialog(all ? 'Delete every time?' : 'Delete this event?', what, 'Delete')) {
            removeEvent(id, { all });
            after?.();
            toast(all ? 'Deleted every time, on Google too' : 'Deleted, on Google too');
          }
        }
      }, 'Delete'),
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      can && h('button', { class: 'btn primary', onclick: save }, 'Save')
    ]
  });
}

/* ---------------- one day of a class ---------------- */

/**
 * @param {object} c     a class from classesOn(date): areaId, slot, start, end, location
 * @param {string} date  the day clicked
 * @param {{ navigate: () => void }} opts  redraw; also carried to the area editor
 */
export function openClass(c, date, { navigate } = {}) {
  const area = areaById(c.areaId);
  const slot = area?.schedule?.[c.slot];
  if (!slot) return;
  const had = slot.ex && date in slot.ex;          // an exception already, null being "cancelled"
  const before = had ? slot.ex[date] : undefined;
  const x = had ? slot.ex[date] : null;
  const draft = { start: x?.start || slot.start, end: x?.end || slot.end, location: x?.location ?? (slot.location || '') };
  const hour12 = state.settings.hour12;
  const usual = `${fmtTime(slot.start, hour12)}–${fmtTime(slot.end, hour12)}${slot.location ? ' · ' + slot.location : ''}`;

  const start = timeInput({ value: draft.start, onchange: (ev) => { draft.start = ev.target.value; } });
  const end = timeInput({ value: draft.end, onchange: (ev) => { draft.end = ev.target.value; } });
  const room = h('input', { type: 'text', value: draft.location, placeholder: slot.location || area.location || 'Room', onchange: (ev) => { draft.location = ev.target.value; } });

  const put = (value, said) => {
    commit(() => setClassDay(c.areaId, c.slot, date, value), { source: 'editor' });
    closeModal();
    navigate?.();
    toast(said, { action: 'Undo', onAction: () => { commit(() => setClassDay(c.areaId, c.slot, date, before), { source: 'editor' }); navigate?.(); } });
  };
  const save = () => {
    if (!draft.start || !draft.end) { toast('It needs a start and an end.'); return; }
    const same = draft.start === slot.start && draft.end === slot.end && (draft.location || '') === (slot.location || '');
    // back to the rule is no exception at all, not one that says the same
    put(same ? undefined : { start: draft.start, end: draft.end, ...(draft.location !== (slot.location || '') ? { location: draft.location } : {}) },
      same ? 'Back to the usual time' : `Moved for ${fmtDate(date, { weekday: true })}`);
  };

  modal({
    title: `${c.title} · ${fmtDate(date, { weekday: true })}`,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      grid(field('Start', start), field('End', end)),
      field('Room', room),
      h('div', { class: 'eyebrow' }, x ? `Moved this day. The usual time is ${usual}.` : `This day only. Every week is ${usual}.`),
      h('button', {
        class: 'btn ghost sm', style: { alignSelf: 'flex-start' },
        onclick: () => { closeModal(); openAreaEditor(c.areaId, navigate, { focus: 'meetings' }); }
      }, 'Change every week →')),
    footer: [
      h('button', { class: 'btn danger', onclick: () => put(null, `Cancelled for ${fmtDate(date, { weekday: true })}`) }, 'Cancel this day'),
      h('button', { class: 'btn', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn primary', onclick: save }, 'Save this day')
    ]
  });
}
