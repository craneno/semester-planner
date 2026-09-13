// @ts-check
// health.js — the phone's steps, and the habit they tick.
//
// Apple Health is the phone's alone, but a Shortcut can read it and post a
// number: each day's steps go to the health-steps function with a token
// made in Settings, and land in planner_health. This reads them as you,
// once an hour per device, into `state.health` — a mirror, never pushed —
// and ticks the habit picked for it on every day the goal was met. A tick
// is only ever added: a walk counted stays counted.

import { state, commit, habitDone, toggleHabit } from './store.js';
import * as C from './cloud.js';
import { today, addDays } from './util.js';

export const HEALTH_EVERY = 60 * 60 * 1000;
export const DEFAULT_GOAL = 10000;

/** Steps a day that count as the habit done. */
export const stepsGoal = () => Number(state.settings.stepsGoal) || DEFAULT_GOAL;
/** The habit the steps tick, or null with none picked, or one gone. */
export function stepsHabit() {
  const id = state.settings.stepsHabitId;
  return id && state.habits.some((x) => x.id === id && !x.archived) ? id : null;
}

/** An hour since this device last read, or never. */
export function healthDue(now = Date.now()) {
  const at = state.settings.healthAt;
  return !at || !(now - Date.parse(at) < HEALTH_EVERY);
}

/**
 * Fold the days in, in one commit tagged `health`: `state.health[day]`,
 * and the habit ticked where the goal was met on a day that has come.
 * Returns a tally.
 * @param {{ day: string, steps: number|string }[]} rows
 */
export function applyHealth(rows, { now = Date.now(), stamp = true } = {}) {
  const tally = { days: 0, ticked: 0 };
  const goal = stepsGoal(), habit = stepsHabit();
  const till = today();
  commit(() => {
    for (const r of rows) {
      const day = String(r.day || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const steps = Math.max(0, Math.round(Number(r.steps) || 0));
      state.health[day] = steps;
      tally.days++;
      if (habit && steps >= goal && day <= till && !habitDone(day, habit)) {
        toggleHabit(day, habit, true);
        tally.ticked++;
      }
    }
    if (stamp) state.settings.healthAt = new Date(now).toISOString();
  }, { source: 'health' });
  return tally;
}

let inFlight = null;

/** Read the last `days` from the server and fold them in. A second call while one is out joins it. */
export function refreshHealth({ fetch = C.fetchHealth, now = Date.now(), days = 14 } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const rows = await fetch(addDays(today(), -days));
    return applyHealth(rows, { now });
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Once an hour, when signed in. Quiet when it cannot: the steps are not the app's to worry about. */
export function refreshHealthIfDue() {
  if (!C.isSignedIn() || !healthDue()) return null;
  return refreshHealth().catch((e) => console.warn('health', e));
}

/** The latest day with a number, or null. */
export function latestSteps() {
  const days = Object.keys(state.health).sort();
  const day = days[days.length - 1];
  return day ? { day, steps: state.health[day] } : null;
}

/** A number of steps, short: 8,420 → "8.4k". */
export const fmtSteps = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

/** What a table with no rows means. */
export function describeHealthError(err) {
  if (err?.code === '42P01' || /planner_health/.test(String(err?.message || ''))) {
    return 'The steps tables are not there yet: run supabase/upgrade.sql in the Supabase SQL editor.';
  }
  return err?.message || String(err);
}
