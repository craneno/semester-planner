// views/overview.js — the whole day on one page. Awareness, not alarm.
//
// Left is today as it will actually happen: classes, calendar events, the work
// you planned. Right is what you decide about it. There is no separate Today
// page; this is it.

import {
  h, clear, today, startOfWeek, weekDays, fmtDate, fmtTime, fmtHours, fmtDuration,
  toMin, fromMin, hexAlpha, DOW_LONG, MONTHS, parseYmd, debounce
} from '../util.js';
import {
  state, commit, toggleItem, upcoming, overdue, workloadFor, semesterProgress,
  weekNumber, categoryLoad, note, carryForward, pendingTomorrow, areaColor,
  areaName, classesOn, eventsOn, itemsDueOn, itemsPlannedOn
} from '../store.js';
import { areaTag, dueChip, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { captureStrip, unfiledQueue } from '../capture.js';
import { dragCreate, newBlockPrompt, snapMins, edgeScroll } from '../timegrid.js';
import { pushItem } from '../gcal.js';

export function renderOverview(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const day = today();
  const ws = state.settings.weekStart;
  const days = weekDays(startOfWeek(day, ws));
  const load = workloadFor(days);
  const late = overdue();
  const soon = upcoming(14);
  const pct = Math.round(semesterProgress() * 100);

  // Last night's line becomes today's focus, before anything reads the note.
  // Checked first so an ordinary render writes nothing, and tagged so app.js
  // does not re-render the page it is in the middle of building.
  if (pendingTomorrow(day)) commit(() => carryForward(day), { source: 'carry' });

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

  pad.append(captureStrip(navigate));
  pad.append(unfiledQueue(navigate, go));

  pad.append(h('div', { class: 'overview-split' },
    todayColumn(day, { navigate, go }),
    decisionColumn(day, { navigate, go, soon })));

  pad.append(deadlines(soon, late, { navigate, go }));
  root.append(pad);
  restoreDayScroll(pad);
}

/**
 * Put the day grid back where it was, or open it at 8am.
 *
 * Deliberately synchronous and called after the tree is in the document:
 * scrollTop does nothing on an element with no layout yet, and a
 * requestAnimationFrame never arrives at all while the tab is in the
 * background — which is exactly when a restored session renders.
 */
function restoreDayScroll(pad) {
  const scroller = pad.querySelector('.day-scroll');
  if (!scroller) return;
  scroller.scrollTop = dayScroll ?? DAY_OPENS_AT * hourHeight();
  trackScroll = true;
}

/* ---------------- left: today, on a clock ---------------- */

/** The hour the day opens on. Earlier hours sit above it, a scroll away. */
const DAY_OPENS_AT = 8;
const HOURS = 24;

/** Survives a re-render, so ticking a box does not throw away where you were. */
let dayScroll = null;
let trackScroll = false;

const hourHeight = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--day-hour-h'));
  return Number.isFinite(v) && v > 0 ? v : 34;
};

