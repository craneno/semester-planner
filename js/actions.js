// actions.js — the small edits every screen makes, each with an Undo.
//
// A tick, a move, a push to tomorrow: the views used to call the store
// straight and each one that wanted an Undo grew its own toast. This is the
// one place those live. Every action takes a copy of the row before it
// changes anything, and Undo puts that copy back — through upsertItem, so an
// occurrence's undo lands on the series' exceptions the way its edit did.

import { state, commit, upsertItem, toggleItem, itemById, seriesById, splitOccurrence } from './store.js';
import { pushItem } from './gcal.js';
import { toast } from './ui.js';
import { addDays, today, fmtDate, fmtTime } from './util.js';

/** What an item's when looks like right now, ready to be put back. */
function whenOf(item) {
  return {
    plan: item.plan ? { ...item.plan } : null,
    due: item.due ?? null,
    dueTime: item.dueTime ?? null
  };
}

const send = (id) => pushItem(seriesById(id)?.id || id).catch(() => {});

/**
 * Tick or untick, with a way back. The toast is short — a tick is the most
 * common thing anyone does here and it must not nag — but it is there,
 * because an untick after a mis-tap is the second most common.
 */
export function tickItem(id, on, { after } = {}) {
  // tagged for the panel's checkbox: the view under it lists this row too
  commit(() => toggleItem(id, on), { source: 'editor' });
  send(id);
  after?.();
  const item = itemById(id);
  toast(on ? `Done · ${item?.title || ''}` : 'Not done', {
    ms: 2600,
    action: 'Undo',
    onAction: () => { commit(() => toggleItem(id, !on), { source: 'editor' }); send(id); after?.(); }
  });
}

/**
 * Move a block: a new plan from a drag, or from the editor. The undo puts
 * the old plan back exactly, start and length included.
 */
export function moveItem(id, plan, { after } = {}) {
  const item = itemById(id);
  if (!item) return;
  const before = whenOf(item);
  commit(() => upsertItem({ id, plan: { ...item.plan, ...plan } }));
  send(id);
  after?.();
  const next = itemById(id);
  const to = next?.plan?.start
    ? `${fmtDate(next.plan.date)} ${fmtTime(next.plan.start, state.settings.hour12)}`
    : fmtDate(next?.plan?.date || plan.date);
  toast(`Moved to ${to}`, {
    action: 'Undo',
    onAction: () => { commit(() => upsertItem({ id, ...before })); send(id); after?.(); }
  });
}

/**
 * The day a push lands: today for a thing left behind, tomorrow for one
 * that is today's or has no day yet. What fell behind is wanted now, not
 * the day after; pushing it a day at a time from last week was six taps.
 */
export function pushTarget(item, ref = today()) {
  const when = item?.due || item?.plan?.date || null;
  return when && when < ref ? ref : addDays(ref, 1);
}

/** What the → does to this row, for a title or a label. */
export const pushLabel = (item, ref = today()) => `Push to ${pushTarget(item, ref) === ref ? 'today' : 'tomorrow'}`;

/**
 * Push forward — the most common reschedule, one tap. A planned block keeps
 * its time and length and moves to the day; a deadline moves to it; a thing
 * with no date at all gets tomorrow, all day. See pushTarget for which day.
 */
export function pushForward(id, { after } = {}) {
  const item = itemById(id);
  if (!item) return;
  const before = whenOf(item);
  const day = pushTarget(item);
  let patch;
  if (item.plan?.date) patch = { plan: { ...item.plan, date: day } };
  else if (item.due) patch = { due: day };
  else patch = { plan: { date: day, start: null, mins: 0 }, due: null, dueTime: null };
  commit(() => upsertItem({ id, ...patch }));
  send(id);
  after?.();
  toast(`Pushed to ${day === today() ? 'today' : fmtDate(day, { weekday: true })}`, {
    action: 'Undo',
    onAction: () => { commit(() => upsertItem({ id, ...before })); send(id); after?.(); }
  });
}

/** The old name, kept for a caller that still says it. */
export const pushToTomorrow = pushForward;

/** True for a row a push makes sense on: not done, and not a whole series. */
export const canPush = (item) => !!item && !item.done && !(item.repeat && !splitOccurrence(item.id));
