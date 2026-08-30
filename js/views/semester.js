// views/semester.js — the whole term, as a chart and as a list.
//
// The chart is the default because a semester has a shape: three bands —
// courses, projects, personal — and inside each one a lane per area. Planned
// work has a length and draws as a bar; a deadline is a moment and draws as a
// diamond. Today is a line down the page.
//
// Not every area belongs on it. A pile of errands has no shape over fifteen
// weeks, so `area.onChart` lets one sit out without being archived — the
// chips above the chart, or the checkbox in the area editor.
//
// The list it used to be is still here, with its filters and its search,
// behind the Chart / List switch: the chart answers "when", the list answers
// "what", and neither does the other's job well.

import {
  h, clear, fmtDate, ymd, monthKey, monthLabel, fmtDuration, diffDays, addDays,
  parseYmd, startOfWeek, today, MONTHS
} from '../util.js';
import {
  state, commit, toggleItem, upsertArea, ITEM_TYPES, progress, chartAreas,
  areasInCategory, areaColor, AREA_CATEGORIES
} from '../store.js';
import { areaTag, dueChip, priorityTag, meta } from '../ui.js';
import { openItem } from '../editor.js';
import { pushItem } from '../gcal.js';

const filters = { area: '', type: '', status: 'open', q: '' };

/** All three survive a re-render, the way the week view's anchor date does —
 *  the picker especially, since toggling an area redraws the page and a panel
 *  that shut itself after every chip would be unusable. */
let mode = 'chart';
let showDone = false;
let pickerOpen = false;

export function renderSemester(root, { navigate, go }) {
  clear(root);
  const pad = h('div', { class: 'pad' });

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('h1', {}, 'Semester'),
      h('div', { class: 'eyebrow' }, `${state.semester.name} · ${state.semester.start} → ${state.semester.end}`)),
    h('div', { style: { flex: 1 } }),
    h('div', { class: 'mode-toggle' },
      modeBtn('chart', 'Chart', navigate),
      modeBtn('list', 'List', navigate))));

  // the host is already in the document, so this is the real width; a tab that
  // has never been painted reports 0, and the window is the better guess then
  const width = root.clientWidth || window.innerWidth;

  if (mode === 'chart') renderChart(pad, { navigate, go, width });
  else renderList(pad, { navigate });

  root.append(pad);
}

function modeBtn(key, label, navigate) {
  return h('button', {
    class: 'mode' + (mode === key ? ' on' : ''), 'aria-pressed': String(mode === key),
    onclick: () => { mode = key; navigate(); }
  }, label);
}


/* ================= the chart =================
   Geometry is kept in whole days from the first day of term and turned into
   pixels at the last moment, by multiplying by --day-w. Everything exported
   below is pure, which is the only reason any of it can be tested. */

const LANE_H = 20;          // one packed row of bars
const LABEL_CHAR = 6.4;     // rough px per character, for reserving label room
const MAX_LABEL = 40;

/** Width of the sticky name column. */
const labelWidth = (width) => (width < 640 ? 116 : 168);

/**
 * How many pixels one day gets. Sized to the space there actually is, so a
 * term usually fits without scrolling, and clamped at both ends: below 4px a
 * week is invisible, above 16px a fortnight fills the screen. Written into
 * --day-w rather than set in the stylesheet, because the lane packing above
 * measures labels in these same pixels and the two must not disagree.
 */
export function fitDayWidth(width, days, labelW) {
  const avail = width - labelW - 46;      // padding, border, and a little air
  return Math.max(4, Math.min(16, Math.floor(avail / Math.max(1, days))));
}

/** The window the chart draws: the term itself, or null if it makes no sense. */
export function chartRange(semester = state.semester) {
  const { start, end } = semester || {};
  if (!start || !end || end < start) return null;
  return { start, end, days: diffDays(start, end) + 1 };
}

/**
 * Where one item sits, in days from the first day of term — or null if it has
 * no date at all, or falls entirely outside the term.
 *
 * A deadline is a moment: it draws as a diamond rather than a one-day bar,
 * because a bar that thin reads as a scrap of work instead of a due date. An
 * item that is both planned and due spans from the day it was planned to the
 * day it is owed, and that is the only true Gantt bar on the page.
 */
