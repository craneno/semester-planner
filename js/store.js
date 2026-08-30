// store.js — single source of truth. Local-first, localStorage-backed.

import { uid, today, addDays, toMin, fromMin, diffDays } from './util.js';

const KEY = 'semesterPlanner.v1';
const LEGACY_KEYS = ['plannerData', 'semester-planner', 'semesterPlanner', 'planner', 'planner-data'];
export const SCHEMA_VERSION = 18;

/* Every area belongs to exactly one category. These are the sidebar's top
   level and the only grouping there is — add one here and it appears in the
   nav, on the overview breakdown, and as a filter, with no other change. */
export const AREA_CATEGORIES = [
  { id: 'course', label: 'Courses', singular: 'course' },
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

/** Categories folded into another one. NER stopped being a heading of its own
 *  in schema 11 — an NER subteam is a project like any other. Unlike a seed
 *  this is not pinned to a version: a category that no longer exists has to be
 *  translated every time it is read, not once. */
const MERGED_CATEGORY = { ner: 'project' };

const areaCategory = (a) => {
  const c = MERGED_CATEGORY[a.category] || a.category;
  return CATEGORY_IDS.includes(c) ? c : (KIND_TO_CATEGORY[a.kind || a.type] || 'course');
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

/* A thing you want and a parcel on its way are one object at two points in its
   life. Declared up here because migrate() runs at import and needs it. */
export const WISH_STATUSES = ['wanted', 'ordered', 'shipped', 'delivered'];

/* Two ways to block out a stretch of the term on the chart. A focus is the
   theme of a few weeks and carries nothing but its name; a sprint is a work
   package and carries the deliverables that say when it is finished. The
   difference is deliberate: making every band demand deliverables would mean
   inventing them, and an invented deliverable is worse than none. */
export const SPRINT_KINDS = ['focus', 'sprint'];

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
    links: [],          // saved links, filed to an area — the "come back to this" pile
    wishlist: [],       // things wanted, and the deliveries they turn into
    sprints: [],        // focuses and sprints — stretches of term drawn on the chart
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
      weekStart: 0,     // Sunday
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
  s.links = (Array.isArray(raw.links) ? raw.links : []).map((l) => {
    const url = normalizeUrl(l.url);
    return url ? {
      id: l.id || uid('l'),
      url,
      title: String(l.title || '').trim() || linkTitleFromUrl(url),
      areaId: l.areaId || null,
      createdAt: l.createdAt || new Date().toISOString(),
      updatedAt: l.updatedAt || l.createdAt || new Date().toISOString()
    } : null;
  }).filter(Boolean);
  s.wishlist = (Array.isArray(raw.wishlist) ? raw.wishlist : []).map((w) => ({
    id: w.id || uid('w'),
    title: String(w.title || '').trim() || 'Untitled',
    url: normalizeUrl(w.url) || null,
    price: Number.isFinite(Number(w.price)) && w.price !== null && w.price !== '' ? Number(w.price) : null,
    status: WISH_STATUSES.includes(w.status) ? w.status : 'wanted',
    eta: w.eta || null,
    createdAt: w.createdAt || new Date().toISOString(),
    updatedAt: w.updatedAt || w.createdAt || new Date().toISOString()
  }));
  s.sprints = (Array.isArray(raw.sprints) ? raw.sprints : []).map((p) => {
    let start = p.start || p.end || null;
    let end = p.end || p.start || null;
    if (start && end && start > end) [start, end] = [end, start];
    return start && end ? {
      id: p.id || uid('s'),
      areaId: p.areaId || null,
      kind: SPRINT_KINDS.includes(p.kind) ? p.kind : 'focus',
      title: String(p.title || '').trim() || 'Untitled',
      start, end,
      // a focus keeps whatever it was given rather than having it thrown
      // away: switching a band back to a sprint should find its list intact
      deliverables: (Array.isArray(p.deliverables) ? p.deliverables : []).map((d) => ({
        id: d.id || uid('d'), text: String(d.text || '').trim(), done: !!d.done
      })).filter((d) => d.text),
      notes: p.notes || '',
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || p.createdAt || new Date().toISOString()
    } : null;
  }).filter(Boolean);
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
    category: areaCategory(a),
    location: a.location || '',
    archived: !!a.archived,
    // absent means yes: every area an older device pushes belongs on the chart
    // until someone says otherwise, and only a false ever has to travel
    onChart: a.onChart !== false,
    // absent means no, which is the quiet default: an area nobody asked to
    // journal in does not grow a writing box on its page
    journal: !!a.journal,
    // the scratch pad every area gets. A string, never null, so a box can be
    // bound to it without a guard at every read
    freewrite: typeof a.freewrite === 'string' ? a.freewrite : '',
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
  /** Seed one named area even where its category already has others. */
  const seedNamed = (name, category) => {
    if (s.areas.some((a) => a.name.toLowerCase() === name.toLowerCase())) return;
    s.areas.push({
      id: uid('a'), name, color: AREA_COLORS[s.areas.length % AREA_COLORS.length],
      category, order: s.areas.length, location: '', archived: false, schedule: [], grading: []
    });
  };

  if (from < 5) seed('Rocket', 'project');
  if (from < 8) seed('Personal', 'personal');
  // v12: the seeded Personal area is the general one — whatever belongs to no
  // course or project — and job hunting is its own thing rather than a pile of
  // tasks inside it. Renamed rather than replaced, so what is already filed
  // there stays filed.
  if (from < 12) {
    const general = s.areas.find((a) => a.category === 'personal' && a.name === 'Personal');
    if (general && !s.areas.some((a) => a.name.toLowerCase() === 'general')) general.name = 'General';
    seedNamed('Job search', 'personal');
  }
  if (from < 16) seedNamed('Journal', 'personal');
  // v17: the Journal seeded a version ago is a place to write, not just a
  // place to file. Marked rather than named, so renaming it keeps the box.
  if (from < 17) {
    const j = s.areas.find((a) => a.category === 'personal' && a.name.toLowerCase() === 'journal');
    if (j) j.journal = true;
  }
  // v18: the week begins on Sunday. Pinned like a seed rather than left to the
  // default, or an install that has already saved its settings would keep
  // Monday for ever — and pinned rather than forced, so Settings can still
  // put it back and the next bump will not overrule that.
  if (from < 18) s.settings.weekStart = 0;

  // the habit page is useless empty, so give it the ones it was built for.
  // Pinned per version like the area seeds: a habit deleted on purpose must
  // not reappear at the next bump.
  const addHabits = (names) => {
    for (const name of names) {
      if (s.habits.some((x) => x.name === name)) continue;
      s.habits.push({
        id: uid('h'), name, order: s.habits.length,
        archived: false, createdAt: new Date().toISOString()
      });
    }
  };
  if (from < 9 && !s.habits.length) {
    addHabits([
      'No phone — morning', 'No phone — eating', 'No phone — night',
      '10k steps or workout', 'Out of bed by 9:00'
    ]);
  }
  if (from < 10) addHabits(['Sunscreen']);

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

/**
 * The areas the semester chart draws, in the order they appear on it: by
 * category, then by the order they were dragged into. Not every area belongs
 * on a chart — a pile of errands has no shape over fifteen weeks — so an area
 * can sit this one out without being archived.
 */
export function chartAreas() {
  return CATEGORY_IDS.flatMap((c) => areasInCategory(c).filter((a) => a.onChart !== false));
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

/* ---------------- what is on today ----------------
   The day as one ordered list, whatever each thing came from: a class that
   recurs, an event Google holds, a block of work planned here. The topbar
   reads it, and so could anything else that wants to know what is next. */

/** Minutes since midnight, now. Passed in everywhere below so the callers are testable. */
export const minsNow = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

/** Everything with a time on it today, earliest first. All-day things have no
 *  place on a "what's next" line, so they are left out. */
export function dayTimeline(date = today()) {
  const out = [];
  for (const c of classesOn(date)) {
    out.push({ kind: 'class', title: c.title, start: c.start, end: c.end });
  }
  for (const e of eventsOn(date)) {
    if (e.allDay || !e.start) continue;
    out.push({ kind: 'event', title: e.title, start: e.start, end: e.end || fromMin(toMin(e.start) + 60) });
  }
  for (const t of itemsPlannedOn(date)) {
    if (!t.plan.start || t.done) continue;
    out.push({
      kind: 'plan', title: t.title, id: t.id,
      start: t.plan.start, end: fromMin(Math.min(24 * 60, toMin(t.plan.start) + (t.plan.mins || 60)))
    });
  }
  return out.sort((a, b) => toMin(a.start) - toMin(b.start));
}

/**
 * What is happening right now, or failing that what is next — null if the day
 * holds nothing else. Something in progress wins over something later: at
 * 9:30 in a 9–10 lecture the useful answer is the lecture, not the next thing
 * after it.
 */
export function nowNext(date = today(), mins = minsNow()) {
  const list = dayTimeline(date);
  const live = list.find((e) => toMin(e.start) <= mins && mins < toMin(e.end));
  if (live) return { ...live, live: true };
  const next = list.find((e) => toMin(e.start) > mins);
  return next ? { ...next, live: false } : null;
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
      schedule: [], grading: [], archived: false, onChart: true, journal: false, freewrite: '',
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
  for (const l of state.links) if (l.areaId === id) l.areaId = null;
  // a band is drawn in its area's lane and nowhere else, so an orphan is not
  // an orphan — it is a thing with no way back onto the screen
  state.sprints = state.sprints.filter((p) => p.areaId !== id);
}

/* ---------------- focuses and sprints ----------------
   A stretch of the term, swept out on the chart. Both kinds are the same
   object; `kind` decides whether the deliverables are asked for and drawn.

   They ride in the meta row for sync, like habits and links: the planner_rows
   CHECK constraint only knows the kinds it was created with, and a new one
   would mean an ALTER run by hand before another device could see any of
   this. */

export const sprintById = (id) => state.sprints.find((p) => p.id === id) || null;

export const sprintsForArea = (areaId) =>
  state.sprints.filter((p) => p.areaId === areaId)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

/** Deliverables ticked off, 0–1. A focus has none, and reports nothing. */
export function sprintProgress(p) {
  const list = p.deliverables || [];
  if (!list.length) return null;
  return list.filter((d) => d.done).length / list.length;
}

export function upsertSprint(patch) {
  const now = new Date().toISOString();
  let p = patch.id ? sprintById(patch.id) : null;
  if (p) Object.assign(p, patch, { updatedAt: now });
  else {
    p = {
      id: uid('s'), areaId: null, kind: 'focus', title: 'Untitled',
      start: today(), end: today(), deliverables: [], notes: '',
      createdAt: now, updatedAt: now, ...patch
    };
    state.sprints.push(p);
  }
  if (p.start > p.end) { const x = p.start; p.start = p.end; p.end = x; }
  if (!SPRINT_KINDS.includes(p.kind)) p.kind = 'focus';
  return p;
}

export function deleteSprint(id) {
  const i = state.sprints.findIndex((p) => p.id === id);
  if (i >= 0) state.sprints.splice(i, 1);
}

export function addDeliverable(sprintId, text) {
  const p = sprintById(sprintId);
  if (!p || !String(text).trim()) return null;
  const d = { id: uid('d'), text: String(text).trim(), done: false };
  p.deliverables.push(d);
  p.updatedAt = new Date().toISOString();
  return d;
}

export function updateDeliverable(sprintId, id, patch) {
  const d = sprintById(sprintId)?.deliverables.find((x) => x.id === id);
  if (!d) return null;
  Object.assign(d, patch);
  sprintById(sprintId).updatedAt = new Date().toISOString();
  return d;
}

export function deleteDeliverable(sprintId, id) {
  const p = sprintById(sprintId);
  if (!p) return;
  p.deliverables = p.deliverables.filter((d) => d.id !== id);
  p.updatedAt = new Date().toISOString();
}

/* ---------------- links ----------------
   A saved link is a bookmark with a home. Paste one into the bar up top and
   it joins an area's pile instead of becoming a task — the tabs you mean to
   come back to, filed where the work is.

   Titles are derived from the URL and nowhere else. A page's real <title>
   cannot be read from here: a cross-origin fetch returns a response the page
   is not allowed to look inside. So the guess is editable, and that is the
   point rather than a gap. */

const URL_HEAD = /^(?:https?:\/\/|www\.)/i;
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * http(s) only, always absolute. Anything else is refused rather than stored:
 * a `javascript:` URL saved here would run as this page the moment it is
 * clicked, and the whole point of the pile is that you click things in it.
 */
export function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return u.href;
}

/** Path segments that name nothing: every site has them. */
const EMPTY_SEGMENT = /^(?:index|home|default|main|page|view|watch|item|post|article|en|us)$/i;

/* A file on Google Drive is addressed by an opaque id and nothing else, so
   there is no name in the URL to find — only a 33-character key that the hash
   rule below would throw away, leaving the bare host. Naming the *kind* of
   thing is the honest guess: "Google Doc" is a far better starting point to
   correct than "1BxiMVs0XRA — docs.google.com". Drive will not tell us the
   real name either; that needs an API key and a scope this app does not ask
   for. Rename it in the pile. */
const GOOGLE_DOC_KIND = {
  document: 'Google Doc', spreadsheets: 'Google Sheet', presentation: 'Google Slides',
  forms: 'Google Form', drawings: 'Google Drawing'
};

function googleFileTitle(u) {
  const host = u.hostname.replace(/^www\./i, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'docs.google.com') return GOOGLE_DOC_KIND[segs[0]] || null;
  if (host === 'drive.google.com') {
    if (segs.includes('folders')) return 'Drive folder';
    if (segs.includes('d') || segs[0] === 'file' || segs[0] === 'open') return 'Drive file';
    return null;
  }
  return null;
}

/** A readable name for a URL, from the URL alone. */
export function linkTitleFromUrl(raw) {
  const href = normalizeUrl(raw);
  if (!href) return '';
  const u = new URL(href);
  const host = u.hostname.replace(/^www\./i, '');
  const drive = googleFileTitle(u);
  if (drive) return drive;
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const name = prettySegment(segs[i]);
    if (name) return `${name} — ${host}`;
  }
  return host;
}

/** '/semester-planner.html' -> 'Semester planner'; an id or a hash -> ''. */
function prettySegment(seg) {
  let s = seg;
  try { s = decodeURIComponent(s); } catch { /* keep it as it came */ }
  s = s.replace(/\.(html?|php|aspx?|jsp|cgi|pdf|docx?|pptx?|txt|md)$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || EMPTY_SEGMENT.test(s)) return '';
  if (/^\d+$/.test(s)) return '';                       // an id
  if (s.length > 60) return '';                         // a token
  if (s.length > 8 && !/[aeiou]/i.test(s)) return '';    // a hash
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const firstAreaOfCategory = (q) => {
  const cat = AREA_CATEGORIES.find((c) => c.id === q || c.label.toLowerCase() === q);
  return cat ? areasInCategory(cat.id)[0] || null : null;
};

/**
 * Resolve "ner", "rocket", "ee lab" to an area. Deliberately loose: it is
 * typed in a hurry after a pasted URL, so a word that starts any part of the
 * name is enough — "ner" has to find "NER Meetings".
 */
export function findAreaByHint(hint) {
  const q = String(hint || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  const live = state.areas.filter((a) => !a.archived);
  const norm = (a) => a.name.toLowerCase().replace(/\s+/g, ' ').trim();
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  return live.find((a) => norm(a) === q)
    || live.find((a) => squash(a.name) === squash(q))
    || live.find((a) => norm(a).startsWith(q))
    || live.find((a) => norm(a).split(' ').some((w) => w.startsWith(q)))
    || live.find((a) => norm(a).includes(q))
    || firstAreaOfCategory(q)
    || null;
}

/**
 * A quick-add line beginning with a URL is a link, not a task.
 *   "example.com"              -> the default area, title from the URL
 *   "example.com ner"          -> NER Meetings, title from the URL
 *   "example.com read this"    -> the default area, titled "read this"
 * Words that name no area become the title rather than being dropped, so
 * nothing typed is ever silently lost.
 * @returns {{url: string, title: string, areaId: string|null}|null}
 */
export function parseLinkAdd(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const [first, ...rest] = text.split(/\s+/);
  if (!URL_HEAD.test(first) && !BARE_DOMAIN.test(first)) return null;
  const url = normalizeUrl(first);
  if (!url) return null;

  const hint = rest.join(' ').trim();
  const area = hint ? findAreaByHint(hint) : null;
  return {
    url,
    title: (hint && !area) ? hint : linkTitleFromUrl(url),
    areaId: (area?.id) ?? defaultAreaId()
  };
}

export const linkById = (id) => state.links.find((l) => l.id === id) || null;
export const linksForArea = (areaId) => state.links.filter((l) => l.areaId === areaId);
/** Links with no home, including ones whose area has since been deleted. */
export const unfiledLinks = () => state.links.filter((l) => !l.areaId || !areaById(l.areaId));

export function addLink(url, { areaId, title } = {}) {
  const href = normalizeUrl(url);
  if (!href) return null;
  const now = new Date().toISOString();
  const link = {
    id: uid('l'),
    url: href,
    title: String(title || '').trim() || linkTitleFromUrl(href),
    areaId: areaId === undefined ? defaultAreaId() : areaId,
    createdAt: now,
    updatedAt: now
  };
  state.links.unshift(link);
  return link;
}

export function updateLink(id, patch) {
  const l = linkById(id);
  if (!l) return null;
  const next = { ...patch };
  if (next.url !== undefined) {
    const href = normalizeUrl(next.url);
    if (href) next.url = href; else delete next.url;    // keep the one that works
  }
  if (next.title !== undefined) next.title = String(next.title).trim() || l.title;
  Object.assign(l, next, { updatedAt: new Date().toISOString() });
  return l;
}

export function deleteLink(id) {
  const i = state.links.findIndex((l) => l.id === id);
  if (i >= 0) state.links.splice(i, 1);
}

/* ---------------- wishlist ----------------
   One list, not two. A thing you want and a parcel on its way are the same
   object at different points in its life, so wanting, ordering and waiting for
   something never means retyping it — the status moves and the ETA appears. */

/** Ordered, shipped: bought and not here yet. This is what an ETA is for. */
export const WISH_IN_FLIGHT = ['ordered', 'shipped'];
const isInFlight = (w) => WISH_IN_FLIGHT.includes(w.status);

export const wishById = (id) => state.wishlist.find((w) => w.id === id) || null;

/** Undated last, so a parcel with no ETA never hides one arriving tomorrow. */
const byEta = (a, b) => (a.eta || '9999-99-99') < (b.eta || '9999-99-99') ? -1
  : (a.eta || '9999-99-99') > (b.eta || '9999-99-99') ? 1
    : a.title.localeCompare(b.title);

export const wishesInFlight = () => state.wishlist.filter(isInFlight).sort(byEta);
export const wishesWanted = () => state.wishlist.filter((w) => w.status === 'wanted');
export const wishesDelivered = () => state.wishlist
  .filter((w) => w.status === 'delivered')
  .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

/** What a set of wishes would cost. Anything unpriced simply does not count. */
export const wishTotal = (list) =>
  list.reduce((n, w) => n + (Number.isFinite(w.price) ? w.price : 0), 0);

/** '' when there is nothing to say: no date, or it has already arrived. */
export function etaState(w, ref = today()) {
  if (!w.eta || w.status === 'delivered') return '';
  if (w.eta < ref) return 'late';
  if (w.eta === ref) return 'today';
  return diffDays(ref, w.eta) <= 2 ? 'soon' : '';
}

/**
 * "Nozzle heater $48.50 mcmaster.com/1234" — a price and a link can be typed
 * in any order, and whatever is left is the name. The same one-line habit as
 * quick add rather than a form with four boxes.
 */
export function parseWishAdd(input) {
  let text = ' ' + String(input || '').trim() + ' ';
  let url = null, price = null;

  for (const word of text.split(/\s+/)) {
    if (url || !word) continue;
    const href = /^(?:https?:\/\/|www\.)/i.test(word) ? normalizeUrl(word) : null;
    if (href) { url = href; text = text.replace(word, ' '); }
  }
  // a bare domain only counts once nothing else has claimed a link, or
  // "3.5in fan" would read the version number as a host
  if (!url) {
    const bare = text.split(/\s+/).find((w) => /\.[a-z]{2,}(?:[/?#]|$)/i.test(w) && normalizeUrl(w));
    if (bare) { url = normalizeUrl(bare); text = text.replace(bare, ' '); }
  }

  const pm = text.match(/\s\$\s?(\d+(?:\.\d{1,2})?)\b/);
  if (pm) { price = Number(pm[1]); text = text.replace(pm[0], ' '); }

  return {
    title: text.replace(/\s+/g, ' ').trim() || 'Untitled',
    url,
    price
  };
}

export function addWish(input, { status = 'wanted' } = {}) {
  // Check the raw line, not the parsed title: parseWishAdd falls back to
  // "Untitled" so that "$40" still records something, which would otherwise
  // let a line of pure whitespace through as a real row.
  if (typeof input === 'string' && !input.trim()) return null;
  const parsed = typeof input === 'string' ? parseWishAdd(input) : input;
  if (!parsed || !String(parsed.title || '').trim()) return null;
  const now = new Date().toISOString();
  const wish = {
    id: uid('w'),
    title: String(parsed.title).trim(),
    url: parsed.url ? normalizeUrl(parsed.url) : null,
    price: Number.isFinite(parsed.price) ? parsed.price : null,
    status: WISH_STATUSES.includes(status) ? status : 'wanted',
    eta: parsed.eta || null,
    createdAt: now,
    updatedAt: now
  };
  state.wishlist.unshift(wish);
  return wish;
}

export function updateWish(id, patch) {
  const w = wishById(id);
  if (!w) return null;
  const next = { ...patch };
  if (next.title !== undefined) next.title = String(next.title).trim() || w.title;
  if (next.url !== undefined) next.url = next.url ? normalizeUrl(next.url) : null;
  if (next.price !== undefined) {
    if (next.price === '' || next.price === null) {
      next.price = null;                  // cleared on purpose
    } else {
      const n = Number(next.price);
      // nonsense leaves what was there; dropping the key is not the same as
      // setting it to null, which is what "cleared" means one line up
      if (Number.isFinite(n)) next.price = n; else delete next.price;
    }
  }
  if (next.status !== undefined && !WISH_STATUSES.includes(next.status)) delete next.status;
  // an ETA is a promise about a parcel; once it is here the date is history
  if (next.status === 'delivered') next.eta = null;
  Object.assign(w, next, { updatedAt: new Date().toISOString() });
  return w;
}

export function deleteWish(id) {
  const i = state.wishlist.findIndex((w) => w.id === id);
  if (i >= 0) state.wishlist.splice(i, 1);
}

/* ---- habits ---- */

/** Days of an unbroken run before a habit is taken to have stuck. */
export const HABIT_TARGET = 21;

/** Days still to go, or 0 once the run is long enough. */
export const habitRemaining = (id, ref = today()) =>
  Math.max(0, HABIT_TARGET - habitStreak(id, ref));

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
  if (!state.notes[date]) state.notes[date] = { focus: '', text: '', tomorrow: '', top3: [], journal: {} };
  return state.notes[date];
}

/* ---------------- a daily journal ----------------
   Any area can keep one; the seeded Journal does by default. Entries live in
   the day's note rather than in a pile of their own, because a note row is
   already one per date: a year of writing stays a year of small rows that
   sync as they change, instead of one row that has to be sent whole every
   time a sentence moves. */

export const journalAreas = () => state.areas.filter((a) => a.journal && !a.archived);

export const journalEntry = (areaId, date) => (state.notes[date]?.journal || {})[areaId] || '';

/** Write today's entry. An emptied one is removed rather than kept blank. */
export function setJournalEntry(areaId, date, text) {
  const n = note(date);
  if (!n.journal) n.journal = {};
  const body = String(text ?? '');
  if (body.trim()) n.journal[areaId] = body;
  else delete n.journal[areaId];
  return n.journal[areaId] || '';
}

/** Every day this area has been written in, newest first. */
export function journalDates(areaId) {
  return Object.entries(state.notes)
    .filter(([, n]) => n && n.journal && n.journal[areaId])
    .map(([date]) => date)
    .sort((x, y) => (x < y ? 1 : -1));
}

/* ---- the end of one day is the start of the next ----
   The end-of-day box used to be write-only: keyed to its date, saved, synced,
   and never read again by anything. A line about what tomorrow needs, written
   at eleven at night and never shown to you again, is a prompt whose answer
   goes nowhere. So it becomes tomorrow's focus. */

/** How far back to look for a line nobody has spent yet — a Friday night
 *  should still reach Monday morning. */
const CARRY_DAYS = 7;

/** The most recent unspent line for tomorrow, or null. */
export function pendingTomorrow(day = today()) {
  for (let i = 1; i <= CARRY_DAYS; i++) {
    const date = addDays(day, -i);
    const n = state.notes[date];
    if (n && n.tomorrow && !n.tomorrowUsed) return { date, text: n.tomorrow };
  }
  return null;
}

/**
 * Make last night's line today's focus. Returns what it carried, or null.
 *
 * The line is spent either way, even when today already has a focus: one you
 * set yourself beats last night's guess, and a line left unspent would arrive
 * a day late, which is worse than not arriving. `carriedFrom` records where
 * the focus came from so the page can say so — and so clearing it sticks,
 * since nothing unspent is left to put back.
 */
export function carryForward(day = today()) {
  const found = pendingTomorrow(day);
  if (!found) return null;
  state.notes[found.date].tomorrowUsed = true;
  const n = note(day);
  if (n.focus) return null;
  n.focus = found.text;
  n.carriedFrom = found.date;
  return found;
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

// a note holding only a line for tomorrow, or only a journal entry, is not
// empty: dropped here, neither would ever reach another device
const emptyNote = (n) => !n || (
  !n.focus && !n.text && !n.tomorrow
  && !(n.top3 || []).length
  && !Object.keys(n.journal || {}).length
);

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
  // habits and links travel in meta rather than as their own kind: the planner_rows
  // CHECK constraint only knows the kinds it was created with, and this needs
  // no migration to reach another device
  rows.push({
    kind: 'meta', id: 'meta',
    data: {
      semester: state.semester, settings,
      habits: state.habits, habitLog: state.habitLog,
      links: state.links, wishlist: state.wishlist,
      sprints: state.sprints
    }
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
    // A device still on an older schema pushes its own category names. One it
    // no longer has a heading for would land here and vanish from the sidebar,
    // so translate on the way in, exactly as migrate() does on the way up.
    case 'area': return put(state.areas, deleted ? data : { ...data, category: areaCategory(data) });
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
      // absent, not empty: a device on an older schema sends no links at all,
      // and must not wipe the pile just by pushing its meta row
      if (Array.isArray(data.links)) state.links = data.links;
      if (Array.isArray(data.wishlist)) state.wishlist = data.wishlist;
      if (Array.isArray(data.sprints)) state.sprints = data.sprints;
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
