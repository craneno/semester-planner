// store.js — single source of truth. Local-first, localStorage-backed.

import { uid, today, addDays, toMin, fromMin, tz, zoneShift, zoneLabel } from './util.js';
import { isRepeat, repeatDates, isRepeatDate, describeRepeat } from './repeat.js';
import { SCHEMA_VERSION, AREA_CATEGORIES, CATEGORY_IDS, ITEM_TYPES, AREA_COLORS, areaCategory } from './store/constants.js';
import { migrate } from './store/migrate.js';
import { keepBackups } from './store/backups.js';
import * as A from './store/areas.js';
import * as Cd from './store/cards.js';
import * as L from './store/links.js';
import * as W from './store/wishlist.js';
import * as P from './store/sprints.js';
import * as H from './store/habits.js';
import * as Q from './store/quickadd.js';

/* ---------------- the slices ----------------
   store/ holds what needs no `state` of its own. Pure modules — constants,
   urls, migrate, backups, quickadd's parsers — and slices that take the
   state as their first argument: areas, cards, links, wishlist, sprints,
   habits. This file stays the one API, views import from here, and it binds
   each slice to the one live `state` below. A slice never owns state, so a
   fresh instance of this module in the tests (storeWith) still has one of its
   own, and a slice can be tested against any plain object. */
export { SCHEMA_VERSION, AREA_CATEGORIES, CATEGORY_IDS, categoryById, ITEM_TYPES, WISH_STATUSES, SPRINT_KINDS, AREA_COLORS } from './store/constants.js';
export { normalizeUrl, linkTitleFromUrl } from './store/urls.js';
export { listBackups, readBackup } from './store/backups.js';
export { sprintProgress } from './store/sprints.js';
export { WISH_IN_FLIGHT, wishTotal, etaState, parseWishAdd } from './store/wishlist.js';
export { HABIT_TARGET } from './store/habits.js';

const bind = (fn) => (...a) => fn(state, ...a);
export const areaById = bind(A.areaById);
export const areaColor = bind(A.areaColor);
export const areaName = bind(A.areaName);
export const areasInCategory = bind(A.areasInCategory);
export const chartAreas = bind(A.chartAreas);
export const defaultAreaId = bind(A.defaultAreaId);
export const unfiledCards = bind(Cd.unfiledCards);
export const cardsForArea = bind(Cd.cardsForArea);
export const cardById = bind(Cd.cardById);
export const addCard = bind(Cd.addCard);
export const updateCard = bind(Cd.updateCard);
export const deleteCard = bind(Cd.deleteCard);
export const findAreaByHint = bind(L.findAreaByHint);
export const parseLinkAdd = bind(L.parseLinkAdd);
export const linkById = bind(L.linkById);
export const linksForArea = bind(L.linksForArea);
export const unfiledLinks = bind(L.unfiledLinks);
export const addLink = bind(L.addLink);
export const updateLink = bind(L.updateLink);
export const deleteLink = bind(L.deleteLink);
export const wishById = bind(W.wishById);
export const wishesInFlight = bind(W.wishesInFlight);
export const wishesWanted = bind(W.wishesWanted);
export const wishesDelivered = bind(W.wishesDelivered);
export const addWish = bind(W.addWish);
export const updateWish = bind(W.updateWish);
export const deleteWish = bind(W.deleteWish);
export const sprintById = bind(P.sprintById);
export const sprintsForArea = bind(P.sprintsForArea);
export const upsertSprint = bind(P.upsertSprint);
export const deleteSprint = bind(P.deleteSprint);
export const addDeliverable = bind(P.addDeliverable);
export const updateDeliverable = bind(P.updateDeliverable);
export const deleteDeliverable = bind(P.deleteDeliverable);
export const habitRemaining = bind(H.habitRemaining);
export const activeHabits = bind(H.activeHabits);
export const habitDone = bind(H.habitDone);
export const toggleHabit = bind(H.toggleHabit);
export const habitStreak = bind(H.habitStreak);
export const addHabit = bind(H.addHabit);
export const updateHabit = bind(H.updateHabit);
export const deleteHabit = bind(H.deleteHabit);
export const reorderHabits = bind(H.reorderHabits);
export const areaByTag = bind(Q.areaByTag);
export const parseQuickAdd = bind(Q.parseQuickAdd);