export function itemSpan(t, range) {
  const plan = t.plan?.date || null;
  const due = t.due || null;
  if (!plan && !due) return null;
  let from = plan || due;
  let to = due || plan;
  if (from > to) [from, to] = [to, from];       // planned after it was owed
  if (to < range.start || from > range.end) return null;
  // clipped rather than dropped: work that began before the term still shows
  const clipStart = from < range.start;
  const clipEnd = to > range.end;
  const a = Math.max(0, diffDays(range.start, from));
  const b = Math.min(range.days - 1, diffDays(range.start, to));
  return { from: a, to: b, days: b - a + 1, milestone: !plan, clipStart, clipEnd };
}

/**
 * Stack bars so none overlap: each takes the first lane free where it starts.
 *
 * A bar needs more room than it covers, because its title is written beside
 * it: `reserve` is where it stops needing room on the right, and `head` where
 * it starts needing it on the left — which is left of the bar itself for one
 * near the end of term, whose title is written on the other side of it.
 */
export function packLanes(spans) {
  const head = (s) => s.head ?? s.from;
  const ends = [];
  const rows = spans.slice()
    .sort((x, y) => head(x) - head(y) || x.to - y.to)
    .map((s) => {
      let lane = ends.findIndex((end) => head(s) > end);
      if (lane < 0) { lane = ends.length; ends.push(-Infinity); }
      ends[lane] = Math.max(s.to, s.reserve ?? s.to);
      return { ...s, lane };
    });
  return { rows, lanes: Math.max(1, ends.length) };
}

/** The months the term crosses, each as an offset and a length in days. */
export function monthBands(range) {
  const out = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const dt = parseYmd(cursor);
    const nextFirst = ymd(new Date(dt.getFullYear(), dt.getMonth() + 1, 1));
    const last = nextFirst > range.end ? range.end : addDays(nextFirst, -1);
    out.push({
      from: diffDays(range.start, cursor),
      days: diffDays(cursor, last) + 1,
      label: MONTHS[dt.getMonth()].slice(0, 3)
    });
    cursor = addDays(last, 1);
  }
  return out;
}

/** Everything the chart draws, plus an honest account of what it left out. */
function chartData(range, dayW) {
  const areas = chartAreas();
  const onChart = new Set(areas.map((a) => a.id));
  const byArea = new Map(areas.map((a) => [a.id, []]));
  const left = { done: 0, offChart: 0, undated: 0, offTerm: 0 };

  for (const t of state.items) {
    if (t.done && !showDone) { left.done++; continue; }
    if (!onChart.has(t.areaId)) { left.offChart++; continue; }
    const s = itemSpan(t, range);
    if (!s) { if (t.due || t.plan?.date) left.offTerm++; else left.undated++; continue; }
    const label = t.title.length > MAX_LABEL ? t.title.slice(0, MAX_LABEL - 1) + '…' : t.title;
    // the title is written to the right of the bar, except within its own
    // width of the end of term, where the scroller would cut it off and it is
    // written to the left instead. Either way the packing has to know.
    const labelDays = Math.ceil((label.length * LABEL_CHAR + 20) / dayW);
    const flip = range.days - s.to < labelDays;
    byArea.get(t.areaId).push({
      ...s, t, label, flip,
      head: flip ? s.from - labelDays : s.from,
      reserve: flip ? s.to : s.to + labelDays
    });
  }
  return { areas, byArea, left };
}

