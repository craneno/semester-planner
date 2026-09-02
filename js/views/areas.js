// views/areas.js — a category page (its areas, each with its next deadlines)
// and the drill-down into one area's full list. Both shapes live here because
// they render the same rows from the same data; only the scope differs.

import { h, clear, fmtTime, fmtDate, today, debounce, DOW, tz } from '../util.js';
import {
  state, commit, toggleItem, upsertArea, deleteArea, areasInCategory, itemsForArea,
  nextForArea, categoryById, areaById, reorderAreas, AREA_CATEGORIES, AREA_COLORS, progress,
  linksForArea, updateLink, deleteLink, addLink, cardsForArea,
  journalEntry, setJournalEntry, journalDates
} from '../store.js';
import { modal, closeModal, confirmDialog, toast, dueChip, priorityTag, meta, reorderable } from '../ui.js';
import { openItem } from '../editor.js';
import { openSyllabusImport } from '../syllabus.js';
import { pushItem, recurringSeries, gcal } from '../gcal.js';
import { noteCard } from '../capture.js';

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

  const groups = h('div', { class: 'area-groups' });
  for (const a of [...areas, ...archived]) groups.append(areaGroup(a, { navigate, go }));
  pad.append(groups);
  root.append(pad);

  reorderable(groups, {
    handle: '.drag-handle',
    onDrop: (ids) => { commit(() => reorderAreas(categoryId, ids)); navigate(); }
  });
}

function emptyBlurb(categoryId) {
  switch (categoryId) {
    case 'course': return 'Add the courses you are taking, then import a syllabus to fill in the deadlines.';
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

  return h('section', {
    class: 'area-group' + (a.archived ? ' is-archived' : ''),
    dataset: { reorderId: a.id }
  },
  h('div', { class: 'area-h' },
    h('button', { class: 'drag-handle', 'aria-label': `Reorder ${a.name}` }, '⠿'),
    h('span', { class: 'dot', style: { background: a.color } }),
      h('button', { class: 'area-name', onclick: () => go(`area/${a.id}`) }, a.name),
      h('span', { class: 'eyebrow num' }, `${done}/${mine.length}`),
      linksForArea(a.id).length
        ? h('span', { class: 'eyebrow num' }, `${linksForArea(a.id).length} links`)
        : null,
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn sm ghost', onclick: () => editArea(a, a.category, navigate) }, 'Edit'),
      a.category === 'course'
        ? h('button', { class: 'btn sm ghost', onclick: () => openSyllabusImport(navigate, a.id) }, 'Syllabus')
        : null),
    body);
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
  const links = linksForArea(a.id);
  const cards = cardsForArea(a.id);

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

  if (a.journal) pad.append(journalSection(a));

  if (!mine.length && !links.length && !cards.length && !a.journal) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, 'Nothing here yet'),
      h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
        'Add work from the bar up top — it lands here when you tag it ' + a.name
        + '. Paste a link there and it joins the pile below.')));
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
  if (cards.length) {
    pad.append(h('div', { class: 'group-h' },
      h('h2', {}, 'Notes'), h('span', { class: 'eyebrow num' }, String(cards.length))));
    for (const c of cards) pad.append(noteCard(c, navigate));
  }

  pad.append(linkSection(a, navigate));
  pad.append(freewriteSection(a));
  root.append(pad);
  fitBoxes(pad);
}

/* ---------------- the freewrite ----------------
   One box per area, below everything else: somewhere to think in sentences
   about work that is otherwise only ever a list of rows. No prompt, no dates,
   no history — the journal is where writing is kept a day at a time, and this
   is the page's margin.

   It saves as you type all the same. "Nothing special" means no button to
   press and nothing to name, not a box that throws your thinking away when
   you click Week. */

function freewriteSection(area) {
  const save = debounce((text) => commit(() => upsertArea({ id: area.id, freewrite: text })), 500);
  const box = h('textarea', {
    class: 'journal-box freewrite-box', rows: '1',
    'aria-label': `Freewrite for ${area.name}`,
    oninput: (e) => { autosize(e.target); save(e.target.value); }
  }, area.freewrite || '');

  return h('section', { class: 'card journal freewrite' },
    h('div', { class: 'card-h' },
      h('span', { class: 'eyebrow' }, 'Freewrite'),
      h('div', { style: { flex: 1 } }),
      h('span', { class: 'eyebrow', style: { color: 'var(--ink-3)' } }, 'saves itself')),
    h('div', { class: 'card-b' }, box));
}

/* ---------------- the daily journal ----------------
   A page to write on. There is no prompt above the box on purpose: a journal
   that asks a question is a form, and you answer a form instead of writing.
   Today is open; everything before it is a day at a time behind a dropdown,
   still editable, because a thought finished the next morning is normal. */

/**
 * Grow every writing box on the page to fit what is in it, and keep doing it.
 *
 * Re-fits on width rather than only on typing: a narrower window wraps the
 * same words onto more lines, and a box that hides its overflow would cut
 * text off silently. It also covers a box that had no width at all when it was
 * drawn, which is the only way to measure one badly wrong. Made per render, so
 * it is dropped with the boxes it watches.
 */
function fitBoxes(root) {
  const seen = new WeakMap();
  const fitter = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = e.contentRect.width;
      // width only: reacting to our own height change would never settle
      if (!w || seen.get(e.target) === w) continue;
      seen.set(e.target, w);
      autosize(e.target);
    }
  });
  for (const el of root.querySelectorAll('.journal-box')) fitter.observe(el);
}

