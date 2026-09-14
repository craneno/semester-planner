// app.js — shell, router, quick add.

import { h, $, clear, fmtDate, fmtTime, today, debounce, zoneLabel, fmtDuration } from './util.js';
import {
  state, commit, subscribe, parseQuickAdd, upsertItem, nowNext, doneBefore, sweepDone,
  AREA_CATEGORIES, CATEGORY_IDS, categoryById, areasInCategory, areaById,
  reorderAreas, parseLinkAdd, addLink, scheduleDrift, shiftSchedules, stampSchedules,
  areaForNew
} from './store.js';
import { toast, closePeek, peekOpen, reorderable, modal, closeModal } from './ui.js';
import { applyAppearance } from './appearance.js';
import { openItem } from './editor.js';
import { wireKeys } from './keys.js';
import { wireNavSwipe } from './swipe.js';
import { renderOverview } from './views/overview.js';
import { renderSemester } from './views/semester.js';
import { renderWeek, showWeekOf, weekAnchor } from './views/week.js';
import { renderMiniMonth } from './minimonth.js';
import { renderCategory, renderArea } from './views/areas.js';
import { renderHabits } from './views/habits.js';
import { renderWishlist } from './views/wishlist.js';
import { renderSettings } from './views/settings.js';
import * as G from './gcal.js';
import * as R from './remind.js';
import { refreshHealthIfDue } from './health.js';
import * as C from './cloud.js';
import { refreshIfDue } from './canvas.js';
import { refreshTrackingIfDue } from './tracking.js';
import { warn, watchWindow } from './problems.js';

/* Plain views. Categories and single areas are routed separately — they are
   data, not screens, so they cannot be listed here. */
const VIEWS = {
  overview: { label: 'Overview', glyph: '◲', render: renderOverview, title: () => state.semester.name },
  semester: { label: 'Semester', glyph: '☰', render: renderSemester, title: () => 'Semester' },
  week:     { label: 'Week',     glyph: '▦', render: renderWeek,     title: () => 'Week', bare: true },
  habits:   { label: 'Habits',   glyph: '◴', render: renderHabits,   title: () => 'Habits' },
  wishlist: { label: 'Wishlist', glyph: '✦', render: renderWishlist, title: () => 'Wishlist' },
  settings: { label: 'Settings', glyph: '⚙', render: renderSettings, title: () => 'Settings' }
};

const TOP_VIEWS = ['overview', 'semester', 'week'];

/* A view pinned inside a category's group in the sidebar. Habits are personal
   but they are not an area — there is no work in them and nothing is ever due
   — so they sit under Personal as a link to their own page rather than as a
   fake row in state.areas. */
const CATEGORY_PINS = {
  personal: [
    { view: 'habits', label: 'Habits', glyph: '◴' },
    { view: 'wishlist', label: 'Wishlist', glyph: '✦' }
  ]
};
const MOBILE_TABS = ['overview', 'week', 'semester', 'course', 'personal'];
const CATEGORY_GLYPH = { course: '◇', project: '▲', personal: '○' };

/** { kind: 'view'|'category'|'area', id } — what the hash currently points at. */
let current = { kind: 'view', id: 'overview' };

/* ---------------- routing ---------------- */

function route() {
  const raw = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const [head, param] = raw.split('/');
  if (head === 'area' && param && areaById(param)) return { kind: 'area', id: param };
  if (CATEGORY_IDS.includes(head)) return { kind: 'category', id: head };
  return { kind: 'view', id: VIEWS[head] ? head : 'overview' };
}

export function go(key) {
  if (location.hash === '#/' + key) navigate();
  else location.hash = '#/' + key;
}

const isCurrent = (kind, id) => current.kind === kind && current.id === id;

/* A redraw under a finger that is dragging the menu replaces the node the
   touch began on, and the browser sends no more of that touch to a node that
   is gone — the menu was left stuck halfway. So a redraw waits for the
   finger to lift; settle() runs the one that was held. */
