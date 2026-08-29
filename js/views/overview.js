// views/overview.js — the whole day on one page. Awareness, not alarm.
//
// Left is today as it will actually happen: classes, calendar events, the work
// you planned. Right is what you decide about it. There is no separate Today
// page; this is it.

import {
  h, clear, today, startOfWeek, weekDays, fmtDate, fmtTime, fmtHours, fmtDuration,
  toMin, DOW_LONG, MONTHS, parseYmd, debounce
} from '../util.js';
import {
  state, commit, toggleItem, upcoming, overdue, workloadFor, semesterProgress,
  weekNumber, categoryLoad, note, areaColor, areaName, classesOn, eventsOn,
  itemsDueOn, itemsPlannedOn
} from '../store.js';
import { areaTag, dueChip, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { captureStrip } from '../capture.js';
import { pushItem } from '../gcal.js';

export function renderOverview(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const day = today();
  const ws = state.settings.weekStart;
  const days = weekDays(startOfWeek(day, ws));
  const load = workloadFor(days);
  const late = overdue();
  const soon = upcoming(14);
  const pct = Math.round(semesterProgress() * 100);

  /* headline — a sentence, not a scoreboard */
  const headline = load.count === 0
    ? 'Nothing scheduled this week yet.'
    : load.count <= 4 ? 'A light week ahead.'
      : load.count <= 9 ? 'A steady week ahead.' : 'A busy week ahead.';

  pad.append(h('section', { style: { marginBottom: '22px' } },
    h('div', { class: 'eyebrow' }, `${state.semester.name} · Week ${weekNumber()} · ${pct}% elapsed`),
    h('h1', { style: { margin: '6px 0 8px' } }, headline),
    h('p', { style: { margin: 0, color: 'var(--ink-2)' } },
      `${load.count} ${load.count === 1 ? 'task' : 'tasks'} · about ${fmtHours(load.mins)} of work`
      + (late.length ? ` · ${late.length} past due` : '')),
    h('div', { class: 'meter', style: { marginTop: '14px', maxWidth: '460px' } },
      h('span', { style: { width: pct + '%' } }))));

  pad.append(captureStrip(navigate));

  pad.append(h('div', { class: 'overview-split' },
    todayColumn(day, { navigate, go }),
    decisionColumn(day, { navigate, go, soon })));

  pad.append(deadlines(soon, late, { navigate, go }));
  root.append(pad);
}

/* ---------------- left: today, in order ---------------- */

function todayColumn(day, { navigate, go }) {
  const d = parseYmd(day);
  const hour12 = state.settings.hour12;
  const col = h('section', { class: 'card today-col' });

  col.append(h('div', { class: 'card-h' },
    h('span', { class: 'eyebrow' }, DOW_LONG[d.getDay()]),
    h('span', { class: 'today-date' }, `${MONTHS[d.getMonth()]} ${d.getDate()}`),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost sm', onclick: () => go('week') }, 'Week →')));

  const entries = [];
  for (const c of classesOn(day)) {
    entries.push({
      sort: toMin(c.start), when: fmtTime(c.start, hour12),
      label: c.title, meta: c.location || 'class', color: c.color
    });
  }
  for (const e of eventsOn(day)) {
    entries.push({
      sort: e.allDay ? -1 : toMin(e.start),
      when: e.allDay ? 'all day' : fmtTime(e.start, hour12),
      label: e.title, meta: e.location, color: null, ext: true, link: e.link
    });
  }
  for (const t of itemsPlannedOn(day)) {
    entries.push({
      sort: t.plan.start ? toMin(t.plan.start) : 24 * 60,
      when: t.plan.start ? fmtTime(t.plan.start, hour12) : '—',
      label: t.title, meta: `${areaName(t.areaId)} · ${fmtDuration(t.plan.mins || t.estMins)}`,
      color: areaColor(t.areaId), id: t.id, done: t.done
    });
  }
  entries.sort((a, b) => a.sort - b.sort);

  const body = h('div', { class: 'card-b' });
  if (!entries.length) {
    body.append(h('div', { class: 'empty', style: { padding: '20px 0' } },
      h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, 'A clear day.')));
  }
  const agenda = h('div', { class: 'agenda' });
  for (const e of entries) {
    agenda.append(h('div', {
      class: 'agenda-row' + (e.ext ? ' ext' : ''),
      style: { '--c': e.color || 'var(--ink-3)', opacity: e.done ? .5 : 1 },
      onclick: () => { if (e.id) openItem(e.id); else if (e.link) window.open(e.link, '_blank', 'noopener'); }
    },
    h('span', { class: 'when' }, e.when),
    h('span', { class: 'rulebar' }),
    h('span', {
      class: 'title',
      style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: e.done ? 'line-through' : 'none' }
    }, e.label),
    h('span', { class: 'eyebrow' }, e.meta || '')));
  }
  body.append(agenda);
  col.append(body);
  return col;
}

/* ---------------- right: what to do about it ---------------- */

function decisionColumn(day, { navigate, go, soon }) {
  const col = h('div', { class: 'overview-side' });
  const n = note(day);

  /* focus + today's three */
  const focus = h('div', { class: 'card-b' });
  focus.append(h('input', {
    class: 'focus-line', value: n.focus, placeholder: 'The one thing that matters today',
    'aria-label': "Today's focus",
    oninput: debounce((e) => commit(() => { n.focus = e.target.value; }), 400)
  }));

  const planned = itemsPlannedOn(day);
  const due = itemsDueOn(day).filter((t) => !planned.includes(t));
  const candidates = [...planned, ...due];
  const chosen = (n.top3 || []).map((id) => state.items.find((t) => t.id === id)).filter(Boolean);
  const three = chosen.length ? chosen : candidates.slice(0, 3);

  focus.append(h('div', { class: 'eyebrow', style: { margin: '16px 0 4px' } }, 'Top three'));
  if (!three.length) {
    focus.append(h('p', { style: { margin: 0, color: 'var(--ink-3)', fontSize: '13px' } },
      'Nothing planned for today. Drag work in from the Week view.'));
  }
  for (const t of three) focus.append(line(t, navigate));

  if (candidates.length > three.length) {
    focus.append(h('details', { style: { marginTop: '8px' } },
      h('summary', { class: 'eyebrow', style: { cursor: 'pointer' } },
        `Everything today (${candidates.length})`),
      ...candidates.slice(three.length).map((t) => line(t, navigate))));
  }

  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Focus')),
    focus));

  /* open work, split the way the sidebar splits it */
  const byCat = h('div', { class: 'card-b' });
  const loads = categoryLoad();
  const busiest = Math.max(1, ...loads.map((c) => c.open));
  for (const c of loads) {
    byCat.append(h('button', {
      class: 'cat-load', onclick: () => go(c.id),
      title: `${c.open} open · ${fmtHours(c.mins)}`
    },
    h('div', { class: 'cat-load-h' },
      h('span', { class: 'cat-load-name' }, c.label),
      h('span', { class: 'eyebrow num' }, c.open ? `${c.open} · ${fmtHours(c.mins)}` : '—')),
    h('div', { class: 'meter' }, h('span', { style: { width: (c.open / busiest) * 100 + '%' } }))));
  }
  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Open work'), h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => go('semester') }, 'All →')),
    byCat));

  /* end of day */
  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'End of day')),
    h('div', { class: 'card-b' },
      h('textarea', {
        placeholder: 'What moved, what stalled, what tomorrow needs.',
        style: { minHeight: '90px' },
        oninput: debounce((e) => commit(() => { n.text = e.target.value; }), 500)
      }, n.text || ''))));

  return col;
}

