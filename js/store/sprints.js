// store/sprints.js — a stretch of the term, swept out on the chart. Both kinds
// are the same object; `kind` decides whether the deliverables are asked for
// and drawn. Takes the state as its first argument; store.js binds it to the
// live one.

import { uid, today } from '../util.js';
import { SPRINT_KINDS } from './constants.js';

export const sprintById = (s, id) => s.sprints.find((p) => p.id === id) || null;

export const sprintsForArea = (s, areaId) =>
  s.sprints.filter((p) => p.areaId === areaId)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

/** Deliverables ticked off, 0–1. A focus has none, and reports nothing. */
export function sprintProgress(p) {
  const list = p.deliverables || [];
  if (!list.length) return null;
  return list.filter((d) => d.done).length / list.length;
}

export function upsertSprint(s, patch) {
  const now = new Date().toISOString();
  let p = patch.id ? sprintById(s, patch.id) : null;
  if (p) Object.assign(p, patch, { updatedAt: now });
  else {
    p = {
      id: uid('s'), areaId: null, kind: 'focus', title: 'Untitled',
      start: today(), end: today(), deliverables: [], notes: '',
      createdAt: now, updatedAt: now, ...patch
    };
    s.sprints.push(p);
  }
  if (p.start > p.end) { const x = p.start; p.start = p.end; p.end = x; }
  if (!SPRINT_KINDS.includes(p.kind)) p.kind = 'focus';
  return p;
}

export function deleteSprint(s, id) {
  const i = s.sprints.findIndex((p) => p.id === id);
  if (i >= 0) s.sprints.splice(i, 1);
}

export function addDeliverable(s, sprintId, text) {
  const p = sprintById(s, sprintId);
  if (!p || !String(text).trim()) return null;
  const d = { id: uid('d'), text: String(text).trim(), done: false };
  p.deliverables.push(d);
  p.updatedAt = new Date().toISOString();
  return d;
}

export function updateDeliverable(s, sprintId, id, patch) {
  const d = sprintById(s, sprintId)?.deliverables.find((x) => x.id === id);
  if (!d) return null;
  Object.assign(d, patch);
  sprintById(s, sprintId).updatedAt = new Date().toISOString();
  return d;
}

export function deleteDeliverable(s, sprintId, id) {
  const p = sprintById(s, sprintId);
  if (!p) return;
  p.deliverables = p.deliverables.filter((d) => d.id !== id);
  p.updatedAt = new Date().toISOString();
}
