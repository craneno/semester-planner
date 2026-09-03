// store/migrate.js — what a saved planner looks like, and how an older one is
// brought up to date. Pure: raw in, state out. Each seed is pinned to the
// version that added it (`if (from < 5)`), never to SCHEMA_VERSION, or the
// next bump brings back something deleted on purpose. A rename is the other
// way round — see areaCategory() in constants.js.

import { uid, tz } from '../util.js';
import { isRepeat } from '../repeat.js';
import { SCHEMA_VERSION, ITEM_TYPES, LEGACY_TYPE, WISH_STATUSES, SPRINT_KINDS, AREA_COLORS, areaCategory } from './constants.js';
import { normalizeUrl, linkTitleFromUrl } from './urls.js';

export const DEFAULTS = () => {
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
    habitLogAt: {},     // 'YYYY-MM-DD' -> when that day's list last changed; its sync clock
    notes: {},          // 'YYYY-MM-DD' -> { focus, text, top3:[itemId] }
    events: [],         // external Google events, read-only mirror
    outbox: [],         // queued Google writes while offline/signed out
    settings: {
      theme: 'graphite',
      colors: {},
      fonts: { heading: '', body: '', mono: '' },
      scale: 1,
      hour12: true,
      sweepDone: true,  // delete finished work at the day reset
      weekStart: 0,     // Sunday
      dayStart: 7,      // week grid first hour
      dayEnd: 23,
      // the zone this device last opened in. Device-local by staying out of
      // SYNCED_SETTINGS: a phone that has travelled is not news for the laptop
      tzSeen: '',
      // when this device last brought the Canvas feed in. Device-only too:
      // each device fetches for itself, once a day
      canvasFeedAt: '',
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

/** Bring a saved payload, of any schema, up to the current shape. */
export function migrate(raw) {
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
    createdAt: x.createdAt || new Date().toISOString(),
    updatedAt: x.updatedAt || x.createdAt || new Date().toISOString()
  }));
  s.habitLog = raw.habitLog && typeof raw.habitLog === 'object' ? raw.habitLog : {};
  s.habitLogAt = raw.habitLogAt && typeof raw.habitLogAt === 'object' ? raw.habitLogAt : {};
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
    grading: Array.isArray(a.grading) ? a.grading : [],
    // Carried, not rebuilt. upsertArea() stamps an edit, but this normaliser
    // used to drop the stamp on the next load, so every area reached the sync
    // layer with no clock at all — and a stale copy could beat a fresh one
    // because there was nothing to compare. That cost a freewrite.
    createdAt: a.createdAt || null,
    updatedAt: a.updatedAt || a.createdAt || null
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
  // v19: a class time now says which zone it was written in. Nothing recorded
  // it before, so the only claim that can be made is the zone reading this —
  // wrong for a schedule that came from another one, which is why Settings can
  // correct it. Stamped rather than left blank so the check below has an
  // answer, and pinned so a later bump never restamps a corrected row.
  if (from < 19) {
    const here = tz();
    for (const a of s.areas) for (const m of a.schedule || []) m.tz = m.tz || here;
  }

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
      repeat: isRepeat(t.repeat) ? t.repeat : null,
      canvasId: t.canvasId || null,   // the Canvas assignment this came from, if any
      gcalId: t.gcalId || null,
      // one Google event per occurrence, so a series needs one id per day it
      // lands on rather than the single `gcalId` a one-off carries
      gcalIds: (t.gcalIds && typeof t.gcalIds === 'object') ? t.gcalIds : null,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || new Date().toISOString()
    };
  });

  s.version = SCHEMA_VERSION;
  return s;
}
