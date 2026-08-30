// views/week.js — the calendar. Owned blocks are filled, borrowed ones are outlined.

import {
  h, clear, today, addDays, startOfWeek, weekDays, fmtDate, fmtTime, fmtDuration, DOW, toMin, fromMin, clamp, hexAlpha, MONTHS, parseYmd, fmtHours, tz, tzLabel
} from '../util.js';
import {
  state, commit, areaColor, classesOn, eventsOn, itemsDueOn, workloadFor
} from '../store.js';
import { draggable, toast } from '../ui.js';
import { openItem } from '../editor.js';
import { dragCreate, newBlockPrompt } from '../timegrid.js';
import { pushItem } from '../gcal.js';

let anchor = today();          // any date inside the shown week
let showExternal = true;

const COMPACT_H = 42;          // below this a block gets one line, not two


export function renderWeek(root, { navigate } = {}) {
  clear(root);
  const ws = state.settings.weekStart;
  const days = weekDays(startOfWeek(anchor, ws));
  const dayStart = state.settings.dayStart, dayEnd = state.settings.dayEnd;
  const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
  const load = workloadFor(days);
  const hour12 = state.settings.hour12;

  /* ---- toolbar ---- */
  const first = parseYmd(days[0]), last = parseYmd(days[6]);
  const span = first.getMonth() === last.getMonth()
    ? `${MONTHS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${MONTHS[first.getMonth()].slice(0, 3)} ${first.getDate()} – ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getDate()}`;

  root.append(h('div', { class: 'weekbar' },
    h('button', { class: 'btn sm', onclick: () => { anchor = addDays(anchor, -7); navigate(); }, 'aria-label': 'Previous week' }, '‹'),
    h('button', { class: 'btn sm', onclick: () => { anchor = today(); navigate(); } }, 'Today'),
    h('button', { class: 'btn sm', onclick: () => { anchor = addDays(anchor, 7); navigate(); }, 'aria-label': 'Next week' }, '›'),
    h('h2', { style: { marginLeft: '6px' } }, span),
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'eyebrow num', title: 'Planned work this week' },
      `${load.count} tasks · ${fmtHours(load.mins)}`),
    h('span', { class: 'eyebrow tz-chip', title: `All times shown in ${tz()}` }, tzLabel()),
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

  for (const d of days) {
    const dt = parseYmd(d);
    const isToday = d === today();
    head.append(h('div', { class: 'dhead' + (isToday ? ' today' : '') + ([0, 6].includes(dt.getDay()) ? ' weekend' : '') },
      h('div', { class: 'eyebrow' }, DOW[dt.getDay()]),
      h('div', { class: 'dnum' }, String(dt.getDate()))));

    const cell = h('div', { class: 'cell' });
    for (const t of itemsDueOn(d)) {
      cell.append(h('div', {
        class: 'due-flag' + (t.done ? ' done' : ''),
        style: { '--c': areaColor(t.areaId) },
        title: `Due: ${t.title}`,
        onclick: () => openItem(t.id)
      }, t.title));
    }
    if (showExternal) {
      for (const e of eventsOn(d).filter((e) => e.allDay)) {
        cell.append(h('div', { class: 'due-flag', style: { '--c': 'var(--ink-3)' }, title: e.title }, e.title));
      }
    }
    // planned but untimed
    for (const t of state.items.filter((x) => x.plan && x.plan.date === d && !x.plan.start)) {
      cell.append(h('div', {
        class: 'due-flag', style: { '--c': areaColor(t.areaId), opacity: .8 },
        title: 'Planned (no time set) — drag into the grid to give it a time',
        onclick: () => openItem(t.id)
      }, '◷ ' + t.title));
    }
    rail.append(cell);
  }

  /* ---- grid ---- */
  const body = h('div', { class: 'week-body' });
  const gutter = h('div', { class: 'hours' });
  for (const H of hours) {
    gutter.append(h('div', { class: 'hour-label' }, h('span', {}, fmtTime(fromMin(H * 60), hour12))));
  }
  body.append(gutter);

  const hourH = 52;
  const top = (mins) => ((mins - dayStart * 60) / 60) * hourH;

  days.forEach((d, i) => {
    const dt = parseYmd(d);
    const col = h('div', {
      class: 'daycol' + ([0, 6].includes(dt.getDay()) ? ' weekend' : '') + (d === today() ? ' today' : ''),
      dataset: { date: d },
      style: { height: hours.length * hourH + 'px' }
    });

    // recurring classes
    for (const c of classesOn(d)) {
      const s = toMin(c.start), e = toMin(c.end) || s + 60;
      const hgt = Math.max(18, ((e - s) / 60) * hourH - 2);
      col.append(h('div', {
        class: 'blk class' + (hgt < COMPACT_H ? ' compact' : ''),
        style: {
          top: top(s) + 'px', height: hgt + 'px',
          '--c': c.color, '--bg': hexAlpha(c.color, 0.18)
        },
        title: `${c.title} · ${fmtTime(c.start, hour12)}–${fmtTime(c.end, hour12)}${c.location ? ' · ' + c.location : ''}`
      },
      h('div', { class: 't' }, fmtTime(c.start, hour12)),
      h('div', { class: 'n' }, c.title)));
    }

    // external google events
    if (showExternal) {
      for (const e of eventsOn(d).filter((x) => !x.allDay && x.start)) {
        const s = toMin(e.start), en = toMin(e.end) || s + 60;
        const hgt = Math.max(18, ((en - s) / 60) * hourH - 2);
        col.append(h('div', {
          class: 'blk ext' + (hgt < COMPACT_H ? ' compact' : ''),
          style: { top: top(s) + 'px', height: hgt + 'px' },
          title: `${e.title}${e.location ? ' · ' + e.location : ''} (Google Calendar)`,
          onclick: () => e.link && window.open(e.link, '_blank', 'noopener')
        },
        h('div', { class: 't' }, fmtTime(e.start, hour12)),
        h('div', { class: 'n' }, e.title)));
      }
    }

    // planned work blocks
    for (const t of state.items.filter((x) => x.plan && x.plan.date === d && x.plan.start)) {
      const s = toMin(t.plan.start), mins = t.plan.mins || t.estMins || 60;
      const color = areaColor(t.areaId);
      const hgt = Math.max(20, (mins / 60) * hourH - 2);
      const el = h('div', {
        class: 'blk plan' + (t.done ? ' done' : '') + (hgt < COMPACT_H ? ' compact' : ''),
        dataset: { id: t.id },
        style: {
          top: top(s) + 'px', height: hgt + 'px',
          '--c': color, '--bg': hexAlpha(color === 'var(--muted)' ? '#8B9099' : color, 0.2)
        },
        title: `${t.title} · ${fmtDuration(mins)}${t.due ? ` · due ${fmtDate(t.due)}` : ''}`
      },
      h('div', { class: 't' }, fmtTime(t.plan.start, hour12) + ' · ' + fmtDuration(mins)),
      h('div', { class: 'n' }, t.title),
      h('div', { class: 'grip' }));
      wireBlock(el, t, body, days, dayStart, hourH, navigate);
      col.append(el);
    }

    // double click empty space -> an hour, named the same way a drag is
    col.addEventListener('dblclick', (e) => {
      if (e.target !== col) return;
      const rect = col.getBoundingClientRect();
      const mins = snap((e.clientY - rect.top) / hourH * 60 + dayStart * 60);
      newBlockPrompt({ date: d, start: fromMin(mins), mins: 60 }, { onDone: navigate });
    });

    body.append(col);
  });

  // press on empty grid and drag out a range, the way a calendar does
  dragCreate(body, {
    only: '.daycol',
    hit: (ev) => hit(ev, body, days, dayStart, hourH),
    hourH, origin: dayStart * 60,
    edge: (ev) => edgeScroll(ev, body),
    onPick: (range) => newBlockPrompt(range, { onDone: navigate })
  });

  const wrap = h('div', { class: 'week-wrap' }, head, rail, body);
  const scroller = h('div', { class: 'week-scroll' }, wrap);

  // now line
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (days.includes(today()) && nowMin >= dayStart * 60 && nowMin <= dayEnd * 60) {
    body.append(h('div', { class: 'nowline', style: { top: top(nowMin) + 'px' } }));
  }

  root.append(scroller);

  /* ---- unscheduled tray ---- */
  const loose = state.items
    .filter((t) => !t.done && !t.plan && (!t.due || t.due <= addDays(days[6], 14)))
    .sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1)
    .slice(0, 24);

  const tray = h('div', { class: 'tray' },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
      h('span', { class: 'eyebrow' }, 'Unscheduled'),
      h('span', { class: 'eyebrow num' }, String(loose.length)),
      h('span', { class: 'eyebrow', style: { color: 'var(--ink-3)' } }, 'drag onto a day to plan the work')));

  const items = h('div', { class: 'tray-items' });
  if (!loose.length) {
    items.append(h('span', { style: { color: 'var(--ink-3)', fontSize: '13px' } }, 'Everything with a deadline has a slot. '));
  }
  for (const t of loose) {
    const chip = h('div', {
      class: 'tray-item', dataset: { id: t.id },
      style: { '--c': areaColor(t.areaId) }
    }, t.title, t.due ? h('span', { class: 'eyebrow', style: { marginLeft: '7px' } }, fmtDate(t.due)) : null);
    wireTray(chip, t, body, days, dayStart, hourH, navigate);
    items.append(chip);
  }
  tray.append(items);
  root.append(tray);

  // open on a useful hour rather than at midnight
  requestAnimationFrame(() => {
    const target = days.includes(today()) ? Math.max(dayStart, now.getHours() - 2) : 8;
    scroller.scrollTop = Math.max(0, (target - dayStart) * hourH - 20);
  });
}

