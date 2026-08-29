// views/areas.js — a category page (its areas, each with its next deadlines)
// and the drill-down into one area's full list. Both shapes live here because
// they render the same rows from the same data; only the scope differs.

import { h, clear, fmtTime, DOW } from '../util.js';
import {
  state, commit, toggleItem, upsertArea, deleteArea, areasInCategory, itemsForArea,
  nextForArea, categoryById, areaById, AREA_CATEGORIES, AREA_COLORS, progress
} from '../store.js';
import { modal, closeModal, confirmDialog, toast, dueChip, priorityTag, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { openSyllabusImport } from '../syllabus.js';
import { pushItem, recurringSeries, gcal } from '../gcal.js';

const PREVIEW = 3;   // deadlines shown under each area before "see all"

/* ---------------- category page ---------------- */

export function renderCategory(root, { navigate, go }, categoryId) {
  clear(root);
  const cat = categoryById(categoryId);
  const pad = h('div', { class: 'pad' });
  const areas = areasInCategory(categoryId);
  const archived = areasInCategory(categoryId, { includeArchived: true }).filter((a) => a.archived);

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('h1', {}, cat.label),
      cat.note ? h('div', { class: 'eyebrow' }, cat.note) : null),
    h('div', { style: { flex: 1 } }),
    categoryId === 'course'
      ? h('button', { class: 'btn', onclick: () => openSyllabusImport(navigate) }, 'Import syllabus')
      : null,
    h('button', {
      class: 'btn primary',
      onclick: () => editArea(null, categoryId, navigate)
    }, `+ New ${cat.singular}`)));

  if (!areas.length && !archived.length) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, `No ${cat.singular}s yet`),
      h('p', { style: { margin: '4px 0 12px', color: 'var(--ink-2)' } }, emptyBlurb(categoryId)),
      h('button', {
        class: 'btn primary', onclick: () => editArea(null, categoryId, navigate)
      }, `Add your first ${cat.singular}`)));
  }

  for (const a of [...areas, ...archived]) pad.append(areaGroup(a, { navigate, go }));
  root.append(pad);
}

function emptyBlurb(categoryId) {
  switch (categoryId) {
    case 'course': return 'Add the courses you are taking, then import a syllabus to fill in the deadlines.';
    case 'ner': return 'Subteams and workstreams for Northeastern Electric Racing.';
    case 'project': return 'Anything you are building that is not a course.';
    default: return 'Appointments, applications, errands — work that is yours alone.';
  }
}

/** One area: its header, meeting times, and the next few things due. */
function areaGroup(a, { navigate, go }) {
  const mine = itemsForArea(a.id);
  const done = mine.filter((t) => t.done).length;
  const next = nextForArea(a.id, PREVIEW);
  const openCount = mine.length - done;

  const body = h('div', { class: 'area-body' });

  if ((a.schedule || []).length) {
    body.append(h('div', { class: 'eyebrow num area-when' },
      a.schedule.map((m) =>
        `${(m.days || []).map((d) => DOW[d]).join('/')} ${fmtTime(m.start, state.settings.hour12)}–${fmtTime(m.end, state.settings.hour12)}`
        + (m.location ? ` · ${m.location}` : '')).join('   ')));
  }

  if (!next.length) {
    body.append(h('div', { class: 'area-none' },
      mine.length ? 'Everything here is done.' : 'Nothing scheduled yet.'));
  }
  for (const t of next) body.append(taskRow(t, navigate));

  if (openCount > next.length) {
    body.append(h('button', {
      class: 'btn ghost sm area-more', onclick: () => go(`area/${a.id}`)
    }, `see all ${openCount} →`));
  }

  return h('section', { class: 'area-group' + (a.archived ? ' is-archived' : '') },
    h('div', { class: 'area-h' },
      h('span', { class: 'dot', style: { background: a.color } }),
      h('button', { class: 'area-name', onclick: () => go(`area/${a.id}`) }, a.name),
      h('span', { class: 'eyebrow num' }, `${done}/${mine.length}`),
      h('div', { style: { flex: 1 } }),
      grade(mine),
      h('button', { class: 'btn sm ghost', onclick: () => editArea(a, a.category, navigate) }, 'Edit'),
      a.category === 'course'
        ? h('button', { class: 'btn sm ghost', onclick: () => openSyllabusImport(navigate, a.id) }, 'Syllabus')
        : null),
    body);
}

function grade(items) {
  const graded = items.filter((t) => t.grade && t.grade.score != null && t.grade.outOf);
  if (!graded.length) return null;
  const earned = graded.reduce((n, t) => n + t.grade.score, 0);
  const outOf = graded.reduce((n, t) => n + t.grade.outOf, 0);
  if (!outOf) return null;
  return h('span', { class: 'eyebrow num', title: `${graded.length} graded` },
    ((earned / outOf) * 100).toFixed(1) + '%');
}

