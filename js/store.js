// store.js — single source of truth. Local-first, localStorage-backed.

import { uid, ymd, today, addDays, toMin, fromMin, startOfWeek, diffDays } from './util.js';

const KEY = 'semesterPlanner.v1';
const LEGACY_KEYS = ['plannerData', 'semester-planner', 'semesterPlanner', 'planner', 'planner-data'];
export const SCHEMA_VERSION = 4;

export const ITEM_TYPES = [
  'assignment', 'reading', 'exam', 'quiz', 'paper', 'presentation',
  'meeting', 'research', 'writing', 'admin', 'personal'
];

export const AREA_COLORS = [
  '#3C6E8F', '#7A5C9E', '#2F7D62', '#B4713C', '#9E4A5C',
  '#4B6BA8', '#7E7A2E', '#5A6572', '#A0522D', '#3F7A7A'
];

const DEFAULTS = () => {
  const y = new Date().getFullYear();
  const fall = new Date().getMonth() >= 6;
  return {
    version: SCHEMA_VERSION,
    semester: {
      name: fall ? `Fall ${y}` : `Spring ${y}`,
      start: fall ? `${y}-09-02` : `${y}-01-06`,
      end: fall ? `${y}-12-12` : `${y}-04-24`
    },
    areas: [],
    items: [],
    sessions: [],
    notes: {},          // 'YYYY-MM-DD' -> { focus, text, top3:[itemId] }
    events: [],         // external Google events, read-only mirror
    outbox: [],         // queued Google writes while offline/signed out
    settings: {
      theme: 'graphite',
      colors: {},
      fonts: { heading: '', body: '', mono: '' },
      scale: 1,
      hour12: true,
      weekStart: 1,     // Monday
      dayStart: 7,      // week grid first hour
      dayEnd: 23,
      gcal: {
        clientId: '',
        calendarId: 'primary',
        enabled: false,
        pushPlans: true,
        syncToken: '',
        lastSync: null
      },
      cloud: {
        url: '',
        anonKey: '',
        enabled: false,
        cursor: '',       // server synced_at high-water mark
        lastSync: null
      }
    }
  };
};

/* ---------------- persistence ---------------- */

function migrate(raw) {
  const base = DEFAULTS();
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.settings = { ...base.settings, ...(raw.settings || {}) };
  s.settings.gcal = { ...base.settings.gcal, ...((raw.settings || {}).gcal || {}) };
  s.settings.cloud = { ...base.settings.cloud, ...((raw.settings || {}).cloud || {}) };
  s.settings.fonts = { ...base.settings.fonts, ...((raw.settings || {}).fonts || {}) };
  s.settings.colors = { ...((raw.settings || {}).colors || {}) };
  s.semester = { ...base.semester, ...(raw.semester || {}) };
  s.areas = Array.isArray(raw.areas) ? raw.areas : (Array.isArray(raw.courses) ? raw.courses : []);
  s.items = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.tasks) ? raw.tasks : []);
  s.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  s.events = Array.isArray(raw.events) ? raw.events : [];
  s.outbox = Array.isArray(raw.outbox) ? raw.outbox : [];
  s.notes = raw.notes && typeof raw.notes === 'object' ? raw.notes : {};

  // normalise areas
  s.areas = s.areas.map((a, i) => ({
    id: a.id || uid('a'),
    name: a.name || a.title || 'Untitled',
    color: a.color || AREA_COLORS[i % AREA_COLORS.length],
    kind: a.kind || a.type || 'course',
    location: a.location || '',
    archived: !!a.archived,
    schedule: Array.isArray(a.schedule) ? a.schedule : [],
    grading: Array.isArray(a.grading) ? a.grading : []
  }));

  // normalise items (older schemas used plannedDate / dueDate / estimate)
  s.items = s.items.map((t) => {
    const plan = t.plan && typeof t.plan === 'object'
      ? t.plan
      : (t.plannedDate || t.planned
        ? { date: t.plannedDate || t.planned, start: t.plannedStart || null, mins: t.estMins || t.estimate || 60 }
        : null);
    return {
      id: t.id || uid('t'),
      title: t.title || 'Untitled',
      areaId: t.areaId || t.courseId || null,
      type: t.type || 'assignment',
      due: t.due || t.dueDate || null,
      dueTime: t.dueTime || null,
      plan,
      priority: t.priority || 'normal',   // low | normal | high
      estMins: Number(t.estMins ?? t.estimate ?? 60) || 60,
      done: !!t.done,
      doneAt: t.doneAt || null,
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      notes: t.notes || '',
      grade: t.grade || null,             // { score, outOf, category }
      gcalId: t.gcalId || null,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || new Date().toISOString()
    };
  });

  s.version = SCHEMA_VERSION;
  return s;
}