const KEY = 'semesterPlanner.v1';
const LEGACY_KEYS = ['plannerData', 'semester-planner', 'semesterPlanner', 'planner', 'planner-data'];

/* ---------------- persistence ---------------- */


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


const raw = loadRaw();
try { keepBackups(raw); } catch (e) { console.warn('planner: backup failed', e); }
export const state = migrate(raw);

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
  if (FOREIGN.has(meta.source) || meta.external) forget();
  else if (typeof fn === 'function') remember(meta);
  if (typeof fn === 'function') fn(state);
  save();
  for (const s of subs) s(meta);
}

/* ---------------- undo ----------------
   Every local commit is preceded by a copy of what it is about to change,
   kept here, ten deep. Undo puts a copy back and stamps every row that
   differs with the clock now: a row put back with its old updatedAt would be
   refused by the server as stale, and the undo quietly undone by the next
   sync. Commits close together are one step, the way an editor groups
   keystrokes. A change from outside — the cloud, another tab, Google, a
   restore — clears the stack: history from before the world moved is not
   safe to replay over it. */
const UNDO_KEYS = ['semester', 'areas', 'items', 'notes', 'cards', 'links', 'wishlist', 'sprints', 'habits', 'habitLog', 'habitLogAt'];
const FOREIGN = new Set(['cloud', 'gcal', 'restore', 'carry', 'zone', 'canvas']);
export const undoSettings = { max: 10, coalesceMs: 800 };
let undoStack = [], redoStack = [], lastLocalAt = 0;

const snapshot = () => structuredClone(Object.fromEntries(UNDO_KEYS.map((k) => [k, state[k]])));

function remember(meta) {
  const at = Date.now();
  if (undoStack.length && at - lastLocalAt < undoSettings.coalesceMs) { lastLocalAt = at; return; }
  lastLocalAt = at;
  undoStack.push({ label: meta.label || '', copy: snapshot() });
  if (undoStack.length > undoSettings.max) undoStack.shift();
  redoStack.length = 0;
}

function forget() { undoStack.length = 0; redoStack.length = 0; }

/** The clock on one row, whatever its kind. The mirror of rowStamp(). */
function stampRow(kind, id, now) {
  const inList = (arr) => { const r = arr.find((x) => x.id === id); if (r) r.updatedAt = now; };
  switch (kind) {
    case 'item': return inList(state.items);
    case 'card': return inList(state.cards);
    case 'area': return inList(state.areas);
    case 'link': return inList(state.links);
    case 'wish': return inList(state.wishlist);
    case 'sprint': return inList(state.sprints);
    case 'habit': return inList(state.habits);
    case 'note': if (state.notes[id]) state.notes[id].updatedAt = now; return;
    case 'habitlog': if (state.habitLog[id]) state.habitLogAt[id] = now; return;
    default: return;
  }
}

