// tracking.js — where the parcels on the wishlist are, from the carriers.
//
// A wish with a tracking number is asked about on the edge (track-parcel,
// under supabase/functions) as you, since the carriers want keys and send
// no CORS headers. The answer lands on the wish through applyTracking(): the
// ETA follows the carrier's, the row says the hour window and the last scan,
// and a delivered parcel moves itself to Delivered. Once a day per device
// (refreshTrackingIfDue), and whenever asked (refreshTracking).

import { state, commit, applyTracking, failTracking } from './store.js';
import * as C from './cloud.js';

export const TRACK_EVERY = 24 * 60 * 60 * 1000;

/** The wishes with a number and still on their way. */
export const tracked = (s = state) =>
  s.wishlist.filter((w) => w.tracking && w.tracking.number && w.status !== 'delivered');

/** A day since this device last asked, or never. */
export function trackingDue(now = Date.now()) {
  const at = state.settings.trackingAt;
  return !at || !(now - Date.parse(at) < TRACK_EVERY);
}

let inFlight = null;

/**
 * Ask about every tracked parcel — or the one named by `only` — and fold the
 * answers in with one commit, tagged `tracking`, so the page redraws once and
 * it is not an undo step. Each parcel is asked on its own: one carrier being
 * down must not take the others with it, and the row keeps the error. A
 * second call while one is out joins it. Resolves to a tally.
 */
export function refreshTracking({ fetch = C.trackParcel, now = Date.now(), only = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const list = tracked().filter((w) => !only || w.id === only);
    const answers = await Promise.all(list.map(async (w) => {
      try { return { id: w.id, res: await fetch({ carrier: w.tracking.carrier, number: w.tracking.number }) }; }
      catch (err) { return { id: w.id, err }; }
    }));
    const tally = { asked: list.length, moved: 0, delivered: 0, failed: 0 };
    const stamp = new Date(now).toISOString();
    commit(() => {
      for (const a of answers) {
        const w = state.wishlist.find((x) => x.id === a.id);
        if (!w) continue;
        if (a.err) { failTracking(w, a.err.message, stamp); tally.failed++; continue; }
        const what = applyTracking(w, a.res, stamp);
        if (what === 'moved') tally.moved++;
        if (what === 'delivered') tally.delivered++;
      }
      // stamped only when every parcel was asked, so a run for one does not
      // put the daily round off for the rest
      if (!only) state.settings.trackingAt = stamp;
    }, { source: 'tracking' });
    return tally;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Once a day, when signed in and there is something to ask about. */
export async function refreshTrackingIfDue(opts = {}) {
  if (!C.isSignedIn() || !tracked().length || !trackingDue(opts.now)) return null;
  try { return await refreshTracking(opts); }
  catch (err) { console.warn('tracking', err); return null; }
}
