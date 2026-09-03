// store/wishlist.js — one list, not two. A thing you want and a parcel on its
// way are the same object at different points in its life, so wanting,
// ordering and waiting for something never means retyping it — the status
// moves and the ETA appears. Takes the state as its first argument; store.js
// binds it to the live one.

import { uid, today, diffDays } from '../util.js';
import { WISH_STATUSES } from './constants.js';
import { normalizeUrl } from './urls.js';

/** Ordered, shipped: bought and not here yet. This is what an ETA is for. */
export const WISH_IN_FLIGHT = ['ordered', 'shipped'];
const isInFlight = (w) => WISH_IN_FLIGHT.includes(w.status);

export const wishById = (s, id) => s.wishlist.find((w) => w.id === id) || null;

/** Undated last, so a parcel with no ETA never hides one arriving tomorrow. */
const byEta = (a, b) => (a.eta || '9999-99-99') < (b.eta || '9999-99-99') ? -1
  : (a.eta || '9999-99-99') > (b.eta || '9999-99-99') ? 1
    : a.title.localeCompare(b.title);

export const wishesInFlight = (s) => s.wishlist.filter(isInFlight).sort(byEta);
export const wishesWanted = (s) => s.wishlist.filter((w) => w.status === 'wanted');
export const wishesDelivered = (s) => s.wishlist
  .filter((w) => w.status === 'delivered')
  .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

/** What a set of wishes would cost. Anything unpriced simply does not count. */
export const wishTotal = (list) =>
  list.reduce((n, w) => n + (Number.isFinite(w.price) ? w.price : 0), 0);

/** '' when there is nothing to say: no date, or it has already arrived. */
export function etaState(w, ref = today()) {
  if (!w.eta || w.status === 'delivered') return '';
  if (w.eta < ref) return 'late';
  if (w.eta === ref) return 'today';
  return diffDays(ref, w.eta) <= 2 ? 'soon' : '';
}

/**
 * "Nozzle heater $48.50 mcmaster.com/1234" — a price and a link can be typed
 * in any order, and whatever is left is the name. The same one-line habit as
 * quick add rather than a form with four boxes.
 */
export function parseWishAdd(input) {
  let text = ' ' + String(input || '').trim() + ' ';
  let url = null, price = null;

  for (const word of text.split(/\s+/)) {
    if (url || !word) continue;
    const href = /^(?:https?:\/\/|www\.)/i.test(word) ? normalizeUrl(word) : null;
    if (href) { url = href; text = text.replace(word, ' '); }
  }
  // a bare domain only counts once nothing else has claimed a link, or
  // "3.5in fan" would read the version number as a host
  if (!url) {
    const bare = text.split(/\s+/).find((w) => /\.[a-z]{2,}(?:[/?#]|$)/i.test(w) && normalizeUrl(w));
    if (bare) { url = normalizeUrl(bare); text = text.replace(bare, ' '); }
  }

  const pm = text.match(/\s\$\s?(\d+(?:\.\d{1,2})?)\b/);
  if (pm) { price = Number(pm[1]); text = text.replace(pm[0], ' '); }

  return {
    title: text.replace(/\s+/g, ' ').trim() || 'Untitled',
    url,
    price
  };
}

export function addWish(s, input, { status = 'wanted' } = {}) {
  // Check the raw line, not the parsed title: parseWishAdd falls back to
  // "Untitled" so that "$40" still records something, which would otherwise
  // let a line of pure whitespace through as a real row.
  if (typeof input === 'string' && !input.trim()) return null;
  const parsed = typeof input === 'string' ? parseWishAdd(input) : input;
  if (!parsed || !String(parsed.title || '').trim()) return null;
  const now = new Date().toISOString();
  const wish = {
    id: uid('w'),
    title: String(parsed.title).trim(),
    url: parsed.url ? normalizeUrl(parsed.url) : null,
    price: Number.isFinite(parsed.price) ? parsed.price : null,
    status: WISH_STATUSES.includes(status) ? status : 'wanted',
    eta: parsed.eta || null,
    createdAt: now,
    updatedAt: now
  };
  s.wishlist.unshift(wish);
  return wish;
}

export function updateWish(s, id, patch) {
  const w = wishById(s, id);
  if (!w) return null;
  const next = { ...patch };
  if (next.title !== undefined) next.title = String(next.title).trim() || w.title;
  if (next.url !== undefined) next.url = next.url ? normalizeUrl(next.url) : null;
  if (next.price !== undefined) {
    if (next.price === '' || next.price === null) {
      next.price = null;                  // cleared on purpose
    } else {
      const n = Number(next.price);
      // nonsense leaves what was there; dropping the key is not the same as
      // setting it to null, which is what "cleared" means one line up
      if (Number.isFinite(n)) next.price = n; else delete next.price;
    }
  }
  if (next.status !== undefined && !WISH_STATUSES.includes(next.status)) delete next.status;
  // an ETA is a promise about a parcel; once it is here the date is history
  if (next.status === 'delivered') next.eta = null;
  Object.assign(w, next, { updatedAt: new Date().toISOString() });
  return w;
}

export function deleteWish(s, id) {
  const i = s.wishlist.findIndex((w) => w.id === id);
  if (i >= 0) s.wishlist.splice(i, 1);
}
