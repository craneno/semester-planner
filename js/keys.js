// keys.js — the keyboard. One key each, none while typing, none with a
// modifier (those are the browser's); `?` lists them. Wired once by app.js.

import { h, $, today } from './util.js';
import { undo, redo } from './store.js';
import { toast, closePeek, closeModal, modalOpen, modal } from './ui.js';
import { openSearch } from './search.js';
import { showWeekOf } from './views/week.js';

/* One key each. None fire while typing, and none need a modifier — the
   modifier keys are the browser's. `?` lists them. */
const KEYS = [
  ['n', 'New — the quick add box'],
  ['/', 'Find a task, note, card or link'],
  ['t', 'Today — this week on Week, Overview elsewhere'],
  ['← →', 'Last week, next week (on Week)'],
  ['1 2 3', 'Overview, Semester, Week'],
  ['Ctrl+Z', 'Undo the last change — Ctrl+Shift+Z or Ctrl+Y redoes'],
  ['Esc', 'Close the panel'],
  ['?', 'This list']
];

/**
 * @param {{ go: (key: string) => void, navigate: () => void, onWeek: () => boolean, views: string[], showDay: (date: string) => void }} deps
 *   onWeek says whether the Week page is up (t and the arrows mean something else there);
 *   views are the pages 1 2 3 go to, in order.
 */
export function wireKeys({ go, navigate, onWeek, views, showDay }) {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
    // Ctrl+Z outside a box is the app's undo; inside one it is the browser's
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      const back = e.key.toLowerCase() === 'z' && !e.shiftKey;
      const label = back ? undo() : redo();
      if (!label) toast(back ? 'Nothing to undo.' : 'Nothing to redo.');
      else toast(`${back ? 'Undone' : 'Redone'}: ${label}.`, { action: back ? 'Redo' : 'Undo', onAction: () => (back ? redo() : undo()) });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { closePeek(); closeModal(); return; }
    // a dialog has the keyboard: `/` on a confirm's button must not swap it for the search
    if (typing || modalOpen()) return;
    switch (e.key) {
      case 'n': e.preventDefault(); $('#quickadd-input').focus(); return;
      case '/': e.preventDefault(); openSearch({ go, showDay }); return;
      case 't':
        if (onWeek()) { showWeekOf(today()); navigate(); }
        else go('overview');
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onWeek()) {
          e.preventDefault();
          $(`.weekbar [aria-label="${e.key === 'ArrowLeft' ? 'Previous' : 'Next'} week"]`)?.click();
        }
        return;
      case '?':
        modal({
          title: 'Keys',
          body: h('div', { class: 'keys' },
            ...KEYS.flatMap(([k, what]) => [h('kbd', {}, k), h('span', {}, what)]))
        });
        return;
      default: {
        const i = +e.key - 1;
        if (i >= 0 && i < views.length) go(views[i]);
      }
    }
  });
}
