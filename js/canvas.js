// canvas.js — assignments from a Canvas calendar feed.
//
// Canvas gives every student an .ics feed of what is due. Read it, and each
// assignment becomes a deadline in the right course. The parser is plain
// text work with no state in it; the import is the only part that writes.
//
// The feed comes in two ways. As a file, which needs nothing stored anywhere.
// Or by itself: Instructure sends no CORS headers, so a page here cannot read
// the feed URL, and the URL carries a per-user token — so the link is kept in
// one row on the server and the canvas-feed Edge Function reads Canvas for
// us, once a day per device (refreshIfDue) and whenever asked (refreshFeed).

import { state, commit, upsertItem, areaById } from './store.js';
import * as C from './cloud.js';

/* ---------------- the text ---------------- */

/** Long lines are folded onto the next with a leading space; put them back. */
const unfold = (text) => text.replace(/\r?\n[ \t]/g, '');

const unescapeText = (s) => s
  .replace(/\\n/gi, '\n')
  .replace(/\\,/g, ',')
  .replace(/\\;/g, ';')
  .replace(/\\\\/g, '\\');

const pad = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * One DTSTART/DTEND value to {date, time}. Three shapes come up:
 *   VALUE=DATE:20260915          a whole day
 *   20260915T235959Z             UTC, converted to the clock here
 *   TZID=...:20260915T235959     a wall clock in a named zone; taken as read,
 *                                which is right when the zone is this one
 */
export function icsWhen(value, params = {}) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (params.VALUE === 'DATE' || hh === undefined) return { date: `${y}-${mo}-${d}`, time: null };
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)));
    return { date: localYmd(dt), time: localHm(dt) };
  }
  return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
}

/** Every VEVENT in the feed, as plain objects. Nothing is filtered here. */
export function parseIcs(text) {
  const lines = unfold(String(text || '')).split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...paramBits] = head.split(';');
    const params = {};
    for (const p of paramBits) { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = v; }
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'URL': cur.url = value; break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DTSTART': cur.start = icsWhen(value, params); break;
      case 'DTEND': cur.end = icsWhen(value, params); break;
      case 'LAST-MODIFIED': cur.modified = value; break;
      default: break;
    }
  }
  return out;
}

/* ---------------- what an assignment is ---------------- */

/** Canvas writes "Problem Set 3 [ME 2340 Thermodynamics]". Split it. */
export function splitSummary(summary) {
  const m = String(summary || '').match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1].trim() || m[2].trim(), course: m[2].trim() } : { title: String(summary || '').trim(), course: '' };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Which area a course string belongs to. The area's whole name inside the
 * course string wins; failing that, every word of the area name found in it
 * — every word, "EE" included, or "EE lab" would claim any lab there is.
 * Longest match first, so "EE lab" does not take what "Electrical
 * Engineering" should. Null when nothing fits: the row then lands in the
 * default area like anything else made with no home, and is named in the
 * result so it can be moved.
 */
export function matchArea(course, areas = state.areas) {
  const c = ' ' + norm(course) + ' ';
  if (!c.trim()) return null;
  const live = areas.filter((a) => !a.archived);
  const byLen = [...live].sort((a, b) => b.name.length - a.name.length);
  for (const a of byLen) {
    const n = norm(a.name);
    if (n && c.includes(' ' + n + ' ')) return a.id;
  }
  for (const a of byLen) {
    const words = norm(a.name).split(' ').filter((w) => w.length >= 2);
    if (words.length && words.every((w) => c.includes(' ' + w + ' '))) return a.id;
  }
  return null;
}

/** Only what is due. Lectures and office hours come from Google already. */
export const isAssignment = (ev) => /assignment/i.test(ev.uid || '');

/* ---------------- the import ---------------- */

/**
 * Bring a feed in. An assignment seen before (by `canvasId`) has its date and
 * title refreshed; one never seen becomes a homework deadline. What a person
 * has set by hand — the area, the notes, a tick — is left alone.
 *
 * @returns {{added:number, updated:number, unfiled:string[], skipped:number}}
 */
export function importCanvas(text, meta) {
  let res;
  commit(() => { res = applyFeed(text); }, meta);
  return res;
}

/** The import itself, inside whatever commit the caller is in. */
function applyFeed(text) {
  const events = parseIcs(text);
  const res = { added: 0, updated: 0, unfiled: [], skipped: 0 };
  const seen = new Set();

  {
    for (const ev of events) {
      if (!isAssignment(ev) || !ev.start || !ev.uid) { res.skipped++; continue; }
      if (seen.has(ev.uid)) continue;
      seen.add(ev.uid);

      const { title, course } = splitSummary(ev.summary);
      const existing = state.items.find((t) => t.canvasId === ev.uid);
      const when = { due: ev.start.date, dueTime: ev.start.time, plan: null };

      if (existing) {
        upsertItem({ id: existing.id, title, ...when });
        res.updated++;
        continue;
      }

      const areaId = matchArea(course);
      const notes = [ev.description?.trim(), ev.url].filter(Boolean).join('\n\n');
      upsertItem({
        title, type: 'homework', canvasId: ev.uid, areaId,
        notes, ...when
      });
      res.added++;
      if (!areaId || !areaById(areaId)) res.unfiled.push(course ? `${title} — ${course}` : title);
    }
  }
  return res;
}

/* ---------------- by itself ---------------- */

export const FEED_EVERY = 24 * 60 * 60 * 1000;

/** Only a Canvas feed link is worth saving: https, on a Canvas host. The function checks the same. */
export function isFeedUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host.endsWith('.instructure.com') || host.startsWith('canvas.') || host.includes('.canvas.');
}

/** A day since this device last brought the feed in, or never. */
export function feedDue(now = Date.now()) {
  const at = state.settings.canvasFeedAt;
  return !at || !(now - Date.parse(at) < FEED_EVERY);
}

let inFlight = null;

/**
 * Fetch the feed and bring it in: one commit, tagged `canvas`, so the page
 * redraws once and it is not an undo step. Resolves to the import's result,
 * or null when no link is saved. A second call while one is out joins it.
 */
export function refreshFeed({ fetch = C.fetchFeed, now = Date.now() } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const text = await fetch();
    let res = null;
    commit(() => {
      if (text != null) res = applyFeed(text);
      state.settings.canvasFeedAt = new Date(now).toISOString();
    }, { source: 'canvas' });
    return res;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Once a day, when signed in. A failure is logged and nothing is stamped, so the next open tries again. */
export async function refreshIfDue(opts = {}) {
  if (!C.isSignedIn() || !feedDue(opts.now)) return null;
  try { return await refreshFeed(opts); }
  catch (err) { console.warn('canvas feed', err); return null; }
}
