// views/semester.js — every piece of work, grouped by month. The database view.

import { h, clear, fmtDate, monthKey, monthLabel, fmtDuration } from '../util.js';
import { state, commit, toggleItem, ITEM_TYPES, progress } from '../store.js';
import { areaTag, dueChip, priorityTag, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { pushItem } from '../gcal.js';

const filters = { area: '', type: '', status: 'open', q: '' };

export function renderSemester(root, { navigate }) {
  clear(root);
  const pad = h('div', { class: 'pad' });

  /* filter bar */
  const bar = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' } },
    select(filters.status, [['open', 'Open'], ['all', 'All'], ['done', 'Done']], (v) => { filters.status = v; navigate(); }),
    select(filters.area, [['', 'All areas'], ...state.areas.filter((a) => !a.archived).map((a) => [a.id, a.name])], (v) => { filters.area = v; navigate(); }),
    select(filters.type, [['', 'All types'], ...ITEM_TYPES.map((t) => [t, t[0].toUpperCase() + t.slice(1)])], (v) => { filters.type = v; navigate(); }),
    h('input', {
      type: 'text', placeholder: 'Filter by name…', value: filters.q, style: { maxWidth: '200px' },
      oninput: (e) => { filters.q = e.target.value; renderList(); }
    }),
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'eyebrow num', id: 'sem-count' }));

  pad.append(bar);
  const listHost = h('div', {});
  pad.append(listHost);
  root.append(pad);

  function renderList() {
    clear(listHost);
    let items = state.items.slice();
    if (filters.status === 'open') items = items.filter((t) => !t.done);
    if (filters.status === 'done') items = items.filter((t) => t.done);
    if (filters.area) items = items.filter((t) => t.areaId === filters.area);
    if (filters.type) items = items.filter((t) => t.type === filters.type);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      items = items.filter((t) => t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q));
    }
    items.sort((a, b) => {
      const da = a.due || a.plan?.date || '9999-99-99';
      const db = b.due || b.plan?.date || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : a.title.localeCompare(b.title);
    });

    const count = document.getElementById('sem-count');
    if (count) count.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

    if (!items.length) {
      listHost.append(h('div', { class: 'empty', style: { marginTop: '18px' } },
        h('h3', {}, 'Nothing here yet'),
        h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
          'Type in the bar up top — "Topology PS3 due fri 2h !high" works.')));
      return;
    }

    let currentKey = null;
    for (const t of items) {
      const key = monthKey(t.due || t.plan?.date);
      if (key !== currentKey) {
        currentKey = key;
        const inMonth = items.filter((x) => monthKey(x.due || x.plan?.date) === key);
        const mins = inMonth.reduce((n, x) => n + (x.estMins || 0), 0);
        listHost.append(h('div', { class: 'group-h' },
          h('h2', {}, monthLabel(key)),
          h('span', { class: 'eyebrow num' }, `${inMonth.length} · ${fmtDuration(mins)}`)));
      }
      listHost.append(itemRow(t, renderList));
    }
  }

  renderList();
}

function itemRow(t, rerender) {
  const pct = Math.round(progress(t) * 100);
  return h('div', {
    class: 'row' + (t.done ? ' done' : ''),
    onclick: () => openItem(t.id)
  },
  h('input', {
    type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); pushItem(t.id).catch(() => {}); rerender(); }
  }),
  h('span', { class: 'title' },
    t.title,
    t.subtasks.length ? h('span', { class: 'eyebrow num', style: { marginLeft: '8px' } }, `${pct}%`) : null),
  meta(
    priorityTag(t.priority),
    areaTag(t.areaId),
    t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
    dueChip(t)));
}

function select(value, options, onchange) {
  return h('select', { style: { width: 'auto' }, onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}