function taskRow(t, rerender) {
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    h('input', {
      type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); pushItem(t.id).catch(() => {}); rerender(); }
    }),
    h('span', { class: 'title' }, t.title),
    meta(priorityTag(t.priority), dueChip(t)));
}

/* ---------------- one area, everything in it ---------------- */

export function renderArea(root, { navigate, go }, areaId) {
  clear(root);
  const a = areaById(areaId);
  if (!a) { go('overview'); return; }

  const cat = categoryById(a.category);
  const pad = h('div', { class: 'pad' });
  const mine = itemsForArea(a.id);
  const open = mine.filter((t) => !t.done);
  const done = mine.filter((t) => t.done);

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('button', { class: 'crumb eyebrow', onclick: () => go(cat.id) }, `← ${cat.label}`),
      h('h1', { style: { display: 'flex', alignItems: 'center', gap: '9px' } },
        h('span', { class: 'dot', style: { background: a.color } }), a.name)),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn', onclick: () => editArea(a, a.category, navigate) }, 'Edit'),
    a.category === 'course'
      ? h('button', { class: 'btn', onclick: () => openSyllabusImport(navigate, a.id) }, 'Syllabus')
      : null));

  if (!mine.length) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, 'Nothing here yet'),
      h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
        'Add work from the bar up top — it lands here when you tag it ' + a.name + '.')));
  }

  if (open.length) {
    pad.append(h('div', { class: 'group-h' },
      h('h2', {}, 'Open'), h('span', { class: 'eyebrow num' }, String(open.length))));
    for (const t of sortByDue(open)) pad.append(fullRow(t, navigate));
  }
  if (done.length) {
    pad.append(h('div', { class: 'group-h' },
      h('h2', {}, 'Done'), h('span', { class: 'eyebrow num' }, String(done.length))));
    for (const t of sortByDue(done)) pad.append(fullRow(t, navigate));
  }

  root.append(pad);
}

const sortByDue = (list) => list.slice().sort((a, b) => {
  const da = a.due || a.plan?.date || '9999-99-99';
  const db = b.due || b.plan?.date || '9999-99-99';
  return da < db ? -1 : da > db ? 1 : a.title.localeCompare(b.title);
});

function fullRow(t, rerender) {
  const pct = Math.round(progress(t) * 100);
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    h('input', {
      type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); pushItem(t.id).catch(() => {}); rerender(); }
    }),
    h('span', { class: 'title' },
      t.title,
      t.subtasks.length ? h('span', { class: 'eyebrow num', style: { marginLeft: '8px' } }, `${pct}%`) : null),
    meta(priorityTag(t.priority), dueChip(t)));
}

/* ---------------- create / edit ---------------- */

