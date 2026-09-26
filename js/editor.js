// editor.js — the task page. Notion-style properties + notes + subtasks.

import { h, uid, fmtDate, fmtDuration, debounce, today, toMin, fromMin, DOW, addDays, diffDays } from './util.js';
import {
  state, commit, itemById, seriesById, splitOccurrence, repeatAnchor, upsertItem, deleteItem, progress,
  repeatLabel, endSeriesBefore, splitSeriesAt, duplicateItem, occurrenceId, canvasUnmoved, areaColor, AREA_COLORS, activeHabits
} from './store.js';
import { peek, closePeek, confirmDialog, modal, closeModal, toast, timeInput } from './ui.js';
import { pushItem, forgetItem } from './gcal.js';
import { tickItem, pushForward, pushLabel, canPush } from './actions.js';

const syncOut = debounce((id) => pushItem(id).catch(() => {}), 700);

/* The panel open: which thing (`id`), and which of the two an edit means
   when it is one occurrence of a series (`scope`: one, after, all). One
   object per panel, kept out here because `rerender()` builds the panel
   again from scratch and both must survive that; a split ("this and after")
   moves `id` on to the new series. A write still waiting in a debounce when
   the panel moved on to another task writes to the panel it came from.
   Scope defaults to the safe one: you cannot change a term of Tuesdays by
   mistake. */
let panel = null;

export function openItem(id) {
  const item = itemById(id);
  if (!item) return;
  panel = { id, scope: 'one' };
  show(item, panel);
}

function show(item, p) {
  peek(render(item, p), { onClose: () => { if (panel === p) panel = null; } });
}

/** Re-render the panel in place (after a structural change). */
function rerender() {
  if (!panel) return;
  const item = itemById(panel.id);
  if (!item) { closePeek(); return; }
  show(item, panel);
}

/* "All of them", from one occurrence: a when built from the day on screen
   would put the series' own day there, and every occurrence before it would
   go. The series keeps its day, moved by as many days as the edit moved this
   one — none, for a change of time, length or kind. */
function onSeries(patch, series, shown) {
  const anchor = series && repeatAnchor(series);
  if (!anchor || !shown) return patch;
  const move = (d) => (d ? addDays(anchor, diffDays(shown, d)) : d);
  const out = { ...patch };
  if (out.plan) out.plan = { ...out.plan, date: move(out.plan.date), ...(out.plan.end ? { end: move(out.plan.end) } : {}) };
  if (out.due) out.due = move(out.due);
  return out;
}

