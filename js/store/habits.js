// store/habits.js — daily habits, ticked per day. Takes the state as its
// first argument; store.js binds it to the live one.

import { uid, today, addDays } from '../util.js';

/** Days of an unbroken run before a habit is taken to have stuck. */
export const HABIT_TARGET = 21;

/** Days still to go, or 0 once the run is long enough. */
export const habitRemaining = (s, id, ref = today()) =>
  Math.max(0, HABIT_TARGET - habitStreak(s, id, ref));

export const activeHabits = (s) =>
  s.habits.filter((x) => !x.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export const habitDone = (s, date, id) => (s.habitLog[date] || []).includes(id);

export function toggleHabit(s, date, id, force) {
  const on = force ?? !habitDone(s, date, id);
  const list = s.habitLog[date] || [];
  if (on) { if (!list.includes(id)) s.habitLog[date] = [...list, id]; }
  else {
    const next = list.filter((x) => x !== id);
    if (next.length) s.habitLog[date] = next; else delete s.habitLog[date];
  }
  // the day's clock, so two devices ticking the same day settle by time
  if (s.habitLog[date]) s.habitLogAt[date] = new Date().toISOString();
  else delete s.habitLogAt[date];
  return on;
}

/** Consecutive days ticked, counting back. Today not yet ticked doesn't break
 *  a streak — the day isn't over — but a missed yesterday does. */
export function habitStreak(s, id, ref = today()) {
  let day = habitDone(s, ref, id) ? ref : addDays(ref, -1);
  let n = 0;
  while (habitDone(s, day, id)) { n++; day = addDays(day, -1); }
  return n;
}

export function addHabit(s, name) {
  const habit = {
    id: uid('h'), name: name.trim() || 'Untitled habit',
    order: s.habits.length, archived: false, createdAt: new Date().toISOString()
  };
  s.habits.push(habit);
  return habit;
}

// stamped like every other row, or a rename here loses to any copy elsewhere
export function updateHabit(s, id, patch) {
  const x = s.habits.find((h) => h.id === id);
  if (x) Object.assign(x, patch, { updatedAt: new Date().toISOString() });
  return x;
}

/** Removes the habit and every tick it ever had — there is nothing else to keep. */
export function deleteHabit(s, id) {
  const i = s.habits.findIndex((x) => x.id === id);
  if (i >= 0) s.habits.splice(i, 1);
  const now = new Date().toISOString();
  for (const [date, list] of Object.entries(s.habitLog)) {
    if (!list.includes(id)) continue;
    const next = list.filter((x) => x !== id);
    if (next.length) { s.habitLog[date] = next; s.habitLogAt[date] = now; }
    else { delete s.habitLog[date]; delete s.habitLogAt[date]; }
  }
}

export function reorderHabits(s, orderedIds) {
  const rest = s.habits.filter((x) => !orderedIds.includes(x.id)).map((x) => x.id);
  const now = new Date().toISOString();
  [...orderedIds, ...rest].forEach((id, i) => {
    const x = s.habits.find((h) => h.id === id);
    if (x && x.order !== i) { x.order = i; x.updatedAt = now; }
  });
}
