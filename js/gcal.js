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

import {
  state, commit, itemById, areaById, upsertItem, seriesById, splitOccurrence,
  repeats, occurrencesBetween
} from './store.js';
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
  status: 'off',     // off | signed-out | connecting | ready | syncing | error | offline | waiting
  message: '',
  lastError: null,
  backoffUntil: 0    // Google asked for a pause: nothing goes out before this
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
    callback: () => {},
    error_callback: () => {}
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
    // a popup that was blocked, or closed, never reaches `callback`; without
    // this the promise hung, api() with it, and the status said Connecting…
    client.error_callback = (err) => {
      const msg = err?.message || (err?.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in did not open.');
      setStatus('signed-out', msg);
      reject(new Error(msg));
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
  // 410 on the events list is a sync token Google will not honour any more;
  // on one event it is the event, gone for good — the callers read the code
  if (res.status === 410) throw Object.assign(new Error(method === 'GET' ? 'Sync token expired' : 'Google Calendar 410: gone'), { code: 410 });
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

  const changed = applyIncoming(incoming, { replace: !useToken });
  cfg().syncToken = nextSync || cfg().syncToken;
  cfg().lastSync = new Date().toISOString();
  // the cursor and the timestamp are worth saving either way; the repaint is
  // only worth it when the calendar actually said something
  commit(null, changed ? { source: 'gcal' } : undefined);
  setStatus('ready');
}

/**
 * Fold what Google sent into state, and say whether any of it landed.
 *
 * The answer matters: a quiet minute is the common case, and repainting the
 * screen for one takes the caret out of whatever is being written.
 */
function applyIncoming(raw, { replace }) {
  const byId = new Map(replace ? [] : state.events.map((e) => [e.id, e]));
  const was = JSON.stringify(state.events);
  let touched = false;

  for (const ev of raw) {
    if (ev.status === 'cancelled') {
      byId.delete(ev.id);
      const owned = state.items.find((t) => t.gcalId === ev.id);
      if (owned) {
        owned.gcalId = null;
        owned.plan = owned.plan ? { ...owned.plan, start: owned.plan.start } : null;
        touched = true;
      }
      continue;
    }
    const n = normalise(ev);
    if (!n) continue;

    if (n.plannerItemId) {
      // our own block came back — accept edits made in Google Calendar. The id
      // may name one occurrence of a series, in which case the change is that
      // occurrence's own and `upsertItem` files it as an exception rather than
      // rewriting the rule for every other week.
      const item = itemById(n.plannerItemId);
      if (item && n.date && (n.allDay || n.start)) {
        const mins = n.allDay ? 0 : Math.max(15, (toMin(n.end) || toMin(n.start) + 60) - toMin(n.start));
        const start = n.allDay ? null : n.start;
        const changed = !item.plan || item.plan.date !== n.date
          || (item.plan.start || null) !== start || (item.plan.mins || 0) !== mins;
        if (changed) { upsertItem({ id: item.id, plan: { date: n.date, start, mins } }); touched = true; }
        const cut = splitOccurrence(item.id);
        if (cut) {
          const series = seriesById(item.id);
          if (series && (series.gcalIds || {})[cut.on] !== n.id) {
            series.gcalIds = { ...(series.gcalIds || {}), [cut.on]: n.id };
            touched = true;
          }
        } else if (item.gcalId !== n.id) {
          item.gcalId = n.id; touched = true;
        }
        if (n.title && n.title !== item.title && !item.title) {
          upsertItem({ id: item.id, title: n.title }); touched = true;
        }
      }
      continue; // not mirrored into state.events; it renders from the item
    }
    byId.set(n.id, n);
  }

  state.events = Array.from(byId.values())
    .filter((e) => e.date >= addDays(state.semester.start, -7) && e.date <= addDays(state.semester.end, 7));
  return touched || JSON.stringify(state.events) !== was;
}

/* ---------------- write ---------------- */

/**
 * The Google event a planned item should be.
 *
 * A block with no start is an all-day one, and Google says all-day in dates
 * rather than times — `end.date` being the morning *after*, which is why it is
 * a day on rather than the same date twice.
 */
export function eventBodyFor(item) {
  const area = areaById(item.areaId);
  const start = item.plan.start;
  const mins = item.plan.mins || item.estMins || 60;
  const when = start
    ? {
      start: { dateTime: toRfc3339(item.plan.date, start), timeZone: tz() },
      end: { dateTime: toRfc3339(item.plan.date, fromMin(toMin(start) + mins)), timeZone: tz() }
    }
    : {
      start: { date: item.plan.date },
      end: { date: addDays(item.plan.date, 1) }
    };
  return {
    ...when,
    summary: area ? `${area.name}: ${item.title}` : item.title,
    description: [item.notes, item.due ? `Due ${item.due}` : ''].filter(Boolean).join('\n\n'),
    extendedProperties: { private: { plannerItemId: item.id } },
    source: { title: 'Semester Planner', url: location.origin + location.pathname }
  };
}

/* ---------------- the queue ----------------
   Nothing goes out the moment it changes. A block dragged five times is one
   PATCH, not five, and a series moved is one reconciliation — Google's
   per-user rate is a few writes a second, and a drag session overran it.
   Every push lands in `state.outbox` (one row per item; the kind is decided
   at send time from the item as it is then), and the outbox goes out
   together `wait` after the last change, or `maxWait` after the first when
   the changes keep coming. Offline, or signed out, the same queue waits for
   the network. */
export const pushSettings = { wait: 30000, maxWait: 90000, backoff: 60000, backoffMax: 900000 };
let flushTimer = null;
let firstQueuedAt = 0;
let backoff = 0;

function queue(op) {
  const row = { ...op, at: Date.now() };
  const i = state.outbox.findIndex((o) => o.itemId === op.itemId);
  if (i >= 0) state.outbox[i] = row; else state.outbox.push(row);
  commit();
}

function scheduleFlush(delay) {
  const now = Date.now();
  if (!firstQueuedAt) firstQueuedAt = now;
  const wait = delay ?? Math.min(pushSettings.wait, Math.max(0, firstQueuedAt + pushSettings.maxWait - now));
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; flushOutbox().catch(() => {}); }, wait);
}

