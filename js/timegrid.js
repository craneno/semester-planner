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

/* ---------------- two things at once ----------------
   Blocks are placed by time alone, so anything sharing an hour lands on top of
   whatever was appended first — the 9:30 that hides behind the 8:45. Every
   calendar answers the same way: the ones that overlap share the width. */

/** How far a block reaches under the one to its right, as a share of a column.
 *  Not zero: the titles are left-aligned, so a block whose left edge shows is
 *  still readable, and the extra width is what makes a lone neighbour on a
 *  phone worth tapping. */
export const LAP = 0.25;

/**
 * Side-by-side geometry for blocks that overlap, as fractions of the column.
 *
 * Pure arithmetic on `{start, mins}` — no DOM, no CSS — so the width a block
 * gets is testable without a grid to hang it in. Blocks are grouped into
 * clusters of things that actually touch, and only a cluster is split: a lone
 * afternoon block stays full width however busy the morning was.
 *
 * @param {Array<{start:number, mins:number}>} blocks minutes from midnight
 * @returns {Array<{x:number, w:number, z:number}>} one per block, in the order
 *   given: `x` the left edge and `w` the width, both 0..1 of the column, and
 *   `z` the stacking order — later columns draw over the tail of earlier ones.
 */
export function packBlocks(blocks) {
  const out = blocks.map(() => ({ x: 0, w: 1, z: 0 }));
  const spans = blocks.map((b, i) => {
    const start = Number.isFinite(b.start) ? b.start : 0;
    return { i, start, end: start + Math.max(1, b.mins || 0) };
  });
  // earliest first, and the longer of two that start together first: a block
  // that spans the cluster belongs in the left column, not squeezed at the end
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.i - b.i);

  let cluster = [];          // the blocks currently overlapping
  let ends = [];             // where each column is free again
  const flush = () => {
    const cols = ends.length;
    for (const { i, col } of cluster) {
      out[i] = {
        x: col / cols,
        // all but the last column run on under their neighbour
        w: (1 / cols) * (col === cols - 1 ? 1 : 1 + LAP),
        z: col
      };
    }
    cluster = []; ends = [];
  };

  for (const s of spans) {
    // a gap with nothing running through it ends the cluster, and the next one
    // starts again at full width
    if (ends.length && s.start >= Math.max(...ends)) flush();
    let col = ends.findIndex((e) => e <= s.start);
    if (col < 0) { col = ends.length; ends.push(s.end); }
    else ends[col] = Math.max(ends[col], s.end);
    cluster.push({ i: s.i, col });
  }
  if (cluster.length) flush();
  return out;
}

/** Write a pack onto the blocks it was worked out for, in the same order. */
export function applyLanes(els, lanes) {
  lanes.forEach((lane, i) => {
    const el = els[i];
    if (!el) return;
    el.style.setProperty('--lane-x', lane.x);
    el.style.setProperty('--lane-w', lane.w);
    el.style.setProperty('--lane-z', lane.z);
    // narrower than half a column and a short block can show the time or the
    // title, not both — and which of the two is wanted is never in doubt: the
    // grid already says when it is
    el.classList.toggle('narrow', lane.w < 0.5);
  });
}

const label = (mins, hour12) =>
  (mins >= DAY ? 'midnight' : fmtTime(fromMin(mins), hour12));

/* ---------------- moving and resizing a block ----------------
   The other half of the calendar gesture: take hold of a block that is already
   there. The middle moves it, the top and bottom edges stretch it — the same
   three targets every calendar has, and the reason a block needs no handles
   drawn on it. */

/** How deep the resize zones at the top and bottom of a block reach, in px. */
export const EDGE = 8;

/** How long a finger must rest on a block before it has hold of it. */
export const HOLD_MS = 400;
/** How far it may stray in that time and still be a press rather than a scroll. */
export const HOLD_SLOP = 8;

/**
 * Which part of a block the pointer has hold of.
 *
 * The zones shrink with the block, and the middle always keeps a third: on a
 * quarter-hour block two 8px edges would leave nothing to move it by, and a
 * calendar where short things can only be resized is worse than one where
 * they cannot be resized at all.
 */
export function grabMode(rect, clientY, edge = EDGE) {
  const zone = Math.min(edge, Math.floor(rect.height / 3));
  if (zone < 1) return 'move';
  if (clientY - rect.top < zone) return 'top';
  if (rect.bottom - clientY < zone) return 'bottom';
  return 'move';
}

/**
 * Where a block lands when it is carried to `mins`.
 *
 * `mins` is already the would-be start — the caller subtracts wherever in the
 * block it was picked up, so a block grabbed by its middle keeps that grip
 * instead of snapping its top under the pointer.
 */
export function moveBlock(mins, dur, { dayEnd = DAY } = {}) {
  return { start: clamp(snapMins(mins), 0, Math.max(0, dayEnd - dur)), mins: dur };
}

/** The top edge moves the start; the end stays where it was put. */
export function resizeTop(startMin, dur, mins, { min = SNAP } = {}) {
  const end = startMin + dur;
  const start = clamp(snapMins(mins), 0, end - min);
  return { start, mins: end - start };
}

/** The bottom edge moves the end; the start stays where it was put. */
export function resizeBottom(startMin, mins, { min = SNAP, dayEnd = DAY } = {}) {
  const end = clamp(snapMins(mins), startMin + min, dayEnd);
  return { start: startMin, mins: end - startMin };
}

