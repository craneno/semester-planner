// ui.js — shared chrome: toasts, modals, the peek panel, pointer drag.

import { h, $, clear, hexAlpha, fmtDate, diffDays, today } from './util.js';
import { areaById } from './store.js';

/* ---------------- the sidebar swipe ----------------
   Where the menu should be while a finger drags it. Pure, so it can be
   tested without a finger. `job` is what the swipe is for — 'open' starts
   with the menu parked off-screen, 'close' with it in place — `dx` how far
   the finger has moved since it landed, `w` the menu's width. */

/** @returns {{x:number, t:number}} x in px from its open place (0 open, -w closed); t 0..1 how much is showing */
export function navSlide(job, dx, w) {
  if (!w) return { x: 0, t: 0 };
  const from = job === 'open' ? -w : 0;
  const x = Math.max(-w, Math.min(0, from + dx));
  return { x, t: 1 + x / w };
}

/** Where it should end up when the finger lifts: past halfway, or a flick past `min`. */
export function navSettle(job, dx, w, min) {
  const { t } = navSlide(job, dx, w);
  if (job === 'open') return dx > min || t > 0.5;
  return !(dx < -min || t < 0.5);
}

/* ---------------- toasts ---------------- */

/** How many may stand at once: past this the oldest goes, or eight quick adds
 *  in a row wall off the page behind them. */
const TOASTS_MAX = 3;

export function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const host = $('#toasts');
  // the same words twice are one toast, said again
  for (const old of host.querySelectorAll('.toast')) if (old.dataset.msg === msg) old.remove();
  while (host.children.length >= TOASTS_MAX) host.firstElementChild.remove();
  const el = h('div', { class: 'toast', dataset: { msg } }, msg,
    action && h('button', { onclick: () => { onAction?.(); el.remove(); } }, action));
  host.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/* ---------------- modal ---------------- */

let openModal = null;

/** A click on the scrim this soon after opening is the one the browser makes
 *  of the tap that opened the dialog, and is not an answer to it. */
const SCRIM_GRACE_MS = 400;

export function modal({ title, body, footer, onClose, wide = false }) {
  closeModal();
  const openedAt = Date.now();
  const scrim = h('div', { class: 'scrim open', onclick: () => { if (Date.now() - openedAt > SCRIM_GRACE_MS) closeModal(); } });
  const el = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-h' },
      h('h2', {}, title),
      h('div', { class: 'spacer', style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: closeModal, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'modal-b' }, body),
    footer && h('div', { class: 'modal-f' }, footer));
  if (wide) el.style.width = 'min(900px, calc(100vw - 24px))';
  document.body.append(scrim, el);
  openModal = { el, scrim, onClose };
  // the first control in the body, else the first button in the footer. The
  // header's ✕ is first in the DOM, and focused there, Enter closed the
  // dialog and typing went nowhere.
  setTimeout(() => {
    if (openModal?.el !== el) return;
    el.querySelector('.modal-b input, .modal-b textarea, .modal-b select, .modal-b button, .modal-f button')?.focus();
  }, 30);
  return el;
}

export function closeModal() {
  if (!openModal) return;
  openModal.el.remove();
  openModal.scrim.remove();
  openModal.onClose?.();
  openModal = null;
}

export function confirmDialog(question, detail, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    // Every path out of the dialog — button, ✕, scrim, Escape — ends in
    // closeModal(), which fires onClose. So the buttons only latch an answer
    // and onClose is the single place that settles the promise. Resolving in
    // the button handler too would settle false first and lose the answer.
    let answer = false;
    modal({
      title: question,
      body: h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, detail || ''),
      footer: [
        h('button', { class: 'btn', onclick: () => { answer = false; closeModal(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { answer = true; closeModal(); } }, confirmLabel)
      ],
      onClose: () => resolve(answer)
    });
  });
}

/* ---------------- peek panel ---------------- */

let peekCloser = null;

export function peek(node, { onClose } = {}) {
  const panel = $('#peek');
  const scrim = $('#peek-scrim');
  clear(panel).append(node);
  panel.classList.add('open');
  scrim.classList.add('open');
  peekCloser = onClose;
  document.body.style.overflow = 'hidden';
}

export function closePeek() {
  const panel = $('#peek'), scrim = $('#peek-scrim');
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  scrim.classList.remove('open');
  document.body.style.overflow = '';
  peekCloser?.();
  peekCloser = null;
  setTimeout(() => { if (!panel.classList.contains('open')) clear(panel); }, 240);
}

/* ---------------- item chrome ---------------- */

/** Trailing chips in a .row live in one cell so the grid can't spill onto a second line. */
export function meta(...children) {
  return h('span', { class: 'meta' }, ...children.filter(Boolean));
}

export function areaTag(areaId) {
  const a = areaById(areaId);
  if (!a) return h('span', { class: 'tag' }, 'Unassigned');
  return h('span', {
    class: 'tag area',
    style: { '--tag-bg': hexAlpha(a.color, 0.14), '--tag-fg': a.color }
  }, a.name);
}

