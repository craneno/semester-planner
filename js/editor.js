// editor.js — the task page. Notion-style properties + notes + subtasks.

import { h, uid, fmtDate, fmtDuration, debounce, today, toMin, fromMin, DOW } from './util.js';
import {
  state, commit, itemById, upsertItem, deleteItem, ITEM_TYPES, progress,
  repeatLabel, endSeriesBefore, splitSeriesAt, duplicateItem, occurrenceId, canvasUnmoved
} from './store.js';
import { peek, closePeek, confirmDialog, modal, closeModal, toast } from './ui.js';
import { pushItem, forgetItem } from './gcal.js';
import { tickItem, pushToTomorrow, canPush } from './actions.js';

const syncOut = debounce((id) => pushItem(id).catch(() => {}), 700);

let currentId = null;
/* Which of the two an edit means, when the thing open is one occurrence of a
   series. Kept out here because `rerender()` builds the panel again from
   scratch and the answer must survive that. Defaults to the safe one: you
   cannot change a term of Tuesdays by mistake. */
let scope = 'one';

export function openItem(id) {
  const item = itemById(id);
  if (!item) return;
  currentId = id;
  scope = 'one';
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
  /* The row in `state.items` behind whatever is open — the item itself, or the
     series an occurrence came from. An occurrence is a copy made on demand, so
     anything written to it directly would be thrown away with it. */
  const live = item.seriesId
    ? (state.items.find((t) => t.id === item.seriesId) || item)
    : item;
  const isOccurrence = !!item.seriesId;
  const toSeries = isOccurrence && scope === 'all';
  const targetId = toSeries ? live.id : item.id;

  const set = (patch, { resync = false } = {}) => {
    /* This and after: the occurrence shown and every one past it become a
       series of their own, carrying the edit, and the old series ends the day
       before. From then on the panel is on the new series, editing all of it
       — which is what "and after" meant. A title being typed is not redrawn
       under the caret. */
    if (isOccurrence && scope === 'after') {
      let made = null;
      commit(() => { made = splitSeriesAt(live, item.occurrence, patch); }, { source: 'editor' });
      if (!made) return;
      pushItem(live.id).catch(() => {});
      pushItem(made.id).catch(() => {});
      currentId = occurrenceId(made.id, patch.plan?.date || patch.due || item.occurrence);
      scope = 'all';
      const onlyTitle = Object.keys(patch).every((k) => k === 'title');
      if (!onlyTitle) rerender();
      return;
    }
    // gone from under the panel — a pull or another tab deleted it. Writing
    // by its id would make it again, as a ghost with default fields.
    if (!itemById(targetId)) { toast('That task was deleted elsewhere.'); closePeek(); return; }
    // tagged: the panel floats over a view that lists this item, and that
    // view repaints only for a source it knows
    commit(() => {
      const next = upsertItem({ id: targetId, ...patch });
      // keep the copy this render is holding in step with what was stored
      if (next && targetId === item.id) Object.assign(item, next);
    }, { source: 'editor' });
    if (resync) syncOut(live.id);
  };

  const root = h('div', { style: { display: 'contents' } });

  /* header */
  const head = h('div', { class: 'peek-h' },
    h('input', {
      type: 'checkbox', class: 'check', checked: item.done,
      'aria-label': 'Mark complete',
      onchange: (e) => tickItem(item.id, e.target.checked, { after: rerender })
    }),
    h('span', { class: 'eyebrow' }, item.done ? 'Done' : item.type),
    h('div', { style: { flex: 1 } }),
    (item.gcalId || live.gcalIds) && h('span', { class: 'eyebrow', title: 'On your Google Calendar' }, 'GCAL'),
    live.canvasId && h('span', { class: 'eyebrow', title: 'From your Canvas feed' + (live.canvasCourse ? ' · ' + live.canvasCourse : '') }, 'CANVAS'),
    canPush(item) && h('button', {
      class: 'btn ghost sm', title: 'Push to tomorrow',
      onclick: () => pushToTomorrow(item.id, { after: rerender })
    }, '→'),
    h('button', {
      class: 'btn ghost sm', title: isOccurrence ? 'Duplicate the series' : 'Duplicate',
      onclick: () => {
        let made = null;
        commit(() => { made = duplicateItem(item.id); }, { source: 'editor' });
        if (made) { toast('Copied'); openItem(made.id); }
      }
    }, '⧉'),
    h('button', {
      class: 'btn ghost sm', title: 'Delete task',
      onclick: () => (isOccurrence ? removeOccurrence(item, live) : removePlain(item))
    }, '🗑'),
    h('button', { class: 'btn ghost sm', onclick: closePeek, 'aria-label': 'Close' }, '✕'));

  /* body */
  const body = h('div', { class: 'peek-b' });

  body.append(h('input', {
    class: 'peek-title', value: item.title, placeholder: 'Untitled',
    oninput: debounce((e) => set({ title: e.target.value }, { resync: true }), 400)
  }));

  const props = h('div', { class: 'props' });

  /* One of a series: say so, and say which of the two an edit means. */
  if (isOccurrence) {
    props.append(prop('Repeats',
      h('div', {},
        h('div', { class: 'mode-toggle' },
          h('button', {
            class: 'mode' + (scope === 'one' ? ' on' : ''), type: 'button',
            'aria-pressed': String(scope === 'one'),
            onclick: () => { scope = 'one'; rerender(); }
          }, 'This one'),
          h('button', {
            class: 'mode' + (scope === 'after' ? ' on' : ''), type: 'button',
            'aria-pressed': String(scope === 'after'),
            title: 'This one and every one after it',
            onclick: () => { scope = 'after'; rerender(); }
          }, 'This and after'),
          h('button', {
            class: 'mode' + (scope === 'all' ? ' on' : ''), type: 'button',
            'aria-pressed': String(scope === 'all'),
            onclick: () => { scope = 'all'; rerender(); }
          }, 'All of them')),
        h('div', { class: 'eyebrow', style: { marginTop: '5px', color: 'var(--ink-3)' } },
          repeatLabel(live)),
        scope === 'one'
          ? h('div', { class: 'eyebrow', style: { marginTop: '3px', color: 'var(--ink-3)' } },
            'Area, kind, notes and subtasks belong to the series')
          : scope === 'after'
            ? h('div', { class: 'eyebrow', style: { marginTop: '3px', color: 'var(--ink-3)' } },
              'The next edit splits the series here')
            : null)));
  }

  props.append(prop('Area',
    h('select', {
      onchange: (e) => {
        // moving a Canvas assignment out of where the import put it takes
        // the rest of its course along (followCourse in the store); say so
        const course = live.canvasCourse, teaches = canvasUnmoved(live);
        set({ areaId: e.target.value || null }, { resync: true });
        if (teaches) {
          const n = state.items.filter((t) => t !== live && t.canvasCourse === course && t.areaId === live.areaId).length;
          if (n) toast(`${n} more from ${course} went along`);
        }
        rerender();
      }
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

  /* The repeat rule is the series', so it is only offered where it can be
     changed: on a one-off, or on an occurrence with "all of them" chosen. */
  if (!isOccurrence || toSeries) repeatRows(props, live, rerender);

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
            commit(() => live.subtasks.splice(i, 1));
            rerender();
          }
        }
      }),
      h('button', { class: 'btn ghost sm', onclick: () => { commit(() => live.subtasks.splice(i, 1)); rerender(); }, 'aria-label': 'Remove subtask' }, '✕')));
  });
  body.append(subs);

  function addSub(at = live.subtasks.length) {
    commit(() => live.subtasks.splice(at, 0, { id: uid('st'), title: '', done: false }));
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
    oninput: debounce((e) => commit(() => { live.notes = e.target.value; }), 400)
  }, live.notes || ''));

  body.append(h('div', { class: 'eyebrow', style: { marginTop: '20px' } },
    `Created ${fmtDate(item.createdAt.slice(0, 10), { year: true })}`
    + (item.plan?.date ? ` · Planned ${fmtDate(item.plan.date)}${item.plan.start ? ' ' + item.plan.start : ''} · ${fmtDuration(item.plan.mins)}` : '')));

  root.append(head, body);
  return root;
}