function swap(from, to, source) {
  const step = from.pop();
  if (!step) return null;
  to.push({ label: step.label, copy: snapshot() });
  const was = new Map(snapshotRows().map((r) => [r.kind + ':' + r.id, JSON.stringify(r.data)]));
  Object.assign(state, structuredClone(step.copy));
  const now = new Date().toISOString();
  for (const r of snapshotRows()) {
    if (was.get(r.kind + ':' + r.id) !== JSON.stringify(r.data)) stampRow(r.kind, r.id, now);
  }
  // no fn, and a source of its own, so this commit is neither remembered
  // nor taken for a change from outside
  commit(null, { source });
  return step.label || 'the last change';
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
/** @returns {string|null} what was undone, or null when there was nothing */
export function undo() { return swap(undoStack, redoStack, 'undo'); }
export function redo() { return swap(redoStack, undoStack, 'redo'); }

// cross-tab / cross-window coherence
window.addEventListener('storage', (e) => {
  if (e.key !== KEY || !e.newValue) return;
  try {
    const next = migrate(JSON.parse(e.newValue));
    Object.assign(state, next);
    forget();
    for (const s of subs) s({ external: true });
  } catch { /* ignore */ }
});

/* ---------------- selectors ---------------- */


/* ---------------- occurrences ----------------
   A repeating item is one row with a rule on it. What the screens draw are
   *occurrences*: read-only copies made on demand, named `<itemId>@<date>` for
   the day the rule put them on. Nothing is written per occurrence except what
   one occurrence can own on its own — when it is, what it is called, whether
   it is done — and that goes in `repeat.ex`, keyed by that same date.

   The parent never draws itself once it repeats, or the first occurrence would
   be on the page twice. */

const AT = '@';
export const occurrenceId = (id, date) => id + AT + date;

/** `t_x@2026-09-08` -> { id, on }, a plain id -> null. */
export function splitOccurrence(id) {
  const i = String(id).indexOf(AT);
  return i < 0 ? null : { id: String(id).slice(0, i), on: String(id).slice(i + 1) };
}

export const seriesById = (id) => {
  const cut = splitOccurrence(id);
  return state.items.find((t) => t.id === (cut ? cut.id : id)) || null;
};

/** The day a series counts from — the block it was drawn on, or its deadline. */
export const repeatAnchor = (item) => (item.plan && item.plan.date) || item.due || null;

export const repeats = (item) => !!item && isRepeat(item.repeat) && !!repeatAnchor(item);

/** One occurrence's own version of things, made on demand. */
const overrideFor = (item, key) => {
  item.repeat.ex = item.repeat.ex || {};
  item.repeat.ex[key] = item.repeat.ex[key] || {};
  return item.repeat.ex[key];
};

/**
 * The occurrence a series puts on `key`, or null if that one was deleted.
 *
 * `repeat` is stripped from the copy: an occurrence does not repeat, and the
 * views ask that question of everything they draw.
 */
export function occurrenceOf(item, key) {
  if (!repeats(item)) return null;
  const ov = (item.repeat.ex || {})[key] || null;
  if (ov && ov.off) return null;
  const on = (ov && ov.date) || key;
  const o = {
    ...item,
    id: occurrenceId(item.id, key),
    seriesId: item.id,
    occurrence: key,
    repeat: null,
    done: !!(ov && ov.done),
    doneAt: (ov && ov.doneAt) || null
  };
  if (ov && ov.title) o.title = ov.title;
  if (item.plan) {
    o.plan = { ...item.plan, date: on };
    if (ov && ov.start !== undefined) o.plan.start = ov.start;
    if (ov && ov.mins !== undefined) o.plan.mins = ov.mins;
  }
  if (item.due) o.due = on;
  return o;
}

/** Every occurrence of one series that shows on `date`, moved ones included. */
function occurrencesOn(item, date) {
  if (!repeats(item)) return [];
  const out = [];
  for (const key of repeatDates(item.repeat, repeatAnchor(item), date, date)) {
    const o = occurrenceOf(item, key);
    // one moved off this day is drawn on the day it was moved to, not here
    if (o && ((o.plan && o.plan.date) || o.due) === date) out.push(o);
  }
  for (const [key, ov] of Object.entries(item.repeat.ex || {})) {
    if (key === date || !ov || ov.off || ov.date !== date) continue;
    if (!isRepeatDate(item.repeat, repeatAnchor(item), key)) continue;
    const o = occurrenceOf(item, key);
    if (o) out.push(o);
  }
  return out;
}

/** Every occurrence of every series inside a window, in date order. */
export function occurrencesBetween(from, to, pick = () => true) {
  const out = [];
  for (const item of state.items) {
    if (!repeats(item) || !pick(item)) continue;
    const anchor = repeatAnchor(item);
    for (const key of repeatDates(item.repeat, anchor, from, to)) {
      const o = occurrenceOf(item, key);
      if (o) out.push(o);
    }
    for (const [key, ov] of Object.entries(item.repeat.ex || {})) {
      if (!ov || ov.off || !ov.date || ov.date < from || ov.date > to) continue;
      if (key >= from && key <= to) continue;          // already taken above
      if (!isRepeatDate(item.repeat, anchor, key)) continue;
      const o = occurrenceOf(item, key);
      if (o) out.push(o);
    }
  }
  return out.sort((a, b) => {
    const x = (a.plan && a.plan.date) || a.due || '', y = (b.plan && b.plan.date) || b.due || '';
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export const repeatLabel = (item) =>
  (repeats(item) ? describeRepeat(item.repeat, repeatAnchor(item)) : '');

/**
 * An item by id — a plain one, or one occurrence of a series.
 *
 * Everything that opens, ticks or drags a thing goes through here, which is
 * what lets an occurrence be handled like any other item by every screen.
 */
export function itemById(id) {
  const cut = splitOccurrence(id);
  if (!cut) return state.items.find((t) => t.id === id) || null;
  const parent = state.items.find((t) => t.id === cut.id);
  if (!repeats(parent)) return null;
  // the day has to be one the rule actually named. `occurrenceOf` builds
  // whatever it is handed, which is right for the callers that walked the rule
  // to get there and wrong for an id off a stale link or a hand-typed one.
  if (!isRepeatDate(parent.repeat, repeatAnchor(parent), cut.on)) return null;
  return occurrenceOf(parent, cut.on);
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

/* A series never answers for itself — its occurrences do, this one included.
   Everything below asks `state.items` for the plain ones and the rule for the
   rest, so no screen has to know which it is holding. */

export function itemsDueOn(date) {
  return [
    ...state.items.filter((t) => !repeats(t) && t.due === date),
    ...occurrencesBetween(date, date, (t) => !!t.due).filter((o) => o.due === date)
  ];
}

export function itemsPlannedOn(date) {
  return [
    ...state.items.filter((t) => !repeats(t) && t.plan && t.plan.date === date),
    ...state.items.filter((t) => repeats(t) && t.plan).flatMap((t) => occurrencesOn(t, date))
  ];
}

/** How far back an unbounded question about the past is allowed to look. */
const LOOKBACK = 120;

export function overdue(ref = today()) {
  return [
    ...state.items.filter((t) => !repeats(t) && !t.done && t.due && t.due < ref),
    ...occurrencesBetween(addDays(ref, -LOOKBACK), addDays(ref, -1), (t) => !!t.due)
      .filter((o) => !o.done && o.due && o.due < ref)
  ];
}

export function upcoming(days = 14, ref = today()) {
  const end = addDays(ref, days);
  return [
    ...state.items.filter((t) => !repeats(t) && !t.done && t.due && t.due >= ref && t.due <= end),
    ...occurrencesBetween(ref, end, (t) => !!t.due).filter((o) => !o.done)
  ].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

export function progress(item) {
  if (!item.subtasks.length) return item.done ? 1 : 0;
  return item.subtasks.filter((s) => s.done).length / item.subtasks.length;
}

export function workloadFor(dates) {
  const set = new Set(dates);
  const sorted = [...set].sort();
  const all = [
    ...state.items.filter((t) => !repeats(t)),
    // one window rather than one expansion per day: the same week asked seven
    // times over would walk every rule seven times
    ...(sorted.length ? occurrencesBetween(sorted[0], sorted[sorted.length - 1]) : [])
  ];
  let mins = 0, count = 0;
  for (const t of all) {
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

/* ---------------- a schedule that has moved ----------------
   Class times are wall clock — "07:30" — and a wall clock is only true in one
   zone. Imported in Vancouver and read in Boston, every lecture is three hours
   early with nothing in the data to notice it. So each slot records the zone
   it is written in, and the two below are the noticing and the fixing. */

/** Roll one slot's clock by `mins`, carrying the weekday when it crosses
 *  midnight — an evening seminar moved east is the next morning's, and moving
 *  the time without the day would put it on a Tuesday it never met. */
function shiftSlot(m, mins) {
  const s = toMin(m.start);
  if (!Number.isFinite(s)) return;
  const e = toMin(m.end);
  const dur = Number.isFinite(e) ? (e - s + 1440) % 1440 : null;
  const moved = s + mins;
  const roll = Math.floor(moved / 1440);
  m.start = fromMin(((moved % 1440) + 1440) % 1440);
  if (dur !== null) m.end = fromMin((toMin(m.start) + dur) % 1440);
  if (roll) m.days = (m.days || []).map((d) => (((d + roll) % 7) + 7) % 7);
}

/**
 * What the class schedule was written in, when that is not where we are.
 *
 * @returns {null|{from, to, mins, rows, label}} `mins` is what reading the
 *   schedule here costs it. Null when everything already agrees, and null too
 *   when two zones merely have different names for the same clock — Phoenix
 *   and Los Angeles in July is not news worth interrupting anyone for.
 */
export function scheduleDrift(at = new Date()) {
  const here = tz();
  const tally = new Map();
  for (const a of state.areas) {
    if (a.archived) continue;
    for (const m of a.schedule || []) {
      if (m.tz && m.tz !== here) tally.set(m.tz, (tally.get(m.tz) || 0) + 1);
    }
  }
  let from = null, rows = 0;
  for (const [zone, n] of tally) if (n > rows) { from = zone; rows = n; }
  if (!from) return null;
  const mins = zoneShift(from, here, at);
  if (!mins) return null;
  return { from, to: here, mins, rows, label: `${zoneLabel(from, at)} → ${zoneLabel(here, at)}` };
}

/** Rewrite every slot written in `from` so it reads correctly in `to`, and
 *  stamp it, which is what keeps a second device from offering the same shift
 *  again. Its own inverse: shifting back is the same call the other way. */
export function shiftSchedules(from, to = tz(), at = new Date()) {
  const mins = zoneShift(from, to, at);
  let n = 0;
  for (const a of state.areas) {
    let touched = false;
    for (const m of a.schedule || []) {
      if (m.tz && m.tz !== from) continue;
      if (mins) shiftSlot(m, mins);
      m.tz = to;
      touched = true; n++;
    }
    if (touched) a.updatedAt = new Date().toISOString();
  }
  return n;
}

/** Say the times are right where they are and the zone label was the stale
 *  part — the answer to the offer below when a trip is not a move. */
export function stampSchedules(zone = tz()) {
  for (const a of state.areas) {
    if (!(a.schedule || []).length) continue;
    for (const m of a.schedule) m.tz = zone;
    a.updatedAt = new Date().toISOString();
  }
}

/** Every zone the schedule claims, for the Settings row that corrects a claim. */
export const scheduleZones = () => {
  const set = new Set();
  for (const a of state.areas) for (const m of a.schedule || []) if (m.tz) set.add(m.tz);
  return [...set].sort();
};

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


/**
 * What one occurrence is allowed to differ in.
 *
 * When it is, what it is called, and whether it is done — the things a single
 * day of a series owns. An area, a kind, a note or a repeat rule belong to the
 * series whichever occurrence you were looking at when you changed them, so
 * they are written straight through to the parent.
 */
const OCCURRENCE_OWNS = new Set(['plan', 'due', 'title', 'done', 'doneAt']);

/** Fold a patch aimed at one occurrence into that occurrence's exception. */
function patchOccurrence(parent, key, patch) {
  const ov = overrideFor(parent, key);
  const rest = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (!OCCURRENCE_OWNS.has(k)) { rest[k] = v; continue; }
    if (k === 'plan' && v) {
      if (v.date !== undefined) ov.date = v.date;
      if (v.start !== undefined) ov.start = v.start;
      if (v.mins !== undefined) ov.mins = v.mins;
    } else if (k === 'due') {
      ov.date = v;
    } else {
      ov[k] = v;
    }
  }
  if (Object.keys(rest).length) Object.assign(parent, rest);
  parent.updatedAt = new Date().toISOString();
  return occurrenceOf(parent, key);
}

export function upsertItem(patch) {
  const now = new Date().toISOString();
  const cut = patch.id ? splitOccurrence(patch.id) : null;
  if (cut) {
    const parent = state.items.find((t) => t.id === cut.id);
    return parent && repeats(parent) ? patchOccurrence(parent, cut.on, patch) : null;
  }
  let item = patch.id ? itemById(patch.id) : null;
  if (item) {
    Object.assign(item, patch, { updatedAt: now });
  } else {
    item = {
      id: uid('t'), title: 'Untitled', areaId: null, type: 'task',
      due: null, dueTime: null, plan: null, priority: 'normal', estMins: 60,
      done: false, doneAt: null, subtasks: [], notes: '', repeat: null,
      gcalId: null, gcalIds: null, canvasId: null, createdAt: now, updatedAt: now, ...patch
    };
    if (!item.areaId) item.areaId = defaultAreaId();
    state.items.push(item);
  }
  return item;
}

/**
 * Delete an item, or one occurrence of a series.
 *
 * A deleted occurrence is a mark in the rule's exceptions rather than a hole
 * anything has to remember: the day stays named, and turning the repeat off
 * later brings nothing back with it.
 */
export function deleteItem(id) {
  const cut = splitOccurrence(id);
  if (cut) {
    const parent = state.items.find((t) => t.id === cut.id);
    if (!parent || !repeats(parent)) return;
    const ov = overrideFor(parent, cut.on);
    ov.off = true;
    parent.updatedAt = new Date().toISOString();
    return;
  }
  const i = state.items.findIndex((t) => t.id === id);
  if (i >= 0) state.items.splice(i, 1);
}

/** Stop a series after the occurrence shown, keeping everything before it. */
export function endSeriesBefore(item, key) {
  if (!repeats(item)) return;
  item.repeat = { ...item.repeat, until: addDays(key, -1), count: null };
  for (const k of Object.keys(item.repeat.ex || {})) {
    if (k >= key) delete item.repeat.ex[k];
  }
  item.updatedAt = new Date().toISOString();
}

/**
 * Split a series at one occurrence: that one and everything after it become
 * a series of their own, carrying `patch`, and the old one ends the day
 * before. This is "this and following" — a lecture that moves rooms from
 * October, with September left where it was. Exceptions from the split on
 * go with the new series; a count is what was left of it.
 */
export function splitSeriesAt(series, key, patch = {}) {
  if (!repeats(series)) return null;
  const rep = series.repeat;
  const anchor = repeatAnchor(series);
  const before = rep.count ? repeatDates(rep, anchor, anchor, addDays(key, -1)).length : 0;
  const ex = {};
  for (const [k, v] of Object.entries(rep.ex || {})) if (k >= key) ex[k] = v;
  const { id, gcalId, gcalIds, createdAt, updatedAt, ...rest } = series;
  const when = series.plan ? { plan: { ...series.plan, date: key } } : { due: key };
  const next = upsertItem({
    ...rest, ...when, ...patch,
    repeat: { ...rep, ex, count: rep.count ? Math.max(1, rep.count - before) : null },
    done: false, doneAt: null
  });
  endSeriesBefore(series, key);
  return next;
}

/** A copy of an item — or of the whole series, if given one occurrence of it. */
export function duplicateItem(id) {
  const src = seriesById(id);
  if (!src) return null;
  const { id: _id, gcalId, gcalIds, canvasId, createdAt, updatedAt, ...rest } = src;
  return upsertItem({
    ...rest,
    title: `${src.title} (copy)`,
    done: false, doneAt: null,
    subtasks: (rest.subtasks || []).map((x) => ({ ...x, id: uid('s'), done: false })),
    repeat: rest.repeat ? { ...rest.repeat, ex: {} } : null
  });
}

/* ---------------- sweeping finished work ----------------
   A list you never clear stops being a list of what to do. At the day reset
   everything ticked on a day that has now ended is deleted, so the morning
   starts with only what is left.

   Judged by the *planner* day `doneAt` falls in, not by the calendar date, or
   a task ticked at half past midnight would be swept three hours later having
   been finished the same evening. A task done since the reset always survives
   the day it was done in — nothing vanishes while you are looking at it. */

/** Whether a task is old enough to sweep — its own `doneAt` decides. */
const sweepable = (t, day) => {
  if (!t.done) return false;
  // no stamp at all: it was ticked long before doneAt existed, so it is older
  // than any day this could be asked about
  if (!t.doneAt) return true;
  return today(new Date(t.doneAt)) < day;
};

/** What the next sweep would take, minus any ids in `spare`. Lets a caller
    skip committing for nothing, and lets an undone sweep stay undone. */
export const doneBefore = (day = today(), spare = null) =>
  (state.settings.sweepDone === false ? []
    : state.items.filter((t) => sweepable(t, day) && !spare?.has(t.id)));

/**
 * Delete every task finished before `day`, and return what went — the caller
 * offers it back as an undo.
 *
 * A day's top three names tasks by id, so a swept one has to be taken out of
 * it as well; left in, `emptyNote()` would keep counting a note that renders
 * as nothing and sync it for ever. Those references are not restored by an
 * undo, which is a smaller loss than a note that cannot die.
 */
export function sweepDone(day = today(), spare = null) {
  sweepTicks(day);
  const gone = doneBefore(day, spare);
  if (!gone.length) return gone;
  const ids = new Set(gone.map((t) => t.id));
  state.items = state.items.filter((t) => !ids.has(t.id));
  for (const n of Object.values(state.notes)) {
    if ((n.top3 || []).some((id) => ids.has(id))) n.top3 = n.top3.filter((id) => !ids.has(id));
  }
  return gone;
}

/**
 * The same reset, applied to a series.
 *
 * A series is never deleted for having been done — there is always another
 * one. What goes is the tick: an exception that says nothing but "this one was
 * finished" on a day now over, which is exactly the row a term of ticking
 * would otherwise grow without end.
 */
function sweepTicks(day) {
  if (state.settings.sweepDone === false) return;
  for (const item of state.items) {
    const ex = item.repeat && item.repeat.ex;
    if (!ex) continue;
    for (const [key, ov] of Object.entries(ex)) {
      if (!ov || !ov.done || key >= day) continue;
      if (Object.keys(ov).some((k) => k !== 'done' && k !== 'doneAt')) continue;
      delete ex[key];
    }
  }
}

export function toggleItem(id, force) {
  const cut = splitOccurrence(id);
  if (cut) {
    const parent = state.items.find((t) => t.id === cut.id);
    if (!parent || !repeats(parent)) return;
    const ov = overrideFor(parent, cut.on);
    ov.done = force ?? !ov.done;
    ov.doneAt = ov.done ? new Date().toISOString() : null;
    parent.updatedAt = new Date().toISOString();
    return;
  }
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


/* ---------------- cloud snapshot ----------------
   Rows are (kind, id, data). One shape, so the sync engine stays generic.
   Device-specific settings — Google tokens, Supabase credentials, sync
   cursors — are deliberately NOT synced: they belong to the device. */

export const SYNCED_SETTINGS = ['theme', 'colors', 'fonts', 'scale', 'hour12', 'sweepDone', 'weekStart', 'dayStart', 'dayEnd'];

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
  /* Each its own row. These used to ride together inside `meta` so that adding
     one needed no ALTER — and that made the whole pile one row, with no clock,
     so a clash was settled by whoever pushed last and a loss was the lot.
     Schema 20 gave them kinds of their own (supabase/upgrade.sql), and a day's
     habit ticks are a row per day, like a note. */
  for (const l of state.links) rows.push({ kind: 'link', id: l.id, data: l });
  for (const w of state.wishlist) rows.push({ kind: 'wish', id: w.id, data: w });
  for (const p of state.sprints) rows.push({ kind: 'sprint', id: p.id, data: p });
  for (const x of state.habits) rows.push({ kind: 'habit', id: x.id, data: x });
  for (const [date, ids] of Object.entries(state.habitLog)) {
    if (ids?.length) rows.push({ kind: 'habitlog', id: date, data: { ids, updatedAt: state.habitLogAt[date] || null } });
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
    case 'link': return put(state.links, data);
    case 'wish': return put(state.wishlist, data);
    case 'sprint': return put(state.sprints, data);
    case 'habit': return put(state.habits, data);
    case 'habitlog':
      if (deleted || !data?.ids?.length) {
        if (!state.habitLog[id]) return false;
        delete state.habitLog[id]; delete state.habitLogAt[id];
        return true;
      }
      state.habitLog[id] = data.ids;
      if (data.updatedAt) state.habitLogAt[id] = data.updatedAt;
      return true;
    case 'meta':
      if (deleted || !data) return false;
      if (data.semester) Object.assign(state.semester, data.semester);
      if (data.settings) for (const k of SYNCED_SETTINGS) {
        if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
      }
      // A device still on schema 19 sends habits, links, the wishlist and the
      // sprints in here. They are rows of their own now and are not read from
      // meta any more — taking them would let an old build's empty pile win.
      return true;
    default: return false;
  }
}

/** Local modification time for a row, used to settle conflicts. */
export function rowStamp(kind, id) {
  if (kind === 'item') return itemById(id)?.updatedAt || null;
  if (kind === 'card') return cardById(id)?.updatedAt || null;
  if (kind === 'area') return areaById(id)?.updatedAt || null;
  if (kind === 'note') return state.notes[id]?.updatedAt || null;
  if (kind === 'link') return linkById(id)?.updatedAt || null;
  if (kind === 'wish') return wishById(id)?.updatedAt || null;
  if (kind === 'sprint') return sprintById(id)?.updatedAt || null;
  if (kind === 'habit') return state.habits.find((x) => x.id === id)?.updatedAt || null;
  if (kind === 'habitlog') return state.habitLogAt[id] || null;
  // `meta` is the semester and the synced settings, and has no clock; the
  // guard for it is that a schema bump never pushes — see cloud.js.
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
