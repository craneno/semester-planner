// store/areas.js — where an area is found. Selectors only; the edits stay in
// store.js. Every function takes the state as its first argument and owns
// none of its own, so store.js can bind them to the one live state and a test
// can hand them any plain object.

import { CATEGORY_IDS } from './constants.js';

export const areaById = (s, id) => s.areas.find((a) => a.id === id) || null;
export const areaColor = (s, id) => (areaById(s, id) || {}).color || 'var(--muted)';
export const areaName = (s, id) => (areaById(s, id) || {}).name || 'Unassigned';

/** Areas filed under one category, active first unless archived is asked for. */
export function areasInCategory(s, categoryId, { includeArchived = false } = {}) {
  return s.areas
    .filter((a) => a.category === categoryId && (includeArchived || !a.archived))
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
}

/**
 * The areas the semester chart draws, in the order they appear on it: by
 * category, then by the order they were dragged into. Not every area belongs
 * on a chart — a pile of errands has no shape over fifteen weeks — so an area
 * can sit this one out without being archived.
 */
export function chartAreas(s) {
  return CATEGORY_IDS.flatMap((c) => areasInCategory(s, c).filter((a) => a.onChart !== false));
}

/** Where an item goes when nothing else is said: the Personal area, if there
 *  is one. Falls back to unassigned rather than inventing an area. */
export const defaultAreaId = (s) => areasInCategory(s, 'personal')[0]?.id || null;
