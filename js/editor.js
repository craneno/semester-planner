// editor.js — the task page. Notion-style properties + notes + subtasks.

import { h, uid, fmtDate, fmtDuration, debounce, today, toMin, fromMin } from './util.js';
import { state, commit, itemById, deleteItem, toggleItem, ITEM_TYPES, progress } from './store.js';
import { peek, closePeek, confirmDialog, toast } from './ui.js';
import { pushItem } from './gcal.js';

const syncOut = debounce((id) => pushItem(id).catch(() => {}), 700);

let currentId = null;

export function openItem(id) {
  const item = itemById(id);
  if (!item) return;
  currentId = id;
  peek(render(item), { onClose: () => { currentId = null; } });
}

/** Re-render the panel in place (after a structural change). */
function rerender() {
  if (!currentId) return;
  const item = itemById(currentId);
  if (!item) { closePeek(); return; }
  peek(render(item), { onClose: () => { currentId = null; } });
}

function render(item) {
  const set = (patch, { resync = false } = {}) => {
    commit(() => { Object.assign(item, patch); item.updatedAt = new Date().toISOString(); });
    if (resync) syncOut(item.id);
  };

  const root = h('div', { style: { display: 'contents' } });

  /* header */
  const head = h('div', { class: 'peek-h' },
    h('input', {
      type: 'checkbox', class: 'check', checked: item.done,
      'aria-label': 'Mark complete',
      onchange: (e) => { commit(() => toggleItem(item.id, e.target.checked)); syncOut(item.id); rerender(); }
    }),
    h('span', { class: 'eyebrow' }, item.done ? 'Done' : item.type),
    h('div', { style: { flex: 1 } }),
    item.gcalId && h('span', { class: 'eyebrow', title: 'On your Google Calendar' }, 'GCAL'),
    h('button', {
      class: 'btn ghost sm', title: 'Delete task',
      onclick: async () => {
        if (await confirmDialog('Delete this task?', item.title, 'Delete')) {
          const snapshot = JSON.parse(JSON.stringify(item));
          // tagged so the view underneath repaints — the peek floats over
          // whichever view is showing, and it still lists this item
          commit(() => deleteItem(item.id), { source: 'editor' });
          closePeek();
          toast('Task deleted', {
            action: 'Undo',
            onAction: () => commit(() => state.items.push(snapshot), { source: 'editor' })
          });
        }
      }
    }, '🗑'),
    h('button', { class: 'btn ghost sm', onclick: closePeek, 'aria-label': 'Close' }, '✕'));

  /* body */
  const body = h('div', { class: 'peek-b' });

  body.append(h('input', {
    class: 'peek-title', value: item.title, placeholder: 'Untitled',
    oninput: debounce((e) => set({ title: e.target.value }, { resync: true }), 400)
  }));

  const props = h('div', { class: 'props' });

  props.append(prop('Area',
    h('select', {
      onchange: (e) => { set({ areaId: e.target.value || null }, { resync: true }); rerender(); }
    },
    h('option', { value: '' }, 'Unassigned'),
    ...state.areas.filter((a) => !a.archived).map((a) =>
      h('option', { value: a.id, selected: a.id === item.areaId }, a.name)))));

  props.append(prop('Type',
    h('select', { onchange: (e) => set({ type: e.target.value }) },
      ...ITEM_TYPES.map((t) => h('option', { value: t, selected: t === item.type }, t[0].toUpperCase() + t.slice(1))))));

  /* Scheduled or Deadline, never both. A scheduled item owns a start and an
     end and is what reaches Google Calendar; a deadline item is owed by a
     time and carries an estimate instead. Which one it is is read off the
     data — a booked block with a start time — so there is no extra field to
     keep honest. */
  const plan = item.plan || {};
  // Three states, all read off the data rather than stored beside it: a block
  // with a start, a day with no time in it, and a thing that is merely owed.
  const mode = plan.date ? (plan.start ? 'scheduled' : 'allday') : 'deadline';
  const scheduled = mode === 'scheduled';

  const toMode = (next) => {
    if (next === mode) return;
    // whatever date and time this already had follows it across, or switching
    // back and forth quietly loses what you set
    const date = plan.date || item.due || today();
    const start = plan.start || item.dueTime || '09:00';
    if (next === 'scheduled') {
      set({ plan: { date, start, mins: plan.mins || item.estMins || 60 }, due: null, dueTime: null },
        { resync: true });
    } else if (next === 'allday') {
      set({ plan: { date, start: null, mins: 0 }, due: null, dueTime: null }, { resync: true });
    } else {
      set({ due: item.due || plan.date || today(), dueTime: item.dueTime || plan.start || null, plan: null },
        { resync: true });
    }
    rerender();
  };

  const modeBtn = (id, label) => h('button', {
    class: 'mode' + (mode === id ? ' on' : ''), type: 'button',
    'aria-pressed': String(mode === id), onclick: () => toMode(id)
  }, label);

  props.append(prop('When',
    h('div', { class: 'mode-toggle' },
      modeBtn('scheduled', 'Scheduled'),
      modeBtn('allday', 'All day'),
      modeBtn('deadline', 'Deadline'))));

  if (mode === 'allday') {
    props.append(prop('Date',
      h('input', {
        type: 'date', value: plan.date || '',
        onchange: (e) => { set({ plan: { ...plan, date: e.target.value || today(), start: null, mins: 0 } }, { resync: true }); rerender(); }
      })));
  } else if (scheduled) {
    const endOf = (p) => fromMin(Math.min(24 * 60 - 1, toMin(p.start || '09:00') + (p.mins || 60)));
    props.append(prop('Date',
      h('input', {
        type: 'date', value: plan.date || '',
        onchange: (e) => { set({ plan: { ...plan, date: e.target.value || today() } }, { resync: true }); rerender(); }
      })));
    props.append(prop('From',
      h('div', { class: 'pair', style: { alignItems: 'center' } },
        h('input', {
          type: 'time', value: plan.start || '', style: { maxWidth: '110px' },
          onchange: (e) => {
            set({ plan: { ...plan, start: e.target.value || '09:00' } }, { resync: true });
            rerender();
          }
        }),
        h('span', { class: 'eyebrow' }, 'to'),
        h('input', {
          type: 'time', value: endOf(plan), style: { maxWidth: '110px' },
          onchange: (e) => {
            // stored as a duration, so an end before the start is nonsense
            const mins = toMin(e.target.value) - toMin(plan.start || '09:00');
            if (mins <= 0) { toast('The end has to come after the start.'); rerender(); return; }
            set({ plan: { ...plan, mins }, estMins: mins }, { resync: true });
            rerender();
          }
        }))));
  } else {
    props.append(prop('Due',
      h('div', { class: 'pair' },
        h('input', { type: 'date', value: item.due || '', onchange: (e) => set({ due: e.target.value || null }, { resync: true }) }),
        h('input', { type: 'time', value: item.dueTime || '', style: { maxWidth: '110px' }, onchange: (e) => set({ dueTime: e.target.value || null }) }))));

    props.append(prop('Estimate',
      h('div', { class: 'pair', style: { alignItems: 'center' } },
        h('input', {
          type: 'number', min: '5', step: '5', value: item.estMins, style: { maxWidth: '92px' },
          onchange: (e) => set({ estMins: Math.max(5, +e.target.value || 60) }, { resync: true })
        }),
        h('span', { class: 'eyebrow' }, 'minutes'))));
  }

  props.append(prop('Priority',
    h('select', { onchange: (e) => set({ priority: e.target.value }) },
      ...['low', 'normal', 'high'].map((p) => h('option', { value: p, selected: p === item.priority }, p[0].toUpperCase() + p.slice(1))))));

  body.append(props);

  /* subtasks */
  const pct = Math.round(progress(item) * 100);
  body.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', margin: '4px 0 6px' } },
    h('span', { class: 'eyebrow' }, 'Subtasks'),
    item.subtasks.length ? h('span', { class: 'eyebrow num' }, `${item.subtasks.filter((s) => s.done).length}/${item.subtasks.length} · ${pct}%`) : null));

  if (item.subtasks.length) {
    body.append(h('div', { class: 'meter', style: { marginBottom: '8px' } }, h('span', { style: { width: pct + '%' } })));
  }

  const subs = h('div', {});
  item.subtasks.forEach((s, i) => {
    subs.append(h('div', { class: 'subtask' + (s.done ? ' done' : '') },
      h('input', {
        type: 'checkbox', class: 'check sm', checked: s.done,
        onchange: (e) => { commit(() => { s.done = e.target.checked; }); rerender(); }
      }),
      h('input', {
        type: 'text', value: s.title,
        oninput: debounce((e) => commit(() => { s.title = e.target.value; }), 400),
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); addSub(i + 1); }
          if (e.key === 'Backspace' && !e.target.value) {
            e.preventDefault();
            commit(() => item.subtasks.splice(i, 1));
            rerender();
          }
        }
      }),
      h('button', { class: 'btn ghost sm', onclick: () => { commit(() => item.subtasks.splice(i, 1)); rerender(); }, 'aria-label': 'Remove subtask' }, '✕')));
  });
  body.append(subs);

  function addSub(at = item.subtasks.length) {
    commit(() => item.subtasks.splice(at, 0, { id: uid('st'), title: '', done: false }));
    rerender();
    setTimeout(() => {
      const inputs = document.querySelectorAll('#peek .subtask input[type="text"]');
      inputs[Math.min(at, inputs.length - 1)]?.focus();
    }, 20);
  }
  body.append(h('button', { class: 'btn ghost sm', style: { marginTop: '4px' }, onclick: () => addSub() }, '+ Add subtask'));

  /* notes */
  body.append(h('div', { class: 'eyebrow', style: { margin: '18px 0 6px' } }, 'Notes'));
  body.append(h('textarea', {
    placeholder: 'Anything worth remembering — where you left off, page numbers, links.',
    style: { minHeight: '130px' },
    oninput: debounce((e) => commit(() => { item.notes = e.target.value; }), 400)
  }, item.notes || ''));

  body.append(h('div', { class: 'eyebrow', style: { marginTop: '20px' } },
    `Created ${fmtDate(item.createdAt.slice(0, 10), { year: true })}`
    + (item.plan?.date ? ` · Planned ${fmtDate(item.plan.date)}${item.plan.start ? ' ' + item.plan.start : ''} · ${fmtDuration(item.plan.mins)}` : '')));

  root.append(head, body);
  return root;
}

function prop(label, control) {
  return h('div', { class: 'prop' }, h('label', {}, label), control);
}