function loadRaw() {
  try {
    const mine = localStorage.getItem(KEY);
    if (mine) return JSON.parse(mine);
  } catch (e) { console.warn('planner: bad primary store', e); }
  // one-time adoption of an older build's data — never destructive, the old key stays put
  for (const k of LEGACY_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (!v) continue;
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') {
        console.info('planner: imported legacy data from', k);
        return parsed;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export const state = migrate(loadRaw());

let saveTimer = null;
const subs = new Set();

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.error('planner: save failed', e);
      window.dispatchEvent(new CustomEvent('planner:save-error', { detail: e }));
    }
  }, 120);
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Mutate + persist + notify. */
export function commit(fn, meta = {}) {
  if (typeof fn === 'function') fn(state);
  save();
  for (const s of subs) s(meta);
}

// cross-tab / cross-window coherence
window.addEventListener('storage', (e) => {
  if (e.key !== KEY || !e.newValue) return;
  try {
    const next = migrate(JSON.parse(e.newValue));
    Object.assign(state, next);
    for (const s of subs) s({ external: true });
  } catch { /* ignore */ }
});

/* ---------------- selectors ---------------- */

export const areaById = (id) => state.areas.find((a) => a.id === id) || null;
export const itemById = (id) => state.items.find((t) => t.id === id) || null;
export const areaColor = (id) => (areaById(id) || {}).color || 'var(--muted)';
export const areaName = (id) => (areaById(id) || {}).name || 'Unassigned';

export const openItems = () => state.items.filter((t) => !t.done);

export function itemsDueOn(date) { return state.items.filter((t) => t.due === date); }
export function itemsPlannedOn(date) { return state.items.filter((t) => t.plan && t.plan.date === date); }

export function itemsInRange(a, b) {
  return state.items.filter((t) => {
    const d = t.due || (t.plan && t.plan.date);
    return d && d >= a && d <= b;
  });
}

export function overdue(ref = today()) {
  return state.items.filter((t) => !t.done && t.due && t.due < ref);
}

export function upcoming(days = 14, ref = today()) {
  const end = addDays(ref, days);
  return state.items
    .filter((t) => !t.done && t.due && t.due >= ref && t.due <= end)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

export function progress(item) {
  if (!item.subtasks.length) return item.done ? 1 : 0;
  return item.subtasks.filter((s) => s.done).length / item.subtasks.length;
}

export function workloadFor(dates) {
  const set = new Set(dates);
  let mins = 0, count = 0;
  for (const t of state.items) {
    if (t.done) continue;
    const d = (t.plan && t.plan.date) || t.due;
    if (d && set.has(d)) { mins += (t.plan && t.plan.mins) || t.estMins || 0; count++; }
  }
  return { mins, count };
}

export function semesterProgress() {
  const { start, end } = state.semester;
  const total = diffDays(start, end) || 1;
  const gone = diffDays(start, today());
  return Math.max(0, Math.min(1, gone / total));
}

export function weekNumber(date = today()) {
  const s = startOfWeek(state.semester.start, state.settings.weekStart);
  return Math.floor(diffDays(s, date) / 7) + 1;
}

/** Recurring class meetings that land on a given date. */
export function classesOn(date) {
  const d = new Date(date + 'T00:00:00');
  const dow = d.getDay();
  const { start, end } = state.semester;
  if (date < start || date > end) return [];
  const out = [];
  for (const a of state.areas) {
    if (a.archived) continue;
    for (const m of a.schedule || []) {
      if (!(m.days || []).includes(dow)) continue;
      out.push({
        kind: 'class', areaId: a.id, title: a.name, color: a.color,
        start: m.start, end: m.end, location: m.location || a.location || ''
      });
    }
  }
  return out.sort((x, y) => toMin(x.start) - toMin(y.start));
}

/** External Google events on a date. */
export function eventsOn(date) {
  return state.events
    .filter((e) => e.date === date)
    .sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || toMin(a.start) - toMin(b.start));
}

