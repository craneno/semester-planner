// app.js — shell, router, quick add.

import { h, $, clear, fmtDate, fmtTime, today, debounce, tz, zoneLabel, fmtDuration } from './util.js';
import {
  state, commit, subscribe, parseQuickAdd, upsertItem, nowNext, doneBefore, sweepDone,
  AREA_CATEGORIES, CATEGORY_IDS, categoryById, areasInCategory, areaById,
  reorderAreas, parseLinkAdd, addLink, scheduleDrift, shiftSchedules, stampSchedules,
  undo, redo
} from './store.js';
import { toast, closePeek, reorderable, modal, closeModal, navSlide, navSettle } from './ui.js';
import { applyAppearance } from './appearance.js';
import { openItem } from './editor.js';
import { renderOverview } from './views/overview.js';
import { renderSemester } from './views/semester.js';
import { renderWeek, showWeekOf } from './views/week.js';
import { openSearch } from './search.js';
import { renderCategory, renderArea } from './views/areas.js';
import { renderHabits } from './views/habits.js';
import { renderWishlist } from './views/wishlist.js';
import { renderSettings } from './views/settings.js';
import * as G from './gcal.js';
import * as C from './cloud.js';
import { refreshIfDue } from './canvas.js';

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
  paintChrome();
  const host = $('#view');
  const view = current.kind === 'view' ? VIEWS[current.id] : null;
  host.classList.toggle('bare', !!view?.bare);
  clear(host);

  const ctx = { navigate, go };
  if (current.kind === 'category') renderCategory(host, ctx, current.id);
  else if (current.kind === 'area') renderArea(host, ctx, current.id);
  else view.render(host, ctx);

  document.title = `${pageTitle()} · Semester Planner`;
}

function pageTitle() {
  if (current.kind === 'category') return categoryById(current.id).label;
  if (current.kind === 'area') return areaById(current.id)?.name || 'Area';
  return VIEWS[current.id].title();
}

window.addEventListener('hashchange', () => { closePeek(); navigate(); });

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
    row.append(caret);
    rail.append(row);
    const areas = areasInCategory(cat.id);
    const pins = CATEGORY_PINS[cat.id] || [];
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
  if (!doneBefore(today(), spared).length) return;
  let gone = [];
  // not a source app.js re-renders for — navigate() is already on its way
  commit(() => { gone = sweepDone(today(), spared); }, { source: 'sweep' });
  toast(`Cleared ${gone.length} finished ${gone.length === 1 ? 'task' : 'tasks'}`, {
    action: 'Undo',
    onAction: () => commit(() => {
      for (const t of gone) spared.add(t.id);
      state.items.push(...gone);
    }, { source: 'editor' })
  });
}

/* ---------------- the menu, by thumb ----------------
   Drag in from the left edge to bring the sidebar out, and back to the left to
   put it away. Kept to the edge on purpose: the week grid is a horizontal
   scroller and the tray under it is another, so a swipe that counted anywhere
   on the page would take the gesture away from both. A drag that is mostly
   vertical is a scroll and is let go of at once. */

const EDGE = 26;      // how far in from the left a swipe may start
const SWIPE = 52;     // how far it must travel to count

/* The menu follows the finger. Until the swipe has shown itself to be one
   — sideways, and past a few px — nothing moves, so a scroll down the page
   is still a scroll; after that the sidebar is dragged by the px, with its
   transition off, and the scrim fades in step. On release it settles: past
   halfway, or a flick past SWIPE, and the transition takes it the rest of
   the way. */