function prop(label, control) {
  return h('div', { class: 'prop' }, h('label', {}, label), control);
}

/* ---------------- repeating ----------------
   Google Calendar's vocabulary, in the panel rather than behind a "Custom…"
   dialog: how often, how many of them apart, which weekdays, and when it
   stops. A rule needs a day to count from — the block's date or the deadline —
   so an item with neither cannot repeat and is not asked to. */

const UNIT = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };
const FREQ_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

function repeatRows(props, live, rerender) {
  const anchor = (live.plan && live.plan.date) || live.due || null;
  if (!anchor) return;

  const rep = live.repeat;
  const write = (next) => {
    commit(() => upsertItem({ id: live.id, repeat: next }));
    pushItem(live.id).catch(() => {});
    rerender();
  };
  // the exceptions are kept across a change of rule: a week you cancelled
  // stays cancelled when you move the series from Tuesdays to Wednesdays
  const edit = (patch) => write({
    freq: 'weekly', every: 1, days: [], until: null, count: null, ex: {},
    ...(rep || {}), ...patch
  });

  props.append(prop('Repeat',
    h('select', {
      onchange: (e) => (e.target.value ? edit({ freq: e.target.value }) : write(null))
    },
    h('option', { value: '', selected: !rep }, 'Does not repeat'),
    ...Object.keys(FREQ_LABEL).map((f) =>
      h('option', { value: f, selected: rep && rep.freq === f }, FREQ_LABEL[f])))));

  if (!rep) return;

  props.append(prop('Every',
    h('div', { class: 'pair', style: { alignItems: 'center' } },
      h('input', {
        type: 'number', min: '1', max: '99', value: String(rep.every || 1),
        style: { maxWidth: '80px' },
        onchange: (e) => edit({ every: Math.min(99, Math.max(1, Math.round(+e.target.value) || 1)) })
      }),
      h('span', { class: 'eyebrow' }, UNIT[rep.freq]))));

  if (rep.freq === 'weekly') {
    const chosen = new Set(rep.days && rep.days.length ? rep.days : [new Date(anchor + 'T00:00').getDay()]);
    props.append(prop('On',
      h('div', { class: 'daypick' },
        ...DOW.map((name, d) => h('button', {
          type: 'button', class: 'day' + (chosen.has(d) ? ' on' : ''),
          'aria-pressed': String(chosen.has(d)), title: name,
          onclick: () => {
            const next = new Set(chosen);
            if (next.has(d)) next.delete(d); else next.add(d);
            // a weekly repeat with no weekday at all has no days in it
            if (next.size) edit({ days: [...next].sort((x, y) => x - y) });
          }
        }, name[0])))));
  }

  const ends = rep.count ? 'count' : rep.until ? 'until' : 'never';
  props.append(prop('Ends',
    h('div', { class: 'pair', style: { alignItems: 'center' } },
      h('select', {
        onchange: (e) => edit(
          e.target.value === 'until' ? { until: addMonths(anchor, 3), count: null }
            : e.target.value === 'count' ? { count: 10, until: null }
              : { until: null, count: null })
      },
      h('option', { value: 'never', selected: ends === 'never' }, 'Never'),
      h('option', { value: 'until', selected: ends === 'until' }, 'On a date'),
      h('option', { value: 'count', selected: ends === 'count' }, 'After')),
      ends === 'until' ? h('input', {
        type: 'date', value: rep.until || '',
        onchange: (e) => edit({ until: e.target.value || null, count: null })
      }) : null,
      ends === 'count' ? h('input', {
        type: 'number', min: '1', max: '400', value: String(rep.count || 10),
        style: { maxWidth: '80px' },
        onchange: (e) => edit({ count: Math.min(400, Math.max(1, Math.round(+e.target.value) || 1)), until: null })
      }) : null,
      ends === 'count' ? h('span', { class: 'eyebrow' }, 'times') : null)));

  props.append(prop('', h('div', { class: 'eyebrow', style: { color: 'var(--ink-3)' } },
    repeatLabel(live))));
}