let redrawHeld = false;
export function navigate() {
  if (document.body.classList.contains('nav-dragging')) { redrawHeld = true; return; }
  sweep();
  current = route();
  // an area deleted while its page was open: the hash still named it, so
  // Overview drew under a lying address and go('overview') did nothing
  if (current.kind === 'view' && /^#\/area\//.test(location.hash)) history.replaceState(null, '', '#/' + current.id);
  // the page you are on is where a new thing goes next (settings are not undo's, and this key never syncs)
  if (current.kind === 'area' && state.settings.lastAreaId !== current.id) commit(() => { state.settings.lastAreaId = current.id; });
  paintChrome();
  const host = $('#view');
  const view = current.kind === 'view' ? VIEWS[current.id] : null;
  host.classList.toggle('bare', !!view?.bare);
  clear(host);

  const ctx = { navigate, go };
  try {
    if (current.kind === 'category') renderCategory(host, ctx, current.id);
    else if (current.kind === 'area') renderArea(host, ctx, current.id);
    else view.render(host, ctx);
  } catch (err) {
    // one page broken is one page, not the app: say so, and leave a way out
    warn('view', err);
    clear(host);
    host.append(h('div', { class: 'pad' },
      h('div', { class: 'empty' },
        h('h3', {}, 'This page hit a problem'),
        h('p', { class: 'help', style: { margin: '4px 0 12px' } }, `${err?.message || err} — your data is not touched.`),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
          h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'),
          h('button', { class: 'btn ghost', onclick: () => go('overview') }, 'Overview')))));
  }

  document.title = `${pageTitle()} · Semester Planner`;
}

function pageTitle() {
  if (current.kind === 'category') return categoryById(current.id).label;
  if (current.kind === 'area') return areaById(current.id)?.name || 'Area';
  return VIEWS[current.id].title();
}

/* The editor commits a word at a time (its boxes debounce 400ms), tagged
   `editor`, and each one rebuilt the whole page under the panel: a title
   typed slowly on a phone was a redraw a word. Held while the panel is open,
   drawn once it has been quiet for REDRAW_HOLD_MS, or the moment it closes.
   The page under the panel is a second behind the panel; nothing else waits. */
export const REDRAW_HOLD_MS = 1000;
// the sources a commit is redrawn for; a view's own edits repaint themselves
const REDRAWS = new Set(['gcal', 'cloud', 'editor', 'restore', 'undo', 'redo', 'canvas', 'tracking', 'health']);
let heldRedraw = 0;
const redrawNow = () => { clearTimeout(heldRedraw); heldRedraw = 0; navigate(); };
window.addEventListener('planner:peek-closed', () => { if (heldRedraw) redrawNow(); });

window.addEventListener('hashchange', () => { clearTimeout(heldRedraw); heldRedraw = 0; closePeek(); navigate(); });

/* ---------------- chrome ---------------- */

/* One place decides whether the menu is showing: the sidebar's own class draws
   it, and the body class is what puts the scrim behind it. */
function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  document.body.classList.toggle('nav-open', open);
}
const closeSidebar = () => setSidebar(false);
const sidebarOpen = () => $('#sidebar').classList.contains('open');

function navButton({ glyph, label, current: isOn, onclick, key }) {
  return h('button', {
    class: 'nav-item',
    'aria-current': isOn ? 'page' : null,
    onclick: () => { onclick(); closeSidebar(); }
  },
  glyph ? h('span', { class: 'nav-glyph' }, glyph) : null,
  h('span', { class: 'nav-label' }, label),
  key ? h('span', { class: 'key' }, key) : null);
}

