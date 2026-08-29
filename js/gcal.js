// gcal.js — Google Calendar, two-way, browser-only (no server).
//
// Auth: Google Identity Services token client (popup) with a full-page
// implicit redirect fallback for installed PWAs, where popups can't return
// a result to the standalone window.
//
// Read:  incremental sync with syncToken, polled while the app is visible.
// Write: planner blocks are pushed as events tagged with
//        extendedProperties.private.plannerItemId, so a round trip never
//        creates a duplicate.

import { state, commit, itemById, areaById } from './store.js';
import { toRfc3339, fromRfc3339, toMin, fromMin, tz, addDays } from './util.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
].join(' ');
const TOKEN_KEY = 'semesterPlanner.gcalToken';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

export const gcal = {
  token: null,
  calendars: [],
  status: 'off',     // off | signed-out | connecting | ready | syncing | error | offline
  message: '',
  lastError: null
};

const listeners = new Set();
export const onGcal = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function emit() { for (const fn of listeners) fn(gcal); }
function setStatus(s, msg = '') { gcal.status = s; gcal.message = msg; emit(); }

const cfg = () => state.settings.gcal;
export const isConfigured = () => !!cfg().clientId;
export const isSignedIn = () => !!(gcal.token && gcal.token.expires_at > Date.now() + 30000);

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

/* ---------------- token ---------------- */

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.expires_at > Date.now() + 30000) { gcal.token = t; return true; }
  } catch { /* ignore */ }
  return false;
}
function storeToken(access_token, expires_in) {
  gcal.token = { access_token, expires_at: Date.now() + (Number(expires_in) || 3600) * 1000 };
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(gcal.token)); } catch { /* ignore */ }
}
export function forgetToken() {
  gcal.token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  setStatus('signed-out', 'Signed out of Google.');
}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = res;
    s.onerror = () => rej(new Error('Google sign-in script did not load. Check your connection.'));
    document.head.append(s);
  });
  return gisPromise;
}

let tokenClient = null;
function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: cfg().clientId,
    scope: SCOPES,
    callback: () => {}
  });
  return tokenClient;
}

function redirectSignIn() {
  const redirect = location.origin + location.pathname;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: cfg().clientId,
    redirect_uri: redirect,
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state: 'planner',
    prompt: 'consent'
  }).toString();
  location.assign(url.toString());
}

/** Called once at boot: picks up #access_token after a redirect sign-in. */
export function captureRedirectToken() {
  if (!location.hash.includes('access_token')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const at = p.get('access_token');
  if (!at) return false;
  storeToken(at, p.get('expires_in'));
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

/**
 * @param {boolean} interactive show account chooser / consent if needed
 */
export async function signIn(interactive = true) {
  if (!isConfigured()) throw new Error('Add a Google OAuth client ID in Settings first.');
  if (isSignedIn()) return gcal.token;
  setStatus('connecting');

  if (standalone() && interactive) { redirectSignIn(); return null; }

  await loadGis();
  const client = ensureTokenClient();
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp.error) {
        setStatus('signed-out', resp.error_description || resp.error);
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      storeToken(resp.access_token, resp.expires_in);
      setStatus('ready', 'Connected.');
      resolve(gcal.token);
    };
    try {
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (e) { reject(e); }
  });
}

/* ---------------- fetch wrapper ---------------- */

async function api(path, { method = 'GET', body, params, retry = true } = {}) {
  if (!isSignedIn()) {
    const ok = await signIn(false).catch(() => null);
    if (!ok) throw Object.assign(new Error('Not signed in to Google.'), { code: 'auth' });
  }
  const url = new URL(API + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${gcal.token.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401 && retry) {
    forgetToken();
    await signIn(false);
    return api(path, { method, body, params, retry: false });
  }
  if (res.status === 410) throw Object.assign(new Error('Sync token expired'), { code: 410 });
  if (res.status === 204) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw Object.assign(new Error(`Google Calendar ${res.status}: ${txt.slice(0, 200)}`), { code: res.status });
  }
  return res.json();
}

/* ---------------- calendars ---------------- */

export async function listCalendars() {
  const data = await api('/users/me/calendarList', { params: { maxResults: 250, minAccessRole: 'reader' } });
  gcal.calendars = (data.items || []).map((c) => ({
    id: c.id, name: c.summary, primary: !!c.primary,
    color: c.backgroundColor, writable: ['owner', 'writer'].includes(c.accessRole)
  }));
  emit();
  return gcal.calendars;
}

/* ---------------- read sync ---------------- */