function wireNavSwipe() {
  const phone = () => matchMedia('(max-width: 860px)').matches;
  const side = $('#sidebar'), scrim = $('#nav-scrim');
  let x0 = 0, y0 = 0, job = null, live = false, w = 0, dx = 0, stale = null;

  const settle = () => {
    clearTimeout(stale);
    if (job && live) {
      side.classList.remove('dragging');
      document.body.classList.remove('nav-dragging');
      side.style.transform = '';
      scrim.style.opacity = '';
      setSidebar(navSettle(job, dx, w, SWIPE));
    }
    job = null; live = false;
    if (redrawHeld) { redrawHeld = false; navigate(); }
  };
  // the end of a touch can go missing (see navigate), so a menu left
  // mid-way settles on the next touch, or on its own after a moment
  const arm = () => { clearTimeout(stale); stale = setTimeout(settle, 2500); };

  document.addEventListener('touchstart', (e) => {
    if (live) settle();
    job = null; live = false; dx = 0;
    if (!phone() || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (sidebarOpen()) job = 'close';
    else if (t.clientX <= EDGE) job = 'open';
    else return;
    x0 = t.clientX; y0 = t.clientY;
    w = side.getBoundingClientRect().width || Math.min(innerWidth * 0.82, 300);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!job || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!live) {
      // scrolling down the menu is not a swipe out of it
      if (Math.abs(dy) > Math.abs(dx)) { job = null; return; }
      if (Math.abs(dx) < 6) return;
      live = true;
      side.classList.add('dragging');
      document.body.classList.add('nav-dragging');
    }
    const { x, t } = navSlide(job, dx, w);
    side.style.transform = `translateX(${x}px)`;
    scrim.style.opacity = String(t);
    arm();
  }, { passive: true });

  document.addEventListener('touchend', settle, { passive: true });
  document.addEventListener('touchcancel', settle, { passive: true });
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
    let created;
    commit(() => { created = upsertItem(parsed); });
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

/* ---------------- keyboard ---------------- */

/* One key each. None fire while typing, and none need a modifier — the
   modifier keys are the browser's. `?` lists them. */
const KEYS = [
  ['n', 'New — the quick add box'],
  ['/', 'Find a task, note, card or link'],
  ['t', 'Today — this week on Week, Overview elsewhere'],
  ['← →', 'Last week, next week (on Week)'],
  ['1 2 3', 'Overview, Semester, Week'],
  ['Ctrl+Z', 'Undo the last change — Ctrl+Shift+Z or Ctrl+Y redoes'],
  ['Esc', 'Close the panel'],
  ['?', 'This list']
];

const showDay = (date) => { showWeekOf(date); go('week'); };

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
    // Ctrl+Z outside a box is the app's undo; inside one it is the browser's
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      const back = e.key.toLowerCase() === 'z' && !e.shiftKey;
      const label = back ? undo() : redo();
      if (!label) toast(back ? 'Nothing to undo.' : 'Nothing to redo.');
      else toast(`${back ? 'Undone' : 'Redone'}: ${label}.`, { action: back ? 'Redo' : 'Undo', onAction: () => (back ? redo() : undo()) });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { closePeek(); closeModal(); return; }
    if (typing) return;
    switch (e.key) {
      case 'n': e.preventDefault(); $('#quickadd-input').focus(); return;
      case '/': e.preventDefault(); openSearch({ go, showDay }); return;
      case 't':
        if (current.kind === 'view' && current.id === 'week') { showWeekOf(today()); navigate(); }
        else go('overview');
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (current.kind === 'view' && current.id === 'week') {
          e.preventDefault();
          $(`.weekbar [aria-label="${e.key === 'ArrowLeft' ? 'Previous' : 'Next'} week"]`)?.click();
        }
        return;
      case '?':
        modal({
          title: 'Keys',
          body: h('div', { class: 'keys' },
            ...KEYS.flatMap(([k, what]) => [h('kbd', {}, k), h('span', {}, what)]))
        });
        return;
      default: {
        const i = +e.key - 1;
        if (i >= 0 && i < TOP_VIEWS.length) go(TOP_VIEWS[i]);
      }
    }
  });
}

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
  applyAppearance();
  wireQuickAdd();
  wireKeys();

  $('#menu-btn').addEventListener('click', () => setSidebar(!sidebarOpen()));
  $('#nav-scrim').addEventListener('click', closeSidebar);
  wireNavSwipe();

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
    if (meta?.external || meta?.source === 'gcal' || meta?.source === 'cloud'
      || meta?.source === 'editor' || meta?.source === 'restore'
      || meta?.source === 'undo' || meta?.source === 'redo'
      || meta?.source === 'canvas') navigate();
  });

  navigate();

  // Google Calendar and Supabase, each only if the user has set it up
  G.start().catch((e) => console.warn('gcal', e));
  C.start().catch((e) => console.warn('cloud', e));
  // the Canvas feed, once a day: after any sync that ends well, so a device
  // that has just woken or just signed in gets its turn
  C.onCloud((c) => { if (c.status === 'ready') refreshIfDue(); });

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
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e));
  }

  window.addEventListener('planner:save-error', () =>
    toast('Storage is full — export a backup and clear some space.'));
}

document.addEventListener('DOMContentLoaded', boot);
