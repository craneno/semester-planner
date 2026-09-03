// search.js — find a thing by a word of it.
//
// Tasks, notes, cards, links and areas, in one box, opened with `/`. Plain
// substring matching, a title that starts with the words ahead of one that
// merely contains them, a few of each kind. Enter opens the first hit.

import { state, areaById } from './store.js';
import { modal, closeModal, areaTag, dueChip } from './ui.js';
import { h, clear, fmtDate, debounce } from './util.js';
import { openItem } from './editor.js';

const CAP = 8;
const norm = (s) => String(s || '').toLowerCase();

/** 0 when the text starts with the query, 1 when it contains it, -1 when not. */
function rank(text, q) {
  const t = norm(text);
  if (!t.includes(q)) return -1;
  return t.startsWith(q) || new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t) ? 0 : 1;
}

/** A short stretch of `text` around the first hit. */
function snippet(text, q, width = 70) {
  const t = String(text || '');
  const i = norm(t).indexOf(q);
  if (i < 0) return t.slice(0, width);
  const from = Math.max(0, i - Math.floor(width / 3));
  const s = t.slice(from, from + width).replace(/\s+/g, ' ');
  return (from > 0 ? '…' : '') + s + (from + width < t.length ? '…' : '');
}

const NOTE_FIELDS = ['focus', 'text', 'tomorrow'];

/** Everything that matches, grouped and ranked. Pure: takes the state. */
export function findAll(query, s = state) {
  const q = norm(query).trim();
  if (!q) return [];
  const pick = (list) => list
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, CAP);

  const groups = [];

  const items = pick(s.items.map((t) => ({ rank: rank(t.title, q), item: t })));
  if (items.length) groups.push({ label: 'Tasks', kind: 'item', hits: items });

  const areas = pick(s.areas.filter((a) => !a.archived).map((a) => ({ rank: rank(a.name, q), area: a })));
  if (areas.length) groups.push({ label: 'Areas', kind: 'area', hits: areas });

  const notes = [];
  for (const [date, n] of Object.entries(s.notes)) {
    const fields = [
      ...NOTE_FIELDS.map((k) => [k, n[k]]),
      ...(Array.isArray(n.top3) ? n.top3.map((x, i) => [`top ${i + 1}`, x]) : []),
      ...Object.entries(n.journal || {}).map(([areaId, text]) => [areaById(areaId)?.name || 'journal', text])
    ];
    for (const [field, text] of fields) {
      const r = rank(text, q);
      if (r >= 0) { notes.push({ rank: r, date, field, text }); break; }
    }
  }
  const noteHits = pick(notes.sort((a, b) => (a.date < b.date ? 1 : -1)));
  if (noteHits.length) groups.push({ label: 'Notes', kind: 'note', hits: noteHits });

  const cards = pick(s.cards.map((c) => ({ rank: rank(c.text, q), card: c })));
  if (cards.length) groups.push({ label: 'Cards', kind: 'card', hits: cards });

  const links = pick(s.links.map((l) => ({ rank: Math.max(rank(l.title, q), rank(l.url, q)), link: l })));
  if (links.length) groups.push({ label: 'Links', kind: 'link', hits: links });

  return groups;
}

/* ---------------- the box ---------------- */

export function openSearch({ go, showDay } = {}) {
  const input = h('input', {
    class: 'search-input', type: 'search', placeholder: 'Find a task, a note, a link…',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search'
  });
  const results = h('div', { class: 'search-results' });
  let first = null;

  const open = (hit, kind) => {
    closeModal();
    if (kind === 'item') openItem(hit.item.id);
    else if (kind === 'area') go?.(`area/${hit.area.id}`);
    else if (kind === 'note') showDay?.(hit.date);
    else if (kind === 'card') go?.(hit.card.areaId ? `area/${hit.card.areaId}` : 'overview');
    else if (kind === 'link') window.open(hit.link.url, '_blank', 'noopener');
  };

  const draw = () => {
    clear(results);
    first = null;
    const q = input.value.trim();
    const groups = findAll(q);
    if (!q) return;
    if (!groups.length) {
      results.append(h('div', { class: 'search-empty' }, `Nothing for “${q}”`));
      return;
    }
    for (const g of groups) {
      results.append(h('div', { class: 'eyebrow search-group' }, g.label));
      for (const hit of g.hits) {
        const row = h('button', { class: 'search-hit', type: 'button', onclick: () => open(hit, g.kind) },
          hitBody(hit, g.kind, norm(q)));
        if (!first) first = () => open(hit, g.kind);
        results.append(row);
      }
    }
  };

  input.addEventListener('input', debounce(draw, 60));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && first) { e.preventDefault(); first(); }
  });

  modal({
    title: 'Find',
    body: h('div', { class: 'search' }, input, results),
    wide: true
  });
  setTimeout(() => input.focus(), 0);
}

function hitBody(hit, kind, q) {
  switch (kind) {
    case 'item': {
      const t = hit.item;
      return h('div', { class: 'search-line' },
        h('span', { class: 'search-title' + (t.done ? ' done' : '') }, t.title),
        h('span', { class: 'search-meta' }, areaTag(t.areaId), dueChip(t)));
    }
    case 'area':
      return h('div', { class: 'search-line' },
        h('span', { class: 'search-title' },
          h('span', { class: 'dot', style: { background: hit.area.color, marginRight: '7px' } }), hit.area.name));
    case 'note':
      return h('div', { class: 'search-line' },
        h('span', { class: 'search-title' }, snippet(hit.text, q)),
        h('span', { class: 'search-meta eyebrow' }, `${fmtDate(hit.date)} · ${hit.field}`));
    case 'card':
      return h('div', { class: 'search-line' },
        h('span', { class: 'search-title' }, snippet(hit.card.text, q)),
        h('span', { class: 'search-meta' }, areaTag(hit.card.areaId)));
    case 'link': {
      let host = hit.link.url;
      try { host = new URL(hit.link.url).hostname.replace(/^www\./, ''); } catch { /* raw */ }
      return h('div', { class: 'search-line' },
        h('span', { class: 'search-title' }, hit.link.title),
        h('span', { class: 'search-meta eyebrow' }, host));
    }
    default: return null;
  }
}