function normalise(ev) {
  const allDay = !!(ev.start && ev.start.date);
  const s = allDay ? { date: ev.start.date, time: null } : fromRfc3339(ev.start.dateTime);
  const e = allDay ? { date: ev.end.date, time: null } : fromRfc3339(ev.end.dateTime);
  if (!s) return null;
  return {
    id: ev.id,
    title: ev.summary || '(no title)',
    date: s.date,
    start: s.time,
    end: e ? e.time : null,
    endDate: e ? e.date : s.date,
    allDay,
    location: ev.location || '',
    description: ev.description || '',
    link: ev.htmlLink || '',
    calendarId: cfg().calendarId,
    plannerItemId: ev.extendedProperties?.private?.plannerItemId || null,
    // instances of a repeating event all carry the same parent id; that is the
    // only thing marking them as repeating, since we sync with singleEvents
    recurringEventId: ev.recurringEventId || null,
    updated: ev.updated
  };
}

/**
 * Repeating events on the synced calendar, grouped from their instances.
 *
 * We ask Google for singleEvents, so a weekly lecture arrives as one event per
 * week rather than as an RRULE. Reading the schedule back off those instances
 * is both easier and truer than parsing the rule: what you get is when the
 * thing actually met, including a moved room or a second weekly block.
 *
 * @returns {Array<{id, title, location, schedule, count, first, last}>}
 *   `schedule` is shaped exactly like an area's, ready to assign.
 */