export function dueChip(item) {
  if (!item.due) return h('span', { class: 'due', style: { color: 'var(--ink-3)' } }, '—');
  const d = diffDays(today(), item.due);
  const cls = item.done ? '' : d < 0 ? 'late' : d <= 2 ? 'soon' : '';
  let label = fmtDate(item.due);
  if (!item.done) {
    if (d === 0) label = 'Today';
    else if (d === 1) label = 'Tomorrow';
    else if (d < 0) label = `${fmtDate(item.due)} · ${-d}d late`;
  }
  return h('span', { class: `due ${cls}` }, label);
}

export const priorityTag = (p) =>
  p === 'high' ? h('span', { class: 'tag flag-high' }, 'High')
    : p === 'low' ? h('span', { class: 'tag flag-low' }, 'Low')
      : null;

/* ---------------- pointer drag (works on iOS + Windows) ---------------- */

/** A finger must rest this long on a `hold` handle before it has hold of it. */
export const DRAG_HOLD_MS = 400;

/**
 * @param {HTMLElement} handle
 * @param {{onStart?:Function, onMove:Function, onEnd:Function, onCancel?:Function,
 *          onClick?:Function, threshold?:number, hold?:boolean}} cb
 *
 * A drag the browser takes back (pointercancel) or the user gives up (Escape)
 * is not a drop: `onCancel` gets it, or `onEnd` when there is none — the
 * callers that reorder a list are safe either way, since nothing moved.
 *
 * `hold`: on touch, wait DRAG_HOLD_MS before the drag begins, and hand the
 * gesture back to the scroller if the finger moves first — a chip in a
 * horizontal tray is swiped past far more often than it is picked up.
 */
export function draggable(handle, cb) {
  const threshold = cb.threshold ?? 5;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const waits = cb.hold && e.pointerType === 'touch';
    let started = false, hold = null, at = e;

    const begin = (ev) => {
      started = true;
      handle.setPointerCapture?.(ev.pointerId);
      cb.onStart?.(ev, { startX, startY });
    };
    // once the hold is out the gesture is ours, not the scroller's
    const keepGesture = (ev) => { if (started && ev.cancelable) ev.preventDefault(); };

    const move = (ev) => {
      at = ev;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!started) {
        if (waits) { if (Math.hypot(dx, dy) >= 8) finish(null); return; }
        if (Math.hypot(dx, dy) < threshold) return;
        begin(ev);
      }
      ev.preventDefault();
      cb.onMove(ev, { dx, dy, startX, startY });
    };
    const finish = (how) => {
      clearTimeout(hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchmove', keepGesture);
      if (!started) { if (how === 'drop') cb.onClick?.(at); return; }
      if (how === 'drop') cb.onEnd(at, { startX, startY });
      else (cb.onCancel || cb.onEnd)(at, { startX, startY, cancelled: true });
    };
    const up = (ev) => { at = ev; finish('drop'); };
    const cancel = (ev) => { at = ev; finish(null); };
    const onKey = (ev) => { if (ev.key === 'Escape') finish(null); };

    if (waits) {
      window.addEventListener('touchmove', keepGesture, { passive: false });
      hold = setTimeout(() => { navigator.vibrate?.(8); begin(at); cb.onMove(at, { dx: 0, dy: 0, startX, startY }); }, DRAG_HOLD_MS);
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
  });
}

/**
 * Drag-to-reorder a vertical list.
 *
 * Reorders the real nodes as the pointer passes each neighbour's midpoint,
 * rather than animating a floating copy — the list is the preview, so there is
 * no ghost element to keep in sync and no measurement to invalidate.
 *
 * Each item must carry `data-reorder-id` and contain the handle.
 *
 * @param {HTMLElement} container
 * @param {{handle: string, onDrop: (ids: string[]) => void}} opts
 */
export function reorderable(container, { handle, onDrop }) {
  const items = () => Array.from(container.querySelectorAll('[data-reorder-id]'))
    .filter((el) => el.parentElement === container);

  for (const el of items()) {
    const grip = el.querySelector(handle);
    if (!grip) continue;
    grip.setAttribute('title', 'Drag to reorder');
    // without this the browser starts a text selection on mousedown and the
    // drag reads as a highlight instead
    grip.addEventListener('pointerdown', (e) => e.preventDefault());

    let startOrder = null;
    draggable(grip, {
      threshold: 4,
      onStart: () => {
        startOrder = items().map((x) => x.dataset.reorderId);
        el.classList.add('is-dragging');
        document.body.classList.add('is-reordering');
      },
      onMove: (ev) => {
        const y = ev.clientY;
        for (const other of items()) {
          if (other === el) continue;
          const r = other.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          // moving up past the midpoint of the one above, or down past the one below
          if (y < mid && other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
            container.insertBefore(el, other);
            break;
          }
          if (y > mid && other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) {
            container.insertBefore(el, other.nextSibling);
            break;
          }
        }
      },
      onEnd: () => {
        el.classList.remove('is-dragging');
        document.body.classList.remove('is-reordering');
        const now = items().map((x) => x.dataset.reorderId);
        if (startOrder && now.join() !== startOrder.join()) onDrop(now);
      }
    });
  }
}

/** Whether a dialog is up — the key handlers ask before they act on a key. */
export const modalOpen = () => !!openModal;

/* keyboard: Escape closes the topmost layer, and only that one. The other
   listeners on window still run after stopPropagation(), and app.js's closed
   the panel under a confirm along with the confirm. */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openModal) { closeModal(); e.stopImmediatePropagation(); return; }
  closePeek();
});
