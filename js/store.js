// store.js — single source of truth. Local-first, localStorage-backed.

import { uid, today, addDays, toMin, fromMin, startOfWeek, diffDays } from './util.js';

const KEY = 'semesterPlanner.v1';
const LEGACY_KEYS = ['plannerData', 'semester-planner', 'semesterPlanner', 'planner', 'planner-data'];
export const SCHEMA_VERSION = 9;

/* Every area belongs to exactly one category. These are the sidebar's top
   level and the only grouping there is — add one here and it appears in the
   nav, on the overview breakdown, and as a filter, with no other change. */
export const AREA_CATEGORIES = [
  { id: 'course', label: 'Courses', singular: 'course' },
  { id: 'ner', label: 'NER', singular: 'NER area', note: 'Northeastern Electric Racing' },
  { id: 'project', label: 'Projects', singular: 'project' },
  { id: 'personal', label: 'Personal', singular: 'personal area' }
];
export const CATEGORY_IDS = AREA_CATEGORIES.map((c) => c.id);
export const categoryById = (id) => AREA_CATEGORIES.find((c) => c.id === id) || null;

/** Schema 4 and earlier filed areas under a free-form `kind`. */
const KIND_TO_CATEGORY = {
  course: 'course', personal: 'personal',
  research: 'project', thesis: 'project', work: 'project', applications: 'project'
};

/* Four kinds of thing, not eleven. An event or a meeting happens at a time;
   homework and a task are owed by a time. */
export const ITEM_TYPES = ['event', 'task', 'meeting', 'homework'];

/** Schema 7 and earlier had eleven types. */
const LEGACY_TYPE = {
  assignment: 'homework', reading: 'homework', paper: 'homework', writing: 'homework',
  exam: 'event', quiz: 'event', presentation: 'event',
  meeting: 'meeting',
  admin: 'task', personal: 'task', research: 'task'
};

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
    cards: [],          // captured notes, unfiled until given an areaId
    habits: [],         // daily habits, ticked per day
    habitLog: {},       // 'YYYY-MM-DD' -> [habitId] ticked that day
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
  s.events = Array.isArray(raw.events) ? raw.events : [];
  s.outbox = Array.isArray(raw.outbox) ? raw.outbox : [];
  s.notes = raw.notes && typeof raw.notes === 'object' ? raw.notes : {};
  s.cards = (Array.isArray(raw.cards) ? raw.cards : []).map((c) => ({
    id: c.id || uid('c'),
    text: c.text || '',
    areaId: c.areaId || null,
    createdAt: c.createdAt || new Date().toISOString(),
    updatedAt: c.updatedAt || c.createdAt || new Date().toISOString()
  })).filter((c) => c.text.trim());
  s.habits = (Array.isArray(raw.habits) ? raw.habits : []).map((x, i) => ({
    id: x.id || uid('h'),
    name: x.name || 'Untitled habit',
    order: Number.isFinite(x.order) ? x.order : i,
    archived: !!x.archived,
    createdAt: x.createdAt || new Date().toISOString()
  }));
  s.habitLog = raw.habitLog && typeof raw.habitLog === 'object' ? raw.habitLog : {};
  delete s.sessions;   // study logging was removed in schema 5

  // normalise areas
  s.areas = s.areas.map((a, i) => ({
    id: a.id || uid('a'),
    name: a.name || a.title || 'Untitled',
    // array position is local; only a field on the row itself syncs
    order: Number.isFinite(a.order) ? a.order : i,
    color: a.color || AREA_COLORS[i % AREA_COLORS.length],
    category: CATEGORY_IDS.includes(a.category)
      ? a.category
      : (KIND_TO_CATEGORY[a.kind || a.type] || 'course'),
    location: a.location || '',
    archived: !!a.archived,
    schedule: Array.isArray(a.schedule) ? a.schedule : [],
    grading: Array.isArray(a.grading) ? a.grading : []
  }));

  // Seed a category that would otherwise be an empty heading, once, on the
  // upgrade that introduced it. Each is pinned to its own version rather than
  // SCHEMA_VERSION: a later bump must not resurrect one the user deleted.
  const from = raw.version || 0;
  const seed = (name, category) => {
    if (s.areas.some((a) => a.category === category)) return;
    s.areas.push({
      id: uid('a'), name, color: AREA_COLORS[s.areas.length % AREA_COLORS.length],
      category, order: s.areas.length, location: '', archived: false, schedule: [], grading: []
    });
  };
  if (from < 5) seed('Rocket', 'project');
  if (from < 6) seed('NER Meetings', 'ner');
  if (from < 8) seed('Personal', 'personal');

  // the habit page is useless empty, so give it the ones it was built for
  if (from < 9 && !s.habits.length) {
    s.habits = [
      'No phone — morning', 'No phone — eating', 'No phone — night',
      '10k steps or workout', 'Out of bed by 9:00'
    ].map((name, i) => ({ id: uid('h'), name, order: i, archived: false, createdAt: new Date().toISOString() }));
  }

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
      type: ITEM_TYPES.includes(t.type) ? t.type : (LEGACY_TYPE[t.type] || 'task'),
      due: t.due || t.dueDate || null,
      dueTime: t.dueTime || null,
      plan,
      priority: t.priority || 'normal',   // low | normal | high
      estMins: Number(t.estMins ?? t.estimate ?? 60) || 60,
      done: !!t.done,
      doneAt: t.doneAt || null,
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      notes: t.notes || '',
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

