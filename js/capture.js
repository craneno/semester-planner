// capture.js — write it down now, decide where it goes later, in one place.
//
// Enter is the whole point: it must always be the shortest path out, so it
// saves an unfiled note and never asks a question. Everything else — task,
// an area, a task with a time on it — sits one Tab away in the filing row and
// is reachable by mouse just as directly.
//
// The queue of things not yet filed lives here too, and renders directly under
// the box on Overview. It used to be a Notes page of its own, but once filed
// notes started showing on their area's page that page held nothing but this
// list, and a whole tab for it only made the sidebar taller.

import { h, clear, $$, fmtDate } from './util.js';
import {
  state, commit, addCard, cardToItem, updateCard, deleteCard, unfiledCards,
  unfiledLinks, updateLink, deleteLink, areaById, areasInCategory, AREA_CATEGORIES
} from './store.js';
import { toast, confirmDialog, modal, closeModal } from './ui.js';
import { pushItem } from './gcal.js';
import { openItem } from './editor.js';

/**
 * @param {() => void} onChange  re-render the host view after a card is filed
 */
export function captureStrip(onChange) {
  const box = h('textarea', {
    class: 'capture-box', rows: '1', spellcheck: 'true',
    placeholder: 'Write something down — Enter saves it below',
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
    toast('Saved — file it below whenever you like');
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
  // on the document only while the menu is up: one left on every draw of
  // Overview stayed for the life of the page, and there were soon dozens
  const clickAway = (e) => {
    if (menu && !menu.contains(e.target) && !row.contains(e.target)) closeAreaMenu();
  };
  const closeAreaMenu = () => {
    menu?.remove(); menu = null;
    document.removeEventListener('click', clickAway);
  };

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
    // after this click has finished, or the one that opened it closes it
    setTimeout(() => { if (menu) document.addEventListener('click', clickAway); }, 0);
  }

  /* ---- the filing row ---- */

  const areaBtn = h('button', { class: 'btn sm', type: 'button', onclick: (e) => openAreaMenu(e.currentTarget) }, 'Area ▾');
  row.append(
    h('span', { class: 'eyebrow capture-hint' }, 'Enter → unfiled'),
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

/* ---------------- the unfiled queue ----------------
   Everything captured and not yet given a home, rendered under the box it was
   typed into. Filed notes are not here: they show on their area's own page,
   which is where you go looking for them. */

export function unfiledQueue(onChange, go) {
  const cards = unfiledCards();
  const loose = unfiledLinks();
  const host = h('div', { class: 'unfiled' });
  if (!cards.length && !loose.length) return host;

  if (cards.length) {
    host.append(group('Unfiled', cards.length));
    for (const c of cards) host.append(noteCard(c, onChange));
  }

  // A link normally lands in an area. One only gets here if its area was
  // deleted out from under it, or there was no personal area to default to.
  if (loose.length) {
    host.append(group('Links with no home', loose.length));
    for (const l of loose) host.append(looseLinkRow(l, onChange, go));
  }
  return host;
}

const group = (label, n, color) => h('div', { class: 'group-h' },
  color ? h('span', { class: 'dot', style: { background: color } }) : null,
  h('h2', {}, label),
  h('span', { class: 'eyebrow num' }, String(n)));

/** One captured note with everything you can do to it. Exported because an
 *  area's page shows its own notes, and they must be as editable there as they
 *  are in the queue — there is no Notes page to fall back to any more. */
export function noteCard(card, onChange) {
  const area = areaById(card.areaId);

  const body = h('div', {
    class: 'card-text', contenteditable: 'true', spellcheck: 'true',
    onblur: (e) => {
      const next = e.target.textContent.trim();
      if (next && next !== card.text) commit(() => updateCard(card.id, { text: next }));
      else if (!next) e.target.textContent = card.text;
    },
    onkeydown: (e) => { if (e.key === 'Escape') e.target.blur(); }
  }, card.text);

  const toTask = (as) => {
    let made;
    commit(() => { made = cardToItem(card.id, { as }); });
    if (as === 'timed') pushItem(made.id).catch(() => {});
    toast(as === 'timed' ? 'Now a task with a time blocked' : 'Now a task',
      { action: 'Open', onAction: () => openItem(made.id) });
    onChange();
  };

  return h('article', { class: 'note-card' },
    body,
    h('div', { class: 'note-foot' },
      h('span', { class: 'eyebrow num' }, fmtDate(card.createdAt.slice(0, 10))),
      area ? h('span', { class: 'tag area', style: { '--tag-bg': 'var(--rule-soft)', '--tag-fg': area.color } }, area.name) : null,
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn sm ghost', onclick: () => toTask('task') }, 'Task'),
      h('button', { class: 'btn sm ghost', onclick: () => toTask('timed') }, 'Timed task'),
      h('button', { class: 'btn sm ghost', onclick: () => pickArea(card, onChange) }, area ? 'Move' : 'File'),
      h('button', {
        class: 'btn sm ghost', 'aria-label': 'Delete note',
        onclick: async () => {
          if (await confirmDialog('Delete this note?', card.text.slice(0, 120), 'Delete')) {
            commit(() => deleteCard(card.id));
            onChange();
          }
        }
      }, '✕')));
}

function pickArea(card, onChange) {
  const list = h('div', { class: 'area-menu-list', style: { maxHeight: '320px' } });
  const choose = (areaId) => {
    commit(() => updateCard(card.id, { areaId }));
    closeModal();
    onChange();
  };

  if (card.areaId) {
    list.append(h('button', { class: 'area-menu-item', onclick: () => choose(null) },
      h('span', { class: 'dot', style: { background: 'var(--ink-3)' } }),
      h('span', {}, 'Unfiled')));
  }
  for (const cat of AREA_CATEGORIES) {
    for (const a of areasInCategory(cat.id)) {
      if (a.id === card.areaId) continue;
      list.append(h('button', { class: 'area-menu-item', onclick: () => choose(a.id) },
        h('span', { class: 'dot', style: { background: a.color } }),
        h('span', {}, a.name),
        h('span', { class: 'eyebrow', style: { marginLeft: 'auto' } }, cat.label)));
    }
  }

  modal({
    title: 'File this note',
    body: list,
    footer: [h('button', { class: 'btn', onclick: closeModal }, 'Cancel')]
  });
}

function looseLinkRow(l, onChange, go) {
  return h('div', { class: 'row link-row' },
    h('a', {
      class: 'title link-title', href: l.url, title: l.url,
      target: '_blank', rel: 'noopener noreferrer'
    }, l.title),
    h('select', {
      'aria-label': `File ${l.title}`,
      onchange: (e) => {
        if (!e.target.value) return;
        commit(() => updateLink(l.id, { areaId: e.target.value }));
        onChange();
      }
    },
    h('option', { value: '' }, 'File it…'),
    ...AREA_CATEGORIES.flatMap((cat) => areasInCategory(cat.id)
      .map((a) => h('option', { value: a.id }, `${cat.label} · ${a.name}`)))),
    h('button', {
      class: 'btn sm ghost', 'aria-label': `Remove ${l.title}`,
      onclick: async () => {
        if (await confirmDialog('Remove this link?', l.title, 'Remove')) {
          commit(() => deleteLink(l.id));
          onChange();
        }
      }
    }, '✕'));
}
