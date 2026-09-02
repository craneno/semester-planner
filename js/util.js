// util.js — dates, DOM, formatting. No dependencies.

export const uid = (p = 'i') =>
  p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- DOM ---------- */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      // custom properties need setProperty; Object.assign silently drops them
      for (const [prop, val] of Object.entries(v)) {
        if (val == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = val;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/* ---------- Dates ----------
   Calendar days are handled as 'YYYY-MM-DD' strings in *local* time.
   Times of day are 'HH:MM' 24h strings. Timestamps are ISO strings. */

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * The hour a planner day begins. Not midnight.
 *
 * Work finished at half past one, a habit ticked on the way to bed and a
 * journal entry written about the day just gone all belong to the day you were
 * awake for, not to the one the clock started thirty minutes ago. Everything
 * that asks what day it is goes through `today()`, so this is the only place
 * the boundary is decided.
 */
export const DAY_RESET_HOUR = 3;

/**
 * The day the planner is on — the calendar date wound back to the last reset.
 * Takes a clock so it can be tested at an hour other than the one it is now.
 */
export function today(now = new Date()) {
  const d = new Date(now);
  d.setHours(d.getHours() - DAY_RESET_HOUR);
  return ymd(d);
}

export function addDays(s, n) {
  const d = parseYmd(s) || new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function diffDays(a, b) { // b - a in whole days
  const da = parseYmd(a), db = parseYmd(b);
  if (!da || !db) return 0;
  return Math.round((db - da) / 86400000);
}

export function startOfWeek(s, weekStartsOn = 1) {
  const d = parseYmd(s) || new Date();
  const shift = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - shift);
  return ymd(d);
}

export function weekDays(startYmd) {
  return Array.from({ length: 7 }, (_, i) => addDays(startYmd, i));
}

export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const DOW_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function fmtDate(s, opts = {}) {
  const d = parseYmd(s);
  if (!d) return '';
  const { weekday = false, year = false } = opts;
  let out = '';
  if (weekday) out += DOW[d.getDay()] + ' ';
  out += MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate();
  if (year) out += ', ' + d.getFullYear();
  return out;
}

export function monthKey(s) { const d = parseYmd(s); return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : 'none'; }
export function monthLabel(key) {
  if (key === 'none') return 'No due date';
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/* minutes since midnight <-> 'HH:MM' */
export function toMin(hhmm) {
  if (!hhmm) return null;
  const [h_, m] = hhmm.split(':').map(Number);
  return h_ * 60 + (m || 0);
}
export function fromMin(min) {
  min = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
export function fmtTime(hhmm, hour12 = true) {
  const m = toMin(hhmm);
  if (m == null) return '';
  const H = Math.floor(m / 60), M = m % 60;
  if (!hour12) return `${pad(H)}:${pad(M)}`;
  const ap = H >= 12 ? 'pm' : 'am';
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return M ? `${h12}:${pad(M)}${ap}` : `${h12}${ap}`;
}

export function fmtDuration(mins) {
  if (!mins) return '—';
  const h_ = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (!h_) return `${m}m`;
  if (!m) return `${h_}h`;
  return `${h_}h ${m}m`;
}
export function fmtHours(mins) {
  return (mins / 60).toFixed(1).replace(/\.0$/, '') + 'h';
}

/* Local Date <-> RFC3339 with offset, for Google Calendar */
export function toRfc3339(dateStr, hhmm) {
  const d = parseYmd(dateStr);
  const m = toMin(hhmm) ?? 0;
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60)), om = pad(Math.abs(off) % 60);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${oh}:${om}`;
}

export function fromRfc3339(s) { // -> {date, time, dt}
  const dt = new Date(s);
  if (isNaN(dt)) return null;
  return { date: ymd(dt), time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`, dt };
}

export const tz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
};

/** Short zone label for the UI — "EDT" where the browser knows one, else the
 *  IANA city. Recomputed per call so it follows daylight saving. */
export const tzLabel = (on = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(on);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^GMT[+-]/.test(name)) return name;
    return name || tz().split('/').pop().replace(/_/g, ' ');
  } catch { return tz(); }
};

/* A wall-clock time is only half a fact: "07:30" is a different moment in
   Vancouver than in Boston, and a schedule carried between the two is three
   hours wrong with nothing in the data to say so. These two put the missing
   half back — what a zone was offset by, and what that costs a time written
   in one and read in another. */

/** Minutes east of UTC that `zone` stood at, at the instant `at`. */
export function zoneOffset(zone, at = new Date()) {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    for (const x of f.formatToParts(at)) p[x.type] = x.value;
    if (!p.year) return null;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch { return null; }
}

/** Minutes to add to a wall-clock time written in `from` to read it in `to`.
 *  Zero when either zone is one the browser does not know, which leaves the
 *  times alone rather than moving them by a guess. */
export function zoneShift(from, to, at = new Date()) {
  if (!from || !to || from === to) return 0;
  const a = zoneOffset(from, at), b = zoneOffset(to, at);
  return a === null || b === null ? 0 : b - a;
}

/** Short label for any zone — "PDT" where the browser knows one, else the city. */
export const zoneLabel = (zone, on = new Date()) => {
  if (!zone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(on);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^GMT[+-]?/.test(name)) return name;
  } catch { /* an unknown zone is named by its city below */ }
  return zone.split('/').pop().replace(/_/g, ' ');
};

/* ---------- misc ---------- */

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** Readable text color for a background hex. */
export function readableOn(hex) {
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#16181D' : '#FFFFFF';
}

export function hexAlpha(hex, a) {
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * A length read off a CSS custom property, in pixels.
 *
 * The calendars draw themselves in JS but rule themselves in CSS: the hour
 * lines are a repeating gradient, the blocks are absolutely positioned, and
 * the two only line up while they agree on how tall an hour is. Reading the
 * number back from the stylesheet is what keeps a media query that shortens
 * the hour from sliding every block an hour down the page.
 */
export function cssPx(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
