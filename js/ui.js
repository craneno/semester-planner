// ui.js — shared chrome: toasts, modals, the peek panel, pointer drag.

import { h, $, clear, hexAlpha, readableOn, fmtDate, diffDays, today } from './util.js';
import { areaById } from './store.js';

/* ---------------- toasts ---------------- */

export function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const host = $('#toasts');
  const el = h('div', { class: 'toast' }, msg,
    action && h('button', { onclick: () => { onAction?.(); el.remove(); } }, action));
  host.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/* ---------------- modal ---------------- */

let openModal = null;

export function modal({ title, body, footer, onClose, wide = false }) {
  closeModal();
  const scrim = h('div', { class: 'scrim open', onclick: closeModal });
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
  setTimeout(() => el.querySelector('input, textarea, button')?.focus(), 30);
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
    modal({
      title: question,
      body: h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, detail || ''),
      footer: [
        h('button', { class: 'btn', onclick: () => { closeModal(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); resolve(true); } }, confirmLabel)
      ],
      onClose: () => resolve(false)
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

export const TYPE_GLYPH = {
  assignment: '✓', reading: '≡', exam: '★', quiz: '◆', paper: '✎', presentation: '▤',
  meeting: '◷', research: '◎', writing: '✎', admin: '⚙', personal: '○'
};

/* ---------------- pointer drag (works on iOS + Windows) ---------------- */

/**
 * @param {HTMLElement} handle
 * @param {{onStart?:Function, onMove:Function, onEnd:Function, threshold?:number}} cb
 */
export function draggable(handle, cb) {
  const threshold = cb.threshold ?? 5;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    let started = false;

    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!started && Math.hypot(dx, dy) < threshold) return;
      if (!started) {
        started = true;
        handle.setPointerCapture?.(ev.pointerId);
        cb.onStart?.(ev, { startX, startY });
      }
      ev.preventDefault();
      cb.onMove(ev, { dx, dy, startX, startY });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (started) cb.onEnd(ev, { startX, startY });
      else cb.onClick?.(ev);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* keyboard: Escape closes the topmost layer */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openModal) { closeModal(); e.stopPropagation(); return; }
  closePeek();
});