const isRateLimit = (err) => err?.code === 429
  || (err?.code === 403 && /rateLimit|usageLimits|quota/i.test(err.message || ''));
// an event Google no longer has: 404, or 410 once it has been deleted there
const gone = (err) => err?.code === 404 || err?.code === 410;

/** Google said slow down: keep the queue, wait longer each time it says so. */
function pauseAfter(err) {
  backoff = Math.min(backoff ? backoff * 2 : pushSettings.backoff, pushSettings.backoffMax);
  gcal.backoffUntil = Date.now() + backoff;
  gcal.lastError = err;
  const at = new Date(gcal.backoffUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  setStatus('waiting', `Google asked for a pause — sending again at ${at}`);
  scheduleFlush(backoff);
}

/* ---------------- a series on the calendar ----------------
   Every occurrence is an ordinary Google event of its own, so a week moved
   here is a week moved there and Google never has to be told a rule. The cost
   is bookkeeping: `item.gcalIds` maps the day the rule named to the event id
   standing for it, and a push is a reconciliation — create what is missing,
   patch what has changed, delete what should no longer be there.

   Bounded by the term, because a repeat with no end has no last occurrence and
   something has to decide how much calendar to fill. */

const HORIZON = 250;

const windowStart = () => addDays(state.semester.start, -7);
const windowEnd = () => addDays(state.semester.end, 7);

/** What a series should have on the calendar: day the rule named -> body. */
function wantedFor(item) {
  const want = new Map();
  if (item.done) return want;
  const from = windowStart(), to = windowEnd();
  for (const o of occurrencesBetween(from, to, (t) => t.id === item.id)) {
    if (o.done || !o.plan || !o.plan.date) continue;
    if (want.size >= HORIZON) break;
    want.set(o.occurrence, eventBodyFor(o));
  }
  return want;
}

/**
 * Bring a repeating item's Google events in line with its rule.
 *
 * Deletes first: a rule that shrank should give the days back before the API
 * is asked for anything new, so an interrupted run leaves too few events
 * rather than a calendar with both the old shape and the new one on it.
 */
async function pushSeries(item, calId) {
  const want = wantedFor(item);
  const have = item.gcalIds || {};
  const ids = { ...have };
  // written to the item after every step, not once at the end: a rate limit
  // on the ninth create of fifteen threw the first eight away, and the retry
  // made them again, so the calendar had each week twice. The re-queue that
  // follows a failure commits, and this is what it saves.
  const keep = () => { item.gcalIds = Object.keys(ids).length ? ids : null; };

  for (const [key, id] of Object.entries(have)) {
    if (want.has(key)) continue;
    try { await api(`/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (err) { if (!gone(err)) throw err; }
    delete ids[key];
    keep();
  }
  for (const [key, body] of want) {
    if (ids[key]) {
      try {
        await api(`/calendars/${calId}/events/${encodeURIComponent(ids[key])}`, { method: 'PATCH', body });
        continue;
      } catch (err) {
        // gone from Google's side: fall through and make it again
        if (!gone(err)) throw err;
        delete ids[key];
        keep();
      }
    }
    const ev = await api(`/calendars/${calId}/events`, { method: 'POST', body });
    ids[key] = ev.id;
    keep();
  }
  keep();
  // a series has no single event of its own; the one it had before it repeated
  // is now the first occurrence's
  item.gcalId = null;
}

/**
 * Push (or remove) the Google event backing a planner item — later, with
 * whatever else changes meanwhile (see the queue above). Resolves at once.
 */
export async function pushItem(itemId) {
  // an occurrence is not a row: the series is what has events to reconcile
  const item = seriesById(itemId);
  if (!cfg().enabled || !cfg().pushPlans || !isConfigured()) return;
  if (!item) return;
  queue({ kind: 'upsert', itemId: item.id });
  scheduleFlush();
}

/**
 * Take an item off the calendar as it goes. Queues a delete that carries the
 * event ids itself, so the send still works once the item is gone from state
 * — so call it *before* `deleteItem()`, with the row being deleted (the series,
 * for "All of them"). Skipping one occurrence is an edit to the series, and
 * `pushItem` reconciles that. Undo within the wait is safe: an item that is
 * back when the queue goes out is pushed as it stands.
 * @param {object} item  the item, or an occurrence of a series
 */
export function forgetItem(item) {
  if (!item || !cfg().enabled || !cfg().pushPlans || !isConfigured()) return;
  if (splitOccurrence(item.id)) { pushItem(item.id).catch(() => {}); return; }
  const live = itemById(item.id) || item;
  const ids = [live.gcalId, ...Object.values(live.gcalIds || {})].filter(Boolean);
  if (!ids.length) return;
  queue({ kind: 'delete', itemId: live.id, ids });
  scheduleFlush();
}

/** The events of an item that no longer exists, off the calendar by id. */
async function deleteGone(op) {
  if (!navigator.onLine || !isSignedIn()) { queue(op); return; }
  const calId = encodeURIComponent(cfg().calendarId || 'primary');
  const left = op.ids.slice();
  try {
    while (left.length) {
      try { await api(`/calendars/${calId}/events/${encodeURIComponent(left[0])}`, { method: 'DELETE' }); }
      catch (err) { if (!gone(err)) throw err; }
      left.shift();
    }
  } catch (err) {
    queue({ ...op, ids: left });   // the ones still standing
    if (isRateLimit(err)) { pauseAfter(err); return; }
    gcal.lastError = err;
    setStatus('error', err.message);
  }
}

/** The push itself, now. Throws nothing: a failure re-queues the op. */
async function pushNow(op) {
  const item = seriesById(op.itemId);
  if (!cfg().enabled || !cfg().pushPlans || !isConfigured()) return;
  // gone from state: only a delete that brought its event ids along has
  // anything left to do — and it is done from the ids, the row being no more
  if (!item) { if (op.kind === 'delete' && op.ids?.length) await deleteGone(op); return; }

  if (repeats(item)) {
    if (!navigator.onLine || !isSignedIn()) { queue({ kind: 'upsert', itemId: item.id }); return; }
    try {
      await pushSeries(item, encodeURIComponent(cfg().calendarId || 'primary'));
      commit(null, { source: 'gcal-push' });
    } catch (err) {
      queue({ kind: 'upsert', itemId: item.id });
      if (isRateLimit(err)) { pauseAfter(err); return; }
      gcal.lastError = err;
      setStatus('error', err.message);
    }
    return;
  }

  // no longer a series: whatever it left on the calendar is not wanted
  if (item.gcalIds) {
    const calId = encodeURIComponent(cfg().calendarId || 'primary');
    const stale = Object.values(item.gcalIds);
    item.gcalIds = null;
    commit(null, { source: 'gcal-push' });
    for (const id of stale) {
      try { await api(`/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
      catch { /* already gone, or it will be swept next time */ }
    }
  }

  // a date is enough: a block with no start of its own is an all-day event,
  // not a reason to keep the thing off the calendar altogether
  const wantsEvent = !!(item.plan && item.plan.date && !item.done);
  if (!wantsEvent && !item.gcalId) return;

  if (!navigator.onLine || !isSignedIn()) {
    queue({ kind: wantsEvent ? 'upsert' : 'delete', itemId: item.id });
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
    // the event is not there any more: forget it and go again — a create
    // when one is wanted, nothing when the delete was the point
    if (gone(err) && item.gcalId) { item.gcalId = null; commit(); return pushNow(op); }
    queue({ kind: wantsEvent ? 'upsert' : 'delete', itemId: item.id });
    if (isRateLimit(err)) { pauseAfter(err); return; }
    gcal.lastError = err;
    setStatus('error', err.message);
  }
}

/** Send the queue, one item at a time, stopping for the rest if Google asks for a pause. */
export async function flushOutbox() {
  if (!state.outbox.length || !navigator.onLine || !isSignedIn()) return;
  if (gcal.backoffUntil > Date.now()) { scheduleFlush(gcal.backoffUntil - Date.now()); return; }
  clearTimeout(flushTimer); flushTimer = null;
  firstQueuedAt = 0;
  const pending = state.outbox.splice(0, state.outbox.length);
  commit();
  let paused = false;
  for (const op of pending) {
    if (paused) { queue(op); continue; }   // back in line, behind the one that hit the limit
    await pushNow(op);
    if (gcal.backoffUntil > Date.now()) paused = true;
  }
  if (!paused) {
    backoff = 0;
    gcal.backoffUntil = 0;
    if (gcal.status === 'waiting') setStatus('ready');
  }
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
  /* The mirror keeps wall-clock times, worked out from the instant Google
     sent at the moment it was fetched. Carried to another zone they are the
     old clock's, and a token sync never asks again about an event that did
     not change — so a device that has moved re-reads the lot. The marker is
     device-local by being outside SYNCED_SETTINGS: which zone a phone is in
     is no business of the laptop's. */
  const here = tz();
  const moved = state.settings.tzSeen && state.settings.tzSeen !== here;
  if (state.settings.tzSeen !== here) {
    state.settings.tzSeen = here;
    if (moved) cfg().syncToken = '';
    commit();
  }
  await sync({ full: moved });
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
