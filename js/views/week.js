// views/week.js — the calendar. Owned blocks are filled, borrowed ones are outlined.

import {
  h, clear, today, addDays, startOfWeek, weekDays, fmtDate, fmtTime, fmtDuration, DOW, toMin, fromMin, clamp, hexAlpha, MONTHS, parseYmd, fmtHours, tz, tzLabel, cssPx
} from '../util.js';
import {
  state, commit, upsertItem, areaColor, classesOn, eventsOn, itemsDueOn, itemsPlannedOn, workloadFor, scheduleDrift, itemColor
} from '../store.js';
import { draggable, toast } from '../ui.js';
import { openItem } from '../editor.js';
import { dragCreate, tapCreate, dragBlock, newBlockPrompt, inlineCreate, packBlocks, applyLanes } from '../timegrid.js';
import { acceptIcsDrop } from '../icsimport.js';
import { pushItem, editEvent, canEditEvents } from '../gcal.js';
import { openEvent, openClass } from '../eventedit.js';
import { moveItem } from '../actions.js';

let anchor = today();          // any date inside the shown week
/* Whether the week still follows the day. Set once at load, the anchor stayed
   on the week it was born in: a tab left open past Saturday night showed last
   week, with no today in it. Prev and next let go of the day; Today takes it
   back. */
let follows = true;

/** Show the week a date falls in, next time the view draws. */
export function showWeekOf(date) { anchor = date || today(); follows = !date || date === today(); }

/* The now line. One timer for the page, reset on every draw, so a week left
   open overnight keeps the line where the clock is. */
let nowTimer = null;
function placeNowLine(col, dayStart, hourH) {
  const line = h('div', { class: 'now-line', 'aria-hidden': 'true' });
  col.append(line);
  const move = () => {
    const d = new Date();
    const mins = d.getHours() * 60 + d.getMinutes();
    line.style.top = ((mins - dayStart * 60) / 60) * hourH + 'px';
    line.hidden = mins < dayStart * 60;
  };
  // placed now, while the column is still being built and not yet in the
  // document — the isConnected check belongs to the ticks, not the first draw
  move();
  clearInterval(nowTimer);
  nowTimer = setInterval(() => {
    if (!line.isConnected) { clearInterval(nowTimer); nowTimer = null; return; }
    move();
  }, 60 * 1000);
}
let showExternal = true;

const COMPACT_H = 42;          // below this a block gets one line, not two