function renderChart(pad, { navigate, go, width }) {
  const range = chartRange();
  if (!range) {
    pad.append(h('div', { class: 'empty' },
      h('h3', {}, 'The term has no dates yet'),
      h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
        'Settings → Semester: give it a first and a last day, and the chart has something to draw.')));
    return;
  }

  const labelW = labelWidth(width);
  const dayW = fitDayWidth(width, range.days, labelW);
  const { areas, byArea, left } = chartData(range, dayW);

  pad.append(chartControls(navigate, areas.length));

  const inner = h('div', {
    class: 'gantt-inner',
    style: {
      '--day-w': dayW + 'px', '--term-days': String(range.days),
      '--label-w': labelW + 'px'
    }
  });

  /* months across the top */
  inner.append(h('div', { class: 'gantt-row gantt-head' },
    h('div', { class: 'gantt-label eyebrow' }, 'Area'),
    h('div', { class: 'gantt-track' },
      ...monthBands(range).map((m) => h('div', {
        class: 'gantt-month',
        style: { left: `calc(var(--day-w) * ${m.from})`, width: `calc(var(--day-w) * ${m.days})` }
      }, m.label)))));

  const body = h('div', { class: 'gantt-body' });

  /* ruled paper: a faint line each week, a firmer one each month, today in ink */
  const rules = h('div', { class: 'gantt-rules' });
  const firstWeek = diffDays(range.start, startOfWeek(range.start, state.settings.weekStart));
  for (let d = firstWeek < 0 ? firstWeek + 7 : firstWeek; d < range.days; d += 7) {
    rules.append(h('div', { class: 'gantt-rule', style: { left: `calc(var(--day-w) * ${d})` } }));
  }
  for (const m of monthBands(range).slice(1)) {
    rules.append(h('div', { class: 'gantt-rule is-month', style: { left: `calc(var(--day-w) * ${m.from})` } }));
  }
  const now = today();
  if (now >= range.start && now <= range.end) {
    rules.append(h('div', {
      class: 'gantt-now', title: `Today — ${fmtDate(now)}`,
      style: { left: `calc(var(--day-w) * ${diffDays(range.start, now)})` }
    }));
  }
  body.append(rules);

  let drawn = 0;
  for (const cat of AREA_CATEGORIES) {
    const mine = areas.filter((a) => a.category === cat.id);
    if (!mine.length) continue;
    body.append(h('div', { class: 'gantt-cat' }, h('span', { class: 'eyebrow' }, cat.label)));
    for (const a of mine) {
      const packed = packLanes(byArea.get(a.id));
      drawn += packed.rows.length;
      body.append(areaLane(a, packed, go, range));
    }
  }

  if (!areas.length) {
    body.append(h('div', { class: 'area-none' }, 'No areas are on the chart. Turn one on above.'));
  }

  inner.append(body);
  pad.append(h('div', { class: 'gantt' }, inner));

  pad.append(h('div', { class: 'gantt-foot' },
    h('span', { class: 'gantt-key' },
      h('span', { class: 'key-bar' }), 'planned work',
      h('span', { class: 'key-mile' }), 'deadline',
      h('span', { class: 'key-now' }), 'today'),
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'eyebrow num', title: 'A chart only shows what has a date on it' },
      [`${drawn} drawn`,
        left.undated && `${left.undated} undated`,
        left.offTerm && `${left.offTerm} outside the term`,
        left.offChart && `${left.offChart} in areas off the chart`,
        left.done && `${left.done} finished`].filter(Boolean).join(' · '))));
}

function chartControls(navigate, onCount) {
  const total = state.areas.filter((a) => !a.archived).length;
  const chips = h('div', { class: 'gantt-picker' });
  for (const cat of AREA_CATEGORIES) {
    const mine = areasInCategory(cat.id);
    if (!mine.length) continue;
    chips.append(h('div', { class: 'gantt-pickrow' },
      h('span', { class: 'eyebrow' }, cat.label),
      ...mine.map((a) => h('button', {
        class: 'preset', 'aria-pressed': String(a.onChart !== false),
        onclick: () => { commit(() => upsertArea({ id: a.id, onChart: a.onChart === false })); navigate(); }
      },
      h('span', { class: 'dot', style: { background: a.color, marginRight: '6px', display: 'inline-block' } }),
      a.name))));
  }

  return h('div', { class: 'gantt-controls' },
    h('details', {
      class: 'gantt-pick', open: pickerOpen ? '' : null,
      ontoggle: (e) => { pickerOpen = e.target.open; }
    },
    h('summary', {}, `Areas on the chart — ${onCount} of ${total}`),
    chips),
    h('label', { class: 'gantt-donetoggle' },
      h('input', {
        type: 'checkbox', class: 'check', checked: showDone,
        onchange: (e) => { showDone = e.target.checked; navigate(); }
      }),
      h('span', {}, 'Show finished')));
}

function areaLane(area, packed, go, range) {
  const track = h('div', {
    class: 'gantt-track',
    style: { height: `${packed.lanes * LANE_H + 8}px` }
  });

  for (const s of packed.rows) {
    const t = s.t;
    track.append(h('button', {
      class: 'gantt-item'
        + (s.milestone ? ' is-mile' : '')
        + (s.flip ? ' flip' : '')
        + (t.done ? ' done' : '')
        + (s.clipStart ? ' clip-l' : '') + (s.clipEnd ? ' clip-r' : ''),
      style: {
        [s.flip ? 'right' : 'left']: `calc(var(--day-w) * ${s.flip ? range.days - 1 - s.to : s.from})`,
        top: `${4 + s.lane * LANE_H}px`,
        '--c': areaColor(t.areaId)
      },
      title: describeSpan(t, s),
      onclick: () => openItem(t.id)
    },
    h('span', {
      class: 'gantt-shape',
      style: s.milestone ? null : { width: `calc(var(--day-w) * ${s.days})` }
    }),
    h('span', { class: 'gantt-tag' }, s.label)));
  }

  if (!packed.rows.length) track.append(h('span', { class: 'gantt-quiet' }, 'nothing dated'));

  return h('div', { class: 'gantt-row' },
    h('button', {
      class: 'gantt-label is-area', title: `Open ${area.name}`,
      onclick: () => go(`area/${area.id}`)
    },
    h('span', { class: 'bar', style: { background: area.color } }),
    h('span', { class: 'gantt-name' }, area.name)),
    track);
}

