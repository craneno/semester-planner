// views/today.js — the daily page.

import {
  h, clear, today, addDays, fmtDate, fmtTime, fmtDuration, fmtHours, toMin,
  DOW_LONG, MONTHS, parseYmd, debounce
} from '../util.js';
import {
  state, commit, toggleItem, areaColor, areaName, classesOn, eventsOn,
  itemsDueOn, itemsPlannedOn, note, workloadFor, sessionsBetween, studyMinutes
} from '../store.js';
import { areaTag, dueChip, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { pushItem } from '../gcal.js';

let day = today();

export function goToDay(d) { day = d; }

export function renderToday(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const d = parseYmd(day);
  const n = note(day);
  const hour12 = state.settings.hour12;
  const load = workloadFor([day]);
  const studied = studyMinutes(sessionsBetween(day, day));

  pad.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '16px' } },
    h('div', {},
      h('div', { class: 'eyebrow' }, DOW_LONG[d.getDay()] + (day === today() ? ' · Today' : '')),
      h('h1', { style: { marginTop: '3px' } }, `${MONTHS[d.getMonth()]} ${d.getDate()}`)),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn sm', onclick: () => { day = addDays(day, -1); navigate(); } }, '‹'),
    h('button', { class: 'btn sm', onclick: () => { day = today(); navigate(); } }, 'Today'),
    h('button', { class: 'btn sm', onclick: () => { day = addDays(day, 1); navigate(); } }, '›')));

  const grid = h('div', { class: 'today-grid' });

  /* ---- left: focus + priorities + notes ---- */
  const left = h('div', {});

  left.append(h('div', { class: 'eyebrow' }, "Today's focus"));
  left.append(h('input', {
    class: 'focus-line', value: n.focus, placeholder: 'The one thing that matters today',
    oninput: debounce((e) => commit(() => { n.focus = e.target.value; }), 400)
  }));

  const planned = itemsPlannedOn(day);
  const due = itemsDueOn(day).filter((t) => !planned.includes(t));
  const candidates = [...planned, ...due];

  left.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', margin: '20px 0 6px' } },
    h('span', { class: 'eyebrow' }, 'Top three'),
    h('span', { class: 'eyebrow num' }, `${load.count} tasks · ${fmtHours(load.mins)}`)));

  const top3 = h('div', { class: 'top3' });
  const chosen = (n.top3 || []).map((id) => state.items.find((t) => t.id === id)).filter(Boolean);
  const fill = chosen.length ? chosen : candidates.slice(0, 3);
  if (!fill.length) {
    top3.append(h('div', { class: 'empty', style: { padding: '16px' } },
      h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, 'Nothing planned for this day. Drag work in from the Week view.')));
  }
  for (const t of fill) {
    top3.append(h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
      h('input', {
        type: 'checkbox', class: 'check', checked: t.done,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); pushItem(t.id).catch(() => {}); navigate(); }
      }),
      h('span', { class: 'title' }, t.title),
      meta(dueChip(t))));
  }
  left.append(top3);

  if (candidates.length > fill.length) {
    left.append(h('details', { style: { marginTop: '10px' } },
      h('summary', { class: 'eyebrow', style: { cursor: 'pointer' } }, `Everything on ${fmtDate(day)} (${candidates.length})`),
      ...candidates.slice(fill.length).map((t) =>
        h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
          h('input', {
            type: 'checkbox', class: 'check', checked: t.done,
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); navigate(); }
          }),
          h('span', { class: 'title' }, t.title),
          meta(areaTag(t.areaId), dueChip(t))))));
  }

  left.append(h('div', { class: 'eyebrow', style: { margin: '24px 0 6px' } }, 'End of day'));
  left.append(h('textarea', {
    placeholder: 'What moved, what stalled, what tomorrow needs.',
    style: { minHeight: '110px' },
    oninput: debounce((e) => commit(() => { n.text = e.target.value; }), 500)
  }, n.text || ''));

  /* ---- right: agenda ---- */
  const right = h('div', {});
  right.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '6px' } },
    h('span', { class: 'eyebrow' }, 'Schedule'),
    studied ? h('span', { class: 'eyebrow num' }, `${fmtHours(studied)} studied`) : null));

  const entries = [];
  for (const c of classesOn(day)) {
    entries.push({ sort: toMin(c.start), when: `${fmtTime(c.start, hour12)}`, label: c.title, meta: c.location, color: c.color, kind: 'class' });
  }
  for (const e of eventsOn(day)) {
    entries.push({
      sort: e.allDay ? -1 : toMin(e.start), when: e.allDay ? 'all day' : fmtTime(e.start, hour12),
      label: e.title, meta: e.location, color: null, kind: 'ext', link: e.link
    });
  }
  for (const t of itemsPlannedOn(day)) {
    entries.push({
      sort: t.plan.start ? toMin(t.plan.start) : 24 * 60,
      when: t.plan.start ? fmtTime(t.plan.start, hour12) : '—',
      label: t.title, meta: `${areaName(t.areaId)} · ${fmtDuration(t.plan.mins || t.estMins)}`,
      color: areaColor(t.areaId), kind: 'plan', id: t.id, done: t.done
    });
  }
  entries.sort((a, b) => a.sort - b.sort);

  const agenda = h('div', { class: 'agenda' });
  if (!entries.length) {
    agenda.append(h('div', { class: 'empty', style: { padding: '18px' } },
      h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, 'A clear day.')));
  }
  for (const e of entries) {
    agenda.append(h('div', {
      class: 'agenda-row' + (e.kind === 'ext' ? ' ext' : ''),
      style: { '--c': e.color || 'var(--ink-3)', opacity: e.done ? .5 : 1 },
      onclick: () => { if (e.id) openItem(e.id); else if (e.link) window.open(e.link, '_blank', 'noopener'); }
    },
    h('span', { class: 'when' }, e.when),
    h('span', { class: 'rulebar' }),
    h('span', { class: 'title', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: e.done ? 'line-through' : 'none' } }, e.label),
    h('span', { class: 'eyebrow' }, e.meta || (e.kind === 'class' ? 'class' : ''))));
  }
  right.append(agenda);

  right.append(h('button', {
    class: 'btn ghost sm', style: { marginTop: '10px' },
    onclick: () => go('week')
  }, 'Open the week →'));

  grid.append(left, right);
  pad.append(grid);
  root.append(pad);
}
