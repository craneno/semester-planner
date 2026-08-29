// views/habits.js — a week of habits, ticked a day at a time.
//
// Habits belong to no area on purpose: they are about the person, not the
// work, so they live on their own page and never appear in a task list.

import { h, clear, today, addDays, startOfWeek, weekDays, parseYmd, DOW, MONTHS } from '../util.js';
import {
  state, commit, activeHabits, habitDone, toggleHabit, habitStreak,
  habitRemaining, HABIT_TARGET, addHabit, updateHabit, deleteHabit, reorderHabits
} from '../store.js';
import { confirmDialog, toast, reorderable } from '../ui.js';

let anchor = today();

export function renderHabits(root, { navigate }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const days = weekDays(startOfWeek(anchor, state.settings.weekStart));
  const habits = activeHabits();
  const first = parseYmd(days[0]), last = parseYmd(days[6]);
  const span = first.getMonth() === last.getMonth()
    ? `${MONTHS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${MONTHS[first.getMonth()].slice(0, 3)} ${first.getDate()} – ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getDate()}`;

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('h1', {}, 'Habits'),
      h('div', { class: 'eyebrow' }, span)),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn sm', 'aria-label': 'Previous week', onclick: () => { anchor = addDays(anchor, -7); navigate(); } }, '‹'),
    h('button', { class: 'btn sm', onclick: () => { anchor = today(); navigate(); } }, 'This week'),
    h('button', { class: 'btn sm', 'aria-label': 'Next week', onclick: () => { anchor = addDays(anchor, 7); navigate(); } }, '›')));

  if (!habits.length) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, 'No habits yet'),
      h('p', { style: { margin: '4px 0 12px', color: 'var(--ink-2)' } },
        'A habit is something you want to do most days. Ticking one is the whole interaction.')));
  }

  const table = h('div', { class: 'habits' });

  // header row: the seven days
  const head = h('div', { class: 'habit-row habit-head' },
    h('div', { class: 'habit-name' }, ''),
    ...days.map((d) => {
      const dt = parseYmd(d);
      return h('div', {
        class: 'habit-day' + (d === today() ? ' is-today' : '') + (d > today() ? ' is-future' : '')
      },
      h('div', { class: 'eyebrow' }, DOW[dt.getDay()][0]),
      h('div', { class: 'habit-dnum num' }, String(dt.getDate())));
    }),
    h('div', { class: 'habit-streak eyebrow' }, 'streak'),
    h('div', { class: 'habit-goal eyebrow' }, `to ${HABIT_TARGET}`));
  table.append(head);

  for (const x of habits) {
    const row = h('div', { class: 'habit-row', dataset: { reorderId: x.id } },
      h('div', { class: 'habit-name' },
        h('span', { class: 'drag-handle', 'aria-label': `Reorder ${x.name}` }, '⠿'),
        h('input', {
          class: 'habit-title', value: x.name, 'aria-label': 'Habit name',
          onchange: (e) => {
            const name = e.target.value.trim();
            if (name) commit(() => updateHabit(x.id, { name }));
            else e.target.value = x.name;
          }
        }),
        h('button', {
          class: 'btn sm ghost habit-del', 'aria-label': `Delete ${x.name}`,
          onclick: async () => {
            if (await confirmDialog('Delete this habit?', `${x.name} — its history goes too.`, 'Delete')) {
              commit(() => deleteHabit(x.id));
              navigate();
            }
          }
        }, '✕')));

    for (const d of days) {
      const on = habitDone(d, x.id);
      const future = d > today();
      row.append(h('div', { class: 'habit-day' + (d === today() ? ' is-today' : '') },
        h('button', {
          class: 'tick' + (on ? ' on' : ''),
          disabled: future || null,
          'aria-pressed': String(on),
          'aria-label': `${x.name} on ${d}`,
          title: future ? 'Not yet' : d,
          onclick: (e) => {
            const nowOn = commitTick(d, x.id);
            e.currentTarget.classList.toggle('on', nowOn);
            e.currentTarget.setAttribute('aria-pressed', String(nowOn));
            paintProgress(e.currentTarget.closest('.habit-row'), x.id);
          }
        }, on ? '✓' : '')));
    }

    row.append(h('div', { class: 'habit-streak num' }, streakLabel(x.id)));
    row.append(h('div', { class: 'habit-goal' },
      h('span', { class: 'goal-n num' }, goalLabel(x.id)),
      h('span', { class: 'meter goal-bar' }, h('span', { style: { width: goalPct(x.id) + '%' } }))));
    table.append(row);
  }

  pad.append(table);

  /* add a habit */
  const input = h('input', {
    class: 'habit-new', placeholder: 'Add a habit…', 'aria-label': 'New habit',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      commit(() => addHabit(e.target.value));
      e.target.value = '';
      navigate();
    }
  });
  pad.append(h('div', { class: 'habit-add' }, input,
    h('button', {
      class: 'btn', onclick: () => {
        if (!input.value.trim()) { toast('Give the habit a name first.'); return; }
        commit(() => addHabit(input.value));
        navigate();
      }
    }, 'Add')));

  root.append(pad);

  reorderable(table, {
    handle: '.drag-handle',
    onDrop: (ids) => { commit(() => reorderHabits(ids)); navigate(); }
  });
}

const commitTick = (date, id) => {
  let on;
  commit(() => { on = toggleHabit(date, id); });
  return on;
};

const streakLabel = (id) => {
  const n = habitStreak(id);
  return n ? String(n) : '—';
};

/** How much further to a habit that has stuck — or nothing left to say. */
const goalLabel = (id) => {
  const left = habitRemaining(id);
  return left ? String(left) : '✓';
};
const goalPct = (id) => Math.min(100, Math.round((habitStreak(id) / HABIT_TARGET) * 100));

/** A tick only changes that habit's own numbers, and re-rendering the page
 *  would take focus off the box you just clicked. */
function paintProgress(row, id) {
  const streak = row.querySelector('.habit-streak');
  if (streak) streak.textContent = streakLabel(id);
  const n = row.querySelector('.goal-n');
  if (n) n.textContent = goalLabel(id);
  const bar = row.querySelector('.goal-bar > span');
  if (bar) bar.style.width = goalPct(id) + '%';
}