export function renderWeek(root, { navigate } = {}) {
  clear(root);
  if (follows) anchor = today();
  const ws = state.settings.weekStart;
  const days = weekDays(startOfWeek(anchor, ws));
  // the whole day, always: a block at 23:00 has somewhere to be, and so does a scroll to it
  const dayStart = 0, dayEnd = 24;
  const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
  const load = workloadFor(days);
  const hour12 = state.settings.hour12;

  /* ---- toolbar ---- */
  const title = h('h2', { style: { marginLeft: '6px' } }, spanFor(days));

  root.append(h('div', { class: 'weekbar' },
    h('button', { class: 'btn sm', dataset: { turn: '-1' }, onclick: () => { anchor = addDays(anchor, -7); follows = false; navigate(); }, 'aria-label': 'Previous week' }, '‹'),
    h('button', { class: 'btn sm', onclick: () => { anchor = today(); follows = true; navigate(); } }, 'Today'),
    h('button', { class: 'btn sm', dataset: { turn: '1' }, onclick: () => { anchor = addDays(anchor, 7); follows = false; navigate(); }, 'aria-label': 'Next week' }, '›'),
    title,
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'eyebrow num', title: 'Planned work this week' },
      `${load.count} tasks · ${fmtHours(load.mins)}`),
    // the zone is news only when this device is not where the schedules were written
    scheduleDrift() ? h('span', { class: 'eyebrow tz-chip', title: `All times shown in ${tz()}` }, tzLabel()) : null,
    h('button', {
      class: 'btn ghost sm desktop-only',
      'aria-pressed': String(showExternal),
      onclick: () => { showExternal = !showExternal; navigate(); }
    }, showExternal ? 'Calendar on' : 'Calendar off')));

  /* ---- header + all-day rail ---- */
  const head = h('div', { class: 'week-head' }, h('div', {}));
  const rail = h('div', { class: 'allday-rail' }, h('div', {
    class: 'gutter eyebrow',
    title: 'Due dates, all-day events, and planned work with no time set'
  }, 'All day'));

  const headFor = (d) => {
    const dt = parseYmd(d);
    return h('div', { class: 'dhead' + (d === today() ? ' today' : '') + ([0, 6].includes(dt.getDay()) ? ' weekend' : '') },
      h('div', { class: 'eyebrow' }, DOW[dt.getDay()]),
      h('div', { class: 'dnum' }, String(dt.getDate())));
  };

  // the empty rail is where an all-day plan is made: a click, or a tap,
  // on the cell itself — a flag in it is that flag's to open
  const cellFor = (d) => {
    const cell = h('div', {
      class: 'cell', title: 'Click for an all-day plan',
      onclick: (e) => { if (e.target === cell) newBlockPrompt({ date: d, allDay: true }, { onDone: navigate }); }
    });
    for (const t of itemsDueOn(d)) {
      cell.append(h('div', {
        class: 'due-flag' + (t.done ? ' done' : ''),
        style: { '--c': itemColor(t) },
        title: `Due: ${t.title}`,
        onclick: () => openItem(t.id)
      }, t.title));
    }
    if (showExternal) {
      for (const e of eventsOn(d).filter((e) => e.allDay)) {
        cell.append(h('div', {
          class: 'due-flag', style: { '--c': 'var(--ink-3)' }, title: `${e.title} (Google Calendar)`,
          onclick: () => openEvent(e.id, { after: navigate })
        }, e.title));
      }
    }
    // planned but untimed — the selector, so a repeating one is here too, and
    // a stretch of days on each of its days, the later ones running on
    for (const t of itemsPlannedOn(d).filter((x) => !x.plan.start)) {
      const cont = !!t.plan.end && t.plan.date !== d;
      cell.append(h('div', {
        class: 'due-flag' + (cont ? ' is-cont' : ''), style: { '--c': itemColor(t), opacity: .8 },
        title: t.plan.end ? `${t.title} · ${fmtDate(t.plan.date)} – ${fmtDate(t.plan.end)}` : 'Planned (no time set) — drag into the grid to give it a time',
        onclick: () => openItem(t.id)
      }, (cont ? '' : '◷ ') + t.title));
    }
    return cell;
  };
  for (const d of days) { head.append(headFor(d)); rail.append(cellFor(d)); }

  /* ---- grid ---- */
  const body = h('div', { class: 'week-body' });
  const gutter = h('div', { class: 'hours' });
  for (const H of hours) {
    gutter.append(h('div', { class: 'hour-label' }, h('span', {}, fmtTime(fromMin(H * 60), hour12))));
  }
  body.append(gutter);

  // read, never assumed: `--hour-h` is shorter on a phone, and a block drawn
  // at a desktop hour would sit most of an hour below its own gridline
  const hourH = hourHeight();
  const top = (mins) => ((mins - dayStart * 60) / 60) * hourH;
  // a block that runs past midnight is drawn to midnight: the grid ends there
  const until = (s, e) => Math.min(e, dayEnd * 60) - s;

  /* The week turns under a drag (pageTurner): the columns stay, and take
     the next week's dates and blocks. So a column is dressed and filled by
     date, and can be again. */
  const dress = (col, d) => {
    const dt = parseYmd(d);
    col.dataset.date = d;
    col.classList.toggle('weekend', [0, 6].includes(dt.getDay()));
    col.classList.toggle('today', d === today());
  };

  const fillCol = (col, d) => {
    /* Everything with a time on it, gathered before any of it is placed:
       a class and a block of work that share an hour have to share the
       column, and that cannot be decided one block at a time. A block being
       carried is left out: it is in the grid already, under the pointer,
       and the week drawn under it may be the one it came from. */
    const held = body.querySelector('.blk.dragging');
    const laid = [];
    const lay = (start, mins, el) => { laid.push({ start, mins }); col.append(el); return el; };

    // recurring classes
    for (const c of classesOn(d)) {
      const s = toMin(c.start), e = toMin(c.end) || s + 60;
      const hgt = Math.max(18, (until(s, e) / 60) * hourH - 2);
      lay(s, e - s, h('div', {
        class: 'blk class' + (hgt < COMPACT_H ? ' compact' : ''),
        style: {
          top: top(s) + 'px', height: hgt + 'px',
          '--c': c.color, '--bg': hexAlpha(c.color, 0.18)
        },
        title: `${c.title} · ${fmtTime(c.start, hour12)}–${fmtTime(c.end, hour12)}${c.location ? ' · ' + c.location : ''}${c.moved ? ' · moved this day' : ''}`,
        // this one day of the class; every week is a step on from there
        onclick: () => openClass(c, d, { navigate })
      },
      h('div', { class: 't' }, fmtTime(c.start, hour12)),
      h('div', { class: 'n' }, c.title)));
    }

    // external google events
    if (showExternal) {
      for (const e of eventsOn(d).filter((x) => !x.allDay && x.start)) {
        if (held?.dataset.eid === e.id) continue;
        const s = toMin(e.start);
        let en = toMin(e.end) || s + 60;
        if (en <= s) en += 24 * 60;      // past midnight: drawn to it, the rest on the next day
        const hgt = Math.max(18, (until(s, en) / 60) * hourH - 2);
        const el = h('div', {
          class: 'blk ext' + (hgt < COMPACT_H ? ' compact' : ''),
          dataset: { eid: e.id },
          style: { top: top(s) + 'px', height: hgt + 'px' },
          title: `${e.title}${e.location ? ' · ' + e.location : ''} (Google Calendar)`
        },
        h('div', { class: 't' }, fmtTime(e.start, hour12)),
        h('div', { class: 'n' }, e.title));
        // Google's own event: moved like a block when two-way sync is on, a
        // click opening the small editor either way
        if (canEditEvents()) wireEvent(el, e, body, days, dayStart, dayEnd, hourH, navigate, turner);
        else el.addEventListener('click', () => openEvent(e.id, { after: navigate }));
        lay(s, en - s, el);
      }
    }

    // planned work blocks
    for (const t of itemsPlannedOn(d).filter((x) => x.plan.start)) {
      if (held?.dataset.id === t.id) continue;
      const s = toMin(t.plan.start), mins = t.plan.mins || t.estMins || 60;
      const color = itemColor(t);
      const hgt = Math.max(20, (until(s, s + mins) / 60) * hourH - 2);
      const el = h('div', {
        class: 'blk plan' + (t.done ? ' done' : '') + (hgt < COMPACT_H ? ' compact' : ''),
        dataset: { id: t.id },
        style: {
          top: top(s) + 'px', height: hgt + 'px',
          '--c': color, '--bg': hexAlpha(color === 'var(--muted)' ? '#8B9099' : color, 0.2)
        },
        title: `${t.title} · ${fmtDuration(mins)}${t.due ? ` · due ${fmtDate(t.due)}` : ''}`
      },
      // a short block has one line: the time, then as much of the name as fits
      h('div', { class: 't' }, fmtTime(t.plan.start, hour12) + (hgt < COMPACT_H ? '' : ' · ' + fmtDuration(mins))),
      h('div', { class: 'n' }, t.title));
      wireBlock(el, t, body, days, dayStart, dayEnd, hourH, navigate, turner);
      lay(s, mins, el);
    }

    /* What ran past midnight the day before: its tail, from the top of this
       day to where it ended. It opens the thing itself; it cannot be dragged,
       the block on the day before being the one to move. */
    const prev = addDays(d, -1);
    const tail = (over, cls, color, title, said, open) => {
      const hgt = Math.max(20, (over / 60) * hourH - 2);
      const el = h('div', {
        class: 'blk is-tail ' + cls + (hgt < COMPACT_H ? ' compact' : ''),
        style: { top: '0px', height: hgt + 'px', ...(color ? { '--c': color, '--bg': hexAlpha(color === 'var(--muted)' ? '#8B9099' : color, 0.2) } : {}) },
        title: said, onclick: open
      },
      h('div', { class: 't' }, `… ${fmtTime(fromMin(Math.min(over, 24 * 60 - 1)), hour12)}`),
      h('div', { class: 'n' }, title));
      return lay(0, over, el);
    };
    for (const t of itemsPlannedOn(prev).filter((x) => x.plan.start)) {
      const s = toMin(t.plan.start), mins = t.plan.mins || t.estMins || 60;
      if (s + mins <= 24 * 60) continue;
      const el = tail(Math.min(s + mins - 24 * 60, 24 * 60), 'plan' + (t.done ? ' done' : ''), itemColor(t), t.title,
        `${t.title} · from ${fmtTime(t.plan.start, hour12)} the day before`, () => openItem(t.id));
      el.dataset.tail = t.id;
    }
    if (showExternal) {
      for (const e of eventsOn(prev).filter((x) => !x.allDay && x.start && x.end && toMin(x.end) <= toMin(x.start))) {
        tail(toMin(e.end), 'ext', null, e.title, `${e.title} · from ${fmtTime(e.start, hour12)} the day before (Google Calendar)`, () => openEvent(e.id, { after: navigate }));
      }
    }

    // and now the widths, which only the whole day knows
    applyLanes(col.querySelectorAll('.blk:not(.dragging)'), packBlocks(laid));
    if (d === today()) placeNowLine(col, dayStart, hourH);
  };

  const turner = pageTurner({ body, days, title, head, rail, headFor, cellFor, dress, fillCol });

  for (const d of days) {
    const col = h('div', { class: 'daycol', style: { height: hours.length * hourH + 'px' } });
    dress(col, d);
    fillCol(col, d);
    body.append(col);
  }

  // press on empty grid and drag out a range, the way a calendar does
  dragCreate(body, {
    only: '.daycol',
    hit: (ev) => hit(ev, body, days, dayStart, hourH),
    hourH, origin: dayStart * 60,
    edge: (ev) => edgeScroll(ev, body),
    onPick: (range) => newBlockPrompt(range, { onDone: navigate }),
    // a plain click: an hour there, named in place
    onClick: (at) => inlineCreate(at.col, { date: at.date, start: fromMin(at.mins), mins: 60 }, { hourH, origin: dayStart * 60, onDone: navigate })
  });
  // and on a phone, where the drag scrolls, a tap on empty grid asks for an hour
  tapCreate(body, {
    only: '.daycol',
    hit: (ev) => hit(ev, body, days, dayStart, hourH),
    onPick: (range) => newBlockPrompt(range, { onDone: navigate })
  });

  // the day heads and the due-date rail stay put while the hours scroll
  const wrap = h('div', { class: 'week-wrap' }, h('div', { class: 'week-top' }, head, rail), body);
  const scroller = h('div', { class: 'week-scroll' }, wrap);

  root.append(scroller);
  // a calendar file dropped on the week is offered as blocks
  acceptIcsDrop(root, { navigate });

  /* ---- unscheduled tray ----
     Work with no block yet: due soon, or with no date at all. Due before the
     calendar began is not this planner's work, however far behind it is. */
  const loose = state.items
    .filter((t) => !t.done && !t.plan && !t.repeat
      && (!t.due || (t.due >= state.calendar.start && t.due <= addDays(days[6], 14))))
    .sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1)
    .slice(0, 24);

  // nothing waiting is one quiet line; the hint and the shelf come with the chips
  const tray = h('div', { class: 'tray' + (loose.length ? '' : ' is-empty') },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
      h('span', { class: 'eyebrow' }, loose.length ? 'Unscheduled' : 'Unscheduled · none'),
      loose.length ? h('span', { class: 'eyebrow num' }, String(loose.length)) : null,
      loose.length ? h('span', { class: 'eyebrow', style: { color: 'var(--ink-3)' } }, 'drag onto a day to plan the work') : null));

  const items = h('div', { class: 'tray-items' });
  for (const t of loose) {
    const chip = h('div', {
      class: 'tray-item', dataset: { id: t.id },
      style: { '--c': itemColor(t) }
    }, t.title, t.due ? h('span', { class: 'eyebrow', style: { marginLeft: '7px' } }, fmtDate(t.due)) : null);
    wireTray(chip, t, body, days, dayStart, hourH, navigate, turner);
    items.append(chip);
  }
  if (loose.length) tray.append(items);
  root.append(tray);

  // open on a useful hour rather than at midnight — and, where the week is
  // wider than the screen, on today rather than on Sunday
  requestAnimationFrame(() => {
    const now = new Date();
    // opened at the settings' hour, or a little before now on a week with today in it
    const open = clamp(state.settings.dayStart | 0, 0, 23);
    const target = days.includes(today()) ? Math.max(open, now.getHours() - 2) : open;
    scroller.scrollTop = Math.max(0, (target - dayStart) * hourH - 20);
    const todayCol = body.querySelector('.daycol.today');
    if (todayCol && scroller.scrollWidth > scroller.clientWidth + 1) {
      scroller.scrollLeft = Math.max(0, todayCol.offsetLeft - gutter.offsetWidth);
    }
  });
}

