// store/backups.js — copies this device keeps, where no sync can reach.
//
// Sync is not a backup. A bad row can be pushed to every device in seconds,
// and an upsert writes over what was there. So before any of that, the state
// as it was found is kept here, on this device, under keys of its own.
//
// Two kinds. One per day, the last few days kept, so a slow leak is caught.
// And one taken the moment a schema upgrade is about to run, because that is
// when the shape of every row changes at once and the damage is widest. The
// Google mirror and the outbox are dropped from both: they are rebuilt from
// Google on the next sync, and they are most of the bytes.

import { today } from '../util.js';
import { SCHEMA_VERSION } from './constants.js';

const BAK = 'semesterPlanner.bak.';
const KEEP_DAYS = 5;

/** Everything worth keeping, minus what a sync can fetch again. */
const backupOf = (raw) => {
  const { events, outbox, ...rest } = raw || {};
  return JSON.stringify({ ...rest, backedUpAt: new Date().toISOString() });
};

export function listBackups() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BAK)) out.push({ key: k, label: k.slice(BAK.length), size: (localStorage.getItem(k) || '').length });
  }
  return out.sort((a, b) => (a.label < b.label ? 1 : -1));
}

export const readBackup = (key) => localStorage.getItem(key);

/** Keep today's copy and the pre-upgrade one, and drop the oldest dailies. */
export function keepBackups(raw) {
  if (!raw || typeof raw !== 'object') return;
  const put = (name) => {
    if (localStorage.getItem(BAK + name)) return;   // already have this one
    try { localStorage.setItem(BAK + name, backupOf(raw)); } catch { prune(true); }
  };
  const prune = (hard = false) => {
    const dailies = listBackups().filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.label));
    for (const b of dailies.slice(hard ? KEEP_DAYS - 2 : KEEP_DAYS)) {
      try { localStorage.removeItem(b.key); } catch { /* nothing else to try */ }
    }
  };
  // the one that matters most: the shape about to be rewritten
  const from = raw.version || 0;
  if (from && from < SCHEMA_VERSION) put(`before-v${SCHEMA_VERSION}`);
  put(today());
  prune();
}