function paintChrome() {
  const rail = $('#rail');
  clear(rail);

  TOP_VIEWS.forEach((key, i) => {
    const v = VIEWS[key];
    rail.append(navButton({
      glyph: v.glyph, label: v.label, key: String(i + 1),
      current: isCurrent('view', key), onclick: () => go(key)
    }));
  });

  // each category, with its areas nested underneath
  for (const cat of AREA_CATEGORIES) {
    const caret = h('button', {
      class: 'rail-caret', 'aria-label': `Show or hide ${cat.label}`,
      onclick: (e) => {
        e.stopPropagation();          // the row itself navigates; the caret must not
        commit(() => {
          const map = state.settings.railClosed || (state.settings.railClosed = {});
          map[cat.id] = !map[cat.id];
        });
        paintChrome();
      }
    }, '›');

    const row = navButton({
      glyph: CATEGORY_GLYPH[cat.id], label: cat.label,
      current: isCurrent('category', cat.id), onclick: () => go(cat.id)
    });
    // the caret goes after the label, not before it: a category is a top-level
    // row like Overview or Week and has to start at the same left edge, so
    // nothing may sit in front of its glyph. Only its areas are indented.
    // An empty category gets none: there is nothing under it to fold.
    const areas = areasInCategory(cat.id);
    const pins = CATEGORY_PINS[cat.id] || [];
    if (areas.length || pins.length) row.append(caret);
    rail.append(row);
    if (!areas.length && !pins.length) continue;

    const closed = !!state.settings.railClosed?.[cat.id];
    caret.classList.toggle('is-closed', closed);
    caret.setAttribute('aria-expanded', String(!closed));
    if (closed) continue;

    const host = h('div', { class: 'rail-areas' });
    for (const a of areas) {
      const open = state.items.filter((t) => t.areaId === a.id && !t.done).length;
      host.append(h('div', {
        class: 'area-chip' + (isCurrent('area', a.id) ? ' is-current' : ''),
        dataset: { reorderId: a.id }
      },
      h('span', { class: 'drag-handle', 'aria-label': `Reorder ${a.name}` }, '⠿'),
      h('button', {
        class: 'area-chip-open',
        'aria-current': isCurrent('area', a.id) ? 'page' : null,
        onclick: () => { go(`area/${a.id}`); closeSidebar(); }
      },
      h('span', { class: 'dot', style: { background: a.color } }),
      h('span', { class: 'nav-label' }, a.name),
      open ? h('span', { class: 'count eyebrow num' }, String(open)) : null)));
    }
    rail.append(host);
    reorderable(host, {
      handle: '.drag-handle',
      onDrop: (ids) => { commit(() => reorderAreas(cat.id, ids)); navigate(); }
    });

    // pinned views sit outside the reorderable host: they have no reorderId,
    // and a drop that included them would have nowhere to write the order
    if (pins.length) {
      const pinHost = h('div', { class: 'rail-areas' });
      for (const p of pins) {
        pinHost.append(h('div', { class: 'area-chip is-pin' },
          h('button', {
            class: 'area-chip-open',
            'aria-current': isCurrent('view', p.view) ? 'page' : null,
            onclick: () => { go(p.view); closeSidebar(); }
          },
          h('span', { class: 'pin-glyph' }, p.glyph),
          h('span', { class: 'nav-label' }, p.label))));
      }
      rail.append(pinHost);
    }
  }

  rail.append(h('div', { style: { marginTop: '10px' } }, navButton({
    glyph: '⚙', label: 'Settings',
    current: isCurrent('view', 'settings'), onclick: () => go('settings')
  })));

  // the month, small, under the views: a day opens its week
  renderMiniMonth($('#mini-month'), {
    shown: isCurrent('view', 'week') ? weekAnchor() : null,
    onPick: (day) => { showWeekOf(day); go('week'); closeSidebar(); }
  });

  paintNextUp();

  // mobile tabs — plain views and categories side by side
  const tabs = $('#tabbar');
  clear(tabs);
  for (const key of MOBILE_TABS) {
    const cat = categoryById(key);
    const label = cat ? cat.label : VIEWS[key].label;
    const glyph = cat ? CATEGORY_GLYPH[key] : VIEWS[key].glyph;
    tabs.append(h('button', {
      'aria-current': isCurrent(cat ? 'category' : 'view', key) ? 'page' : null,
      onclick: () => go(key)
    }, h('span', { class: 'glyph' }, glyph), label));
  }

  $('#view-title').textContent = pageTitle();
  paintSync();
}