/**
 * Wire one block for dragging.
 *
 * plan      { date, start, mins } as drawn — read once, since a re-render
 *           replaces the element anyway
 * hit(ev)   -> { date, mins, col }, the same hit test `dragCreate` uses. A
 *           move follows it wherever it goes, so a grid whose `hit` can name
 *           another day lets a block cross to it and one that cannot, will not
 * onDrop({ date, start, mins })   — only when something actually changed
 * onClick() — a press that never moved is a click, and must open the thing
 *
 * A resize stays in the block's own column whatever the pointer does
 * sideways: dragging an end into tomorrow is not a thing a day grid can draw.
 *
 * A finger has no hover and no second button, so it says which of the two it
 * means by waiting: a tap opens the block, a press held still for `HOLD_MS`
 * picks it up. Until the hold is out the gesture still belongs to the
 * scroller, and any real movement hands it back — you cannot pick up a block
 * you were only scrolling past.
 */
export function dragBlock(el, plan, { hit, hourH, origin = 0, edge, onDrop, onClick, dayEnd = DAY }) {
  const startMin = toMin(plan.start);

  /* The click is the block's, not the browser's. One is fired after every
     drag, and a block with its own `onclick` would open the panel each time
     something was moved. So the listener lives here and a finished drag eats
     the click that follows it — which is also what lets a *tap* open the
     panel on a phone, where there is no drag to own it. */
  let dragged = false;
  el.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    onClick?.();
  });

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // a fresh press: whatever the last drag left behind is spent, and a flag
    // still standing because no click followed must not eat this one
    dragged = false;
    const anchor = hit(ev);
    if (!anchor) return;

    const touch = ev.pointerType === 'touch';
    // An 8px edge is a mouse's precision, not a finger's, and a block picked up
    // by mistake at its top edge stretches instead of moving. A finger always
    // moves; the panel is where a time gets typed.
    const mode = touch ? 'move' : grabMode(el.getBoundingClientRect(), ev.clientY);
    // where in the block it was taken hold of, kept for the whole drag
    const grab = anchor.mins - startMin;
    const hour12 = state.settings.hour12;
    const startX = ev.clientX, startY = ev.clientY;
    let ghost = null, started = false, pend = null, at = ev, hold = null;

    const paint = (e) => {
      const now = hit(e) || anchor;
      let range, col, date;
      if (mode === 'move') {
        range = moveBlock(now.mins - grab, plan.mins, { dayEnd });
        col = now.col;
        date = now.date;
      } else {
        range = mode === 'top'
          ? resizeTop(startMin, plan.mins, now.mins)
          : resizeBottom(startMin, now.mins, { dayEnd });
        col = el.parentElement;
        date = plan.date;
      }
      pend = { date, start: fromMin(range.start), mins: range.mins };
      if (!ghost) ghost = h('div', { class: 'drop-ghost is-new' }, h('span', { class: 'ghost-t' }));
      if (ghost.parentElement !== col) col.append(ghost);
      ghost.style.top = ((range.start - origin) / 60 * hourH) + 'px';
      ghost.style.height = Math.max(11, range.mins / 60 * hourH - 2) + 'px';
      ghost.firstChild.textContent =
        `${label(range.start, hour12)} – ${label(range.start + range.mins, hour12)}`;
    };

    const begin = () => {
      started = true;
      // a synthetic pointer has none active to capture; the drag still works
      try { el.setPointerCapture(ev.pointerId); } catch { /* not a live pointer */ }
      el.classList.add('dragging');
      document.body.classList.add(mode === 'move' ? 'is-moving' : 'is-sweeping');
      paint(at);            // the block is under the finger before it has moved
    };

    /* Once the hold is out the gesture is ours, and this is what stops the
       browser taking it back as a pan. `touch-action` on the block leaves
       scrolling alone until this point, so the grid still scrolls under a
       finger that came down on a block and kept going. */
    const keepGesture = (e) => { if (started && e.cancelable) e.preventDefault(); };
    const noMenu = (e) => e.preventDefault();

    if (touch) {
      window.addEventListener('touchmove', keepGesture, { passive: false });
      el.addEventListener('contextmenu', noMenu);
      hold = setTimeout(() => {
        hold = null;
        navigator.vibrate?.(8);      // ignored where it is not supported
        begin();
      }, HOLD_MS);
    }

    const move = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      at = e;
      if (!started) {
        const far = Math.hypot(e.clientX - startX, e.clientY - startY);
        // a finger that moves before the hold is out was scrolling past
        if (touch) { if (far >= HOLD_SLOP) finish(false); return; }
        if (far < 4) return;
        begin();
      }
      e.preventDefault();
      edge?.(e);
      paint(e);
    };

    const finish = (fire) => {
      clearTimeout(hold);
      hold = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchmove', keepGesture);
      el.removeEventListener('contextmenu', noMenu);
      document.body.classList.remove('is-moving', 'is-sweeping');
      el.classList.remove('dragging');
      ghost?.remove();
      ghost = null;
      // a press that never moved is a click, and the click listener has it
      if (!started) return;
      dragged = true;
      // a block put back exactly where it was is not an edit, and committing
      // one would stamp updatedAt and push it to Google for nothing
      const same = fire && pend
        && pend.date === plan.date && pend.start === plan.start && pend.mins === plan.mins;
      if (fire && pend && !same) onDrop?.(pend);
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