export function sessionsBetween(a, b) {
  return state.sessions.filter((s) => s.date >= a && s.date <= b);
}
export const studyMinutes = (list) => list.reduce((n, s) => n + (s.mins || 0), 0);

/* ---------------- mutations ---------------- */

export function upsertItem(patch) {
  const now = new Date().toISOString();
  let item = patch.id ? itemById(patch.id) : null;
  if (item) {
    Object.assign(item, patch, { updatedAt: now });
  } else {
    item = {
      id: uid('t'), title: 'Untitled', areaId: null, type: 'assignment',
      due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60,
      done: false, doneAt: null, subtasks: [], notes: '', grade: null,
      gcalId: null, createdAt: now, updatedAt: now, ...patch
    };
    state.items.push(item);
  }
  return item;
}

export function deleteItem(id) {
  const i = state.items.findIndex((t) => t.id === id);
  if (i >= 0) state.items.splice(i, 1);
}

export function toggleItem(id, force) {
  const t = itemById(id);
  if (!t) return;
  t.done = force ?? !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  t.updatedAt = new Date().toISOString();
}

export function upsertArea(patch) {
  let a = patch.id ? areaById(patch.id) : null;
  if (a) Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  else {
    a = {
      id: uid('a'), name: 'New area', kind: 'course', location: '',
      color: AREA_COLORS[state.areas.length % AREA_COLORS.length],
      schedule: [], grading: [], archived: false,
      updatedAt: new Date().toISOString(), ...patch
    };
    state.areas.push(a);
  }
  return a;
}

export function deleteArea(id) {
  const i = state.areas.findIndex((a) => a.id === id);
  if (i >= 0) state.areas.splice(i, 1);
  for (const t of state.items) if (t.areaId === id) t.areaId = null;
  for (const s of state.sessions) if (s.areaId === id) s.areaId = null;
}

export function note(date) {
  if (!state.notes[date]) state.notes[date] = { focus: '', text: '', top3: [] };
  return state.notes[date];
}

export function logSession({ areaId, startedAt, endedAt, mins, mode }) {
  const s = {
    id: uid('s'), areaId: areaId || null,
    startedAt, endedAt, mins: Math.max(1, Math.round(mins)),
    mode: mode || 'focus', date: ymd(new Date(startedAt))
  };
  state.sessions.unshift(s);
  return s;
}

/* ---------------- quick add parser ----------------
   "Topology PS3 due fri 5pm 2h !high #Topology plan tue"
   Understands: due <when>, plan <when>, bare dates, times, durations, !priority, #area  */

