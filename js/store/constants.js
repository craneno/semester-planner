// store/constants.js — the names every part of the store agrees on.
// Pure: no state, no DOM, safe to import from anywhere.

export const SCHEMA_VERSION = 20;

/* Every area belongs to exactly one category. These are the sidebar's top
   level and the only grouping there is — add one here and it appears in the
   nav, on the overview breakdown, and as a filter, with no other change. */
export const AREA_CATEGORIES = [
  { id: 'course', label: 'Courses', singular: 'course' },
  { id: 'project', label: 'Projects', singular: 'project' },
  { id: 'personal', label: 'Personal', singular: 'personal area' }
];
export const CATEGORY_IDS = AREA_CATEGORIES.map((c) => c.id);
export const categoryById = (id) => AREA_CATEGORIES.find((c) => c.id === id) || null;

/** Schema 4 and earlier filed areas under a free-form `kind`. */
const KIND_TO_CATEGORY = {
  course: 'course', personal: 'personal',
  research: 'project', thesis: 'project', work: 'project', applications: 'project'
};

/** Categories folded into another one. NER stopped being a heading of its own
 *  in schema 11 — an NER subteam is a project like any other. Unlike a seed
 *  this is not pinned to a version: a category that no longer exists has to be
 *  translated every time it is read, not once. */
const MERGED_CATEGORY = { ner: 'project' };

export const areaCategory = (a) => {
  const c = MERGED_CATEGORY[a.category] || a.category;
  return CATEGORY_IDS.includes(c) ? c : (KIND_TO_CATEGORY[a.kind || a.type] || 'course');
};

/* Four kinds of thing, not eleven. An event or a meeting happens at a time;
   homework and a task are owed by a time. */
export const ITEM_TYPES = ['event', 'task', 'meeting', 'homework'];

/** Schema 7 and earlier had eleven types. */
export const LEGACY_TYPE = {
  assignment: 'homework', reading: 'homework', paper: 'homework', writing: 'homework',
  exam: 'event', quiz: 'event', presentation: 'event',
  meeting: 'meeting',
  admin: 'task', personal: 'task', research: 'task'
};

/* A thing you want and a parcel on its way are one object at two points in its
   life. */
export const WISH_STATUSES = ['wanted', 'ordered', 'shipped', 'delivered'];

/* Two ways to block out a stretch of the term on the chart. A focus is the
   theme of a few weeks and carries nothing but its name; a sprint is a work
   package and carries the deliverables that say when it is finished. The
   difference is deliberate: making every band demand deliverables would mean
   inventing them, and an invented deliverable is worse than none. */
export const SPRINT_KINDS = ['focus', 'sprint'];

export const AREA_COLORS = [
  '#3C6E8F', '#7A5C9E', '#2F7D62', '#B4713C', '#9E4A5C',
  '#4B6BA8', '#7E7A2E', '#5A6572', '#A0522D', '#3F7A7A'
];