const snap = (mins) => clamp(Math.round(mins / 15) * 15, 0, 24 * 60 - 15);

/** Nudge the grid when a drag reaches its top or bottom edge. */
function edgeScroll(ev, body) {
  const sc = body.closest('.week-scroll');
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  const margin = 48;
  if (ev.clientY < r.top + margin) sc.scrollTop -= 12;
  else if (ev.clientY > r.bottom - margin) sc.scrollTop += 12;
}

/** Shared hit-test: pointer position -> {date, mins} */
function hit(ev, body, days, dayStart, hourH) {
  const cols = body.querySelectorAll('.daycol');
  let idx = -1;
  for (let i = 0; i < cols.length; i++) {
    const r = cols[i].getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right) { idx = i; break; }
  }
  if (idx < 0) {
    const r0 = cols[0].getBoundingClientRect();
    idx = ev.clientX < r0.left ? 0 : cols.length - 1;
  }
  const r = cols[idx].getBoundingClientRect();
  const mins = snap((ev.clientY - r.top) / hourH * 60 + dayStart * 60);
  return { date: days[idx], mins, col: cols[idx] };
}

function wireBlock(el, item, body, days, dayStart, hourH, navigate) {
  const grip = el.querySelector('.grip');
  let mode = null, ghost = null;

  draggable(el, {
    onStart: (ev) => {
      mode = ev.target === grip ? 'resize' : 'move';
      el.classList.add('dragging');
    },
    onMove: (ev) => {
      edgeScroll(ev, body);
      const { date, mins, col } = hit(ev, body, days, dayStart, hourH);
      if (!ghost) { ghost = h('div', { class: 'drop-ghost' }); }
      if (mode === 'move') {
        const dur = item.plan.mins || 60;
        ghost.style.top = ((mins - dayStart * 60) / 60 * hourH) + 'px';
        ghost.style.height = (dur / 60 * hourH - 2) + 'px';
        col.append(ghost);
        el.dataset.pendDate = date;
        el.dataset.pendMins = mins;
      } else {
        const startM = toMin(item.plan.start);
        const dur = Math.max(15, snap(mins - startM));
        ghost.style.top = ((startM - dayStart * 60) / 60 * hourH) + 'px';
        ghost.style.height = (dur / 60 * hourH - 2) + 'px';
        el.parentElement.append(ghost);
        el.dataset.pendDur = dur;
      }
    },
    onEnd: () => {
      el.classList.remove('dragging');
      ghost?.remove(); ghost = null;
      if (mode === 'move' && el.dataset.pendDate) {
        const date = el.dataset.pendDate, start = fromMin(+el.dataset.pendMins);
        commit(() => { item.plan = { ...item.plan, date, start }; item.updatedAt = new Date().toISOString(); });
        pushItem(item.id).catch(() => {});
      } else if (mode === 'resize' && el.dataset.pendDur) {
        const mins = +el.dataset.pendDur;
        commit(() => { item.plan = { ...item.plan, mins }; item.updatedAt = new Date().toISOString(); });
        pushItem(item.id).catch(() => {});
      }
      mode = null;
      navigate();
    },
    onClick: () => openItem(item.id)
  });
}

function wireTray(chip, item, body, days, dayStart, hourH, navigate) {
  let ghost = null, pend = null;
  draggable(chip, {
    onStart: () => { chip.classList.add('dragging'); },
    onMove: (ev) => {
      edgeScroll(ev, body);
      const { date, mins, col } = hit(ev, body, days, dayStart, hourH);
      if (!ghost) ghost = h('div', { class: 'drop-ghost' });
      ghost.style.top = ((mins - dayStart * 60) / 60 * hourH) + 'px';
      ghost.style.height = ((item.estMins || 60) / 60 * hourH - 2) + 'px';
      col.append(ghost);
      pend = { date, start: fromMin(mins) };
    },
    onEnd: () => {
      chip.classList.remove('dragging');
      ghost?.remove(); ghost = null;
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
