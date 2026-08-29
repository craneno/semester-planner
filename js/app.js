// app.js — shell, router, quick add.

import { h, $, clear, fmtDate, debounce } from './util.js';
import {
  state, commit, subscribe, parseQuickAdd, upsertItem, semesterProgress, weekNumber,
  AREA_CATEGORIES, CATEGORY_IDS, categoryById, areasInCategory, areaById,
  unfiledCards, reorderAreas, parseLinkAdd, addLink
} from './store.js';
import { toast, closePeek, reorderable } from './ui.js';
import { applyAppearance } from './appearance.js';
import { openItem } from './editor.js';
import { renderOverview } from './views/overview.js';
import { renderSemester } from './views/semester.js';
import { renderWeek } from './views/week.js';
import { renderCategory, renderArea } from './views/areas.js';
import { renderNotes } from './views/notes.js';
import { renderHabits } from './views/habits.js';
import { renderSettings } from './views/settings.js';
import * as G from './gcal.js';
import * as C from './cloud.js';

/* Plain views. Categories and single areas are routed separately — they are
   data, not screens, so they cannot be listed here. */
const VIEWS = {
  overview: { label: 'Overview', glyph: '◲', render: renderOverview, title: () => state.semester.name },
  semester: { label: 'Semester', glyph: '☰', render: renderSemester, title: () => 'Semester' },
  week:     { label: 'Week',     glyph: '▦', render: renderWeek,     title: () => 'Week', bare: true },
  habits:   { label: 'Habits',   glyph: '◴', render: renderHabits,   title: () => 'Habits' },
  notes:    { label: 'Notes',    glyph: '✎', render: renderNotes,    title: () => 'Notes' },
  settings: { label: 'Settings', glyph: '⚙', render: renderSettings, title: () => 'Settings' }
};

const TOP_VIEWS = ['overview', 'semester', 'week'];

/* A view pinned inside a category's group in the sidebar. Habits are personal
   but they are not an area — there is no work in them and nothing is ever due
   — so they sit under Personal as a link to their own page rather than as a
   fake row in state.areas. */
const CATEGORY_PINS = { personal: [{ view: 'habits', label: 'Habits', glyph: '◴' }] };
const MOBILE_TABS = ['overview', 'week', 'semester', 'course', 'notes'];
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

export function navigate() {
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

const closeSidebar = () => $('#sidebar').classList.remove('open');

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
    row.prepend(caret);
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

  const waiting = unfiledCards().length;
  const notes = navButton({
    glyph: '✎', label: 'Notes',
    current: isCurrent('view', 'notes'), onclick: () => go('notes')
  });
  if (waiting) notes.append(h('span', { class: 'count eyebrow num' }, String(waiting)));

  rail.append(h('div', { style: { marginTop: '10px' } }, notes, navButton({
    glyph: '⚙', label: 'Settings',
    current: isCurrent('view', 'settings'), onclick: () => go('settings')
  })));

  // brand
  const meta = $('#sem-meta');
  clear(meta).append(
    h('span', { class: 'eyebrow num' }, `Week ${weekNumber()}`),
    h('span', { class: 'eyebrow num' }, `${Math.round(semesterProgress() * 100)}%`));

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
    offline: 'Offline · queued'
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
        onAction: () => go(home ? `area/${home.id}` : 'notes')
      });
      navigate();
      return;
    }

    const parsed = parseQuickAdd(input.value);
    let created;
    commit(() => { created = upsertItem(parsed); });
    input.value = '';
    const bits = [];
    if (parsed.due) bits.push('due ' + fmtDate(parsed.due));
    if (parsed.plan?.date) bits.push('planned ' + fmtDate(parsed.plan.date));
    toast(`Added${bits.length ? ' · ' + bits.join(' · ') : ''}`, { action: 'Open', onAction: () => openItem(created.id) });
    navigate();
  });
}

/* ---------------- keyboard ---------------- */

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing) return;
    if (e.key === '/' || e.key === 'n') { e.preventDefault(); $('#quickadd-input').focus(); return; }
    const i = +e.key - 1;
    if (i >= 0 && i < TOP_VIEWS.length) go(TOP_VIEWS[i]);
  });
}

/* ---------------- boot ---------------- */

function boot() {
  applyAppearance();
  wireQuickAdd();
  wireKeys();

  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

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
    if (meta?.external || meta?.source === 'gcal' || meta?.source === 'cloud'
      || meta?.source === 'editor') navigate();
  });

  navigate();

  // Google Calendar and Supabase, each only if the user has set it up
  G.start().catch((e) => console.warn('gcal', e));
  C.start().catch((e) => console.warn('cloud', e));

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