/* ---------------- the day reset ----------------
   Everything ticked on a day that has ended is deleted, and the morning starts
   with what is left. Run before the view is built rather than from inside one,
   so no screen renders a task that is about to disappear from under it.

   Checked rather than committed: `doneBefore()` is a filter, and committing on
   every navigation would stamp and sync rows on a day when nothing was
   finished at all. */

/* An undone sweep has to stay undone: putting a task back is a commit, a
   commit re-renders, and a render sweeps — so without this the task would
   vanish again on the way back. Ids only, for this session, emptied at the
   reset that ends the day they were spared from. */
const spared = new Set();

function sweep() {
  const due = doneBefore(today(), spared);
  if (!due.length) return;
  // their Google events go too; queued now, while the rows still hold the ids
  for (const t of due) G.forgetItem(t);
  let gone = [];
  // not a source app.js re-renders for — navigate() is already on its way
  commit(() => { gone = sweepDone(today(), spared); }, { source: 'sweep' });
  toast(`Cleared ${gone.length} finished ${gone.length === 1 ? 'task' : 'tasks'}`, {
    action: 'Undo',
    onAction: () => commit(() => {
      // stamped now, or the server keeps the tombstone and the next sync sweeps them again
      const now = new Date().toISOString();
      for (const t of gone) { spared.add(t.id); t.updatedAt = now; }
      state.items.push(...gone);
    }, { source: 'editor' })
  });
}

/* ---------------- what's on now ----------------
   The one thing the topbar says about today, on every screen: what you are in
   the middle of, or what is coming. Small, and never a count of anything. */

function paintNextUp() {
  const host = $('#nextup');
  if (!host) return;
  const up = nowNext();
  clear(host);
  if (!up) {
    host.classList.remove('is-live');
    host.append(h('span', { class: 'nextup-t' }, 'No scheduled events today'));
    return;
  }
  host.classList.toggle('is-live', up.live);
  host.append(
    h('span', { class: 'eyebrow' }, up.live ? 'Now' : 'Next'),
    h('span', { class: 'nextup-t', title: up.title }, up.title),
    h('span', { class: 'eyebrow num' }, fmtTime(up.start, state.settings.hour12)));
}

/** A clock the page has no other reason to keep: "Now" stops being true on its
 *  own, with nothing committed and no render to hang the repaint off — and so
 *  does the day itself, on a tab left open past 3am. */
/* The calendars measure themselves in CSS pixels read from the stylesheet, and
   the stylesheet gives an hour a different height on a phone. Crossing the
   breakpoint — a rotation, usually — has to redraw them, or every block keeps
   the geometry of the layout it was born in. */
matchMedia('(max-width: 860px)').addEventListener('change', () => {
  try { navigate(); } catch { /* pre-boot */ }
});

let shownDay = today();
setInterval(() => {
  try {
    paintNextUp();
    if (today() === shownDay) return;
    shownDay = today();
    spared.clear();    // yesterday's reprieve does not carry into today
    navigate();        // sweeps, then redraws the new day
  } catch { /* pre-boot */ }
}, 30_000);

function paintStrip(sel, status, labels) {
  const strip = $(sel);
  if (!strip) return;
  strip.querySelector('.sync-led').dataset.s = status;
  strip.querySelector('.sync-label').textContent = labels[status] || labels.off;
}