/* ---------------- below: the fortnight ---------------- */

function deadlines(soon, late, { navigate, go }) {
  const list = h('section', {});
  list.append(h('div', { class: 'group-h' },
    h('h2', {}, 'Next two weeks'),
    h('span', { class: 'eyebrow num' }, String(soon.length))));

  if (late.length) {
    list.append(h('div', { class: 'eyebrow', style: { color: 'var(--warn)', padding: '10px 4px 2px' } },
      `${late.length} past due — worth rescheduling`));
    for (const t of late.slice(0, 6)) list.append(row(t, navigate));
  }
  if (!soon.length && !late.length) {
    list.append(h('div', { class: 'empty', style: { marginTop: '14px' } },
      h('h3', {}, 'Nothing due yet'),
      h('p', { style: { margin: '4px 0 12px', color: 'var(--ink-2)' } }, 'Import a syllabus or add your first task.'),
      h('button', { class: 'btn primary', onclick: () => go('semester') }, 'Go to Semester')));
  }
  for (const t of soon) list.append(row(t, navigate));
  return list;
}

const check = (t, navigate) => h('input', {
  type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
  onclick: (e) => e.stopPropagation(),
  onchange: (e) => {
    commit(() => toggleItem(t.id, e.target.checked));
    pushItem(t.id).catch(() => {});
    navigate();
  }
});

function line(t, navigate) {
  return h('div', {
    class: 'row' + (t.done ? ' done' : ''),
    style: { gridTemplateColumns: '22px minmax(0,1fr) auto', borderBottom: 0, padding: '4px 0' },
    onclick: () => openItem(t.id)
  },
  check(t, navigate),
  h('span', { class: 'title', style: { fontSize: '13.5px' } }, t.title),
  meta(dueChip(t)));
}

function row(t, navigate) {
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    check(t, navigate),
    h('span', { class: 'title' }, t.title),
    meta(
      areaTag(t.areaId),
      t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
      dueChip(t)));
}