const snap = (mins) => clamp(Math.round(mins / 15) * 15, 0, 24 * 60 - 15);

/** "September 6–12", or across a month "Sep 28 – Oct 4". */
function spanFor(days) {
  const first = parseYmd(days[0]), last = parseYmd(days[6]);
  return first.getMonth() === last.getMonth()
    ? `${MONTHS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${MONTHS[first.getMonth()].slice(0, 3)} ${first.getDate()} – ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getDate()}`;
}

/** How tall an hour is drawn, straight from the stylesheet that draws it. */
const hourHeight = () => cssPx('--hour-h', 52);

/** Nudge the grid when a drag reaches its top or bottom edge. */
function edgeScroll(ev, body) {
  const sc = body.closest('.week-scroll');
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  const margin = 48;
  if (ev.clientY < r.top + margin) sc.scrollTop -= 12;
  else if (ev.clientY > r.bottom - margin) sc.scrollTop += 12;
}

/* ---- turning the week under a drag ----
   A block carried to the grid's edge, or over ‹ ›, and held there turns
   the page, the way a calendar does: the days take the next week's dates
   and blocks, the ghost stays under the pointer, and the drop lands where
   the pointer is. Nothing is rebuilt — a redraw under a finger loses the
   touch — so the block picked up stays where it was until the drop, and
   `days` is changed in place, since every hit test reads it. One turn per
   visit to the edge: to turn again, come away and back, so a hand held
   there does not run off through the term. A drag called off goes back to
   the week it began in. */