function todayColumn(day, { navigate, go }) {
  const d = parseYmd(day);
  const hour12 = state.settings.hour12;
  const hourH = hourHeight();
  const top = (mins) => (mins / 60) * hourH;

  const col = h('section', { class: 'card today-col' });
  col.append(h('div', { class: 'card-h' },
    h('span', { class: 'eyebrow' }, DOW_LONG[d.getDay()]),
    h('span', { class: 'today-date' }, `${MONTHS[d.getMonth()]} ${d.getDate()}`),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost sm', onclick: () => go('week') }, 'Week →')));

  /* things with no time of their own sit above the grid rather than being
     dropped on the floor */
  const untimed = [
    ...eventsOn(day).filter((e) => e.allDay)
      .map((e) => ({ label: e.title, color: null, link: e.link })),
    ...itemsPlannedOn(day).filter((t) => !t.plan.start)
      .map((t) => ({ label: t.title, color: areaColor(t.areaId), id: t.id }))
  ];
  if (untimed.length) {
    const strip = h('div', { class: 'day-allday' });
    for (const u of untimed) {
      strip.append(h('button', {
        class: 'day-chip', style: { '--c': u.color || 'var(--ink-3)' },
        onclick: () => { if (u.id) openItem(u.id); else if (u.link) window.open(u.link, '_blank', 'noopener'); }
      }, u.label));
    }
    col.append(strip);
  }

  /* the grid: every hour of the day, empty ones included */
  const hours = h('div', { class: 'day-hours' });
  for (let H = 0; H < HOURS; H++) {
    hours.append(h('div', { class: 'hour-label' }, h('span', {}, fmtTime(fromMin(H * 60), hour12))));
  }

  const lanes = h('div', { class: 'day-lanes' });
  const block = ({ start, mins, cls, color, title, sub, onclick, done }) => {
    const height = Math.max(16, (mins / 60) * hourH - 2);
    return h('div', {
      class: 'blk ' + cls + (done ? ' done' : '') + (height < 34 ? ' compact' : ''),
      style: {
        top: top(start) + 'px', height: height + 'px',
        '--c': color || 'var(--ink-3)',
        '--bg': cls === 'class' && color ? hexAlpha(color, 0.18) : null
      },
      title: sub ? `${title} · ${sub}` : title,
      onclick
    },
    h('div', { class: 't' }, fmtTime(fromMin(start), hour12)),
    h('div', { class: 'n' }, title));
  };

  for (const c of classesOn(day)) {
    const s = toMin(c.start), e = toMin(c.end) || s + 60;
    lanes.append(block({ start: s, mins: e - s, cls: 'class', color: c.color, title: c.title, sub: c.location }));
  }
  for (const e of eventsOn(day).filter((x) => !x.allDay && x.start)) {
    const s = toMin(e.start), en = toMin(e.end) || s + 60;
    lanes.append(block({
      start: s, mins: en - s, cls: 'ext', color: null,
      title: e.title, sub: e.location || 'Google Calendar',
      onclick: () => e.link && window.open(e.link, '_blank', 'noopener')
    }));
  }
  for (const t of itemsPlannedOn(day).filter((x) => x.plan.start)) {
    const mins = t.plan.mins || t.estMins || 60;
    lanes.append(block({
      start: toMin(t.plan.start), mins, cls: 'plan', color: areaColor(t.areaId),
      title: t.title, sub: `${areaName(t.areaId)} · ${fmtDuration(mins)}`,
      done: t.done, onclick: () => openItem(t.id)
    }));
  }

  if (day === today()) {
    const now = new Date();
    lanes.append(h('div', {
      class: 'nowline', style: { top: top(now.getHours() * 60 + now.getMinutes()) + 'px' }
    }));
  }

  const grid = h('div', { class: 'day-grid', style: { height: HOURS * hourH + 'px' } }, hours, lanes);

  // A freshly mounted scroller fires scroll at 0, and so does our own restore.
  // Either would overwrite the position we are trying to keep, so recording is
  // off until restoreDayScroll() has run.
  trackScroll = false;
  const scroller = h('div', {
    class: 'day-scroll', onscroll: (e) => { if (trackScroll) dayScroll = e.target.scrollTop; }
  }, grid);
  col.append(scroller);

  /* press and drag on the empty clock to block out time, the same gesture as
     the week grid — only the geometry differs */
  const at = (ev) => {
    const r = lanes.getBoundingClientRect();
    const mins = Math.max(0, Math.min(24 * 60 - 15, snapMins((ev.clientY - r.top) / hourH * 60)));
    return { date: day, mins, col: lanes };
  };
  dragCreate(lanes, {
    only: '.day-lanes', hit: at, hourH,
    edge: (ev) => edgeScroll(scroller, ev),
    onPick: (range) => newBlockPrompt(range, { onDone: navigate })
  });
  lanes.addEventListener('dblclick', (ev) => {
    if (ev.target !== lanes) return;
    newBlockPrompt({ date: day, start: fromMin(at(ev).mins), mins: 60 }, { onDone: navigate });
  });

  return col;
}

/* ---------------- right: what to do about it ---------------- */

function decisionColumn(day, { navigate, go, soon }) {
  const col = h('div', { class: 'overview-side' });
  const n = note(day);

  /* focus + today's three */
  const focus = h('div', { class: 'card-b' });
  focus.append(h('input', {
    class: 'focus-line', value: n.focus, placeholder: 'The one thing that matters today',
    'aria-label': "Today's focus",
    oninput: debounce((e) => commit(() => { n.focus = e.target.value; }), 400)
  }));

  // only while it is still last night's line, so editing it stops the credit
  const source = n.carriedFrom ? state.notes[n.carriedFrom] : null;
  if (source && n.focus && n.focus === source.tomorrow) {
    focus.append(h('div', { class: 'eyebrow carried' },
      `Carried from ${fmtDate(n.carriedFrom)}`));
  }

  const planned = itemsPlannedOn(day);
  const due = itemsDueOn(day).filter((t) => !planned.includes(t));
  const candidates = [...planned, ...due];
  const chosen = (n.top3 || []).map((id) => state.items.find((t) => t.id === id)).filter(Boolean);
  const three = chosen.length ? chosen : candidates.slice(0, 3);

  focus.append(h('div', { class: 'eyebrow', style: { margin: '16px 0 4px' } }, 'Top three'));
  if (!three.length) {
    focus.append(h('p', { style: { margin: 0, color: 'var(--ink-3)', fontSize: '13px' } },
      'Nothing planned for today. Drag work in from the Week view.'));
  }
  for (const t of three) focus.append(line(t, navigate));

  if (candidates.length > three.length) {
    focus.append(h('details', { style: { marginTop: '8px' } },
      h('summary', { class: 'eyebrow', style: { cursor: 'pointer' } },
        `Everything today (${candidates.length})`),
      ...candidates.slice(three.length).map((t) => line(t, navigate))));
  }

  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Focus')),
    focus));

  /* open work, split the way the sidebar splits it */
  const byCat = h('div', { class: 'card-b' });
  const loads = categoryLoad();
  const busiest = Math.max(1, ...loads.map((c) => c.open));
  for (const c of loads) {
    byCat.append(h('button', {
      class: 'cat-load', onclick: () => go(c.id),
      title: `${c.open} open · ${fmtHours(c.mins)}`
    },
    h('div', { class: 'cat-load-h' },
      h('span', { class: 'cat-load-name' }, c.label),
      h('span', { class: 'eyebrow num' }, c.open ? `${c.open} · ${fmtHours(c.mins)}` : '—')),
    h('div', { class: 'meter' }, h('span', { style: { width: (c.open / busiest) * 100 + '%' } }))));
  }
  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Open work'), h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => go('semester') }, 'All →')),
    byCat));

  /* End of day. The second box is the one that goes somewhere: whatever is in
     it is tomorrow's focus line, so it is asked for separately rather than
     left to be dug out of the paragraph above it. */
  col.append(h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'End of day')),
    h('div', { class: 'card-b' },
      h('textarea', {
        placeholder: 'What moved, what stalled.',
        style: { minHeight: '78px' },
        oninput: debounce((e) => commit(() => { n.text = e.target.value; }), 500)
      }, n.text || ''),
      h('div', { class: 'eyebrow', style: { margin: '14px 0 4px' } }, 'Tomorrow needs'),
      h('input', {
        class: 'focus-line sm', value: n.tomorrow || '',
        placeholder: 'One line — it becomes tomorrow’s focus',
        'aria-label': 'What tomorrow needs',
        oninput: debounce((e) => commit(() => {
          n.tomorrow = e.target.value;
          // edited after it was spent: mean it again, and it carries again
          if (n.tomorrowUsed) delete n.tomorrowUsed;
        }), 400)
      }))));

  return col;
}

/* ---------------- below: the fortnight ---------------- */

function deadlines(soon, late, { navigate, go }) {
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
  return list;
}

const check = (t, navigate) => h('input', {
  type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
  onclick: (e) => e.stopPropagation(),
  onchange: (e) => {
    commit(() => toggleItem(t.id, e.target.checked));
    pushItem(t.id).catch(() => {});
    navigate();
  }
});

function line(t, navigate) {
  return h('div', {
    class: 'row' + (t.done ? ' done' : ''),
    style: { gridTemplateColumns: '22px minmax(0,1fr) auto', borderBottom: 0, padding: '4px 0' },
    onclick: () => openItem(t.id)
  },
  check(t, navigate),
  h('span', { class: 'title', style: { fontSize: '13.5px' } }, t.title),
  meta(dueChip(t)));
}

function row(t, navigate) {
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    check(t, navigate),
    h('span', { class: 'title' }, t.title),
    meta(
      areaTag(t.areaId),
      t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
      dueChip(t)));
}
