// timegrid.js — sweep out a time range on a calendar, and name what goes in it.
//
// The gesture every calendar has: press on empty space, drag down (or up),
// let go, and say what it is. Both grids use it — Overview's day clock and
// the Week view — so the geometry is passed in and only the arithmetic and
// the prompt live here.
//
// What it creates is a `plan` block on an item, because that is the only
// thing this app puts on a calendar at all: a due date alone never reaches
// Google.

import { h, fmtDate, fmtTime, fmtDuration, toMin, fromMin, clamp } from './util.js';
import {
  state, commit, upsertItem, ITEM_TYPES, AREA_CATEGORIES, areasInCategory, defaultAreaId
} from './store.js';
import { modal, closeModal, toast } from './ui.js';
import { openItem } from './editor.js';
import { pushItem } from './gcal.js';

/** Quarter hours, like every calendar. */
export const SNAP = 15;
const DAY = 24 * 60;

export const snapMins = (m) => Math.round(m / SNAP) * SNAP;

/**
 * The range two points on the grid sweep out, in minutes from midnight.
 * Direction does not matter — dragging up is the same range as dragging down
 * — and it can never come out shorter than one snap, or a flick of the wrist
 * would make a block with no height.
 */
export function sweep(a, b, { min = SNAP, dayEnd = DAY } = {}) {
  const start = clamp(snapMins(Math.min(a, b)), 0, dayEnd - min);
  const end = clamp(Math.max(snapMins(Math.max(a, b)), start + min), start + min, dayEnd);
  return { start, mins: end - start };
}

/** Minutes between two 'HH:MM' strings — an hour if that makes no sense. */
export function spanBetween(start, end) {
  const s = toMin(start), e = toMin(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 60;
  return e - s;
}

const label = (mins, hour12) =>
  (mins >= DAY ? 'midnight' : fmtTime(fromMin(mins), hour12));

/** Nudge a scroller when the pointer reaches its top or bottom edge. */
export function edgeScroll(scroller, ev, margin = 44) {
  if (!scroller) return;
  const r = scroller.getBoundingClientRect();
  if (ev.clientY < r.top + margin) scroller.scrollTop -= 12;
  else if (ev.clientY > r.bottom - margin) scroller.scrollTop += 12;
}

/**
 * Watch `host` for a press-and-drag over empty grid.
 *
 * only      selector the press must land on exactly — the empty column
 *           itself. Anything drawn in it is something else's to handle.
 * hit(ev)   -> { date, mins, col }: the day pressed, minutes from midnight,
 *           and the positioned element to draw the ghost in
 * origin    minutes the grid starts at (a week grid may open at 07:00)
 * hourH     pixels per hour
 * onPick({ date, start, mins })
 *
 * The date and the column are taken once, at the press: a range that spans
 * two days is not a thing either grid can draw, and following the pointer
 * sideways into tomorrow would silently move the block you are drawing.
 */
export function dragCreate(host, { only, hit, hourH, origin = 0, onPick, edge }) {
  host.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // touch is left alone: the same gesture scrolls the grid, and a calendar
    // you cannot scroll is worse than one you cannot draw on
    if (ev.pointerType === 'touch') return;
    if (only && !ev.target.matches(only)) return;

    const anchor = hit(ev);
    if (!anchor) return;
    const hour12 = state.settings.hour12;
    const startX = ev.clientX, startY = ev.clientY;
    let ghost = null, started = false, pend = null;

    const paint = (e) => {
      const now = hit(e) || anchor;
      const range = sweep(anchor.mins, now.mins);
      pend = { date: anchor.date, start: fromMin(range.start), mins: range.mins };
      if (!ghost) {
        ghost = h('div', { class: 'drop-ghost is-new' }, h('span', { class: 'ghost-t' }));
        anchor.col.append(ghost);
      }
      ghost.style.top = ((range.start - origin) / 60 * hourH) + 'px';
      ghost.style.height = Math.max(11, range.mins / 60 * hourH - 2) + 'px';
      ghost.firstChild.textContent =
        `${label(range.start, hour12)} – ${label(range.start + range.mins, hour12)}`;
    };

    const move = (e) => {
      if (!started) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        started = true;
        host.setPointerCapture?.(e.pointerId);
        document.body.classList.add('is-sweeping');
      }
      // or the browser starts selecting text and the drag reads as a highlight
      e.preventDefault();
      edge?.(e);
      paint(e);
    };

    /**
     * @param {boolean} fire  ask for a name, or drop the range on the floor.
     * A cancelled pointer is not a finished drag — the browser taking the
     * gesture over, or Escape — and putting a dialog up for one would be a
     * prompt nobody asked for.
     */
    const finish = (fire) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('is-sweeping');
      ghost?.remove();
      ghost = null;
      // a press that never moved is a click, and a click on a calendar should
      // not leave anything behind either
      if (fire && started && pend) onPick(pend);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const onKey = (e) => { if (e.key === 'Escape') cancel(); };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
  });
}

