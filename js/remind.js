// @ts-check
// remind.js — a heads-up before a thing begins.
//
// A lead of minutes, set on this device: a notification is the device's to
// show, and the permission is its own, so `remindLead` never syncs. Every
// half minute the day's timeline is read, and anything that begins within
// the lead and has not been said is shown through the service worker, so
// it shows with the tab behind another. What was said is kept per day, so
// a reload does not say it twice.

import { state, dayTimeline, minsNow } from './store.js';
import { today, toMin, fmtTime } from './util.js';

export const LEADS = [0, 5, 10, 15, 30, 60];
const KEY = 'semesterPlanner.reminded';

/** What one entry is known by for the day. */
export const keyOf = (e) => `${e.start}|${e.kind}|${e.id || e.title}`;

/** Of a day's timeline, what begins within `lead` minutes after `now` and was not said. Pure. */
export function dueReminders(list, now, lead, said = new Set()) {
  if (!lead) return [];
  return list.filter((e) => {
    const s = toMin(e.start);
    return s > now && s - now <= lead && !said.has(keyOf(e));
  });
}

function loadSaid() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    return j && j.date === today() ? new Set(j.keys) : new Set();
  } catch { return new Set(); }
}
function saveSaid(set) {
  try { localStorage.setItem(KEY, JSON.stringify({ date: today(), keys: [...set] })); } catch { /* full */ }
}

export const lead = () => Number(state.settings.remindLead) || 0;
export const canNotify = () => typeof Notification !== 'undefined';
export const permission = () => (canNotify() ? Notification.permission : 'unsupported');
/** Ask once, from a click. */
export async function ask() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission;
}

async function show(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const opts = { body, tag, icon: './icons/icon-192.png', badge: './icons/icon-192.png' };
    if (reg?.showNotification) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch (e) { console.warn('remind', e); }
}

/** One look at the clock. Returns what it said. */
export function tick(now = minsNow(), date = today()) {
  const l = lead();
  if (!l || permission() !== 'granted') return [];
  const said = loadSaid();
  const due = dueReminders(dayTimeline(date), now, l, said);
  const hour12 = state.settings.hour12;
  for (const e of due) {
    const inMins = toMin(e.start) - now;
    show(e.title,
      `${inMins <= 1 ? 'In a minute' : `In ${inMins} min`} · ${fmtTime(e.start, hour12)}${e.end ? ' – ' + fmtTime(e.end, hour12) : ''}`,
      keyOf(e));
    said.add(keyOf(e));
  }
  if (due.length) saveSaid(said);
  return due;
}

export function start() {
  try { tick(); } catch { /* pre-boot */ }
  setInterval(() => { try { tick(); } catch (e) { console.warn('remind', e); } }, 30_000);
}
