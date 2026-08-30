// sprint.js — naming a stretch of the term, and saying what finishes it.
//
// Two kinds of band, one object. A **focus** is the theme of a few weeks —
// "get the nozzle characterised" — and carries nothing but its name, because
// a theme with a checklist stapled to it is just a task list with a worse
// name. A **sprint** is a work package, a fortnight or so, and carries the
// deliverables that decide when it is done.
//
// The deliverables are where SMART lives, and it lives in the wording rather
// than in five labelled boxes: "3 hot-fire runs logged by Oct 12" is specific,
// measurable and time-bound in one line, and five fields would have produced
// four of them empty. The placeholder says so; nothing enforces it.

import { h, fmtDate, diffDays, debounce } from './util.js';
import {
  commit, upsertSprint, deleteSprint, sprintById, sprintProgress,
  addDeliverable, updateDeliverable, deleteDeliverable,
  areasInCategory, areaById, AREA_CATEGORIES, SPRINT_KINDS
} from './store.js';
import { modal, closeModal, confirmDialog, toast } from './ui.js';

const KIND_LABEL = { focus: 'Focus', sprint: 'Sprint' };
const KIND_BLURB = {
  focus: 'The theme of these weeks. No deliverables — this one is for shape, not for scoring.',
  sprint: 'A work package. List what has to exist for it to be finished.'
};

/** How long a band runs, in the words anyone would use for it. */
export function describeSpan(p) {
  const days = diffDays(p.start, p.end) + 1;
  const weeks = Math.round(days / 7);
  const len = days < 10 ? `${days} day${days === 1 ? '' : 's'}` : `${weeks} week${weeks === 1 ? '' : 's'}`;
  return `${fmtDate(p.start)} → ${fmtDate(p.end)} · ${len}`;
}

/**
 * Open the editor for a band — an existing one by id, or a draft swept out on
 * the chart. A draft is not written until Create, so letting go of a drag by
 * accident and pressing Escape leaves nothing behind.
 */