const TURN_MS = 550, TURN_ZONE = 18;
function pageTurner({ body, days, title, head, rail, headFor, cellFor, dress, fillCol }) {
  let timer = null, dir = 0, from = null;
  const hot = (d) => {
    for (const b of document.querySelectorAll('.weekbar [data-turn]')) b.classList.toggle('is-hot', Number(b.dataset.turn) === d);
  };
  const zone = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-turn]');
    if (over) return Number(over.dataset.turn);
    const r = body.closest('.week-scroll')?.getBoundingClientRect();
    if (!r || ev.clientY < r.top || ev.clientY > r.bottom) return 0;
    return ev.clientX < r.left + TURN_ZONE ? -1 : ev.clientX > r.right - TURN_ZONE ? 1 : 0;
  };
  const stop = () => { clearTimeout(timer); timer = null; dir = 0; hot(0); };
  const turn = (d) => {
    if (!body.isConnected) return stop();    // drawn again under us: this grid is gone
    if (!from) from = { anchor, follows };
    anchor = addDays(anchor, 7 * d);
    follows = false;
    for (let i = 0; i < days.length; i++) days[i] = addDays(days[i], 7 * d);
    title.textContent = spanFor(days);
    head.replaceChildren(head.firstChild, ...days.map((d) => headFor(d)));
    rail.replaceChildren(rail.firstChild, ...days.map((d) => cellFor(d)));
    body.querySelectorAll('.daycol').forEach((col, i) => {
      for (const n of [...col.children]) if (!n.classList.contains('dragging') && !n.classList.contains('drop-ghost')) n.remove();
      dress(col, days[i]);
      fillCol(col, days[i]);
    });
  };
  return {
    /** Each move of a drag: arm a turn, keep one armed, or let it go. */
    at(ev) {
      const d = zone(ev);
      if (d === dir) return;
      stop();
      dir = d;
      hot(d);
      if (!d) return;
      timer = setTimeout(() => { timer = null; turn(d); }, TURN_MS);
    },
    /** The drag is over. True when the week has to be drawn again here: it was turned, and nothing landed. */
    end(dropped) {
      stop();
      const back = !!from && !dropped;
      if (back) { anchor = from.anchor; follows = from.follows; }
      from = null;
      return back;
    }
  };
}

