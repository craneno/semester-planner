// views/notes.js — everything captured, and the one place to decide where it goes.

import { h, clear, fmtDate } from '../util.js';
import {
  state, commit, updateCard, deleteCard, cardToItem, unfiledCards, cardsForArea,
  areasInCategory, areaById, AREA_CATEGORIES
} from '../store.js';
import { toast, confirmDialog, modal, closeModal } from '../ui.js';
import { openItem } from '../editor.js';
import { captureStrip } from '../capture.js';
import { pushItem } from '../gcal.js';

export function renderNotes(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const unfiled = unfiledCards();

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('h1', {}, 'Notes'),
      h('div', { class: 'eyebrow' },
        unfiled.length ? `${unfiled.length} unfiled` : 'Nothing waiting')),
    h('div', { style: { flex: 1 } })));

  pad.append(captureStrip(navigate));

  if (!state.cards.length) {
    pad.append(h('div', { class: 'empty', style: { marginTop: '20px' } },
      h('h3', {}, 'Nothing captured yet'),
      h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
        'Write in the box above, or on Overview, and press Enter. Decide where it belongs later.')));
    root.append(pad);
    return;
  }

  if (unfiled.length) {
    pad.append(group('Unfiled', unfiled.length));
    for (const c of unfiled) pad.append(cardRow(c, navigate, go));
  }

  // then whatever has been filed to an area, in sidebar order
  for (const cat of AREA_CATEGORIES) {
    for (const a of areasInCategory(cat.id)) {
      const mine = cardsForArea(a.id);
      if (!mine.length) continue;
      pad.append(group(a.name, mine.length, a.color));
      for (const c of mine) pad.append(cardRow(c, navigate, go));
    }
  }

  root.append(pad);
}

const group = (label, n, color) => h('div', { class: 'group-h' },
  color ? h('span', { class: 'dot', style: { background: color } }) : null,
  h('h2', {}, label),
  h('span', { class: 'eyebrow num' }, String(n)));

function cardRow(card, navigate, go) {
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
    navigate();
  };

  return h('article', { class: 'note-card' },
    body,
    h('div', { class: 'note-foot' },
      h('span', { class: 'eyebrow num' }, fmtDate(card.createdAt.slice(0, 10))),
      area ? h('span', { class: 'tag area', style: { '--tag-bg': 'var(--rule-soft)', '--tag-fg': area.color } }, area.name) : null,
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn sm ghost', onclick: () => toTask('task') }, 'Task'),
      h('button', { class: 'btn sm ghost', onclick: () => toTask('timed') }, 'Timed task'),
      h('button', { class: 'btn sm ghost', onclick: () => pickArea(card, navigate) }, area ? 'Move' : 'File'),
      h('button', {
        class: 'btn sm ghost', 'aria-label': 'Delete note',
        onclick: async () => {
          if (await confirmDialog('Delete this note?', card.text.slice(0, 120), 'Delete')) {
            commit(() => deleteCard(card.id));
            navigate();
          }
        }
      }, '✕')));
}

function pickArea(card, navigate) {
  const list = h('div', { class: 'area-menu-list', style: { maxHeight: '320px' } });
  const choose = (areaId) => {
    commit(() => updateCard(card.id, { areaId }));
    closeModal();
    navigate();
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