/* ---- categories ---- */

/** Areas filed under one category, active first unless archived is asked for. */
export function areasInCategory(categoryId, { includeArchived = false } = {}) {
  return state.areas
    .filter((a) => a.category === categoryId && (includeArchived || !a.archived))
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
}

export const itemsForArea = (areaId) => state.items.filter((t) => t.areaId === areaId);

/** Everything belonging to any area in this category. */
function itemsInCategory(categoryId) {
  const ids = new Set(areasInCategory(categoryId, { includeArchived: true }).map((a) => a.id));
  return state.items.filter((t) => ids.has(t.areaId));
}

/** Open-work counts per category, for the overview breakdown. */
export function categoryLoad() {
  return AREA_CATEGORIES.map((c) => {
    const open = itemsInCategory(c.id).filter((t) => !t.done);
    return {
      ...c,
      areas: areasInCategory(c.id).length,
      open: open.length,
      mins: open.reduce((n, t) => n + (t.estMins || 0), 0)
    };
  });
}

/* ---- captured cards ---- */

export const unfiledCards = () => state.cards.filter((c) => !c.areaId);
export const cardsForArea = (areaId) => state.cards.filter((c) => c.areaId === areaId);
export const cardById = (id) => state.cards.find((c) => c.id === id) || null;

/** The next few open items for an area, soonest first — undated last. */
export function nextForArea(areaId, limit = 3) {
  return itemsForArea(areaId)
    .filter((t) => !t.done)
    .sort((a, b) => {
      const da = a.due || a.plan?.date || '9999-99-99';
      const db = b.due || b.plan?.date || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}

export function itemsDueOn(date) { return state.items.filter((t) => t.due === date); }
export function itemsPlannedOn(date) { return state.items.filter((t) => t.plan && t.plan.date === date); }

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

/* ---------------- mutations ---------------- */

/** Where an item goes when nothing else is said: the Personal area, if there
 *  is one. Falls back to unassigned rather than inventing an area. */
export const defaultAreaId = () => areasInCategory('personal')[0]?.id || null;

export function upsertItem(patch) {
  const now = new Date().toISOString();
  let item = patch.id ? itemById(patch.id) : null;
  if (item) {
    Object.assign(item, patch, { updatedAt: now });
  } else {
    item = {
      id: uid('t'), title: 'Untitled', areaId: null, type: 'task',
      due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60,
      done: false, doneAt: null, subtasks: [], notes: '',
      gcalId: null, createdAt: now, updatedAt: now, ...patch
    };
    if (!item.areaId) item.areaId = defaultAreaId();
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
      id: uid('a'), name: 'New area', category: 'course', location: '',
      color: AREA_COLORS[state.areas.length % AREA_COLORS.length],
      schedule: [], grading: [], archived: false,
      order: state.areas.length,
      updatedAt: new Date().toISOString(), ...patch
    };
    state.areas.push(a);
  }
  return a;
}

/**
 * Write a new order for one category. Takes the ids in the order they should
 * appear; anything not named keeps its place at the end. Values are only ever
 * compared within a category, so they need not be unique across all areas.
 */
export function reorderAreas(categoryId, orderedIds) {
  const rest = areasInCategory(categoryId, { includeArchived: true })
    .filter((a) => !orderedIds.includes(a.id))
    .map((a) => a.id);
  [...orderedIds, ...rest].forEach((id, i) => {
    const a = areaById(id);
    if (a) { a.order = i; a.updatedAt = new Date().toISOString(); }
  });
}

export function deleteArea(id) {
  const i = state.areas.findIndex((a) => a.id === id);
  if (i >= 0) state.areas.splice(i, 1);
  for (const t of state.items) if (t.areaId === id) t.areaId = null;
}

/* ---- habits ---- */

export const activeHabits = () =>
  state.habits.filter((x) => !x.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export const habitDone = (date, id) => (state.habitLog[date] || []).includes(id);

export function toggleHabit(date, id, force) {
  const on = force ?? !habitDone(date, id);
  const list = state.habitLog[date] || [];
  if (on) { if (!list.includes(id)) state.habitLog[date] = [...list, id]; }
  else {
    const next = list.filter((x) => x !== id);
    if (next.length) state.habitLog[date] = next; else delete state.habitLog[date];
  }
  return on;
}

/** Consecutive days ticked, counting back. Today not yet ticked doesn't break
 *  a streak — the day isn't over — but a missed yesterday does. */
export function habitStreak(id, ref = today()) {
  let day = habitDone(ref, id) ? ref : addDays(ref, -1);
  let n = 0;
  while (habitDone(day, id)) { n++; day = addDays(day, -1); }
  return n;
}

export function addHabit(name) {
  const habit = {
    id: uid('h'), name: name.trim() || 'Untitled habit',
    order: state.habits.length, archived: false, createdAt: new Date().toISOString()
  };
  state.habits.push(habit);
  return habit;
}

export function updateHabit(id, patch) {
  const x = state.habits.find((h) => h.id === id);
  if (x) Object.assign(x, patch);
  return x;
}

/** Removes the habit and every tick it ever had — there is nothing else to keep. */
export function deleteHabit(id) {
  const i = state.habits.findIndex((x) => x.id === id);
  if (i >= 0) state.habits.splice(i, 1);
  for (const [date, list] of Object.entries(state.habitLog)) {
    const next = list.filter((x) => x !== id);
    if (next.length) state.habitLog[date] = next; else delete state.habitLog[date];
  }
}

export function reorderHabits(orderedIds) {
  const rest = state.habits.filter((x) => !orderedIds.includes(x.id)).map((x) => x.id);
  [...orderedIds, ...rest].forEach((id, i) => { const x = state.habits.find((h) => h.id === id); if (x) x.order = i; });
}

/* ---- cards ---- */

/** Capture a note. Unfiled unless an area is named. */
export function addCard(text, { areaId = null } = {}) {
  const now = new Date().toISOString();
  const card = { id: uid('c'), text: text.trim(), areaId, createdAt: now, updatedAt: now };
  state.cards.unshift(card);
  return card;
}

export function updateCard(id, patch) {
  const c = cardById(id);
  if (c) Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  return c;
}

export function deleteCard(id) {
  const i = state.cards.findIndex((c) => c.id === id);
  if (i >= 0) state.cards.splice(i, 1);
}

/**
 * Turn a card into a task and consume it. The card's own text goes through the
 * quick-add parser, so "call advisor thu 2pm 30m" arrives dated exactly as it
 * would from the bar up top.
 * @param {'task'|'timed'} as  'timed' also books a work block, which is what
 *   makes it reach Google Calendar — a due date alone is never pushed.
 */
export function cardToItem(id, { as = 'task', areaId } = {}) {
  const card = cardById(id);
  if (!card) return null;
  const parsed = parseQuickAdd(card.text);
  if (areaId !== undefined) parsed.areaId = areaId;
  else if (card.areaId) parsed.areaId = card.areaId;

  if (as === 'timed') {
    const date = parsed.due || parsed.plan?.date || today();
    const start = parsed.dueTime || parsed.plan?.start || '09:00';
    parsed.due = date;
    parsed.dueTime = start;
    parsed.plan = { date, start, mins: parsed.estMins || 60 };
  }
  const item = upsertItem(parsed);
  deleteCard(id);
  return item;
}

export function note(date) {
  if (!state.notes[date]) state.notes[date] = { focus: '', text: '', top3: [] };
  return state.notes[date];
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

/**
 * A start–end time range: "12-7", "2:30-4pm", "9 to 11am".
 *
 * Bare hours are read the way a person means them during a day: 7–11 is
 * morning, 12 is noon, 1–6 is afternoon. So "12-7" is noon to seven, and
 * "2-4" is the afternoon. An end that lands before its start is pushed
 * twelve hours, which is what "11-1" means.
 */
function parseRange(text) {
  const m = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;

  // "read ch 3-4" and "pages 10-20" are ranges of things, not of hours
  const before = text.slice(0, m.index);
  if (/\b(ch|chap|chapters?|p|pp|pg|pages?|problems?|q|questions?|sections?|no|nums?|units?|weeks?|#)\s*\.?\s*$/i.test(before)) {
    return null;
  }

  const daytime = (h) => (h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12);
  const hour = (raw, ampm) => {
    const h = +raw;
    if (!ampm) return daytime(h);
    const base = h % 12;
    return /pm/i.test(ampm) ? base + 12 : base;
  };

  let sh = hour(m[1], m[3]);
  let eh = hour(m[4], m[6] || m[3]);   // "9 to 11am" — a trailing meridiem covers both
  const sm = +(m[2] || 0), em = +(m[5] || 0);
  let start = sh * 60 + sm, end = eh * 60 + em;
  if (end <= start) end += 12 * 60;                       // "11-1"
  if (end <= start || end > 24 * 60) return null;

  return { start: fromMin(start), end: fromMin(end), mins: end - start, consumed: m[0] };
}

export function parseQuickAdd(input) {
  let text = ' ' + input.trim() + ' ';
  const out = { title: '', areaId: null, type: 'task', due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60 };

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

  // type: first specific hint wins, else the bare type word, else task
  const TYPE_HINTS = [
    [/\b(meet|meeting|call|1:1|sync|standup|office\s*hours)\b/i, 'meeting'],
    [/\b(hw|homework|problem\s?set|pset|ps\s*\d|assignment|quiz|paper|essay|report|memo|proposal|draft|abstract|read|reading|chapter|ch\.)\b/i, 'homework'],
    [/\b(midterm|final\s+exam|exam|test|present|presentation|talk|demo|lecture|class|flight|fly|appointment)\b/i, 'event'],
    [/\b(email|form|register|submit|admin|errand)\b/i, 'task']
  ];
  const hinted = TYPE_HINTS.find(([re]) => re.test(text));
  if (hinted) out.type = hinted[1];
  else {
    for (const ty of ITEM_TYPES) {
      if (new RegExp(`\\b${ty}\\b`, 'i').test(text)) { out.type = ty; break; }
    }
  }

  // A start-end range makes this a scheduled thing rather than a deadline.
  // Take it out of the text before anything else looks for a time: otherwise
  // parseWhen() claims one half as a due time and the other half is left
  // stranded in the title — "fly to boston aug 29 12-7" became "fly to boston
  // 12 to", due 7pm.
  const range = parseRange(text);
  if (range) {
    const at = text.toLowerCase().indexOf(range.consumed.toLowerCase());
    if (at >= 0) {
      text = text.slice(0, at) + ' '.repeat(range.consumed.length) + text.slice(at + range.consumed.length);
    }
    out.estMins = range.mins;
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

  if (range) {
    out.plan = { date: out.due || out.plan?.date || today(), start: range.start, mins: range.mins };
    out.due = null;
    out.dueTime = null;
    if (!hinted) out.type = 'event';
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
  for (const c of state.cards) rows.push({ kind: 'card', id: c.id, data: c });
  for (const [date, n] of Object.entries(state.notes)) {
    if (!emptyNote(n)) rows.push({ kind: 'note', id: date, data: n });
  }
  const settings = {};
  for (const k of SYNCED_SETTINGS) settings[k] = state.settings[k];
  // habits travel in meta rather than as their own kind: the planner_rows
  // CHECK constraint only knows the kinds it was created with, and this needs
  // no migration to reach another device
  rows.push({
    kind: 'meta', id: 'meta',
    data: { semester: state.semester, settings, habits: state.habits, habitLog: state.habitLog }
  });
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
    case 'card': return put(state.cards, data);
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
      if (Array.isArray(data.habits)) state.habits = data.habits;
      if (data.habitLog && typeof data.habitLog === 'object') state.habitLog = data.habitLog;
      return true;
    default: return false;
  }
}

/** Local modification time for a row, used to settle conflicts. */
export function rowStamp(kind, id) {
  if (kind === 'item') return itemById(id)?.updatedAt || null;
  if (kind === 'card') return cardById(id)?.updatedAt || null;
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
    const seenC = new Set(state.cards.map((c) => c.id));
    state.cards.push(...next.cards.filter((c) => !seenC.has(c.id)));
    const seenH = new Set(state.habits.map((x) => x.id));
    state.habits.push(...next.habits.filter((x) => !seenH.has(x.id)));
    for (const [d, list] of Object.entries(next.habitLog)) {
      state.habitLog[d] = [...new Set([...(state.habitLog[d] || []), ...list])];
    }
    Object.assign(state.notes, next.notes);
  }
  save();
}