function editArea(area, categoryId, navigate) {
  const draft = area
    ? JSON.parse(JSON.stringify(area))
    : {
      name: '', category: categoryId || 'course', location: '',
      color: AREA_COLORS[state.areas.length % AREA_COLORS.length], schedule: [], grading: []
    };

  const meetingsHost = h('div', {});

  function drawMeetings() {
    clear(meetingsHost);
    draft.schedule.forEach((m, i) => {
      meetingsHost.append(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '7px' } },
        h('div', { style: { display: 'flex', gap: '2px' } },
          ...DOW.map((label, d) => h('button', {
            class: 'preset', type: 'button',
            'aria-pressed': String((m.days || []).includes(d)),
            style: { padding: '3px 8px' },
            onclick: (e) => {
              m.days = m.days || [];
              const at = m.days.indexOf(d);
              if (at >= 0) m.days.splice(at, 1); else m.days.push(d);
              e.target.setAttribute('aria-pressed', String(m.days.includes(d)));
            }
          }, label[0]))),
        h('input', { type: 'time', value: m.start || '', style: { maxWidth: '120px' }, onchange: (e) => { m.start = e.target.value; } }),
        h('input', { type: 'time', value: m.end || '', style: { maxWidth: '120px' }, onchange: (e) => { m.end = e.target.value; } }),
        h('input', { type: 'text', placeholder: 'Room', value: m.location || '', style: { maxWidth: '130px' }, onchange: (e) => { m.location = e.target.value; } }),
        h('button', { class: 'btn ghost sm', onclick: () => { draft.schedule.splice(i, 1); drawMeetings(); } }, '✕')));
    });
    meetingsHost.append(h('button', {
      class: 'btn ghost sm',
      onclick: () => { draft.schedule.push({ days: [], start: '10:30', end: '11:35', location: '' }); drawMeetings(); }
    }, '+ Add meeting time'));
  }
  drawMeetings();

  const custom = h('input', {
    type: 'color', value: draft.color, style: { width: '38px', height: '26px', padding: '2px' },
    oninput: (e) => { draft.color = e.target.value; }
  });
  const swatches = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
    ...AREA_COLORS.map((c) => h('button', {
      type: 'button', 'aria-label': c,
      style: {
        width: '22px', height: '22px', borderRadius: '50%', background: c, cursor: 'pointer',
        border: c === draft.color ? '2px solid var(--ink)' : '1px solid var(--rule)'
      },
      onclick: (e) => {
        draft.color = c;
        [...e.target.parentElement.children].forEach((b) => { b.style.border = '1px solid var(--rule)'; });
        e.target.style.border = '2px solid var(--ink)';
        custom.value = c;
      }
    })));

  const picker = calendarPicker(draft, () => drawMeetings(), {
    get nameInput() { return nameInput; },
    get locationInput() { return locationInput; }
  });

  const nameInput = h('input', {
    type: 'text', value: draft.name, placeholder: 'Thermodynamics II',
    oninput: (e) => { draft.name = e.target.value; }
  });
  const locationInput = h('input', {
    type: 'text', value: draft.location, placeholder: 'Snell 108',
    oninput: (e) => { draft.location = e.target.value; }
  });

  modal({
    title: area ? 'Edit area' : `New ${categoryById(draft.category).singular}`,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'field' },
        h('label', {}, 'Name'),
        nameInput),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        h('div', { class: 'field' },
          h('label', {}, 'Category'),
          h('select', { onchange: (e) => { draft.category = e.target.value; } },
            ...AREA_CATEGORIES.map((c) =>
              h('option', { value: c.id, selected: c.id === draft.category }, c.label)))),
        h('div', { class: 'field' },
          h('label', {}, 'Default location'),
          locationInput)),
      h('div', { class: 'field' },
        h('label', {}, 'Color'),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, swatches, custom)),
      h('div', { class: 'field' },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
          h('label', { style: { flex: 1 } }, 'Recurring meetings'),
          picker.button),
        picker.host,
        meetingsHost)),
    footer: [
      area && h('button', {
        class: 'btn danger', onclick: async () => {
          closeModal();
          if (await confirmDialog('Delete this area?', `${area.name} — its tasks stay, but lose their area.`, 'Delete')) {
            commit(() => deleteArea(area.id));
            navigate();
          }
        }
      }, 'Delete'),
      area && h('button', {
        class: 'btn', onclick: () => {
          commit(() => { area.archived = !area.archived; });
          closeModal();
          navigate();
        }
      }, area.archived ? 'Restore' : 'Archive'),
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: () => {
          if (!draft.name.trim()) { toast('Give the area a name first.'); return; }
          commit(() => upsertArea(area ? { ...draft, id: area.id } : draft));
          closeModal();
          navigate();
        }
      }, area ? 'Save changes' : 'Create')
    ]
  });
}


/* ---------------- pull a schedule off Google Calendar ---------------- */

/**
 * Anything repeating on the synced calendar can become an area's schedule:
 * a lecture, a lab, a weekly NER meeting. Days, times, room and name all come
 * from what the event actually does, so there is nothing to retype.
 *
 * This expands inside the editor rather than opening a second modal — ui.js
 * keeps one modal at a time, so a modal on top would close the editor under it.
 */
function calendarPicker(draft, redrawMeetings, fields) {
  const series = gcal.status === 'off' ? [] : recurringSeries();
  const host = h('div', { class: 'series-host', hidden: true });
  if (!series.length) return { button: null, host };

  const button = h('button', {
    class: 'btn sm ghost', type: 'button',
    onclick: () => { host.hidden = !host.hidden; if (!host.hidden) draw(); }
  }, 'Pull from calendar');

  function draw() {
    clear(host);
    host.append(h('div', { class: 'eyebrow series-note' },
      'Repeating events on your calendar — picking one fills the times below'));
    for (const sx of series) {
      host.append(h('button', {
        class: 'series', type: 'button',
        onclick: () => {
          draft.schedule = sx.schedule.map((r) => ({ ...r, days: [...r.days] }));
          if (!draft.name.trim()) { draft.name = sx.title; fields.nameInput.value = sx.title; }
          if (!draft.location && sx.location) {
            draft.location = sx.location;
            fields.locationInput.value = sx.location;
          }
          redrawMeetings();
          host.hidden = true;
          toast(`Filled from “${sx.title}”`);
        }
      },
      h('div', { class: 'series-title' }, sx.title),
      h('div', { class: 'eyebrow num series-when' }, describe(sx)),
      sx.location ? h('div', { class: 'eyebrow series-where' }, sx.location) : null));
    }
  }

  return { button, host };
}

function describe(sx) {
  const when = sx.schedule.map((r) =>
    `${r.days.map((d) => DOW[d]).join('/')} ${fmtTime(r.start, state.settings.hour12)}`
    + (r.end ? `–${fmtTime(r.end, state.settings.hour12)}` : '')).join('   ');
  return `${when}   ·   ${sx.count} meetings`;
}