export function openSprint(subject, { onDone } = {}) {
  const existing = typeof subject === 'string' ? sprintById(subject) : null;
  if (typeof subject === 'string' && !existing) return;
  const isNew = !existing;
  const draft = existing || {
    areaId: subject.areaId || null,
    kind: subject.kind || 'focus',
    title: '',
    start: subject.start,
    end: subject.end,
    deliverables: []
  };

  // an existing band saves as it is touched; a draft only exists in here
  const write = (patch) => {
    if (isNew) Object.assign(draft, patch);
    else commit(() => upsertSprint({ id: draft.id, ...patch }));
  };

  const spanOut = h('span', { class: 'eyebrow num' }, describeSpan(draft));
  const refreshSpan = () => { spanOut.textContent = describeSpan(draft); };

  const titleIn = h('input', {
    type: 'text', value: draft.title, 'aria-label': 'Name',
    placeholder: draft.kind === 'sprint' ? 'Nozzle characterisation' : 'Midterms',
    oninput: debounce((e) => write({ title: e.target.value }), 400),
    onkeydown: (e) => { if (e.key === 'Enter' && isNew) { e.preventDefault(); save(); } }
  });

  const startIn = h('input', {
    type: 'date', value: draft.start, 'aria-label': 'First day',
    onchange: (e) => {
      if (!e.target.value) { e.target.value = draft.start; return; }
      // dragging the start past the end takes the end with it rather than
      // silently swapping the two behind your back
      const end = e.target.value > draft.end ? e.target.value : draft.end;
      write({ start: e.target.value, end });
      draft.start = e.target.value; draft.end = end;
      endIn.value = end;
      refreshSpan();
    }
  });
  const endIn = h('input', {
    type: 'date', value: draft.end, 'aria-label': 'Last day',
    onchange: (e) => {
      if (!e.target.value) { e.target.value = draft.end; return; }
      const start = e.target.value < draft.start ? e.target.value : draft.start;
      write({ start, end: e.target.value });
      draft.start = start; draft.end = e.target.value;
      startIn.value = start;
      refreshSpan();
    }
  });

  const areaIn = h('select', {
    'aria-label': 'Area', onchange: (e) => write({ areaId: e.target.value || null })
  },
  h('option', { value: '', selected: !draft.areaId }, 'No area'),
  ...AREA_CATEGORIES.map((c) => {
    const mine = areasInCategory(c.id);
    return mine.length
      ? h('optgroup', { label: c.label },
        ...mine.map((a) => h('option', { value: a.id, selected: a.id === draft.areaId }, a.name)))
      : null;
  }));

  const delivHost = h('div', { class: 'deliv' });
  const blurb = h('p', { class: 'deliv-blurb' }, KIND_BLURB[draft.kind]);

  const kindIn = h('div', { class: 'mode-toggle' }, ...SPRINT_KINDS.map((k) => h('button', {
    class: 'mode' + (draft.kind === k ? ' on' : ''), 'aria-pressed': String(draft.kind === k),
    onclick: () => {
      draft.kind = k;
      write({ kind: k });
      for (const b of kindIn.children) {
        const on = b.textContent === KIND_LABEL[k];
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      blurb.textContent = KIND_BLURB[k];
      titleIn.placeholder = k === 'sprint' ? 'Nozzle characterisation' : 'Midterms';
      drawDeliverables();
    }
  }, KIND_LABEL[k])));

  function drawDeliverables() {
    delivHost.replaceChildren();
    if (draft.kind !== 'sprint') return;
    if (isNew) {
      delivHost.append(h('p', { class: 'deliv-blurb' },
        'Create it first, then the deliverables go here.'));
      return;
    }
    const pct = sprintProgress(draft);
    delivHost.append(h('div', { class: 'group-h' },
      h('h2', {}, 'Deliverables'),
      h('span', { class: 'eyebrow num' },
        pct === null ? 'none yet'
          : `${draft.deliverables.filter((d) => d.done).length}/${draft.deliverables.length}`)));

    for (const d of draft.deliverables) {
      delivHost.append(h('div', { class: 'deliv-row' + (d.done ? ' done' : '') },
        h('input', {
          type: 'checkbox', class: 'check', checked: d.done,
          'aria-label': `Mark "${d.text}" delivered`,
          onchange: (e) => {
            commit(() => updateDeliverable(draft.id, d.id, { done: e.target.checked }));
            drawDeliverables();
            onDone?.();
          }
        }),
        h('input', {
          type: 'text', class: 'deliv-text', value: d.text, 'aria-label': 'Deliverable',
          oninput: debounce((e) => commit(() => updateDeliverable(draft.id, d.id, { text: e.target.value })), 400)
        }),
        h('button', {
          class: 'btn ghost sm', 'aria-label': `Remove "${d.text}"`,
          onclick: () => { commit(() => deleteDeliverable(draft.id, d.id)); drawDeliverables(); onDone?.(); }
        }, '×')));
    }

    const add = h('input', {
      type: 'text', class: 'deliv-add',
      placeholder: '3 hot-fire runs logged by Oct 12',
      'aria-label': 'Add a deliverable',
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        e.preventDefault();
        commit(() => addDeliverable(draft.id, e.target.value));
        drawDeliverables();
        delivHost.querySelector('.deliv-add')?.focus();
        onDone?.();
      }
    });
    delivHost.append(add);
  }
  drawDeliverables();

  function save() {
    const title = titleIn.value.trim();
    if (!title) { toast('Give it a name first.'); return; }
    let made;
    commit(() => { made = upsertSprint({ ...draft, title }); });
    closeModal();
    const where = areaById(made.areaId)?.name;
    toast(`${KIND_LABEL[made.kind]} · ${title}${where ? ' · ' + where : ''}`);
    onDone?.(made);
  }

  const footer = isNew
    ? [h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, 'Create')]
    : [h('button', {
      class: 'btn danger',
      onclick: async () => {
        if (!await confirmDialog(`Delete "${draft.title}"?`,
          'The band goes off the chart. Nothing else is touched.')) return;
        commit(() => deleteSprint(draft.id));
        closeModal();
        onDone?.();
      }
    }, 'Delete'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onclick: () => { closeModal(); onDone?.(draft); } }, 'Done')];

  modal({
    title: isNew ? 'New band' : draft.title || KIND_LABEL[draft.kind],
    body: h('div', { class: 'sprint-form' },
      h('div', { class: 'field' }, h('label', {}, 'Kind'), kindIn, blurb),
      h('div', { class: 'field' }, h('label', {}, 'Name'), titleIn),
      h('div', { class: 'field' },
        h('label', {}, 'From'),
        h('div', { class: 'time-range' }, startIn, h('span', {}, '→'), endIn, spanOut)),
      h('div', { class: 'field' }, h('label', {}, 'Area'), areaIn),
      delivHost),
    footer,
    onClose: () => { if (!isNew) onDone?.(draft); }
  });

  setTimeout(() => titleIn.focus(), 30);
}
