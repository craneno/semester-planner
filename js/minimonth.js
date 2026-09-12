// @ts-check
// minimonth.js — the month in the sidebar, small.
//
// A month at a glance beside the views. A click on a day opens that week;
// a block or a tray chip dragged over a day lands on it, a block keeping
// its time. It follows the week on screen until paged by hand, and follows
// again once the week moves or a day is picked. A dot marks a day with
// something on it.

import { state, itemsPlannedOn, itemsDueOn, eventsOn } from './store.js';
import { h, clear, today, addDays, startOfWeek, weekDays, monthKey, MONTHS, DOW, pad } from './util.js';

/** The days a month page shows: six weeks of seven, from the week the 1st is in. Pure. */
export function monthGrid(ym, weekStart = 1) {
  const [y, m] = ym.split('-').map(Number);
  const start = startOfWeek(`${y}-${pad(m)}-01`, weekStart);
  return Array.from({ length: 6 }, (_, w) => weekDays(addDays(start, 7 * w)));
}

/** The month key `n` months on. Pure. */
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Whether a day has anything on it: work planned or due, or a Google event. */
export const busyOn = (d) => itemsPlannedOn(d).length > 0 || itemsDueOn(d).length > 0 || eventsOn(d).length > 0;

let paged = null;        // a month turned to by hand, else the shown week's
let lastYm = null;       // the shown week's month at the last draw
let over = null;         // the day a drag is over

/**
 * Draw it into `host`. `shown` is a day in the week on screen — null when
 * Week is not the view, and then today is the mark. `onPick(day)` opens the
 * week that day is in.
 * @param {HTMLElement|null} host
 * @param {{ shown?: string|null, onPick?: (day: string) => void }} [opts]
 */
export function renderMiniMonth(host, { shown = null, onPick } = {}) {
  if (!host) return;
  const focus = shown || today();
  const ym = monthKey(focus);
  if (ym !== lastYm) { paged = null; lastYm = ym; }    // the week moved: follow it again
  const page = paged || ym;
  const weekStart = state.settings.weekStart ?? 1;
  const week = shown ? weekDays(startOfWeek(shown, weekStart)) : [];
  const now = today();
  const [py, pm] = page.split('-').map(Number);

  clear(host);
  const draw = () => renderMiniMonth(host, { shown, onPick });
  host.append(
    h('div', { class: 'mm-head' },
      h('button', { class: 'mm-turn', type: 'button', 'aria-label': 'Previous month', onclick: () => { paged = shiftMonth(page, -1); draw(); } }, '‹'),
      h('span', { class: 'mm-title' }, `${MONTHS[pm - 1]} ${py}`),
      h('button', { class: 'mm-turn', type: 'button', 'aria-label': 'Next month', onclick: () => { paged = shiftMonth(page, 1); draw(); } }, '›')),
    h('div', { class: 'mm-grid', role: 'grid' },
      ...Array.from({ length: 7 }, (_, i) => h('span', { class: 'mm-dow' }, DOW[(weekStart + i) % 7][0])),
      ...monthGrid(page, weekStart).flat().map((d) => h('button', {
        type: 'button',
        class: 'mm-day' + (monthKey(d) !== page ? ' is-out' : '') + (d === now ? ' is-today' : '')
          + (week.includes(d) ? ' is-shown' : '') + (busyOn(d) ? ' is-busy' : ''),
        dataset: { day: d }, title: d,
        onclick: () => { paged = null; onPick?.(d); }
      }, String(Number(d.slice(8))))))
  );
}

/* A drag from the week: each move lights the day under the pointer, if
   any; the drop asks which; the end puts the light out. */
const unlight = () => { for (const e of document.querySelectorAll('.mm-day.is-over')) e.classList.remove('is-over'); };
export function dragOver(ev) {
  const el = /** @type {HTMLElement|null} */ (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mm-day'));
  const day = el?.dataset.day || null;
  if (day === over) return;
  unlight();
  over = day;
  el?.classList.add('is-over');
}
/** The day a drag is over, or null. */
export const dragDay = () => over;
export function dragEnd() { over = null; unlight(); }
