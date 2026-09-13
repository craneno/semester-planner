// views/overview.js — the whole day on one page. Awareness, not alarm.
//
// Left is today as it will actually happen: classes, calendar events, the work
// you planned. Right is what you decide about it. There is no separate Today
// page; this is it.

import {
  h, clear, today, fmtDate, fmtTime, fmtHours, fmtDuration,
  toMin, fromMin, hexAlpha, DOW_LONG, MONTHS, parseYmd, debounce, addDays
} from '../util.js';
import {
  state, commit, upsertItem, toggleItem, upcoming, overdue,
  categoryLoad, note, touchNote, carryForward, pendingTomorrow, areaColor,
  areaName, classesOn, eventsOn, itemsDueOn, itemsPlannedOn, itemById, itemColor, dayTimeline, minsNow
} from '../store.js';
import { areaTag, dueChip, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { showWeekOf } from './week.js';
import { openEvent, openClass } from '../eventedit.js';
import { captureStrip, unfiledQueue } from '../capture.js';
import { dragCreate, tapCreate, dragBlock, newBlockPrompt, snapMins, edgeScroll, packBlocks, applyLanes } from '../timegrid.js';
import { pushItem } from '../gcal.js';
import { tickItem, pushForward, pushLabel, canPush } from '../actions.js';

export function renderOverview(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });
  const day = today();
  const late = overdue();
  const soon = upcoming(14);

  // Last night's line becomes today's focus, before anything reads the note.
  // Checked first so an ordinary render writes nothing, and tagged so app.js
  // does not re-render the page it is in the middle of building.
  if (pendingTomorrow(day)) commit(() => carryForward(day), { source: 'carry' });

  /* The page opens on the next class, not on a score: "a busy week, 10
     tasks, 13h" was a number to feel bad about, and the one thing worth
     knowing at a glance is where you have to be next. */
  pad.append(h('section', { class: 'overview-top' }, nextClassPeek(day, go)));

  pad.append(captureStrip(navigate));
  pad.append(unfiledQueue(navigate, go));

  pad.append(h('div', { class: 'overview-split' },
    todayColumn(day, { navigate, go }),
    decisionColumn(day, { navigate, go, soon })));

  pad.append(deadlines(soon, late, { navigate, go }));
  root.append(pad);
  restoreDayScroll(pad);
  keepNextClassFresh(pad, go);
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
/* So does this. The page is rebuilt whenever a sync brings news, and a
   <details> built fresh is a closed one — the list snapped shut by itself a
   few seconds after being opened. The answer lives out here, not in the DOM. */
let everythingOpen = false;
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
      .map((t) => ({ label: t.title, color: itemColor(t), id: t.id }))
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
  /* Placed by time alone, blocks that share an hour would sit on top of one
     another; the widths are settled once the whole day is gathered. */
  const laid = [];
  const block = ({ start, mins, cls, color, title, sub, onclick, done }) => {
    laid.push({ start, mins });
    // to midnight at most: the clock ends there
    const height = Math.max(16, (Math.min(mins, HOURS * 60 - start) / 60) * hourH - 2);
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
    lanes.append(block({
      start: s, mins: e - s, cls: 'class', color: c.color, title: c.title, sub: c.location,
      onclick: () => openClass(c, day, { navigate })
    }));
  }
  for (const e of eventsOn(day).filter((x) => !x.allDay && x.start)) {
    const s = toMin(e.start), en = toMin(e.end) || s + 60;
    lanes.append(block({
      start: s, mins: en - s, cls: 'ext', color: null,
      title: e.title, sub: e.location || 'Google Calendar',
      onclick: () => openEvent(e.id, { after: navigate })
    }));
  }
  /* Planned work is the only thing here that can be taken hold of: a class
     comes from an area's recurring schedule and a Google event is a mirror, so
     dragging either would be editing something this grid is not showing. The
     click is wired through the gesture rather than as an onclick, or the click
     the browser fires after a drag would open the panel every time. */
  const plans = [];
  for (const t of itemsPlannedOn(day).filter((x) => x.plan.start)) {
    const mins = t.plan.mins || t.estMins || 60;
    const el = block({
      start: toMin(t.plan.start), mins, cls: 'plan', color: itemColor(t),
      title: t.title, sub: `${areaName(t.areaId)} · ${fmtDuration(mins)}`,
      done: t.done
    });
    lanes.append(el);
    plans.push([el, t, mins]);
  }

  applyLanes(lanes.children, packBlocks(laid));

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

  // and take hold of one that is already there: middle moves, edges stretch
  for (const [el, t, mins] of plans) {
    dragBlock(el, { date: day, start: t.plan.start, mins }, {
      hit: at, hourH,
      edge: (ev) => edgeScroll(scroller, ev),
      onDrop: (plan) => {
        // gone while it was being carried: writing by id would make it again
        if (!itemById(t.id)) { navigate(); return; }
        commit(() => upsertItem({ id: t.id, plan: { ...t.plan, ...plan } }));
        pushItem(t.id).catch(() => {});
        navigate();
      },
      onClick: () => openItem(t.id)
    });
  }
  lanes.addEventListener('dblclick', (ev) => {
    if (ev.target !== lanes) return;
    newBlockPrompt({ date: day, start: fromMin(at(ev).mins), mins: 60 }, { onDone: navigate });
  });
  // a phone has no double-click; a tap on the empty clock is the same ask
  tapCreate(lanes, { only: '.day-lanes', hit: at, onPick: (range) => newBlockPrompt(range, { onDone: navigate }) });

  return col;
}

