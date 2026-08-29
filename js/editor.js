// editor.js — the task page. Notion-style properties + notes + subtasks.

import { h, uid, fmtDate, fmtDuration, debounce } from './util.js';
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

  props.append(prop('Due',
    h('div', { class: 'pair' },
      h('input', { type: 'date', value: item.due || '', onchange: (e) => set({ due: e.target.value || null }, { resync: true }) }),
      h('input', { type: 'time', value: item.dueTime || '', style: { maxWidth: '110px' }, onchange: (e) => set({ dueTime: e.target.value || null }) }))));

  const plan = item.plan || {};
  props.append(prop('Work on',
    h('div', { class: 'pair' },
      h('input', {
        type: 'date', value: plan.date || '',
        onchange: (e) => {
          const date = e.target.value;
          set({ plan: date ? { date, start: plan.start || null, mins: plan.mins || item.estMins } : null }, { resync: true });
          rerender();
        }
      }),
      h('input', {
        type: 'time', value: plan.start || '', style: { maxWidth: '110px' }, disabled: !plan.date,
        onchange: (e) => {
          set({ plan: { ...plan, date: plan.date, start: e.target.value || null, mins: plan.mins || item.estMins } }, { resync: true });
          rerender();
        }
      }))));

  props.append(prop('Estimate',
    h('div', { class: 'pair', style: { alignItems: 'center' } },
      h('input', {
        type: 'number', min: '5', step: '5', value: item.estMins, style: { maxWidth: '92px' },
        onchange: (e) => {
          const mins = Math.max(5, +e.target.value || 60);
          const patch = { estMins: mins };
          if (item.plan) patch.plan = { ...item.plan, mins };
          set(patch, { resync: true });
          rerender();
        }
      }),
      h('span', { class: 'eyebrow' }, 'minutes'))));

  props.append(prop('Priority',
    h('select', { onchange: (e) => set({ priority: e.target.value }) },
      ...['low', 'normal', 'high'].map((p) => h('option', { value: p, selected: p === item.priority }, p[0].toUpperCase() + p.slice(1))))));

  const g = item.grade || {};
  props.append(prop('Grade',
    h('div', { class: 'pair', style: { alignItems: 'center' } },
      h('input', {
        type: 'number', step: 'any', placeholder: '—', value: g.score ?? '', style: { maxWidth: '80px' },
        onchange: (e) => set({ grade: { ...g, score: e.target.value === '' ? null : +e.target.value } })
      }),
      h('span', { style: { color: 'var(--ink-3)' } }, '/'),
      h('input', {
        type: 'number', step: 'any', placeholder: '100', value: g.outOf ?? '', style: { maxWidth: '80px' },
        onchange: (e) => set({ grade: { ...g, outOf: e.target.value === '' ? null : +e.target.value } })
      }),
      h('input', {
        type: 'text', placeholder: 'category', value: g.category || '',
        onchange: (e) => set({ grade: { ...g, category: e.target.value } })
      }))));

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