function describeSpan(t, s) {
  const when = s.milestone
    ? `Due ${fmtDate(t.due)}`
    : `Planned ${fmtDate(t.plan.date)}${t.due && t.due !== t.plan.date ? ` → due ${fmtDate(t.due)}` : ''}`;
  return `${t.title}\n${when}${t.estMins ? ` · ${fmtDuration(t.estMins)}` : ''}${t.done ? ' · done' : ''}`;
}


/* ================= the list ================= */

function renderList(pad, { navigate }) {
  pad.append(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' } },
    select(filters.status, [['open', 'Open'], ['all', 'All'], ['done', 'Done']], (v) => { filters.status = v; navigate(); }),
    select(filters.area, [['', 'All areas'], ...state.areas.filter((a) => !a.archived).map((a) => [a.id, a.name])], (v) => { filters.area = v; navigate(); }),
    select(filters.type, [['', 'All types'], ...ITEM_TYPES.map((t) => [t, t[0].toUpperCase() + t.slice(1)])], (v) => { filters.type = v; navigate(); }),
    h('input', {
      type: 'text', placeholder: 'Filter by name…', value: filters.q, style: { maxWidth: '200px' },
      oninput: (e) => { filters.q = e.target.value; draw(); }
    }),
    h('div', { style: { flex: 1 } }),
    h('span', { class: 'eyebrow num', id: 'sem-count' })));

  const listHost = h('div', {});
  pad.append(listHost);

  function draw() {
    clear(listHost);
    let items = state.items.slice();
    if (filters.status === 'open') items = items.filter((t) => !t.done);
    if (filters.status === 'done') items = items.filter((t) => t.done);
    if (filters.area) items = items.filter((t) => t.areaId === filters.area);
    if (filters.type) items = items.filter((t) => t.type === filters.type);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      items = items.filter((t) => t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q));
    }
    items.sort((a, b) => {
      const da = a.due || a.plan?.date || '9999-99-99';
      const db = b.due || b.plan?.date || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : a.title.localeCompare(b.title);
    });

    const count = document.getElementById('sem-count');
    if (count) count.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

    if (!items.length) {
      listHost.append(h('div', { class: 'empty', style: { marginTop: '18px' } },
        h('h3', {}, 'Nothing here yet'),
        h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
          'Type in the bar up top — "Topology PS3 due fri 2h !high" works.')));
      return;
    }

    let currentKey = null;
    for (const t of items) {
      const key = monthKey(t.due || t.plan?.date);
      if (key !== currentKey) {
        currentKey = key;
        const inMonth = items.filter((x) => monthKey(x.due || x.plan?.date) === key);
        const mins = inMonth.reduce((n, x) => n + (x.estMins || 0), 0);
        listHost.append(h('div', { class: 'group-h' },
          h('h2', {}, monthLabel(key)),
          h('span', { class: 'eyebrow num' }, `${inMonth.length} · ${fmtDuration(mins)}`)));
      }
      listHost.append(itemRow(t, draw));
    }
  }

  draw();
}

function itemRow(t, rerender) {
  const pct = Math.round(progress(t) * 100);
  return h('div', {
    class: 'row' + (t.done ? ' done' : ''),
    onclick: () => openItem(t.id)
  },
  h('input', {
    type: 'checkbox', class: 'check', checked: t.done, 'aria-label': `Mark ${t.title} complete`,
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { commit(() => toggleItem(t.id, e.target.checked)); pushItem(t.id).catch(() => {}); rerender(); }
  }),
  h('span', { class: 'title' },
    t.title,
    t.subtasks.length ? h('span', { class: 'eyebrow num', style: { marginLeft: '8px' } }, `${pct}%`) : null),
  meta(
    priorityTag(t.priority),
    areaTag(t.areaId),
    t.plan?.date ? h('span', { class: 'eyebrow num', title: 'Planned work date' }, '◷ ' + fmtDate(t.plan.date)) : null,
    dueChip(t)));
}

function select(value, options, onchange) {
  return h('select', { style: { width: 'auto' }, onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}