/**
 * The next class, from now: today's while one is still ahead (or on), then
 * tomorrow's first, then the first on the next day that has any, up to two
 * weeks out. Classes only — a planned block is not somewhere to be. It opens
 * that week, and redraws itself each minute so a class that ends moves it on.
 */
export function nextClass(day = today(), mins = minsNow()) {
  const left = classesOn(day).filter((c) => toMin(c.end) > mins);
  if (left.length) return { date: day, list: left, ahead: 0, now: toMin(left[0].start) <= mins };
  for (let n = 1; n <= 14; n++) {
    const date = addDays(day, n);
    const list = classesOn(date);
    if (list.length) return { date, list, ahead: n, now: false };
  }
  return null;
}

function nextClassPeek(day, go) {
  const next = nextClass(day);
  const card = h('button', {
    class: 'card next-class', type: 'button', title: next ? 'Open that week' : 'Open the week',
    onclick: () => { showWeekOf(next ? next.date : day); go('week'); }
  });
  if (!next) {
    card.append(
      h('span', { class: 'eyebrow' }, 'Classes'),
      h('span', { class: 'peek-first' }, 'No classes in the next two weeks'));
    return card;
  }
  const { date, list, ahead, now } = next;
  const first = list[0];
  const label = now ? 'In class now' : ahead === 0 ? 'Next class today'
    : ahead === 1 ? 'First class tomorrow' : `First class ${fmtDate(date, { weekday: true })}`;
  const n = list.length, word = n === 1 ? 'class' : 'classes';
  const count = ahead === 0 ? `${n} ${word} left today` : ahead === 1 ? `${n} ${word} tomorrow` : `${n} ${word} that day`;
  card.append(
    h('span', { class: 'eyebrow' }, label),
    h('span', { class: 'peek-first' }, `${fmtTime(first.start, state.settings.hour12)} ${first.title}`
      + (first.location ? ` · ${first.location}` : '')),
    h('span', { class: 'eyebrow num' }, count));
  return card;
}

/* The card is the one thing on the page that goes stale by itself: a class
   ends, and the next one is on. One timer, reset on every draw, that swaps
   the card in place and stops once the page is gone. */
let classTimer = null;
function keepNextClassFresh(host, go) {
  clearInterval(classTimer);
  classTimer = setInterval(() => {
    const old = host.querySelector('.next-class');
    if (!old || !old.isConnected) { clearInterval(classTimer); classTimer = null; return; }
    const fresh = nextClassPeek(today(), go);
    if (fresh.textContent !== old.textContent) old.replaceWith(fresh);
  }, 60 * 1000);
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
    oninput: debounce((e) => commit(() => { n.focus = e.target.value; touchNote(day); }), 400)
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
    focus.append(h('details', {
      style: { marginTop: '8px' }, open: everythingOpen ? true : null,
      ontoggle: (e) => { everythingOpen = e.target.open; }
    },
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
  const any = loads.some((c) => c.open);
  if (!any) byCat.append(h('p', { style: { margin: 0, color: 'var(--ink-3)', fontSize: '13px' } }, 'Nothing open.'));
  for (const c of any ? loads : []) {
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
        oninput: debounce((e) => commit(() => { n.text = e.target.value; touchNote(day); }), 500)
      }, n.text || ''),
      h('div', { class: 'eyebrow', style: { margin: '14px 0 4px' } }, 'Tomorrow needs'),
      h('input', {
        class: 'focus-line sm', value: n.tomorrow || '',
        placeholder: 'One line — it becomes tomorrow’s focus',
        'aria-label': 'What tomorrow needs',
        oninput: debounce((e) => commit(() => {
          n.tomorrow = e.target.value;
          touchNote(day);
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
    // a past block with no deadline is here too: its day was the only when it had
    for (const t of late.slice(0, 6)) list.append(row(t, navigate));
  }
  // "your first task" only while there is none; a quiet fortnight is just quiet
  if (!soon.length && !late.length) {
    list.append(state.items.length
      ? h('p', { style: { margin: '14px 4px 0', color: 'var(--ink-3)', fontSize: '13px' } }, 'Nothing due in the next two weeks.')
      : h('div', { class: 'empty', style: { marginTop: '14px' } },
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
  onchange: (e) => tickItem(t.id, e.target.checked, { after: navigate })
});

/** One tap forward: today from behind, else tomorrow. Stops the row's own click, which opens the editor. */
const pushBtn = (t, navigate) => (canPush(t) ? h('button', {
  class: 'push-btn', title: pushLabel(t), 'aria-label': `${pushLabel(t)}: ${t.title}`,
  onclick: (e) => { e.stopPropagation(); pushForward(t.id, { after: navigate }); }
}, '→') : null);

function line(t, navigate) {
  return h('div', {
    class: 'row' + (t.done ? ' done' : ''),
    style: { gridTemplateColumns: '22px minmax(0,1fr) auto', borderBottom: 0, padding: '4px 0' },
    onclick: () => openItem(t.id)
  },
  check(t, navigate),
  h('span', { class: 'title', style: { fontSize: '13.5px' } }, t.title),
  meta(dueChip(t), pushBtn(t, navigate)));
}

function row(t, navigate) {
  return h('div', { class: 'row' + (t.done ? ' done' : ''), onclick: () => openItem(t.id) },
    check(t, navigate),
    h('span', { class: 'title' }, t.title),
    meta(
      areaTag(t.areaId),
      t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
      dueChip(t),
      pushBtn(t, navigate)));
}
