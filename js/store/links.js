// store/links.js — a saved link is a bookmark with a home. Paste one into the
// bar up top and it joins an area's pile instead of becoming a task — the
// tabs you mean to come back to, filed where the work is. Takes the state as
// its first argument; store.js binds it to the live one.

import { uid } from '../util.js';
import { AREA_CATEGORIES } from './constants.js';
import { URL_HEAD, BARE_DOMAIN, normalizeUrl, linkTitleFromUrl } from './urls.js';
import { areaById, areasInCategory, defaultAreaId } from './areas.js';

const firstAreaOfCategory = (s, q) => {
  const cat = AREA_CATEGORIES.find((c) => c.id === q || c.label.toLowerCase() === q);
  return cat ? areasInCategory(s, cat.id)[0] || null : null;
};

/**
 * Resolve "ner", "rocket", "ee lab" to an area. Deliberately loose: it is
 * typed in a hurry after a pasted URL, so a word that starts any part of the
 * name is enough — "ner" has to find "NER Meetings".
 */
export function findAreaByHint(s, hint) {
  const q = String(hint || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  const live = s.areas.filter((a) => !a.archived);
  const norm = (a) => a.name.toLowerCase().replace(/\s+/g, ' ').trim();
  const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

  return live.find((a) => norm(a) === q)
    || live.find((a) => squash(a.name) === squash(q))
    || live.find((a) => norm(a).startsWith(q))
    || live.find((a) => norm(a).split(' ').some((w) => w.startsWith(q)))
    || live.find((a) => norm(a).includes(q))
    || firstAreaOfCategory(s, q)
    || null;
}

/**
 * A quick-add line beginning with a URL is a link, not a task.
 *   "example.com"              -> the default area, title from the URL
 *   "example.com ner"          -> NER Meetings, title from the URL
 *   "example.com read this"    -> the default area, titled "read this"
 * Words that name no area become the title rather than being dropped, so
 * nothing typed is ever silently lost.
 * @returns {{url: string, title: string, areaId: string|null}|null}
 */
export function parseLinkAdd(s, input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const [first, ...rest] = text.split(/\s+/);
  if (!URL_HEAD.test(first) && !BARE_DOMAIN.test(first)) return null;
  const url = normalizeUrl(first);
  if (!url) return null;

  const hint = rest.join(' ').trim();
  const area = hint ? findAreaByHint(s, hint) : null;
  return {
    url,
    title: (hint && !area) ? hint : linkTitleFromUrl(url),
    areaId: (area?.id) ?? defaultAreaId(s)
  };
}

export const linkById = (s, id) => s.links.find((l) => l.id === id) || null;
export const linksForArea = (s, areaId) => s.links.filter((l) => l.areaId === areaId);
/** Links with no home, including ones whose area has since been deleted. */
export const unfiledLinks = (s) => s.links.filter((l) => !l.areaId || !areaById(s, l.areaId));

export function addLink(s, url, { areaId, title } = {}) {
  const href = normalizeUrl(url);
  if (!href) return null;
  const now = new Date().toISOString();
  const link = {
    id: uid('l'),
    url: href,
    title: String(title || '').trim() || linkTitleFromUrl(href),
    areaId: areaId === undefined ? defaultAreaId(s) : areaId,
    createdAt: now,
    updatedAt: now
  };
  s.links.unshift(link);
  return link;
}

export function updateLink(s, id, patch) {
  const l = linkById(s, id);
  if (!l) return null;
  const next = { ...patch };
  if (next.url !== undefined) {
    const href = normalizeUrl(next.url);
    if (href) next.url = href; else delete next.url;    // keep the one that works
  }
  if (next.title !== undefined) next.title = String(next.title).trim() || l.title;
  Object.assign(l, next, { updatedAt: new Date().toISOString() });
  return l;
}

export function deleteLink(s, id) {
  const i = s.links.findIndex((l) => l.id === id);
  if (i >= 0) s.links.splice(i, 1);
}
