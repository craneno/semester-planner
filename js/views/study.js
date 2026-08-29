// views/study.js — timers that stay honest when the screen locks.
// Everything is derived from wall-clock timestamps; the interval only repaints.

import { h, clear, today, addDays, startOfWeek, weekDays, fmtHours, fmtDuration, pad, fmtDate } from '../util.js';
import { state, commit, logSession, areaName, areaColor, sessionsBetween, studyMinutes } from '../store.js';
import { toast, confirmDialog } from '../ui.js';

const TKEY = 'semesterPlanner.timer';
const PRESETS = [
  { label: '25 / 5', focus: 25, brk: 5 },
  { label: '45 / 10', focus: 45, brk: 10 },
  { label: '50 / 10', focus: 50, brk: 10 }
];

let timer = load();
let tick = null;
let repaint = null;

function load() {
  try {
    const t = JSON.parse(localStorage.getItem(TKEY) || 'null');
    if (t && t.startedAt) return t;
  } catch { /* ignore */ }
  return null;
}
function persist() {
  try {
    if (timer) localStorage.setItem(TKEY, JSON.stringify(timer));
    else localStorage.removeItem(TKEY);
  } catch { /* ignore */ }
}

/** Milliseconds of the current phase that have actually elapsed. */
function elapsed() {
  if (!timer) return 0;
  const base = timer.accum || 0;
  return timer.pausedAt ? base : base + (Date.now() - timer.resumedAt);
}

export function timerRunning() { return !!(timer && !timer.pausedAt); }

