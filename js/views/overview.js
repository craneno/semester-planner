// views/overview.js — the semester at a glance. Awareness, not alarm.

import { h, clear, today, addDays, startOfWeek, weekDays, fmtDate, fmtHours, fmtDuration, diffDays } from '../util.js';
import {
  state, commit, areaColor, areaName, upcoming, overdue, workloadFor, semesterProgress,
  weekNumber, sessionsBetween, studyMinutes, progress, note
} from '../store.js';
import { areaTag, dueChip, meta } from '../ui.js';
import { openItem } from '../editor.js';

export function renderOverview(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const ws = state.settings.weekStart;
  const days = weekDays(startOfWeek(today(), ws));
  const load = workloadFor(days);
  const late = overdue();
  const soon = upcoming(14);
  const pct = Math.round(semesterProgress() * 100);
  const studyWeek = studyMinutes(sessionsBetween(days[0], days[6]));
  const studySem = studyMinutes(sessionsBetween(state.semester.start, state.semester.end));

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

  /* three cards */
  const cards = h('div', { class: 'grid cols-3', style: { marginBottom: '18px' } });

  // focus
  const n = note(today());
  const top3 = soon.filter((t) => !t.done).slice(0, 3);
  cards.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Focus'), h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => go('today') }, 'Today →')),
    h('div', { class: 'card-b' },
      n.focus
        ? h('p', { style: { margin: '0 0 10px', fontWeight: 550 } }, n.focus)
        : h('p', { style: { margin: '0 0 10px', color: 'var(--ink-3)' } }, 'No focus set for today.'),
      ...(top3.length ? top3.map((t) => itemLine(t, navigate)) : [h('span', { style: { color: 'var(--ink-3)' } }, 'Nothing due in the next two weeks.')]))));

  // study
  cards.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Study time'), h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => go('study') }, 'Timer →')),
    h('div', { class: 'card-b' },
      h('div', { class: 'num', style: { fontSize: '30px', letterSpacing: '-.02em', lineHeight: 1.1 } }, fmtHours(studyWeek)),
      h('div', { class: 'eyebrow', style: { marginTop: '2px' } }, 'this week'),
      h('div', { style: { marginTop: '12px', color: 'var(--ink-2)', fontSize: '13px' } },
        `${fmtHours(studySem)} this semester · ${state.sessions.length} sessions`))));

  // areas
  const areaCard = h('div', { class: 'card-b' });
  const active = state.areas.filter((a) => !a.archived);
  if (!active.length) {
    areaCard.append(h('span', { style: { color: 'var(--ink-3)' } }, 'No courses or projects yet.'));
  }
  for (const a of active.slice(0, 6)) {
    const mine = state.items.filter((t) => t.areaId === a.id);
    const done = mine.filter((t) => t.done).length;
    const p = mine.length ? Math.round((done / mine.length) * 100) : 0;
    areaCard.append(h('div', { style: { margin: '0 0 9px' } },
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
        h('span', { class: 'dot', style: { background: a.color } }),
        h('span', { style: { fontSize: '13px' } }, a.name),
        h('span', { style: { flex: 1 } }),
        h('span', { class: 'eyebrow num' }, `${done}/${mine.length}`)),
      h('div', { class: 'meter' }, h('span', { style: { width: p + '%', background: a.color } }))));
  }
  cards.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Courses & projects'), h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => go('courses') }, 'Manage →')),
    areaCard));

  pad.append(cards);

  /* deadlines */
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

  pad.append(list);
  root.append(pad);
}

function itemLine(t, navigate) {
  return h('div', { class: 'row', style: { gridTemplateColumns: '22px minmax(0,1fr) auto', borderBottom: 0, padding: '4px 0' }, onclick: () => openItem(t.id) },
    h('input', {
      type: 'checkbox', class: 'check sm', checked: t.done,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { commit(() => { t.done = e.target.checked; t.doneAt = e.target.checked ? new Date().toISOString() : null; }); navigate(); }
    }),
    h('span', { class: 'title', style: { fontSize: '13.5px' } }, t.title),
    meta(dueChip(t)));
}

function row(t, navigate) {
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    h('input', {
      type: 'checkbox', class: 'check', checked: t.done,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { commit(() => { t.done = e.target.checked; t.doneAt = e.target.checked ? new Date().toISOString() : null; }); navigate(); }
    }),
    h('span', { class: 'title' }, t.title),
    meta(
      areaTag(t.areaId),
      t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
      dueChip(t)));
}