const TYPE_LABEL = {
  event: 'Event', meeting: 'Meeting', task: 'Work block', homework: 'Homework'
};

/**
 * Name what goes in the range just swept out. Deliberately small: a title, the
 * times, where it belongs. Everything else is a click away in the panel, and
 * a long form here would be slower than the drag it follows.
 */
export function newBlockPrompt({ date, start, mins }, { onDone } = {}) {
  const hour12 = state.settings.hour12;
  const draft = {
    title: '', type: 'event', areaId: defaultAreaId(),
    start, mins,
    // an input[type=time] cannot hold 24:00, so a range that runs to midnight
    // shows as 23:59 — and keeps its real length unless the field is touched
    end: fromMin(Math.min(toMin(start) + mins, DAY - 1))
  };

  const titleIn = h('input', {
    type: 'text', placeholder: 'Nozzle review, office hours, gym…',
    'aria-label': 'Title',
    oninput: (e) => { draft.title = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }
  });
  const startIn = h('input', {
    type: 'time', value: start, 'aria-label': 'Starts',
    onchange: (e) => {
      draft.start = e.target.value || draft.start;
      draft.mins = spanBetween(draft.start, draft.end);
      span.textContent = fmtDuration(draft.mins);
    }
  });
  const endIn = h('input', {
    type: 'time', value: draft.end, 'aria-label': 'Ends',
    onchange: (e) => {
      draft.end = e.target.value || draft.end;
      draft.mins = spanBetween(draft.start, draft.end);
      span.textContent = fmtDuration(draft.mins);
    }
  });
  const span = h('span', { class: 'eyebrow num' }, fmtDuration(mins));

  // a fresh install has no areas at all, and an empty select reads as broken
  const areaIn = h('select', { 'aria-label': 'Area', onchange: (e) => { draft.areaId = e.target.value; } },
    h('option', { value: '', selected: !draft.areaId }, 'No area'),
    ...AREA_CATEGORIES.map((c) => {
      const mine = areasInCategory(c.id);
      return mine.length
        ? h('optgroup', { label: c.label },
          ...mine.map((a) => h('option', { value: a.id, selected: a.id === draft.areaId }, a.name)))
        : null;
    }));

  const typeIn = h('select', { 'aria-label': 'Kind', onchange: (e) => { draft.type = e.target.value; } },
    ...ITEM_TYPES.map((t) => h('option', { value: t, selected: t === draft.type }, TYPE_LABEL[t] || t)));

  function create() {
    const title = draft.title.trim();
    if (!title) { toast('Give it a name first.'); return; }
    let item;
    commit(() => {
      item = upsertItem({
        title, type: draft.type, areaId: draft.areaId || null,
        plan: { date, start: draft.start, mins: draft.mins },
        estMins: draft.mins
      });
    });
    closeModal();
    pushItem(item.id).catch(() => {});
    toast(`${title} · ${fmtDate(date, { weekday: true })} ${fmtTime(draft.start, hour12)}`,
      { action: 'Edit', onAction: () => openItem(item.id) });
    onDone?.(item);
  }

  modal({
    title: `New block · ${fmtDate(date, { weekday: true })}`,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'field' }, h('label', {}, 'What is it'), titleIn),
      h('div', { class: 'field' },
        h('label', {}, 'When'),
        h('div', { class: 'time-range' }, startIn, h('span', {}, '→'), endIn, span)),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        h('div', { class: 'field' }, h('label', {}, 'Area'), areaIn),
        h('div', { class: 'field' }, h('label', {}, 'Kind'), typeIn))),
    footer: [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: create }, 'Create')
    ]
  });
}