/**
 * Shared hit-test: pointer position -> {date, mins, col, inside}. The nearest
 * column is always named, so a drag keeps its ghost past the edge; `inside`
 * says whether the pointer is really over a day, which a drop must be.
 */
function hit(ev, body, days, dayStart, hourH, dayEnd = 24) {
  const cols = body.querySelectorAll('.daycol');
  let idx = -1, inside = false;
  for (let i = 0; i < cols.length; i++) {
    const r = cols[i].getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right) {
      idx = i;
      inside = ev.clientY >= r.top && ev.clientY <= r.bottom;
      break;
    }
  }
  if (idx < 0) {
    const r0 = cols[0].getBoundingClientRect();
    idx = ev.clientX < r0.left ? 0 : cols.length - 1;
  }
  const r = cols[idx].getBoundingClientRect();
  // a column runs on under the tray, out of sight in the scroller; over
  // there the pointer is not over a day
  const sc = body.closest('.week-scroll')?.getBoundingClientRect();
  if (sc && (ev.clientY < sc.top || ev.clientY > sc.bottom)) inside = false;
  // held to the hours drawn: a drop over the due-date rail is not a block at 5am
  const mins = clamp(snap((ev.clientY - r.top) / hourH * 60 + dayStart * 60), dayStart * 60, dayEnd * 60 - 15);
  return { date: days[idx], mins, col: cols[idx], inside };
}

