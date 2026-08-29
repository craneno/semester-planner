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

export function today() { return ymd(new Date()); }

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