const DOW_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function nextDow(dow, from = today()) {
  const d = new Date(from + 'T00:00:00');
  const delta = (dow - d.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

function parseWhen(text) { // returns {date, time, consumed:[strings]} or null
  const t = text.toLowerCase();
  const consumed = [];
  let date = null, time = null;

  let m = t.match(/\b(today|tonight|tomorrow|tmr)\b/);
  if (m) { date = m[1] === 'today' || m[1] === 'tonight' ? today() : addDays(today(), 1); consumed.push(m[0]); }

  if (!date) {
    m = t.match(/\bnext\s+(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\b/);
    if (m) { date = addDays(nextDow(DOW_WORDS[m[1]]), 0); consumed.push(m[0]); }
  }
  if (!date) {
    m = t.match(/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(day|s|nesday|rsday|urday)?\b/);
    if (m) { date = nextDow(DOW_WORDS[m[1]]); consumed.push(m[0]); }
  }
  if (!date) {
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
    if (m) {
      const mi = MONTH_WORDS.indexOf(m[1].slice(0, 3));
      const y = new Date().getFullYear();
      const cand = `${y}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
      date = cand < today() && diffDays(cand, today()) > 200 ? `${y + 1}${cand.slice(4)}` : cand;
      consumed.push(m[0]);
    }
  }
  if (!date) {
    m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
      date = `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
      consumed.push(m[0]);
    }
  }

  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let H = +m[1] % 12;
    if (m[3] === 'pm') H += 12;
    time = fromMin(H * 60 + (+m[2] || 0));
    consumed.push(m[0]);
  } else {
    m = t.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
    if (m) { time = fromMin(+m[1] * 60 + +m[2]); consumed.push(m[0]); }
  }

  return date || time ? { date, time, consumed } : null;
}

export function parseQuickAdd(input) {
  let text = ' ' + input.trim() + ' ';
  const out = { title: '', areaId: null, type: 'assignment', due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60 };

  // priority
  const pm = text.match(/\s!(high|low|normal|h|l)\b/i);
  if (pm) {
    const v = pm[1].toLowerCase();
    out.priority = v.startsWith('h') ? 'high' : v.startsWith('l') ? 'low' : 'normal';
    text = text.replace(pm[0], ' ');
  }

  // duration
  const dm = text.match(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i);
  if (dm) {
    const n = parseFloat(dm[1]);
    out.estMins = /^h/i.test(dm[2]) ? Math.round(n * 60) : Math.round(n);
    text = text.replace(dm[0], ' ');
  }

  // area by #tag or exact name match
  const am = text.match(/\s#([\w-]+)/);
  if (am) {
    const a = state.areas.find((x) => x.name.toLowerCase().replace(/\s+/g, '') === am[1].toLowerCase().replace(/\s+/g, ''));
    if (a) out.areaId = a.id;
    text = text.replace(am[0], ' ');
  } else {
    for (const a of state.areas) {
      const re = new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) { out.areaId = a.id; break; }
    }
  }

  // type: first specific hint wins, else the bare type word, else assignment
  const TYPE_HINTS = [
    [/\bquiz\b/i, 'quiz'],
    [/\b(midterm|final\s+exam|exam|test)\b/i, 'exam'],
    [/\b(hw|homework|problem\s?set|pset|ps\s*\d)\b/i, 'assignment'],
    [/\b(present|presentation|talk|demo)\b/i, 'presentation'],
    [/\b(paper|essay|report|memo|proposal|draft|abstract)\b/i, 'paper'],
    [/\b(read|reading|chapter|ch\.)\b/i, 'reading'],
    [/\b(meet|meeting|call|1:1|sync)\b/i, 'meeting'],
    [/\b(email|form|register|submit|admin)\b/i, 'admin']
  ];
  const hinted = TYPE_HINTS.find(([re]) => re.test(text));
  if (hinted) out.type = hinted[1];
  else {
    for (const ty of ITEM_TYPES) {
      if (new RegExp(`\\b${ty}\\b`, 'i').test(text)) { out.type = ty; break; }
    }
  }

  // planned date: "plan <when>" / "work <when>"
  const planIdx = text.search(/\b(plan|work on|work|start)\b/i);
  const dueIdx = text.search(/\bdue\b/i);

  const grab = (from) => {
    const seg = text.slice(from);
    const w = parseWhen(seg);
    if (!w) return null;
    for (const c of w.consumed) {
      const i = text.toLowerCase().indexOf(c, from);
      if (i >= 0) text = text.slice(0, i) + ' '.repeat(c.length) + text.slice(i + c.length);
    }
    return w;
  };

  if (planIdx >= 0) {
    const w = grab(planIdx);
    if (w) out.plan = { date: w.date || today(), start: w.time || null, mins: out.estMins };
    text = text.replace(/\b(plan|work on|work|start)\b/i, ' ');
  }
  if (dueIdx >= 0) {
    const w = grab(dueIdx);
    if (w) { out.due = w.date; out.dueTime = w.time; }
    text = text.replace(/\bdue\b/i, ' ');
  }
  if (!out.due && !out.plan) {
    const w = grab(0);
    if (w) { out.due = w.date; out.dueTime = w.time; }
  }

  out.title = text.replace(/\s+/g, ' ').trim().replace(/^[-–—:]\s*/, '') || 'Untitled';
  return out;
}

/* ---------------- cloud snapshot ----------------
   Rows are (kind, id, data). One shape, so the sync engine stays generic.
   Device-specific settings — Google tokens, Supabase credentials, sync
   cursors — are deliberately NOT synced: they belong to the device. */

export const SYNCED_SETTINGS = ['theme', 'colors', 'fonts', 'scale', 'hour12', 'weekStart', 'dayStart', 'dayEnd'];

const emptyNote = (n) => !n || (!n.focus && !n.text && !(n.top3 || []).length);

/** Every syncable row in the current state. */
export function snapshotRows() {
  const rows = [];
  for (const a of state.areas) rows.push({ kind: 'area', id: a.id, data: a });
  for (const t of state.items) rows.push({ kind: 'item', id: t.id, data: t });
  for (const x of state.sessions) rows.push({ kind: 'session', id: x.id, data: x });
  for (const [date, n] of Object.entries(state.notes)) {
    if (!emptyNote(n)) rows.push({ kind: 'note', id: date, data: n });
  }
  const settings = {};
  for (const k of SYNCED_SETTINGS) settings[k] = state.settings[k];
  rows.push({ kind: 'meta', id: 'meta', data: { semester: state.semester, settings } });
  return rows;
}

/** Write one row from the cloud into local state. Returns true if anything changed. */
export function applyRow({ kind, id, data, deleted }) {
  const put = (arr, obj) => {
    const i = arr.findIndex((x) => x.id === id);
    if (deleted) { if (i >= 0) { arr.splice(i, 1); return true; } return false; }
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    return true;
  };
  switch (kind) {
    case 'area': return put(state.areas, data);
    case 'item': return put(state.items, data);
    case 'session': return put(state.sessions, data);
    case 'note':
      if (deleted) { if (state.notes[id]) { delete state.notes[id]; return true; } return false; }
      state.notes[id] = data;
      return true;
    case 'meta':
      if (deleted || !data) return false;
      if (data.semester) Object.assign(state.semester, data.semester);
      if (data.settings) for (const k of SYNCED_SETTINGS) {
        if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
      }
      return true;
    default: return false;
  }
}

/** Local modification time for a row, used to settle conflicts. */
export function rowStamp(kind, id) {
  if (kind === 'item') return itemById(id)?.updatedAt || null;
  if (kind === 'session') return state.sessions.find((s) => s.id === id)?.startedAt || null;
  return null;
}

/* ---------------- backup ---------------- */

export function exportJson() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString(), app: 'semester-planner' }, null, 2);
}

export function importJson(text, { merge = false } = {}) {
  const raw = JSON.parse(text);
  const next = migrate(raw);
  if (!merge) {
    Object.assign(state, next);
  } else {
    const seen = new Set(state.items.map((t) => t.id));
    state.items.push(...next.items.filter((t) => !seen.has(t.id)));
    const seenA = new Set(state.areas.map((a) => a.id));
    state.areas.push(...next.areas.filter((a) => !seenA.has(a.id)));
    const seenS = new Set(state.sessions.map((s) => s.id));
    state.sessions.push(...next.sessions.filter((s) => !seenS.has(s.id)));
    Object.assign(state.notes, next.notes);
  }
  save();
}
