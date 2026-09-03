// cloud.js — Supabase sync. Local-first: localStorage stays the working copy,
// Postgres is durable storage plus the fan-out between your devices.
//
// Change detection is a snapshot diff, not per-mutation bookkeeping. Views all
// over this app mutate state objects directly inside commit(), so any scheme
// that needed every call site to remember to flag a row would rot within a
// week. Instead we hash every row after each save and compare against the
// hashes from the last successful sync: changed rows get pushed, rows that
// vanished become tombstones. Nothing to forget.
//
// Conflicts settle last-write-wins per row. Rows carry two timestamps:
//   updated_at — the writing client's clock, used to decide who wins
//   synced_at  — the server's clock, used as the pull cursor
// Splitting them means clock skew between your laptop and phone can't make
// the app miss a change; at worst it settles a genuine conflict the wrong way.

import { state, commit, save, subscribe, snapshotRows, applyRow, rowStamp, SCHEMA_VERSION } from './store.js';
import { debounce } from './util.js';
import { applyAppearance } from './appearance.js';

const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://esm.sh/@supabase/supabase-js@2'
];
const TABLE = 'planner_rows';
const BASE_KEY = (uid) => `semesterPlanner.cloudBase.${uid}`;
const SCHEMA_KEY = (uid) => `semesterPlanner.cloudSchema.${uid}`;
const EPOCH = '1970-01-01T00:00:00Z';
const PAGE = 500;

export const cloud = {
  status: 'off',      // off | signed-out | connecting | ready | syncing | error | offline
  message: '',
  email: null,
  userId: null,
  live: false,        // realtime channel is subscribed
  storageFull: false, // the baseline could not be written to localStorage
  halted: false,      // the loop breaker tripped; a manual sync starts it again
  log: []             // the last LOG_MAX syncs, newest first — see logSync()
};

/* ---------------- the sync log ----------------
   What each sync did, kept on this device: how many rows went up, came
   down, were adopted from the read-back, and how long it took. A loop of
   the kind we shipped three times shows here in the first minute — a
   column of "up 40" with nothing edited — where the status line only ever
   said "synced". Device-only, small, and survives a reload. */
const LOG_KEY = 'semesterPlanner.cloudLog';
const LOG_MAX = 30;
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
}
function logSync(entry) {
  cloud.log.unshift(entry);
  cloud.log.length = Math.min(cloud.log.length, LOG_MAX);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(cloud.log)); } catch { /* it is only a log */ }
}
cloud.log = loadLog();

/* ---------------- the loop breaker ----------------
   A push with nothing edited here since the last sync is legitimate once or
   twice — the first sync after an upgrade, a tombstone — never five times
   running. Five is a loop, and a loop is stopped rather than let run all
   night: status goes to `error`, the timers and the channel stay up but
   sync() refuses until someone presses Sync now. */
const LOOP_MAX = 5;
let editsSinceSync = 0;   // local commits since the last sync began
let quietPushes = 0;      // syncs in a row that pushed with no local edit

const listeners = new Set();
export const onCloud = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(cloud); };
function setStatus(s, msg = '') { cloud.status = s; cloud.message = msg; emit(); }

/**
 * Turn a Postgres error into something worth reading. The one that actually
 * happens is the kind CHECK: a project created before notecards existed
 * refuses `kind = 'card'`, so every sync fails on a row the client is right to
 * send. Reporting Postgres verbatim leaves you with a constraint name and no
 * idea that the fix is one file in the SQL editor.
 */
export function describeSyncError(err) {
  const text = err?.message || String(err || '');
  // 23514 is check_violation; the name is matched too, since PostgREST does
  // not always pass the code through
  if (err?.code === '23514' || /planner_rows_kind_check/.test(text)) {
    return 'This database is older than the app. Open the Supabase SQL editor '
      + 'and run supabase/upgrade.sql from the repo, then sync again.';
  }
  // 42P01 is undefined_table: the history table is newer than the database
  if (err?.code === '42P01' || /planner_rows_history/.test(text)) {
    return 'This database keeps no history yet. Open the Supabase SQL editor '
      + 'and run supabase/upgrade.sql from the repo.';
  }
  return text;
}

const cfg = () => state.settings.cloud;
export const isConfigured = () => !!(cfg().url && cfg().anonKey);
export const isSignedIn = () => !!cloud.userId;

/* ---------------- client ---------------- */

let sb = null;
let lib = null;

async function loadLib() {
  if (lib) return lib;
  let lastErr;
  for (const url of CDN) {
    try { lib = await import(url); return lib; } catch (e) { lastErr = e; }
  }
  throw new Error('Could not load the Supabase library. Check your connection. (' + (lastErr?.message || '') + ')');
}

