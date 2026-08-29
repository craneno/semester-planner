// app.js — shell, router, quick add.

import { h, $, clear, today, fmtDate, debounce, diffDays } from './util.js';
import { state, commit, subscribe, parseQuickAdd, upsertItem, semesterProgress, weekNumber } from './store.js';
import { toast, closePeek } from './ui.js';
import { applyAppearance } from './appearance.js';
import { openItem } from './editor.js';
import { renderOverview } from './views/overview.js';
import { renderSemester } from './views/semester.js';
import { renderWeek, goToWeekOf } from './views/week.js';
import { renderToday, goToDay } from './views/today.js';
import { renderCourses } from './views/courses.js';
import { renderStudy, teardownStudy } from './views/study.js';
import { renderSettings } from './views/settings.js';
import * as G from './gcal.js';
import * as C from './cloud.js';

const VIEWS = {
  overview: { label: 'Overview', glyph: '◲', render: renderOverview, title: () => state.semester.name },
  semester: { label: 'Semester', glyph: '☰', render: renderSemester, title: () => 'Semester' },
  week:     { label: 'Week',     glyph: '▦', render: renderWeek,     title: () => 'Week', bare: true },
  today:    { label: 'Today',    glyph: '◉', render: renderToday,    title: () => 'Today' },
  courses:  { label: 'Courses',  glyph: '◇', render: renderCourses,  title: () => 'Courses' },
  study:    { label: 'Study',    glyph: '◷', render: renderStudy,    title: () => 'Study' },
  settings: { label: 'Settings', glyph: '⚙', render: renderSettings, title: () => 'Settings' }
};

const MOBILE_TABS = ['today', 'week', 'semester', 'study', 'overview'];

let current = 'overview';

/* ---------------- routing ---------------- */

function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  return VIEWS[key] ? key : 'overview';
}

export function go(key) {
  if (location.hash === '#/' + key) navigate();
  else location.hash = '#/' + key;
}

export function navigate() {
  const next = route();
  if (current === 'study' && next !== 'study') teardownStudy();
  current = next;
  paintChrome();
  const host = $('#view');
  host.classList.toggle('bare', !!VIEWS[current].bare);
  clear(host);
  VIEWS[current].render(host, { navigate, go });
  document.title = `${VIEWS[current].title()} · Semester Planner`;
}

window.addEventListener('hashchange', () => { closePeek(); navigate(); });

/* ---------------- chrome ---------------- */

function paintChrome() {
  // sidebar nav
  const rail = $('#rail');
  clear(rail);
  Object.entries(VIEWS).forEach(([key, v], i) => {
    if (key === 'settings') return;
    rail.append(h('button', {
      class: 'nav-item', 'aria-current': key === current ? 'page' : null,
      onclick: () => { go(key); $('#sidebar').classList.remove('open'); }
    },
    h('span', { class: 'nav-glyph' }, v.glyph),
    h('span', {}, v.label),
    h('span', { class: 'key' }, String(i + 1))));
  });

  const active = state.areas.filter((a) => !a.archived);
  if (active.length) {
    rail.append(h('div', { class: 'rail-group' }, h('span', { class: 'eyebrow' }, 'Areas')));
    for (const a of active) {
      const open = state.items.filter((t) => t.areaId === a.id && !t.done).length;
      rail.append(h('button', {
        class: 'area-chip',
        onclick: () => { go('semester'); $('#sidebar').classList.remove('open'); }
      },
      h('span', { class: 'dot', style: { background: a.color } }),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name),
      h('span', { class: 'count eyebrow num' }, String(open))));
    }
  }
  rail.append(h('button', {
    class: 'nav-item', style: { marginTop: '10px' },
    'aria-current': current === 'settings' ? 'page' : null,
    onclick: () => { go('settings'); $('#sidebar').classList.remove('open'); }
  }, h('span', { class: 'nav-glyph' }, '⚙'), h('span', {}, 'Settings')));

  // brand
  const meta = $('#sem-meta');
  clear(meta).append(
    h('span', { class: 'eyebrow num' }, `Week ${weekNumber()}`),
    h('span', { class: 'eyebrow num' }, `${Math.round(semesterProgress() * 100)}%`));

  // mobile tabs
  const tabs = $('#tabbar');
  clear(tabs);
  for (const key of MOBILE_TABS) {
    const v = VIEWS[key];
    tabs.append(h('button', {
      'aria-current': key === current ? 'page' : null,
      onclick: () => go(key)
    }, h('span', { class: 'glyph' }, v.glyph), v.label));
  }

  $('#view-title').textContent = VIEWS[current].title();
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
    const keys = Object.keys(VIEWS);
    const i = +e.key - 1;
    if (i >= 0 && i < keys.length) go(keys[i]);
  });
}

/* ---------------- boot ---------------- */

function boot() {
  applyAppearance();
  wireQuickAdd();
  wireKeys();

  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
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
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e));
  }

  // notifications are only asked for on the Study page, on user action
  window.addEventListener('planner:save-error', () =>
    toast('Storage is full — export a backup and clear some space.'));
}

document.addEventListener('DOMContentLoaded', boot);