export function recurringSeries({ minInstances = 3 } = {}) {
  const groups = new Map();
  for (const e of state.events) {
    if (!e.recurringEventId || e.allDay || !e.start) continue;
    if (!groups.has(e.recurringEventId)) groups.set(e.recurringEventId, []);
    groups.get(e.recurringEventId).push(e);
  }

  const out = [];
  for (const [id, evs] of groups) {
    if (evs.length < minInstances) continue;
    evs.sort((a, b) => (a.date < b.date ? -1 : 1));

    // one schedule row per distinct day+time, so a lecture that also meets for
    // a Friday lab comes back as two rows rather than one averaged mess
    const slots = new Map();
    for (const e of evs) {
      const dow = new Date(e.date + 'T00:00:00').getDay();
      const key = `${dow}|${e.start}|${e.end || ''}`;
      if (!slots.has(key)) slots.set(key, { dow, start: e.start, end: e.end, n: 0, location: e.location });
      slots.get(key).n++;
    }
    // a one-off moved meeting shouldn't become part of the schedule
    const solid = [...slots.values()].filter((s) => s.n > 1 || slots.size === 1);
    const schedule = [];
    for (const slot of solid.length ? solid : [...slots.values()]) {
      const row = schedule.find((r) => r.start === slot.start && r.end === slot.end);
      if (row) row.days.push(slot.dow);
      else schedule.push({ days: [slot.dow], start: slot.start, end: slot.end, location: slot.location || '' });
    }
    for (const r of schedule) r.days.sort();

    out.push({
      id,
      title: mode(evs.map((e) => e.title)),
      location: mode(evs.map((e) => e.location).filter(Boolean)) || '',
      schedule,
      count: evs.length,
      first: evs[0].date,
      last: evs[evs.length - 1].date
    });
  }
  return out.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** The most common value in a list — titles and rooms drift over a semester. */
function mode(list) {
  const n = new Map();
  for (const v of list) n.set(v, (n.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, c] of n) if (c > bestN) { best = v; bestN = c; }
  return best;
}

/** Pull a page set. Uses syncToken when we have one, else a bounded full sync. */
export async function sync({ full = false } = {}) {
  if (!cfg().enabled || !isConfigured()) return;
  if (!navigator.onLine) { setStatus('offline', 'Offline — changes are queued.'); return; }
  setStatus('syncing');

  const calId = encodeURIComponent(cfg().calendarId || 'primary');
  const useToken = !full && cfg().syncToken;
  let pageToken = null, nextSync = null;
  const incoming = [];

  try {
    do {
      const params = useToken
        ? { syncToken: cfg().syncToken, singleEvents: true, showDeleted: true, maxResults: 2500, pageToken }
        : {
            timeMin: toRfc3339(state.semester.start, '00:00'),
            timeMax: toRfc3339(addDays(state.semester.end, 1), '00:00'),
            singleEvents: true, showDeleted: true, maxResults: 2500, orderBy: 'startTime', pageToken
          };
      const data = await api(`/calendars/${calId}/events`, { params });
      incoming.push(...(data.items || []));
      pageToken = data.nextPageToken || null;
      if (data.nextSyncToken) nextSync = data.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) { cfg().syncToken = ''; commit(); return sync({ full: true }); }
    gcal.lastError = err;
    setStatus('error', err.message);
    return;
  }

  applyIncoming(incoming, { replace: !useToken });
  cfg().syncToken = nextSync || cfg().syncToken;
  cfg().lastSync = new Date().toISOString();
  commit(null, { source: 'gcal' });
  setStatus('ready');
}

function applyIncoming(raw, { replace }) {
  const byId = new Map(replace ? [] : state.events.map((e) => [e.id, e]));

  for (const ev of raw) {
    if (ev.status === 'cancelled') {
      byId.delete(ev.id);
      const owned = state.items.find((t) => t.gcalId === ev.id);
      if (owned) { owned.gcalId = null; owned.plan = owned.plan ? { ...owned.plan, start: owned.plan.start } : null; }
      continue;
    }
    const n = normalise(ev);
    if (!n) continue;

    if (n.plannerItemId) {
      // our own block came back — accept edits made in Google Calendar
      const item = itemById(n.plannerItemId);
      if (item && !n.allDay && n.start) {
        const mins = Math.max(15, (toMin(n.end) || toMin(n.start) + 60) - toMin(n.start));
        const changed = !item.plan || item.plan.date !== n.date || item.plan.start !== n.start || item.plan.mins !== mins;
        if (changed) item.plan = { date: n.date, start: n.start, mins };
        item.gcalId = n.id;
        if (n.title && n.title !== item.title && !item.title) item.title = n.title;
      }
      continue; // not mirrored into state.events; it renders from the item
    }
    byId.set(n.id, n);
  }

  state.events = Array.from(byId.values())
    .filter((e) => e.date >= addDays(state.semester.start, -7) && e.date <= addDays(state.semester.end, 7));
}

/* ---------------- write ---------------- */

function eventBodyFor(item) {
  const area = areaById(item.areaId);
  const start = item.plan.start || '09:00';
  const mins = item.plan.mins || item.estMins || 60;
  return {
    summary: area ? `${area.name}: ${item.title}` : item.title,
    description: [item.notes, item.due ? `Due ${item.due}` : ''].filter(Boolean).join('\n\n'),
    start: { dateTime: toRfc3339(item.plan.date, start), timeZone: tz() },
    end: { dateTime: toRfc3339(item.plan.date, fromMin(toMin(start) + mins)), timeZone: tz() },
    extendedProperties: { private: { plannerItemId: item.id } },
    source: { title: 'Semester Planner', url: location.origin + location.pathname }
  };
}

function queue(op) {
  state.outbox.push({ ...op, at: Date.now() });
  commit();
}

/** Push (or remove) the Google event backing a planner item. */
export async function pushItem(itemId) {
  const item = itemById(itemId);
  if (!cfg().enabled || !cfg().pushPlans || !isConfigured()) return;
  if (!item) return;

  const wantsEvent = !!(item.plan && item.plan.date && item.plan.start && !item.done);
  if (!wantsEvent && !item.gcalId) return;

  if (!navigator.onLine || !isSignedIn()) {
    queue({ kind: wantsEvent ? 'upsert' : 'delete', itemId });
    return;
  }
  const calId = encodeURIComponent(cfg().calendarId || 'primary');
  try {
    if (!wantsEvent) {
      await api(`/calendars/${calId}/events/${encodeURIComponent(item.gcalId)}`, { method: 'DELETE' });
      item.gcalId = null;
    } else if (item.gcalId) {
      await api(`/calendars/${calId}/events/${encodeURIComponent(item.gcalId)}`, { method: 'PATCH', body: eventBodyFor(item) });
    } else {
      const ev = await api(`/calendars/${calId}/events`, { method: 'POST', body: eventBodyFor(item) });
      item.gcalId = ev.id;
    }
    commit(null, { source: 'gcal-push' });
  } catch (err) {
    if (err.code === 404 && item.gcalId) { item.gcalId = null; commit(); return pushItem(itemId); }
    gcal.lastError = err;
    queue({ kind: wantsEvent ? 'upsert' : 'delete', itemId });
    setStatus('error', err.message);
  }
}

export async function flushOutbox() {
  if (!state.outbox.length || !navigator.onLine || !isSignedIn()) return;
  const pending = state.outbox.splice(0, state.outbox.length);
  commit();
  for (const op of pending) await pushItem(op.itemId);
}

/* ---------------- lifecycle ---------------- */

let timer = null;

export async function start() {
  captureRedirectToken();
  loadToken();
  if (!cfg().enabled || !isConfigured()) { setStatus(isConfigured() ? 'signed-out' : 'off'); return; }
  if (!isSignedIn()) {
    try { await signIn(false); } catch { setStatus('signed-out', 'Sign in to sync.'); return; }
  }
  setStatus('ready');
  listCalendars().catch(() => {});
  await flushOutbox();
  await sync();
  schedule();
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && cfg().enabled) sync();
  }, 60000);
}

export function stop() { clearInterval(timer); timer = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg().enabled && isConfigured()) {
    flushOutbox().then(() => sync());
  }
});
window.addEventListener('online', () => { if (cfg().enabled) flushOutbox().then(() => sync()); });
window.addEventListener('offline', () => setStatus('offline', 'Offline — changes are queued.'));