function paintSync() {
  const g = state.settings.gcal;
  paintStrip('#sync', G.gcal.status, {
    off: 'Connect Google Calendar',
    'signed-out': 'Sign in to Google',
    connecting: 'Connecting…',
    ready: g.lastSync ? 'Calendar synced' : 'Calendar connected',
    syncing: 'Syncing…',
    error: 'Calendar problem — open Settings',
    offline: 'Offline · queued',
    waiting: 'Calendar paused · sending soon'
  });

  const c = state.settings.cloud;
  paintStrip('#cloudsync', C.cloud.status, {
    off: 'Set up cloud sync',
    'signed-out': 'Sign in to sync devices',
    connecting: 'Connecting…',
    ready: (C.cloud.live ? 'Cloud live' : 'Cloud synced')
      + (c.lastSync ? ' · ' + new Date(c.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''),
    syncing: 'Syncing…',
    error: 'Cloud problem — open Settings',
    offline: 'Offline · queued'
  });
}

G.onGcal(() => { try { paintSync(); } catch { /* pre-boot */ } });
C.onCloud(() => { try { paintSync(); } catch { /* pre-boot */ } });

/* ---------------- quick add ---------------- */

function wireQuickAdd() {
  const input = $('#quickadd-input');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;

    // A line that starts with a URL is a bookmark, not something to do.
    const link = parseLinkAdd(input.value);
    if (link) {
      let made;
      commit(() => { made = addLink(link.url, { areaId: link.areaId, title: link.title }); });
      input.value = '';
      const home = areaById(link.areaId);
      toast(`Saved to ${home ? home.name : 'Notes'} · ${made.title}`, {
        action: 'Open',
        onAction: () => go(home ? `area/${home.id}` : 'overview')
      });
      navigate();
      return;
    }

    const parsed = parseQuickAdd(input.value);
    if (!parsed.areaId) parsed.areaId = areaForNew();
    let created;
    commit(() => { created = upsertItem(parsed); state.settings.lastAreaId = created.areaId; });
    // a block typed here is a block like any other, and belongs on the
    // calendar as soon as it exists rather than whenever something else pushes
    if (parsed.plan?.date) G.pushItem(created.id).catch(() => {});
    input.value = '';
    const bits = [];
    if (parsed.due) bits.push('due ' + fmtDate(parsed.due));
    if (parsed.plan?.date) {
      bits.push((parsed.plan.start ? 'planned ' : 'all day ') + fmtDate(parsed.plan.date));
    }
    toast(`Added${bits.length ? ' · ' + bits.join(' · ') : ''}`, { action: 'Open', onAction: () => openItem(created.id) });
    navigate();
  });
}

const showDay = (date) => { showWeekOf(date); go('week'); };

/* ---------------- opened somewhere else ----------------
   A schedule imported in one zone and read in another is silently wrong by
   the difference — the lecture that says 7:30 met at 10:30. The times cannot
   be moved without asking: a week away is not a move, and a shift applied
   twice is worse than one never applied. So it is a question, once, and the
   answer is written into the rows themselves rather than kept here, which is
   what stops the next device asking it again. */

function askAboutZone() {
  const drift = scheduleDrift();
  if (!drift) return;
  const later = drift.mins > 0;
  const by = fmtDuration(Math.abs(drift.mins));
  const way = later ? 'later' : 'earlier';
  const shift = () => {
    commit(() => { shiftSchedules(drift.from); }, { source: 'zone' });
    navigate();
    toast(`Class times moved ${by} ${way}.`, {
      action: 'Undo',
      onAction: () => {
        commit(() => { shiftSchedules(drift.to, drift.from); }, { source: 'zone' });
        navigate();
      }
    });
  };
  // "leave them" is an answer, not a dismissal: the rows are restamped where
  // they stand, or the same question would be waiting at the next boot.
  // Closing the dialog without answering is neither, and it asks again.
  const keep = () => commit(() => { stampSchedules(drift.to); }, { source: 'zone' });

  modal({
    title: 'Your clock has moved',
    body: h('div', {},
      h('p', { style: { marginTop: 0 } },
        `These class times were set in ${zoneLabel(drift.from)}, and this device is on `,
        `${zoneLabel(drift.to)} — so every one of them reads ${by} ${later ? 'early' : 'late'}.`),
      h('p', { style: { margin: 0, color: 'var(--ink-2)' } },
        `Move ${drift.rows} meeting time${drift.rows === 1 ? '' : 's'} ${by} ${way}?`)),
    footer: [
      h('button', { class: 'btn', onclick: () => { keep(); closeModal(); } }, 'Leave them'),
      h('button', { class: 'btn primary', onclick: () => { shift(); closeModal(); } },
        `Shift ${by} ${way}`)
    ]
  });
}