export async function client() {
  if (sb) return sb;
  if (!isConfigured()) throw new Error('Add your Supabase URL and anon key in Settings first.');
  const { createClient } = await loadLib();
  sb = createClient(cfg().url.replace(/\/+$/, ''), cfg().anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'semesterPlanner.sb',
      // Google Calendar owns the URL hash; don't let two libraries fight over it
      detectSessionInUrl: false
    }
  });
  return sb;
}

function resetClient() { sb = null; }

/** Test seam: inject a stand-in for the Supabase client. */
export function _setClient(fake, { userId, email } = {}) {
  sb = fake;
  if (userId) { cloud.userId = userId; cloud.email = email || null; }
}

/* ---------------- auth ---------------- */

export async function signUp(email, password) {
  const c = await client();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.session) return { needsConfirmation: true };
  await adoptSession(data.session);
  return { needsConfirmation: false };
}

export async function signIn(email, password) {
  const c = await client();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await adoptSession(data.session);
}

export async function sendReset(email) {
  const c = await client();
  const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}

/** Sign out. Local data is never touched — this device keeps working offline. */
export async function signOut() {
  stop();
  try { const c = await client(); await c.auth.signOut(); } catch { /* already gone */ }
  cloud.userId = null;
  cloud.email = null;
  setStatus('signed-out', 'Signed out. Your data is still on this device.');
}

async function adoptSession(session) {
  if (!session) return;
  cloud.userId = session.user.id;
  cloud.email = session.user.email;
  setStatus('ready');
}

/* ---------------- baseline ---------------- */

/* A short hash of a row's JSON, never the JSON itself. The baseline keeps one
   per row in localStorage, and keeping every row's whole JSON there put a
   phone over its quota: the baseline then failed to save, quietly, so every
   sync pushed the whole store, and every push came back down the channel as
   one more sync — one a second, for as long as the app was open. cyrb53.

   Hashed with the keys in sorted order, whatever order they came in. Postgres
   keeps jsonb with its keys sorted, so every row comes back from the server
   in an order other than the one we sent. Hashing the bytes as they were,
   push read a row back, found it "different", adopted the server's copy and
   recorded its hash; the next sync hashed our own order, saw a change, and
   pushed the same row again — and each push woke the realtime channel, which
   scheduled the next sync. One a second, for as long as the app was open. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => x === undefined ? 'null' : canon(x)).join(',') + ']';
  if (v && typeof v === 'object') {
    const parts = [];
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) parts.push(JSON.stringify(k) + ':' + canon(v[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}
function hash(data) {
  const str = canon(data);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + '.' + (h1 >>> 0).toString(36);
}
export { hash as rowHash };
const key = (kind, id) => `${kind}:${id}`;

function loadBaseline() {
  if (!cloud.userId) return null;
  if (mem.uid === cloud.userId && mem.has) return mem.base;
  try {
    const raw = localStorage.getItem(BASE_KEY(cloud.userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* The baseline lives here as well as in localStorage. A write there can fail
   — a full phone — and a baseline that did not save is what turns one push
   into a push a second. Here it holds for the session at least, and
   `storageFull` lets Settings say why. */
let mem = { uid: null, has: false, base: null, schema: null };

function storeBaseline(map) {
  if (!cloud.userId) return;
  mem = { ...mem, uid: cloud.userId, has: true, base: map };
  try {
    if (map) localStorage.setItem(BASE_KEY(cloud.userId), JSON.stringify(map));
    else localStorage.removeItem(BASE_KEY(cloud.userId));
    cloud.storageFull = false;
  } catch (e) {
    cloud.storageFull = true;
    console.warn('cloud: the baseline did not save', e);
  }
}

/* An upgrade is not an edit.
   The baseline spots changes by hashing each row, so a migration that adds a
   field — a `tz` on every class meeting, say — makes every row it touched look
   edited, and the first device to open the new version pushes its whole copy
   over everyone else's. That is how a freewrite written on the phone was
   replaced by the laptop's empty one. So the schema the baseline was built
   under is recorded, and when it moves we throw the baseline away: with none,
   the cloud wins every row, and the new shape goes up only after we have
   agreed with the server about what it holds. */
