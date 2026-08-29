// views/courses.js — courses, projects, and any other area work belongs to.

import { h, clear, fmtTime, uid, DOW, debounce } from '../util.js';
import { state, commit, upsertArea, deleteArea, AREA_COLORS } from '../store.js';
import { modal, closeModal, confirmDialog, toast } from '../ui.js';
import { openSyllabusImport } from '../syllabus.js';

export function renderCourses(root, { navigate }) {
  clear(root);
  const pad = h('div', { class: 'pad' });

  pad.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' } },
    h('h1', {}, 'Courses & projects'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn', onclick: () => openSyllabusImport(navigate) }, 'Import syllabus'),
    h('button', { class: 'btn primary', onclick: () => editArea(null, navigate) }, '+ New area')));

  const active = state.areas.filter((a) => !a.archived);
  if (!active.length) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, 'No areas yet'),
      h('p', { style: { margin: '4px 0 12px', color: 'var(--ink-2)' } },
        'An area is a course, a research project, a job, an application push — anything work can belong to.'),
      h('button', { class: 'btn primary', onclick: () => editArea(null, navigate) }, 'Add your first area')));
  }

  const grid = h('div', { class: 'grid cols-2' });
  for (const a of state.areas) {
    const mine = state.items.filter((t) => t.areaId === a.id);
    const done = mine.filter((t) => t.done).length;
    const graded = mine.filter((t) => t.grade && t.grade.score != null && t.grade.outOf);
    const earned = graded.reduce((n, t) => n + t.grade.score, 0);
    const outOf = graded.reduce((n, t) => n + t.grade.outOf, 0);

    grid.append(h('section', { class: 'card', style: { opacity: a.archived ? .55 : 1 } },
      h('div', { class: 'card-h' },
        h('span', { class: 'dot', style: { background: a.color, width: '10px', height: '10px' } }),
        h('h2', {}, a.name),
        h('div', { style: { flex: 1 } }),
        h('span', { class: 'eyebrow num' }, `${done}/${mine.length}`)),
      h('div', { class: 'card-b' },
        h('div', { class: 'meter', style: { marginBottom: '10px' } },
          h('span', { style: { width: (mine.length ? (done / mine.length) * 100 : 0) + '%', background: a.color } })),
        (a.schedule || []).length
          ? h('div', { style: { marginBottom: '8px' } },
            ...a.schedule.map((m) => h('div', { class: 'eyebrow num', style: { marginBottom: '2px' } },
              `${(m.days || []).map((d) => DOW[d]).join(' / ')}  ${fmtTime(m.start, state.settings.hour12)}–${fmtTime(m.end, state.settings.hour12)}${m.location ? '  ' + m.location : ''}`)))
          : h('div', { class: 'eyebrow', style: { marginBottom: '8px', color: 'var(--ink-3)' } }, 'No recurring meetings'),
        outOf > 0
          ? h('div', { style: { fontSize: '13px', color: 'var(--ink-2)', marginBottom: '10px' } },
            h('span', { class: 'num', style: { fontWeight: 600, color: 'var(--ink)' } }, ((earned / outOf) * 100).toFixed(1) + '%'),
            ` across ${graded.length} graded ${graded.length === 1 ? 'item' : 'items'}`)
          : null,
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { class: 'btn sm', onclick: () => editArea(a, navigate) }, 'Edit'),
          h('button', { class: 'btn sm', onclick: () => openSyllabusImport(navigate, a.id) }, 'Syllabus'),
          h('button', {
            class: 'btn sm ghost', onclick: () => { commit(() => { a.archived = !a.archived; }); navigate(); }
          }, a.archived ? 'Restore' : 'Archive')))));
  }
  pad.append(grid);
  root.append(pad);
}

function editArea(area, navigate) {
  const draft = area
    ? JSON.parse(JSON.stringify(area))
    : { name: '', kind: 'course', color: AREA_COLORS[state.areas.length % AREA_COLORS.length], location: '', schedule: [], grading: [] };

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
  const custom = h('input', { type: 'color', value: draft.color, style: { width: '38px', height: '26px', padding: '2px' }, oninput: (e) => { draft.color = e.target.value; } });

  modal({
    title: area ? 'Edit area' : 'New area',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'field' },
        h('label', {}, 'Name'),
        h('input', { type: 'text', value: draft.name, placeholder: 'Thermodynamics II', oninput: (e) => { draft.name = e.target.value; } })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        h('div', { class: 'field' },
          h('label', {}, 'Kind'),
          h('select', { onchange: (e) => { draft.kind = e.target.value; } },
            ...['course', 'research', 'thesis', 'work', 'applications', 'personal'].map((k) =>
              h('option', { value: k, selected: k === draft.kind }, k[0].toUpperCase() + k.slice(1))))),
        h('div', { class: 'field' },
          h('label', {}, 'Default location'),
          h('input', { type: 'text', value: draft.location, placeholder: 'Snell 108', oninput: (e) => { draft.location = e.target.value; } }))),
      h('div', { class: 'field' },
        h('label', {}, 'Color'),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, swatches, custom)),
      h('div', { class: 'field' },
        h('label', {}, 'Recurring meetings'),
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
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: () => {
          if (!draft.name.trim()) { toast('Give the area a name first.'); return; }
          commit(() => upsertArea(area ? { ...draft, id: area.id } : draft));
          closeModal();
          navigate();
        }
      }, area ? 'Save changes' : 'Create area')
    ]
  });
}