function render(item, p) {
  /* The row in `state.items` behind whatever is open — the item itself, or the
     series an occurrence came from — as it was when this was drawn, for
     reading. An occurrence is a copy made on demand, so anything written to
     it directly would be thrown away with it. */
  const live = seriesById(item.id) || item;
  const isOccurrence = !!item.seriesId;
  const toSeries = isOccurrence && p.scope === 'all';
  // the day this one shows on: what a when built from it is measured against
  const shown = (item.plan && item.plan.date) || item.due || null;

  /* Every write finds its row by id, at the time of writing. An undo, a save
     in another tab or a pull puts a new object where the old one was, and a
     write to the one this drawing began with would go nowhere. */
  const row = () => seriesById(p.id);
  // gone from under the panel — a pull or another tab deleted it. Writing
  // by its id would make it again, as a ghost with default fields.
  const gone = () => { toast('That task was deleted elsewhere.'); if (panel === p) closePeek(); };

  const set = (patch, { resync = false } = {}) => {
    const cut = splitOccurrence(p.id);
    /* This and after: the occurrence shown and every one past it become a
       series of their own, carrying the edit, and the old series ends the day
       before. From then on the panel is on the new series, editing all of it
       — which is what "and after" meant. A title being typed is not redrawn
       under the caret; the next keystroke finds the new series through `p`. */
    if (cut && p.scope === 'after') {
      const series = row();
      if (!series) { gone(); return; }
      let made = null;
      commit(() => { made = splitSeriesAt(series, cut.on, patch); }, { source: 'editor' });
      if (!made) return;
      pushItem(series.id).catch(() => {});
      pushItem(made.id).catch(() => {});
      p.id = occurrenceId(made.id, patch.plan?.date || patch.due || cut.on);
      p.scope = 'all';
      const onlyTitle = Object.keys(patch).every((k) => k === 'title');
      if (!onlyTitle) rerender();
      return;
    }
    const id = cut && p.scope === 'all' ? cut.id : p.id;
    if (!itemById(id)) { gone(); return; }
    let next = null;
    // tagged: the panel floats over a view that lists this item, and that
    // view repaints only for a source it knows
    commit(() => {
      next = upsertItem({ id, ...(id === p.id ? patch : onSeries(patch, seriesById(id), shown)) });
    }, { source: 'editor', touches: ['items'] });
    // keep the copy this render is holding in step with what was stored
    if (next && id === item.id) Object.assign(item, next);
    if (resync) syncOut(id);
  };

  /* A write to what belongs to the series — subtasks, notes — on the row as
     it is now, stamped, and tagged so the view under the panel repaints. */
  const editRow = (fn) => {
    const r = row();
    if (!r) { gone(); return; }
    commit(() => { fn(r); r.updatedAt = new Date().toISOString(); }, { source: 'editor', touches: ['items'] });
  };
  // a subtask by its id on that row, or by its place for one older than ids
  const subOf = (r, s, i) => r.subtasks.find((x, j) => (s.id ? x.id === s.id : j === i)) || null;

  const root = h('div', { style: { display: 'contents' } });

  /* header */
  const head = h('div', { class: 'peek-h' },
    h('input', {
      type: 'checkbox', class: 'check', checked: item.done,
      'aria-label': 'Mark complete',
      // p.id, not item.id: after a split the panel is on the new series
      onchange: (e) => tickItem(p.id, e.target.checked, { after: rerender })
    }),
    item.done ? h('span', { class: 'eyebrow' }, 'Done') : null,
    h('div', { style: { flex: 1 } }),
    (item.gcalId || live.gcalIds) && h('span', { class: 'eyebrow', title: 'On your Google Calendar' }, 'GCAL'),
    live.canvasId && h('span', { class: 'eyebrow', title: 'From your Canvas feed' + (live.canvasCourse ? ' · ' + live.canvasCourse : '') }, 'CANVAS'),
    canPush(item) && h('button', {
      class: 'btn ghost sm', title: pushLabel(item),
      onclick: () => pushForward(p.id, { after: rerender })
    }, '→'),
    h('button', {
      class: 'btn ghost sm', title: isOccurrence ? 'Duplicate the series' : 'Duplicate',
      onclick: () => {
        let made = null;
        commit(() => { made = duplicateItem(p.id); }, { source: 'editor' });
        if (made) { toast('Copied'); openItem(made.id); }
      }
    }, '⧉'),
    h('button', {
      class: 'btn ghost sm', title: 'Delete task',
      onclick: () => {
        const now = itemById(p.id);
        if (!now) { gone(); return; }
        if (now.seriesId) removeOccurrence(now); else removePlain(now);
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

  /* One of a series: say so, and say which of the two an edit means. */
  if (isOccurrence) {
    props.append(prop('Repeats',
      h('div', {},
        h('div', { class: 'mode-toggle' },
          h('button', {
            class: 'mode' + (p.scope === 'one' ? ' on' : ''), type: 'button',
            'aria-pressed': String(p.scope === 'one'),
            onclick: () => { p.scope = 'one'; rerender(); }
          }, 'This one'),
          h('button', {
            class: 'mode' + (p.scope === 'after' ? ' on' : ''), type: 'button',
            'aria-pressed': String(p.scope === 'after'),
            title: 'This one and every one after it',
            onclick: () => { p.scope = 'after'; rerender(); }
          }, 'This and after'),
          h('button', {
            class: 'mode' + (p.scope === 'all' ? ' on' : ''), type: 'button',
            'aria-pressed': String(p.scope === 'all'),
            onclick: () => { p.scope = 'all'; rerender(); }
          }, 'All of them')),
        h('div', { class: 'eyebrow', style: { marginTop: '5px', color: 'var(--ink-3)' } },
          repeatLabel(live)),
        p.scope === 'one'
          ? h('div', { class: 'eyebrow', style: { marginTop: '3px', color: 'var(--ink-3)' } },
            'Area, kind, notes and subtasks belong to the series')
          : p.scope === 'after'
            ? h('div', { class: 'eyebrow', style: { marginTop: '3px', color: 'var(--ink-3)' } },
              'The next edit splits the series here')
            : null)));
  }

  props.append(prop('Area',
    h('select', {
      onchange: (e) => {
        // moving a Canvas assignment out of where the import put it takes
        // the rest of its course along (followCourse in the store); say so
        const lead = row() || live;
        const course = lead.canvasCourse, teaches = canvasUnmoved(lead);
        set({ areaId: e.target.value || null }, { resync: true });
        const now = row();
        if (teaches && now) {
          const n = state.items.filter((t) => t !== now && t.canvasCourse === course && t.areaId === now.areaId).length;
          if (n) toast(`${n} more from ${course} went along`);
        }
        rerender();
      }
    },
    h('option', { value: '' }, 'Unassigned'),
    ...state.areas.filter((a) => !a.archived).map((a) =>
      h('option', { value: a.id, selected: a.id === item.areaId }, a.name)))));

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
    // a stretch of days keeps its `end` only while it is after the first day
    const stretch = (date, end) => ({ date, start: null, mins: 0, ...(end && end > date ? { end } : {}) });
    props.append(prop('Date',
      h('input', {
        type: 'date', value: plan.date || '',
        onchange: (e) => { set({ plan: stretch(e.target.value || today(), plan.end) }, { resync: true }); rerender(); }
      })));
    props.append(prop('Until',
      h('input', {
        type: 'date', value: plan.end || '', min: plan.date || '', title: 'The last day, for a stretch of days',
        onchange: (e) => { set({ plan: stretch(plan.date, e.target.value) }, { resync: true }); rerender(); }
      })));
  } else if (scheduled) {
    // wrapped: a block that runs past midnight ends the next morning
    const endOf = (b) => fromMin((toMin(b.start || '09:00') + (b.mins || 60)) % (24 * 60));
    props.append(prop('Date',
      h('input', {
        type: 'date', value: plan.date || '',
        onchange: (e) => { set({ plan: { ...plan, date: e.target.value || today() } }, { resync: true }); rerender(); }
      })));
    props.append(prop('From',
      h('div', { class: 'pair', style: { alignItems: 'center' } },
        timeInput({
          value: plan.start || '',
          onchange: (e) => {
            set({ plan: { ...plan, start: e.target.value || '09:00' } }, { resync: true });
            rerender();
          }
        }),
        h('span', { class: 'eyebrow' }, 'to'),
        timeInput({
          value: endOf(plan),
          onchange: (e) => {
            // stored as a duration; an end before the start is the next morning
            let mins = toMin(e.target.value) - toMin(plan.start || '09:00');
            if (mins < 0) mins += 24 * 60;
            if (mins === 0) { toast('The end has to come after the start.'); rerender(); return; }
            set({ plan: { ...plan, mins }, estMins: mins }, { resync: true });
            rerender();
          }
        }))));
  } else {
    props.append(prop('Due',
      h('div', { class: 'pair' },
        h('input', { type: 'date', value: item.due || '', onchange: (e) => set({ due: e.target.value || null }, { resync: true }) }),
        timeInput({ value: item.dueTime || '', blank: true, 'aria-label': 'Due at', onchange: (e) => set({ dueTime: e.target.value || null }) }))));

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
      ...['low', 'normal', 'high'].map((v) => h('option', { value: v, selected: v === item.priority }, v[0].toUpperCase() + v.slice(1))))));

  // the area's colour unless one is picked for this alone
  const own = item.color || null;
  const swatch = (col, label) => h('button', {
    type: 'button', class: 'swatch' + (col === own ? ' on' : ''), title: label, 'aria-label': label,
    'aria-pressed': String(col === own), style: { '--c': col || areaColor(item.areaId) },
    onclick: () => { set({ color: col }); rerender(); }
  }, col ? '' : 'A');
  props.append(prop('Colour', h('div', { class: 'swatches' },
    swatch(null, "The area's colour"), ...AREA_COLORS.map((col) => swatch(col, col)))));

  // a task tied to a habit: ticking the task ticks the habit for that day
  const habits = activeHabits();
  if (habits.length || item.habitId) {
    props.append(prop('Habit',
      h('select', {
        'aria-label': 'Habit this counts for',
        title: 'Ticking this task ticks the habit for that day',
        onchange: (e) => set({ habitId: e.target.value || null })
      },
      h('option', { value: '', selected: !item.habitId }, 'None'),
      ...habits.map((x) => h('option', { value: x.id, selected: x.id === item.habitId }, x.name)))));
  }

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
        onchange: (e) => { editRow((r) => { const st = subOf(r, s, i); if (st) st.done = e.target.checked; }); rerender(); }
      }),
      h('input', {
        type: 'text', value: s.title,
        oninput: debounce((e) => editRow((r) => { const st = subOf(r, s, i); if (st) st.title = e.target.value; }), 400),
        onkeydown: (e) => {
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); addSub(i + 1); }
          if (e.key === 'Backspace' && !e.target.value) {
            e.preventDefault();
            removeSub(s, i);
          }
        }
      }),
      h('button', { class: 'btn ghost sm', onclick: () => removeSub(s, i), 'aria-label': 'Remove subtask' }, '✕')));
  });
  body.append(subs);

  function removeSub(s, i) {
    editRow((r) => { const j = r.subtasks.indexOf(subOf(r, s, i)); if (j >= 0) r.subtasks.splice(j, 1); });
    rerender();
  }

  function addSub(at = item.subtasks.length) {
    editRow((r) => r.subtasks.splice(Math.min(at, r.subtasks.length), 0, { id: uid('st'), title: '', done: false }));
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
    oninput: debounce((e) => editRow((r) => { r.notes = e.target.value; }), 400)
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
    // by id, and only while it is there: upsertItem would make a ghost of one deleted elsewhere
    if (!itemById(live.id)) { toast('That task was deleted elsewhere.'); closePeek(); return; }
    // tagged, or the view under the panel never repaints
    commit(() => upsertItem({ id: live.id, repeat: next }), { source: 'editor', touches: ['items'] });
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
  // the row as it is now: the dialog waited, and a pull or an undo may have
  // put a new one in its place
  const row = itemById(item.id);
  if (!row) { closePeek(); return; }
  const snapshot = JSON.parse(JSON.stringify(row));
  // its Google event goes with it — queued before the row is gone, since the
  // queue needs the event ids the row holds
  forgetItem(row);
  // tagged so the view underneath repaints — the peek floats over whichever
  // view is showing, and it still lists this item
  commit(() => deleteItem(row.id), { source: 'editor' });
  closePeek();
  toast('Task deleted', {
    action: 'Undo',
    onAction: () => {
      // Ctrl+Z may have put it back already: a second row with the one id
      // would draw twice and sync as one
      if (itemById(snapshot.id)) return;
      // stamped now, like the store's own undo: put back with its old clock the
      // server keeps the tombstone, and the next full sync deletes it here too
      commit(() => {
        snapshot.updatedAt = new Date().toISOString();
        state.items.push(snapshot);
      }, { source: 'editor' });
    }
  });
}

function removeOccurrence(item) {
  const live = seriesById(item.id);
  if (!live) { closePeek(); return; }
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
          const series = seriesById(item.id) || live;   // as it is now, not when the dialog opened
          commit(() => endSeriesBefore(series, item.occurrence), { source: 'editor' });
          // from its first one, "this and after" is the whole series, deleted:
          // its events go too, as for "All of them" (the row still holds their ids)
          if (itemById(series.id)) done(`Series ended before ${on}`);
          else { forgetItem(series); done('Series deleted'); }
        }
      }, 'This and after'),
      h('button', {
        class: 'btn', onclick: () => {
          const series = seriesById(item.id) || live;
          forgetItem(series);        // every occurrence's event, before the row goes
          commit(() => deleteItem(series.id), { source: 'editor' });
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
