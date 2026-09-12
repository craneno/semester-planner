// share.js — a week as a picture.
//
// Drawn by hand on a canvas: the days across, the hours down, opened wider
// for anything outside 7am to 10pm; classes, Google's events and planned
// blocks in their colours, sharing the width the way the grid does. Handed
// to the share sheet where there is one, saved as a PNG where there is not.

import { state, classesOn, eventsOn, itemsPlannedOn, itemsDueOn, itemColor } from './store.js';
import { parseYmd, toMin, fromMin, fmtTime, DOW, MONTHS, saveFile, hexAlpha } from './util.js';
import { packBlocks } from './timegrid.js';
import { toast } from './ui.js';

const PAPER = '#FBFBF9', INK = '#1C1C1A', INK2 = '#5F6368', INK3 = '#8B9099', RULE = '#E4E4E0';
const FONT = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

/** Where everything goes, in pixels, before any drawing. */
export function layoutWeek(days, { width = 1400, hourH = 44, pad = 28, headH = 70 } = {}) {
  let first = 7 * 60, last = 22 * 60;
  const gutter = 46;
  const colW = (width - pad * 2 - gutter) / 7;
  const cols = days.map((d) => {
    const list = [];
    for (const c of classesOn(d)) list.push({ kind: 'class', title: c.title, start: toMin(c.start), end: toMin(c.end), color: c.color || INK3 });
    for (const e of eventsOn(d)) {
      if (e.allDay || !e.start) continue;
      const s = toMin(e.start);
      let en = e.end ? toMin(e.end) : s + 60;
      if (en <= s) en = 24 * 60;
      list.push({ kind: 'event', title: e.title, start: s, end: en, color: null });
    }
    for (const t of itemsPlannedOn(d)) {
      if (!t.plan.start) continue;
      const s = toMin(t.plan.start);
      const c = itemColor(t);
      list.push({ kind: 'plan', title: t.title, start: s, end: Math.min(24 * 60, s + (t.plan.mins || t.estMins || 60)), color: c === 'var(--muted)' ? INK3 : c, done: !!t.done });
    }
    const allDay = [
      ...eventsOn(d).filter((e) => e.allDay).map((e) => e.title),
      ...itemsPlannedOn(d).filter((t) => !t.plan.start).map((t) => t.title),
      ...itemsDueOn(d).map((t) => 'Due · ' + t.title)
    ];
    for (const e of list) {
      first = Math.min(first, Math.floor(e.start / 60) * 60);
      last = Math.max(last, Math.ceil(e.end / 60) * 60);
    }
    return { date: d, list, allDay };
  });
  const rows = Math.max(0, ...cols.map((c) => c.allDay.length));
  const railH = rows ? 10 + rows * 17 : 0;
  const top = pad + headH + railH;
  const height = Math.round(top + ((last - first) / 60) * hourH + pad);
  const boxes = [];
  cols.forEach((c, i) => {
    const x = pad + gutter + i * colW;
    const lanes = packBlocks(c.list.map((b) => ({ start: b.start, mins: b.end - b.start })));
    c.list.forEach((b, j) => {
      const l = lanes[j];
      boxes.push({
        ...b, col: i, z: l.z,
        x: x + 2 + l.x * (colW - 4), w: l.w * (colW - 4),
        y: top + ((b.start - first) / 60) * hourH,
        h: Math.max(14, ((b.end - b.start) / 60) * hourH - 2)
      });
    });
  });
  boxes.sort((a, b) => a.z - b.z);
  return { width, height, pad, gutter, colW, headH, railH, top, first, last, hourH, cols, boxes };
}

/** Draw it. `scale` is pixels per layout unit, for a sharp picture. */
export function paintWeek(canvas, lay, { title = '', hour12 = state.settings.hour12, scale = 2 } = {}) {
  canvas.width = lay.width * scale;
  canvas.height = lay.height * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, lay.width, lay.height);
  g.textBaseline = 'top';

  // the title and the days
  g.fillStyle = INK;
  g.font = `600 22px ${FONT}`;
  g.fillText(title, lay.pad, lay.pad);
  const today = new Date();
  lay.cols.forEach((c, i) => {
    const d = parseYmd(c.date);
    const x = lay.pad + lay.gutter + i * lay.colW;
    const isToday = d.toDateString() === today.toDateString();
    g.fillStyle = isToday ? INK : INK3;
    g.font = `500 11px ${FONT}`;
    g.fillText(DOW[d.getDay()].toUpperCase(), x + 4, lay.pad + 38);
    g.font = `${isToday ? 700 : 500} 16px ${FONT}`;
    g.fillText(String(d.getDate()), x + 4, lay.pad + 50);
    // the all-day things
    g.font = `500 11px ${FONT}`;
    g.fillStyle = INK2;
    c.allDay.forEach((t, r) => g.fillText(clip(g, t, lay.colW - 8), x + 4, lay.pad + lay.headH + 6 + r * 17));
  });

  // the hours
  g.strokeStyle = RULE;
  g.lineWidth = 1;
  g.font = `500 10px ${FONT}`;
  for (let m = lay.first; m <= lay.last; m += 60) {
    const y = lay.top + ((m - lay.first) / 60) * lay.hourH;
    g.beginPath(); g.moveTo(lay.pad + lay.gutter, y + .5); g.lineTo(lay.width - lay.pad, y + .5); g.stroke();
    g.fillStyle = INK3;
    g.fillText(fmtTime(fromMin(Math.min(m, 24 * 60 - 1)), hour12).replace(':00', ''), lay.pad, y - 5);
  }
  for (let i = 0; i <= 7; i++) {
    const x = lay.pad + lay.gutter + i * lay.colW;
    g.beginPath(); g.moveTo(x + .5, lay.top); g.lineTo(x + .5, lay.height - lay.pad); g.stroke();
  }

  // the blocks
  for (const b of lay.boxes) {
    const c = b.color || INK3;
    g.fillStyle = b.kind === 'event' ? PAPER : hexAlpha(c, b.kind === 'class' ? 0.18 : 0.22);
    g.fillRect(b.x, b.y, b.w, b.h);
    if (b.kind === 'event') { g.strokeStyle = INK3; g.setLineDash([3, 3]); g.strokeRect(b.x + .5, b.y + .5, b.w - 1, b.h - 1); g.setLineDash([]); }
    else { g.fillStyle = c; g.fillRect(b.x, b.y, 3, b.h); }
    g.fillStyle = b.done ? INK3 : INK;
    g.font = `500 10px ${FONT}`;
    const t = fmtTime(fromMin(b.start), hour12);
    if (b.h >= 30) {
      g.fillText(t, b.x + 7, b.y + 4);
      g.font = `600 11px ${FONT}`;
      g.fillText(clip(g, b.title, b.w - 10), b.x + 7, b.y + 16);
    } else {
      g.font = `600 10px ${FONT}`;
      g.fillText(clip(g, `${t} ${b.title}`, b.w - 10), b.x + 7, b.y + 3);
    }
  }
  return canvas;
}

function clip(g, text, w) {
  if (g.measureText(text).width <= w) return text;
  let t = text;
  while (t.length && g.measureText(t + '…').width > w) t = t.slice(0, -1);
  return t + '…';
}

/** The week, drawn and handed on: the share sheet where there is one, a PNG file where not. */
export async function shareWeek(days, { title }) {
  const lay = layoutWeek(days);
  const canvas = paintWeek(document.createElement('canvas'), lay, { title });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const name = `week-${days[0]}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  saveFile(blob, name);
  toast('Saved as a picture.');
}
