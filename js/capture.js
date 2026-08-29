// capture.js — write it down now, decide where it goes later.
//
// Enter is the whole point: it must always be the shortest path out, so it
// files to unfiled notes and never asks a question. Everything else — task,
// an area, a task with a time on it — sits one Tab away in the filing row and
// is reachable by mouse just as directly.

import { h, clear, $$ } from './util.js';
import { state, commit, addCard, cardToItem, areasInCategory, AREA_CATEGORIES } from './store.js';
import { toast } from './ui.js';
import { pushItem } from './gcal.js';
import { openItem } from './editor.js';

/**
 * @param {() => void} onChange  re-render the host view after a card is filed
 */
export function captureStrip(onChange) {
  const box = h('textarea', {
    class: 'capture-box', rows: '1', spellcheck: 'true',
    placeholder: 'Write something down — Enter files it to Notes',
    'aria-label': 'Capture a note'
  });

  const row = h('div', { class: 'capture-actions', hidden: true });
  const wrap = h('div', { class: 'capture' }, box, row);

  const text = () => box.value.trim();
  const grow = () => {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 260) + 'px';
  };
  const reset = () => {
    box.value = '';
    grow();
    row.hidden = true;
    closeAreaMenu();
  };

  /* ---- filing ---- */

  const fileUnfiled = () => {
    if (!text()) return;
    const t = text();
    commit(() => addCard(t));
    reset();
    toast('Filed to Notes', { action: 'Open', onAction: () => { location.hash = '#/notes'; } });
    onChange();
  };

  const fileAsItem = (as) => {
    if (!text()) return;
    const t = text();
    let made;
    commit(() => {
      const card = addCard(t);
      made = cardToItem(card.id, { as });
    });
    reset();
    if (as === 'timed') pushItem(made.id).catch(() => {});
    toast(as === 'timed' ? 'Added with a time blocked' : 'Added as a task',
      { action: 'Open', onAction: () => openItem(made.id) });
    onChange();
  };

  const fileToArea = (areaId) => {
    if (!text()) return;
    const t = text();
    commit(() => addCard(t, { areaId }));
    reset();
    toast('Filed to ' + (state.areas.find((a) => a.id === areaId)?.name || 'area'));
    onChange();
  };

  /* ---- the area menu ---- */

  let menu = null;
  const closeAreaMenu = () => { menu?.remove(); menu = null; };

  function openAreaMenu(anchor) {
    if (menu) { closeAreaMenu(); return; }
    const areas = AREA_CATEGORIES.flatMap((c) => areasInCategory(c.id));
    if (!areas.length) { toast('No areas yet — make one first.'); return; }

    const filter = h('input', {
      type: 'text', class: 'area-menu-filter', placeholder: 'Filter…', 'aria-label': 'Filter areas'
    });
    const list = h('div', { class: 'area-menu-list' });
    menu = h('div', { class: 'area-menu' }, filter, list);

    const draw = () => {
      clear(list);
      const q = filter.value.toLowerCase();
      const shown = areas.filter((a) => a.name.toLowerCase().includes(q));
      if (!shown.length) list.append(h('div', { class: 'area-menu-none' }, 'No match'));
      for (const a of shown) {
        list.append(h('button', {
          class: 'area-menu-item', type: 'button',
          onclick: () => { closeAreaMenu(); fileToArea(a.id); }
        },
        h('span', { class: 'dot', style: { background: a.color } }),
        h('span', {}, a.name)));
      }
    };
    draw();

    filter.addEventListener('input', draw);
    menu.addEventListener('keydown', (e) => {
      const items = $$('.area-menu-item', menu);
      const at = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); closeAreaMenu(); anchor.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (items[at + 1] || items[0])?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[at - 1] || filter).focus(); }
      else if (e.key === 'Enter' && document.activeElement === filter) {
        e.preventDefault();
        items[0]?.click();
      }
    });

    anchor.parentElement.append(menu);
    filter.focus();
  }

  document.addEventListener('click', (e) => {
    if (menu && !menu.contains(e.target) && !row.contains(e.target)) closeAreaMenu();
  });

  /* ---- the filing row ---- */

  const areaBtn = h('button', { class: 'btn sm', type: 'button', onclick: (e) => openAreaMenu(e.currentTarget) }, 'Area ▾');
  row.append(
    h('span', { class: 'eyebrow capture-hint' }, 'Enter → Notes'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn sm', type: 'button', onclick: () => fileAsItem('task') }, 'Task'),
    h('div', { style: { position: 'relative' } }, areaBtn),
    h('button', { class: 'btn sm', type: 'button', onclick: () => fileAsItem('timed') }, 'Timed task'));

  /* ---- keys ---- */

  box.addEventListener('input', () => {
    grow();
    row.hidden = !text();
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();          // Shift+Enter still makes a newline
      fileUnfiled();
    } else if (e.key === 'Escape' && text()) {
      e.preventDefault();
      e.stopPropagation();         // don't let the shell close a panel instead
      reset();
    }
  });

  return wrap;
}