// the schema, and the shape of the hash: a baseline of whole-JSON "hashes"
// from before h2 would call every row edited, which is the very thing this
// guards against, so it is thrown away the same as one from an old schema
const AGREED = `${SCHEMA_VERSION}/h3`;
const baselineSchema = () => {
  if (!cloud.userId) return null;
  if (mem.uid === cloud.userId && mem.schema) return mem.schema;
  try { return localStorage.getItem(SCHEMA_KEY(cloud.userId)) || null; } catch { return null; }
};
function storeSchema() {
  if (!cloud.userId) return;
  mem = { ...mem, uid: cloud.userId, schema: AGREED };
  try { localStorage.setItem(SCHEMA_KEY(cloud.userId), AGREED); } catch { /* storeBaseline has said so */ }
}

function currentHashes() {
  const out = {};
  for (const r of snapshotRows()) out[key(r.kind, r.id)] = hash(r.data);
  return out;
}

/* ---------------- sync ---------------- */

let syncing = false;
let pending = false;
let authRetried = false;
const isAuthError = (e) => e?.code === 'PGRST301' || e?.status === 401
  || /jwt.*expired|expired.*jwt|invalid.*jwt|not authenticated/i.test(e?.message || '');

/**
 * Back from the background. An iOS app that slept for hours wakes with an
 * expired token, and a sync fired straight away got a 401 before supabase-js
 * had refreshed it — so ask for the session first, which refreshes it on the
 * way, and sync after.
 */
export async function resume() {
  if (!cfg().enabled || !isConfigured() || !isSignedIn()) return;
  try {
    const c = await client();
    if (c.auth?.getSession) {
      const { data } = await c.auth.getSession();
      if (!data?.session) { cloud.userId = null; setStatus('signed-out', 'Sign in to sync.'); return; }
    }
  } catch (err) {
    setStatus('error', err.message || String(err));
    return;
  }
  return sync();
}

export async function sync({ full = false, manual = false } = {}) {
  if (!cfg().enabled || !isConfigured() || !isSignedIn()) return;
  if (!navigator.onLine) { setStatus('offline', 'Offline — changes sync when you reconnect.'); return; }
  if (cloud.halted && !manual) return;
  if (syncing) { pending = true; return; }

  syncing = true;
  if (manual) { cloud.halted = false; quietPushes = 0; }
  const edits = editsSinceSync;
  editsSinceSync = 0;
  const t0 = Date.now();
  const entry = { at: new Date().toISOString(), ms: 0, up: 0, down: 0, adopted: 0, full: !!full, error: null };
  setStatus('syncing');
  try {
    const c = await client();
    // an upgrade since the last sync counts as a full one: adopt, then send
    const upgraded = baselineSchema() !== AGREED;
    if (full || upgraded) { cfg().cursor = ''; storeBaseline(null); entry.full = true; }

    const pulled = await pull(c);
    // What came down is what the server holds: push must judge against
    // that, or every row another device sent goes straight back up — a
    // wasted write, and an echo down the channel for it.
    const base = { ...(loadBaseline() || {}) };
    for (const [k, v] of Object.entries(pulled.took)) { if (v === null) delete base[k]; else base[k] = v; }
    const pushed = await push(c, base);
    entry.down = pulled.applied; entry.up = pushed.sent; entry.adopted = pushed.adopted || 0;

    cfg().cursor = [cfg().cursor, pulled.cursor, pushed.cursor].filter(Boolean).sort().pop() || cfg().cursor;
    cfg().lastSync = new Date().toISOString();
    // Record what push saw, not what state holds now: an edit or delete made
    // while the round trip was in flight has not been sent yet, and baking it
    // into the baseline would hide it from the next push forever.
    storeBaseline(pushed.hashes);
    storeSchema();
    save();

    authRetried = false;
    quietPushes = pushed.sent && !edits && !entry.full ? quietPushes + 1 : 0;
    if (quietPushes >= LOOP_MAX) {
      cloud.halted = true;
      entry.error = 'loop';
      setStatus('error', `Sync stopped itself: it sent rows on ${quietPushes} syncs in a row with nothing edited here. `
        + 'That is a loop, not sync. Press Sync now to try once more.');
    } else {
      setStatus('ready');
    }
  } catch (err) {
    // A token that expired while the app slept: refresh it and go once more.
    // Once — a refresh that does not help is an error like any other.
    if (isAuthError(err) && !authRetried) {
      authRetried = true;
      try { await (await client()).auth?.refreshSession?.(); } catch { /* the retry will say */ }
      entry.error = 'token expired — refreshed, trying again';
      pending = true;
    } else {
      console.warn('cloud sync', err);
      entry.error = describeSyncError(err);
      setStatus('error', entry.error);
    }
  } finally {
    entry.ms = Date.now() - t0;
    logSync(entry);
    syncing = false;
    if (pending) { pending = false; setTimeout(() => sync(), 250); }
  }
}

