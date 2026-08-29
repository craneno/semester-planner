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

import { state, commit, save, subscribe, snapshotRows, applyRow, rowStamp } from './store.js';
import { debounce } from './util.js';
import { applyAppearance } from './appearance.js';

const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://esm.sh/@supabase/supabase-js@2'
];
const TABLE = 'planner_rows';
const BASE_KEY = (uid) => `semesterPlanner.cloudBase.${uid}`;
const EPOCH = '1970-01-01T00:00:00Z';
const PAGE = 500;

export const cloud = {
  status: 'off',      // off | signed-out | connecting | ready | syncing | error | offline
  message: '',
  email: null,
  userId: null,
  live: false         // realtime channel is subscribed
};

const listeners = new Set();
export const onCloud = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(cloud); };
function setStatus(s, msg = '') { cloud.status = s; cloud.message = msg; emit(); }

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

const hash = (data) => JSON.stringify(data);
const key = (kind, id) => `${kind}:${id}`;

function loadBaseline() {
  if (!cloud.userId) return null;
  try {
    const raw = localStorage.getItem(BASE_KEY(cloud.userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storeBaseline(map) {
  if (!cloud.userId) return;
  try { localStorage.setItem(BASE_KEY(cloud.userId), JSON.stringify(map)); } catch { /* quota */ }
}

function currentHashes() {
  const out = {};
  for (const r of snapshotRows()) out[key(r.kind, r.id)] = hash(r.data);
  return out;
}

/* ---------------- sync ---------------- */

let syncing = false;
let pending = false;

export async function sync({ full = false } = {}) {
  if (!cfg().enabled || !isConfigured() || !isSignedIn()) return;
  if (!navigator.onLine) { setStatus('offline', 'Offline — changes sync when you reconnect.'); return; }
  if (syncing) { pending = true; return; }

  syncing = true;
  setStatus('syncing');
  try {
    const c = await client();
    if (full) { cfg().cursor = ''; storeBaseline(null); }

    const cursorAfterPull = await pull(c);
    const pushed = await push(c);

    cfg().cursor = [cfg().cursor, cursorAfterPull, pushed.cursor].filter(Boolean).sort().pop() || cfg().cursor;
    cfg().lastSync = new Date().toISOString();
    // Record what push saw, not what state holds now: an edit or delete made
    // while the round trip was in flight has not been sent yet, and baking it
    // into the baseline would hide it from the next push forever.
    storeBaseline(pushed.hashes);
    save();
    setStatus('ready');
  } catch (err) {
    console.warn('cloud sync', err);
    setStatus('error', err.message || String(err));
  } finally {
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
      if (winner(row, baseline, hashes) === 'remote') {
        if (applyRow(row)) changed = true;
      }
    }
    cursor = data[data.length - 1].synced_at;
    if (data.length < PAGE) break;
  }

  if (changed) {
    applyAppearance();
    commit(null, { source: 'cloud' });
  }
  return maxSynced;
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
async function push(c) {
  const baseline = loadBaseline();
  const rows = snapshotRows();
  const hashes = {};
  const now = new Date().toISOString();
  const out = [];

  for (const r of rows) {
    const k = key(r.kind, r.id);
    hashes[k] = hash(r.data);
    if (!baseline || baseline[k] !== hashes[k]) {
      out.push({ user_id: cloud.userId, kind: r.kind, id: r.id, data: r.data, deleted: false, updated_at: now });
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
  if (!out.length) return { cursor: '', hashes };

  let maxSynced = '';
  for (let i = 0; i < out.length; i += 200) {
    const { data, error } = await c
      .from(TABLE)
      .upsert(out.slice(i, i + 200), { onConflict: 'user_id,kind,id' })
      .select('synced_at');
    if (error) throw error;
    for (const row of data || []) if (row.synced_at > maxSynced) maxSynced = row.synced_at;
  }
  return { cursor: maxSynced, hashes };
}

/* ---------------- realtime ---------------- */

let channel = null;
const pullSoon = debounce(() => sync(), 600);

async function subscribeLive(c) {
  if (channel) return;
  channel = c.channel('planner-' + cloud.userId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${cloud.userId}` },
      () => pullSoon())
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

/** Forget this device's sync bookkeeping without touching the data itself. */
export function resetLocalSyncState() {
  if (cloud.userId) { try { localStorage.removeItem(BASE_KEY(cloud.userId)); } catch { /* ignore */ } }
  cfg().cursor = '';
  save();
  resetClient();
}

// local edits schedule a push; cloud-driven edits must not bounce straight back
subscribe((meta) => {
  if (meta?.source === 'cloud') return;
  if (cfg().enabled && isSignedIn()) pushSoon();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg().enabled && isSignedIn()) sync();
});
window.addEventListener('online', () => { if (cfg().enabled && isSignedIn()) sync(); });
window.addEventListener('offline', () => {
  if (cfg().enabled) setStatus('offline', 'Offline — changes sync when you reconnect.');
});