/* ---------------- boot ---------------- */

function boot() {
  watchWindow();     // what nothing catches goes to Settings → Problems
  applyAppearance();
  wireQuickAdd();
  wireKeys({ go, navigate, onWeek: () => isCurrent('view', 'week'), views: TOP_VIEWS, showDay });

  $('#menu-btn').addEventListener('click', () => setSidebar(!sidebarOpen()));
  $('#nav-scrim').addEventListener('click', closeSidebar);
  // a redraw that came while the finger was down (see navigate) is drawn once it lifts
  wireNavSwipe({ setSidebar, sidebarOpen, onSettle: () => { if (redrawHeld) { redrawHeld = false; navigate(); } } });

  // collapsing the sidebar: the toggle lives in the topbar, so it is still
  // there to bring it back once the sidebar itself is gone
  const railToggle = $('#rail-toggle');
  const paintRailToggle = () => {
    const hidden = document.body.classList.contains('rail-hidden');
    railToggle.textContent = hidden ? '⟩' : '⟨';
    railToggle.setAttribute('aria-expanded', String(!hidden));
    railToggle.setAttribute('aria-label', hidden ? 'Show sidebar' : 'Hide sidebar');
    railToggle.title = railToggle.getAttribute('aria-label');
  };
  document.body.classList.toggle('rail-hidden', !!state.settings.railHidden);
  paintRailToggle();
  railToggle.addEventListener('click', () => {
    const hidden = document.body.classList.toggle('rail-hidden');
    commit(() => { state.settings.railHidden = hidden; });
    paintRailToggle();
  });
  $('#peek-scrim').addEventListener('click', closePeek);
  $('#sync').addEventListener('click', () => go('settings'));
  $('#cloudsync').addEventListener('click', () => go('settings'));
  $('#sem-name').addEventListener('input', debounce((e) => {
    commit(() => { state.semester.name = e.target.value; });
  }, 400));
  $('#sem-name').value = state.semester.name;

  // re-render on any state change that came from outside this view
  subscribe((meta) => {
    // cheap, and almost anything committed can change what is on next —
    // including a block planned from a panel that must not repaint the view
    paintNextUp();
    // the name box is written once at boot; a rename in Settings, or one
    // synced down, has to reach it — unless it is the box being typed in
    const nameBox = $('#sem-name');
    if (document.activeElement !== nameBox && nameBox.value !== state.semester.name) nameBox.value = state.semester.name;
    if (!(meta?.external || REDRAWS.has(meta?.source))) return;
    if (meta.source === 'editor' && peekOpen()) { clearTimeout(heldRedraw); heldRedraw = setTimeout(redrawNow, REDRAW_HOLD_MS); return; }
    redrawNow();
  });

  navigate();
  R.start();       // a heads-up before things begin, when asked for

  // Google Calendar and Supabase, each only if the user has set it up
  G.start().catch((e) => warn('gcal', e));
  C.start().catch((e) => warn('cloud', e));
  // the Canvas feed, once a day: after any sync that ends well, so a device
  // that has just woken or just signed in gets its turn
  C.onCloud((c) => { if (c.status === 'ready') { refreshIfDue(); refreshTrackingIfDue(); refreshHealthIfDue(); } });

  askAboutZone();

  // service worker
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // A new worker skipWaiting()s and claims this page, but the page is still
    // showing the previous version's files. Reload once when that happens, so
    // a deploy lands on the first visit instead of the second. Guarded on
    // there being an old worker at all: on a first install there is nothing
    // stale to replace, and reloading would be a pointless flash.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch((e) => warn('sw', e));
  }

  window.addEventListener('planner:save-error', () =>
    toast('Storage is full — export a backup and clear some space.'));
}

document.addEventListener('DOMContentLoaded', boot);
