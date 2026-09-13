// @ts-check
// problems.js — the last things that went wrong on this device.
// console.warn is gone once DevTools closes, and a phone has no DevTools;
// Settings shows this list instead. Device-only: never a row, never synced.

const KEY = 'semesterPlanner.problems';
const KEEP = 20;

/** @typedef {{ at: string, tag: string, text: string }} Problem */

/** @type {Problem[]} */
let list = load();

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.slice(-KEEP) : [];
  } catch { return []; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* full, or blocked */ }
}

/** One line for whatever was thrown. */
export function describe(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

/** Keeps it. The newest is last in the store, first in `problems()`. */
export function note(tag, err) {
  list.push({ at: new Date().toISOString(), tag, text: describe(err).slice(0, 300) });
  if (list.length > KEEP) list = list.slice(-KEEP);
  save();
}

/** Says it in the console and keeps it: what console.warn was for. */
export function warn(tag, err) {
  console.warn(tag, err);
  note(tag, err);
}

/** Newest first. */
export const problems = () => list.slice().reverse();

export function clearProblems() { list = []; save(); }

/** Errors nothing caught, and promises nothing waited on, go in too. */
export function watchWindow(win = window) {
  win.addEventListener('error', (e) => note('page', e.error || e.message));
  win.addEventListener('unhandledrejection', (e) => note('promise', e.reason));
}