/** Bring down everything the server has seen since our cursor. */
async function pull(c) {
  const baseline = loadBaseline();
  const hashes = currentHashes();
  let cursor = cfg().cursor || EPOCH;
  let maxSynced = '';
  let changed = false;
  let applied = 0;
  const took = {};   // key -> hash of what was applied, null for a tombstone

  for (;;) {
    const { data, error } = await c
      .from(TABLE)
      .select('kind,id,data,deleted,updated_at,synced_at')
      .gt('synced_at', cursor)
      .order('synced_at', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    if (!data || !data.length) break;

    for (const row of data) {
      if (row.synced_at > maxSynced) maxSynced = row.synced_at;
      // Our own write, coming back down the realtime channel we are subscribed
      // to. Applying it would set the row to what it already holds and still
      // report a change, and the re-render that follows takes the caret out of
      // whatever was being typed — the write having been caused by that typing.
      if (!row.deleted && hashes[key(row.kind, row.id)] === hash(row.data)) continue;
      if (winner(row, baseline, hashes) === 'remote') {
        const ok = applyRow(row);
        if (ok) { changed = true; applied++; }
        // a kind this build does not know is not taken, and must not be
        // recorded either, or push would send a tombstone for it
        if (ok || row.deleted) took[key(row.kind, row.id)] = row.deleted ? null : hash(row.data);
      }
    }
    cursor = data[data.length - 1].synced_at;
    if (data.length < PAGE) break;
  }

  if (changed) {
    applyAppearance();
    commit(null, { source: 'cloud' });
  }
  return { cursor: maxSynced, applied, took };
}

/**
 * Who wins for this row: 'remote' or 'local'.
 * A local row only contests if it changed since our last sync. On a device's
 * very first sync there is no baseline to judge against, so the established
 * cloud copy wins unless the local row can prove it is newer.
 */
function winner(row, baseline, hashes) {
  const k = key(row.kind, row.id);
  const localHash = hashes[k];
  if (localHash === undefined) {
    if (row.deleted) return 'local';
    // Missing locally has two very different causes, and the baseline tells
    // them apart: if we had this row at our last sync and it is gone now, it
    // was deleted here and its tombstone has not gone up yet — adopting the
    // server's live copy would undo the delete. Without a baseline (first
    // sync, or after a rebuild) we cannot tell, so the cloud still wins.
    if (baseline && baseline[k] !== undefined) return 'local';
    return 'remote';
  }

  const dirty = baseline ? baseline[k] !== localHash : true;
  if (!dirty) return 'remote';

  const stamp = rowStamp(row.kind, row.id);
  if (stamp && row.updated_at && new Date(stamp) > new Date(row.updated_at)) return 'local';
  if (!baseline) return 'remote';       // first sync: trust the cloud
  return stamp ? 'remote' : 'local';    // no local timestamp to compare: keep the edit we can see
}

/**
 * Send up anything that changed here, plus tombstones for anything deleted here.
 * Returns the pushed cursor and the hashes it actually sent — those hashes, not
 * the state at the end of the sync, are what the next baseline must record.
 */
async function push(c, baseline = loadBaseline()) {
  const rows = snapshotRows();
  const hashes = {};
  const now = new Date().toISOString();
  const out = [];

  for (const r of rows) {
    const k = key(r.kind, r.id);
    hashes[k] = hash(r.data);
    if (!baseline || baseline[k] !== hashes[k]) {
      // the row's own edit time, not the clock at push time: a row that was
      // dirtied by an upgrade rather than by a person must not present itself
      // as the newest thing anyone has written
      out.push({
        user_id: cloud.userId, kind: r.kind, id: r.id, data: r.data,
        deleted: false, updated_at: rowStamp(r.kind, r.id) || now
      });
    }
  }
  // present at last sync, gone now => deleted on this device
  if (baseline) {
    for (const k of Object.keys(baseline)) {
      if (hashes[k] !== undefined) continue;
      const [kind, ...rest] = k.split(':');
      out.push({ user_id: cloud.userId, kind, id: rest.join(':'), data: {}, deleted: true, updated_at: now });
    }
  }
  if (!out.length) return { cursor: '', hashes, sent: 0, adopted: 0 };

  /* Read back what landed, not just that it landed. The database drops a
     write older than the row it hits (planner_rows_keep_newest) and answers
     with the row it kept — so a row that comes back different from the one we
     sent is one the server refused, and the copy it holds is the newer one.
     Take it, and record its hash rather than ours, or the next diff would
     push the same stale copy again for ever. */
  let maxSynced = '';
  let adopted = 0;
  for (let i = 0; i < out.length; i += 200) {
    const { data, error } = await c
      .from(TABLE)
      .upsert(out.slice(i, i + 200), { onConflict: 'user_id,kind,id' })
      .select('kind,id,data,deleted,synced_at');
    if (error) throw error;
    for (const row of data || []) {
      if (row.synced_at > maxSynced) maxSynced = row.synced_at;
      const k = key(row.kind, row.id);
      if (row.deleted || hashes[k] === undefined) continue;
      const kept = hash(row.data);
      if (kept === hashes[k]) continue;
      if (applyRow(row)) adopted++;
      hashes[k] = kept;
    }
  }
  if (adopted) commit(null, { source: 'cloud' });
  return { cursor: maxSynced, hashes, sent: out.length, adopted };
}

/* ---------------- realtime ---------------- */

let channel = null;
const pullSoon = debounce(() => sync(), 600);

async function subscribeLive(c) {
  if (channel) return;
  channel = c.channel('planner-' + cloud.userId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${cloud.userId}` },
      (payload) => {
        // our own write coming back down the channel is not news, and a
        // sync for it is a round trip plus a status flicker for nothing
        const r = payload?.new;
        if (r && !r.deleted && r.kind && currentHashes()[key(r.kind, r.id)] === hash(r.data)) return;
        pullSoon();
      })
    .subscribe((s) => {
      cloud.live = s === 'SUBSCRIBED';
      emit();
    });
}

/* ---------------- lifecycle ---------------- */

let timer = null;
const pushSoon = debounce(() => sync(), 1500);

export async function start() {
  if (!isConfigured()) { setStatus('off'); return; }
  if (!cfg().enabled) { setStatus('signed-out'); return; }
  setStatus('connecting');
  try {
    const c = await client();
    const { data } = await c.auth.getSession();
    if (!data.session) { setStatus('signed-out', 'Sign in to sync.'); return; }
    await adoptSession(data.session);
    c.auth.onAuthStateChange((_e, session) => {
      if (session) adoptSession(session);
      else { cloud.userId = null; setStatus('signed-out'); }
    });
    await sync();
    await subscribeLive(c);
    schedule();
  } catch (err) {
    setStatus('error', err.message || String(err));
  }
}

function schedule() {
  clearInterval(timer);
  // realtime does the heavy lifting; this is the safety net for a dropped socket
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && cfg().enabled) sync();
  }, cloud.live ? 300000 : 60000);
}

export function stop() {
  clearInterval(timer); timer = null;
  if (channel) { try { channel.unsubscribe(); } catch { /* ignore */ } channel = null; }
  cloud.live = false;
}

/* ---------------- history ----------------
   Every version a row had on the server, kept 30 days by a trigger
   (supabase/upgrade.sql). An upsert has no undo of its own; this is it. */
const HISTORY = 'planner_rows_history';

/** The last versions rows had on the server, newest first. */
export async function history(limit = 40) {
  const c = await client();
  const { data, error } = await c
    .from(HISTORY)
    .select('hid,kind,id,data,deleted,updated_at,replaced_at')
    .order('replaced_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/** Put a version back: into state, stamped now, so the next push wins over what the server holds. */
export function restore(row) {
  const data = { ...row.data };
  if (row.kind !== 'meta') data.updatedAt = new Date().toISOString();
  if (!applyRow({ kind: row.kind, id: row.id, data, deleted: false })) return false;
  commit(null, { source: 'restore' });
  return true;
}

/** Forget this device's sync bookkeeping without touching the data itself. */
export function resetLocalSyncState() {
  if (cloud.userId) { try { localStorage.removeItem(BASE_KEY(cloud.userId)); } catch { /* ignore */ } }
  mem = { uid: null, has: false, base: null, schema: null };
  cloud.halted = false; quietPushes = 0; editsSinceSync = 0;
  cfg().cursor = '';
  save();
  resetClient();
}

// Local edits schedule a push; cloud-driven edits must not bounce straight
// back. Nor may a save seen from another tab: that tab pushes its own edits,
// and every sync here writes `lastSync`, which the other tab sees as a save
// of ours, pushes, writes its own `lastSync`... two tabs of the planner on
// one device kept each other syncing every couple of seconds, and Settings
// twitched with each round.
subscribe((meta) => {
  if (meta?.source === 'cloud' || meta?.external) return;
  editsSinceSync++;
  if (cfg().enabled && isSignedIn()) pushSoon();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resume();
});
window.addEventListener('online', () => { resume(); });
window.addEventListener('offline', () => {
  if (cfg().enabled) setStatus('offline', 'Offline — changes sync when you reconnect.');
});