export function renderStudy(root, { navigate }) {
  clear(root);
  const p = h('div', { class: 'pad' });

  const days = weekDays(startOfWeek(today(), state.settings.weekStart));
  const tToday = studyMinutes(sessionsBetween(today(), today()));
  const tWeek = studyMinutes(sessionsBetween(days[0], days[6]));
  const tSem = studyMinutes(sessionsBetween(state.semester.start, state.semester.end));

  /* ---- timer card ---- */
  const face = h('div', { class: 'timer-face' }, '00:00');
  const phaseLabel = h('div', { class: 'eyebrow' }, 'Ready');
  const controls = h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } });

  const areaSelect = h('select', { style: { width: 'auto', minWidth: '160px' }, onchange: (e) => { if (timer) { timer.areaId = e.target.value || null; persist(); } } },
    h('option', { value: '' }, 'No area'),
    ...state.areas.filter((a) => !a.archived).map((a) =>
      h('option', { value: a.id, selected: timer?.areaId === a.id }, a.name)));

  const presetRow = h('div', { class: 'preset-row' },
    ...PRESETS.map((pr) => h('button', {
      class: 'preset', 'aria-pressed': String(timer?.mode === 'pomodoro' && timer?.focus === pr.focus),
      onclick: () => startTimer('pomodoro', pr, areaSelect.value)
    }, pr.label)),
    h('button', {
      class: 'preset', 'aria-pressed': String(timer?.mode === 'free'),
      onclick: () => startTimer('free', null, areaSelect.value)
    }, 'Free study'));

  function paint() {
    if (!timer) {
      face.textContent = '00:00';
      phaseLabel.textContent = 'Ready';
      clear(controls).append(h('span', { style: { color: 'var(--ink-3)', fontSize: '13px' } },
        'Pick a length above. Only focus time is logged.'));
      return;
    }
    const ms = elapsed();
    const target = timer.mode === 'pomodoro'
      ? (timer.phase === 'focus' ? timer.focus : timer.brk) * 60000
      : null;
    const shown = target ? Math.max(0, target - ms) : ms;
    const s = Math.floor(shown / 1000);
    face.textContent = `${pad(Math.floor(s / 3600) ? Math.floor(s / 3600) : Math.floor(s / 60))}:${pad(Math.floor(s / 3600) ? Math.floor(s / 60) % 60 : s % 60)}`
      + (Math.floor(s / 3600) ? `:${pad(s % 60)}` : '');
    phaseLabel.textContent = timer.mode === 'free'
      ? (timer.pausedAt ? 'Free study · paused' : 'Free study')
      : `${timer.phase === 'focus' ? 'Focus' : 'Break'}${timer.pausedAt ? ' · paused' : ''} · ${timer.focus}/${timer.brk}`;

    if (target && ms >= target) completePhase();

    clear(controls).append(
      h('button', { class: 'btn', onclick: () => { toggle(); paint(); } }, timer.pausedAt ? 'Resume' : 'Pause'),
      timer.phase === 'focus' || timer.mode === 'free'
        ? h('button', { class: 'btn primary', onclick: () => { finishAndLog(); navigate(); } }, 'Finish & log')
        : h('button', { class: 'btn', onclick: () => { skipBreak(); paint(); } }, 'Skip break'),
      h('button', { class: 'btn ghost', onclick: () => { discard(); navigate(); } }, 'Discard'));
  }

  function startTimer(mode, preset, areaId) {
    timer = {
      mode, areaId: areaId || null,
      focus: preset?.focus ?? 0, brk: preset?.brk ?? 0,
      phase: 'focus', startedAt: Date.now(), resumedAt: Date.now(), accum: 0, pausedAt: null
    };
    persist(); paint(); loop();
  }
  function toggle() {
    if (!timer) return;
    if (timer.pausedAt) { timer.resumedAt = Date.now(); timer.pausedAt = null; }
    else { timer.accum = elapsed(); timer.pausedAt = Date.now(); }
    persist();
  }
  function completePhase() {
    if (!timer) return;
    if (timer.phase === 'focus') {
      const mins = timer.focus || Math.round(elapsed() / 60000);
      commit(() => logSession({
        areaId: timer.areaId, startedAt: new Date(timer.startedAt).toISOString(),
        endedAt: new Date().toISOString(), mins, mode: 'focus'
      }));
      notify(`Focus block done — ${mins} min logged.`);
      timer = { ...timer, phase: 'break', startedAt: Date.now(), resumedAt: Date.now(), accum: 0, pausedAt: null };
    } else {
      notify('Break over.');
      timer = { ...timer, phase: 'focus', startedAt: Date.now(), resumedAt: Date.now(), accum: 0, pausedAt: null };
    }
    persist();
    navigate();
  }
  function skipBreak() {
    if (!timer) return;
    timer = { ...timer, phase: 'focus', startedAt: Date.now(), resumedAt: Date.now(), accum: 0, pausedAt: null };
    persist();
  }
  function finishAndLog() {
    if (!timer) return;
    const mins = Math.round(elapsed() / 60000);
    if (mins >= 1) {
      commit(() => logSession({
        areaId: timer.areaId, startedAt: new Date(timer.startedAt).toISOString(),
        endedAt: new Date().toISOString(), mins, mode: timer.mode
      }));
      toast(`${fmtDuration(mins)} logged.`);
    } else {
      toast('Under a minute — nothing logged.');
    }
    timer = null; persist(); stopLoop();
  }
  function discard() { timer = null; persist(); stopLoop(); }

  function loop() {
    stopLoop();
    tick = setInterval(paint, 1000);
  }
  function stopLoop() { clearInterval(tick); tick = null; }

  p.append(h('div', { class: 'grid cols-2', style: { alignItems: 'start' } },
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Timer'), h('div', { style: { flex: 1 } }), areaSelect),
      h('div', { class: 'card-b' }, phaseLabel, face, presetRow, controls)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('span', { class: 'eyebrow' }, 'Totals')),
      h('div', { class: 'card-b' },
        h('div', { style: { display: 'flex', gap: '26px', marginBottom: '16px' } },
          stat('Today', fmtHours(tToday)), stat('This week', fmtHours(tWeek)), stat('Semester', fmtHours(tSem))),
        byArea(days)))));

  /* ---- history ---- */
  p.append(h('div', { class: 'group-h', style: { marginTop: '10px' } },
    h('h2', {}, 'Recent sessions'),
    h('span', { class: 'eyebrow num' }, String(state.sessions.length))));

  if (!state.sessions.length) {
    p.append(h('div', { class: 'empty', style: { marginTop: '14px' } },
      h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, 'No sessions yet. Start a timer above.')));
  }
  for (const s of state.sessions.slice(0, 40)) {
    p.append(h('div', { class: 'row', style: { gridTemplateColumns: '84px 3px minmax(0,1fr) auto auto', cursor: 'default' } },
      h('span', { class: 'eyebrow num' }, fmtDate(s.date)),
      h('span', { style: { width: '3px', height: '15px', borderRadius: '2px', background: areaColor(s.areaId) } }),
      h('span', { class: 'title' }, areaName(s.areaId)),
      h('span', { class: 'eyebrow' }, s.mode),
      h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('span', { class: 'num', style: { fontSize: '13px' } }, fmtDuration(s.mins)),
        h('button', {
          class: 'btn ghost sm', 'aria-label': 'Delete session',
          onclick: async () => {
            if (await confirmDialog('Delete this session?', `${fmtDuration(s.mins)} on ${fmtDate(s.date)}`, 'Delete')) {
              commit(() => { state.sessions = state.sessions.filter((x) => x.id !== s.id); });
              navigate();
            }
          }
        }, '✕'))));
  }

  root.append(p);
  paint();
  if (timer && !timer.pausedAt) loop();

  // stop repainting when the view is replaced
  repaint = () => stopLoop();
}

export function teardownStudy() { repaint?.(); repaint = null; }

function stat(label, value) {
  return h('div', {},
    h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 600, letterSpacing: '-.02em' } }, value),
    h('div', { class: 'eyebrow' }, label));
}

function byArea(days) {
  const week = sessionsBetween(days[0], days[6]);
  const totals = new Map();
  for (const s of week) totals.set(s.areaId, (totals.get(s.areaId) || 0) + s.mins);
  const max = Math.max(1, ...totals.values());
  if (!totals.size) return h('span', { style: { color: 'var(--ink-3)', fontSize: '13px' } }, 'No study time logged this week.');
  return h('div', { class: 'bars' },
    ...[...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id, mins]) =>
      h('div', { class: 'bar-row' },
        h('span', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, areaName(id)),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: (mins / max) * 100 + '%', background: areaColor(id) } })),
        h('span', { class: 'eyebrow num', style: { textAlign: 'right' } }, fmtDuration(mins)))));
}

function notify(msg) {
  toast(msg);
  try {
    if (window.Notification && Notification.permission === 'granted') new Notification('Semester Planner', { body: msg });
  } catch { /* ignore */ }
}