/** A date `n` months on, clamped to the end of a shorter month. */
function addMonths(date, n) {
  const d = new Date(date + 'T00:00');
  const day = d.getDate();
  const m = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const out = new Date(m.getFullYear(), m.getMonth(), Math.min(day, last));
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
}

/* ---------------- deleting ----------------
   A one-off asks whether you meant it. A repeating one has to ask *what* you
   meant as well, because there are three honest answers and picking one for
   you would either lose a term of Tuesdays or leave a cancelled one standing. */

async function removePlain(item) {
  if (!await confirmDialog('Delete this task?', item.title, 'Delete')) return;
  const snapshot = JSON.parse(JSON.stringify(item));
  // its Google event goes with it — queued before the row is gone, since the
  // queue needs the event ids the row holds
  forgetItem(item);
  // tagged so the view underneath repaints — the peek floats over whichever
  // view is showing, and it still lists this item
  commit(() => deleteItem(item.id), { source: 'editor' });
  closePeek();
  toast('Task deleted', {
    action: 'Undo',
    // stamped now, like the store's own undo: put back with its old clock the
    // server keeps the tombstone, and the next full sync deletes it here too
    onAction: () => commit(() => {
      snapshot.updatedAt = new Date().toISOString();
      state.items.push(snapshot);
    }, { source: 'editor' })
  });
}

function removeOccurrence(item, live) {
  const on = fmtDate(item.occurrence, { weekday: true });
  const undo = JSON.parse(JSON.stringify(live));
  const done = (msg) => {
    closeModal();
    closePeek();
    pushItem(live.id).catch(() => {});
    toast(msg, {
      action: 'Undo',
      onAction: () => commit(() => {
        undo.updatedAt = new Date().toISOString();
        const i = state.items.findIndex((t) => t.id === undo.id);
        if (i >= 0) state.items[i] = undo; else state.items.push(undo);
      }, { source: 'editor' })
    });
  };

  modal({
    title: 'Delete a repeating event',
    body: h('div', {},
      h('p', { style: { margin: '0 0 6px' } }, item.title),
      h('div', { class: 'eyebrow' }, repeatLabel(live))),
    footer: [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn', onclick: () => {
          commit(() => endSeriesBefore(live, item.occurrence), { source: 'editor' });
          done(`Series ended before ${on}`);
        }
      }, 'This and after'),
      h('button', {
        class: 'btn', onclick: () => {
          forgetItem(live);          // every occurrence's event, before the row goes
          commit(() => deleteItem(live.id), { source: 'editor' });
          done('Series deleted');
        }
      }, 'All of them'),
      h('button', {
        class: 'btn primary', onclick: () => {
          commit(() => deleteItem(item.id), { source: 'editor' });
          done(`${on} skipped`);
        }
      }, 'This one')
    ]
  });
}