function journalSection(area) {
  const day = today();
  const past = journalDates(area.id).filter((d) => d !== day);
  const box = (date) => entryBox(area, date);

  const card = h('section', { class: 'card journal' },
    h('div', { class: 'card-h' },
      h('span', { class: 'eyebrow' }, 'Today'),
      h('span', { class: 'journal-date' }, fmtDate(day, { weekday: true }))),
    h('div', { class: 'card-b' }, box(day)));

  if (past.length) {
    const list = h('div', { class: 'journal-past' },
      ...past.map((d) => h('div', { class: 'journal-day' },
        h('div', { class: 'eyebrow' }, fmtDate(d, { weekday: true })),
        box(d))));
    card.append(h('details', { class: 'history journal-history' },
      h('summary', {}, `Earlier entries (${past.length})`),
      list));
  }
  return card;
}

function entryBox(area, date) {
  // one debounce per box, not one shared: two days written in quick
  // succession would otherwise land as one save of whichever typed last
  const save = debounce((text) => commit(() => setJournalEntry(area.id, date, text)), 500);
  return h('textarea', {
    class: 'journal-box', rows: '1',
    'aria-label': `Journal entry for ${fmtDate(date, { weekday: true })}`,
    oninput: (e) => { autosize(e.target); save(e.target.value); }
  }, journalEntry(area.id, date));
}

/**
 * Grow with what is written in it; the floor is a min-height in the CSS.
 *
 * Never size from a box with no width. A textarea measured before it has one
 * wraps every word onto its own line and reports a height in the tens of
 * thousands of pixels — leaving the box short is recoverable, leaving it
 * thirty thousand pixels tall is not.
 */
function autosize(el) {
  if (!el.clientWidth) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* ---------------- links ----------------
   The pile of things to come back to. Titles are guessed from the URL — the
   page's own <title> is not readable across origins — so every one of them
   can be corrected in place. */

function linkSection(area, rerender) {
  const links = linksForArea(area.id);
  const host = h('div', {});

  const add = h('input', {
    class: 'link-new', type: 'url', placeholder: 'Paste a link…',
    'aria-label': `Add a link to ${area.name}`,
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      let made;
      commit(() => { made = addLink(e.target.value, { areaId: area.id }); });
      if (!made) { toast('That does not look like a web address.'); return; }
      e.target.value = '';
      rerender();
    }
  });

  host.append(h('div', { class: 'group-h' },
    h('h2', {}, 'Links'),
    h('span', { class: 'eyebrow num' }, String(links.length)),
    h('div', { style: { flex: 1 } }),
    add));

  if (!links.length) {
    host.append(h('div', { class: 'area-none' },
      `Nothing saved yet. Paste a link up top followed by "${hintFor(area)}" and it lands here.`));
  }
  for (const l of links) host.append(linkRow(l, rerender));
  return host;
}

/** The shortest thing you could type after a URL to reach this area. */
function hintFor(area) {
  const first = area.name.split(/\s+/)[0].toLowerCase();
  const clash = state.areas.some((x) => x.id !== area.id && !x.archived
    && x.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(first)));
  return clash ? area.name.toLowerCase() : first;
}

function linkRow(l, rerender) {
  const row = h('div', { class: 'row link-row' });
  let host = l.url;
  try { host = new URL(l.url).hostname.replace(/^www\./i, ''); } catch { /* keep the raw url */ }

  const draw = () => {
    clear(row);
    row.append(
      h('a', {
        class: 'title link-title', href: l.url, title: l.url,
        target: '_blank', rel: 'noopener noreferrer'
      }, l.title),
      meta(h('span', { class: 'eyebrow' }, host)),
      h('button', {
        class: 'btn sm ghost', 'aria-label': `Rename ${l.title}`, title: 'Rename', onclick: edit
      }, '✎'),
      h('button', {
        class: 'btn sm ghost', 'aria-label': `Remove ${l.title}`, title: 'Remove',
        onclick: async () => {
          if (await confirmDialog('Remove this link?', l.title, 'Remove')) {
            commit(() => deleteLink(l.id));
            rerender();
          }
        }
      }, '✕'));
  };

  function edit() {
    let cancelled = false;
    const input = h('input', {
      class: 'link-edit', value: l.title, 'aria-label': 'Link title',
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        // Escape redraws, which takes the input out of the document and fires
        // blur on the way — the flag stops that from saving what was rejected.
        if (e.key === 'Escape') { e.preventDefault(); cancelled = true; draw(); }
      },
      onblur: () => {
        if (cancelled) return;
        commit(() => updateLink(l.id, { title: input.value }));
        draw();
      }
    });
    clear(row).append(input, h('span', { class: 'eyebrow' }, host));
    input.focus();
    input.select();
  }

  draw();
  return row;
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
      onclick: () => { draft.schedule.push({ days: [], start: '10:30', end: '11:35', location: '', tz: tz() }); drawMeetings(); }
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
      h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox', class: 'check', checked: draft.onChart !== false,
          onchange: (e) => { draft.onChart = e.target.checked; }
        }),
        h('span', {},
          h('div', { style: { fontSize: '13.5px' } }, 'Show on the semester chart'),
          h('div', { style: { fontSize: '12.5px', color: 'var(--ink-3)' } },
            'Off for work with no shape over a term — errands, say. The area stays everywhere else.'))),
      h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox', class: 'check', checked: !!draft.journal,
          onchange: (e) => { draft.journal = e.target.checked; }
        }),
        h('span', {},
          h('div', { style: { fontSize: '13.5px' } }, 'Keep a daily journal here'),
          h('div', { style: { fontSize: '12.5px', color: 'var(--ink-3)' } },
            'A box at the top of this page to write in, one entry a day, with the earlier ones behind a dropdown.'))),
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
          // stamped with the zone the times were just read in: Google holds
          // instants, and this is the wall clock they came out as here
          draft.schedule = sx.schedule.map((r) => ({ ...r, days: [...r.days], tz: tz() }));
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