/**
 * The middle carries a block to another time — or another day, since this
 * grid's hit test names one. The top and bottom edges stretch it. All three
 * are `dragBlock`, shared with Overview's clock; only the geometry differs.
 */
function wireBlock(el, item, body, days, dayStart, dayEnd, hourH, navigate, turner) {
  const mins = item.plan.mins || item.estMins || 60;
  dragBlock(el, { date: item.plan.date, start: item.plan.start, mins }, {
    hit: (ev) => hit(ev, body, days, dayStart, hourH, dayEnd),
    hourH, origin: dayStart * 60, dayEnd: dayEnd * 60,
    edge: (ev) => { edgeScroll(ev, body); turner.at(ev); },
    onDrop: (plan) => moveItem(item.id, plan, { after: navigate }),
    onEnd: (dropped) => { if (turner.end(dropped)) navigate(); },
    onClick: () => openItem(item.id)
  });
}

/* A Google event moves like a block, and the move goes to Google — with
   an Undo, since `events` is not the store's to remember. */
function wireEvent(el, e, body, days, dayStart, dayEnd, hourH, navigate, turner) {
  const s = toMin(e.start), en = toMin(e.end) || s + 60;
  dragBlock(el, { date: e.date, start: e.start, mins: en - s }, {
    hit: (ev) => hit(ev, body, days, dayStart, hourH, dayEnd),
    hourH, origin: dayStart * 60, dayEnd: dayEnd * 60,
    edge: (ev) => { edgeScroll(ev, body); turner.at(ev); },
    onEnd: (dropped) => { if (turner.end(dropped)) navigate(); },
    onDrop: (plan) => {
      const before = { date: e.date, start: e.start, end: e.end, allDay: false };
      editEvent(e.id, { date: plan.date, start: plan.start, end: fromMin(toMin(plan.start) + plan.mins), allDay: false });
      navigate();
      toast(`Moved to ${fmtDate(plan.date)} ${fmtTime(plan.start, state.settings.hour12)}, on Google too`, {
        action: 'Undo', onAction: () => { editEvent(e.id, before); navigate(); }
      });
    },
    onClick: () => openEvent(e.id, { after: navigate })
  });
}

/* A chip is planned only when it is let go over a day. The hit test names
   the nearest column whatever the pointer is over, and a wiggle let go on the
   tray itself used to plan the task for Sunday at a quarter to midnight. On
   touch the chip waits for a hold, so a swipe along the tray scrolls it. */
function wireTray(chip, item, body, days, dayStart, hourH, navigate, turner) {
  let ghost = null, pend = null;
  const drop = () => { ghost?.remove(); ghost = null; pend = null; };
  draggable(chip, {
    hold: true,
    onStart: () => { chip.classList.add('dragging'); },
    onMove: (ev) => {
      edgeScroll(ev, body);
      turner.at(ev);
      const { date, mins, col, inside } = hit(ev, body, days, dayStart, hourH);
      if (!inside) { drop(); return; }
      if (!ghost) ghost = h('div', { class: 'drop-ghost' });
      ghost.style.top = ((mins - dayStart * 60) / 60 * hourH) + 'px';
      ghost.style.height = ((item.estMins || 60) / 60 * hourH - 2) + 'px';
      col.append(ghost);
      pend = { date, start: fromMin(mins) };
    },
    onCancel: () => { chip.classList.remove('dragging'); drop(); turner.end(false); },
    onEnd: () => {
      chip.classList.remove('dragging');
      ghost?.remove(); ghost = null;
      turner.end(!!pend);      // the redraw below draws whichever week that left us in
      if (pend) {
        commit(() => {
          item.plan = { date: pend.date, start: pend.start, mins: item.estMins || 60 };
          item.updatedAt = new Date().toISOString();
        });
        pushItem(item.id).catch(() => {});
        toast(`Planned for ${fmtDate(pend.date, { weekday: true })} ${fmtTime(pend.start, state.settings.hour12)}`);
        pend = null;
      }
      navigate();
    },
    onClick: () => openItem(item.id)
  });
}
