// views/settings/steps.js — steps from the phone.
// Health is the phone's; a Shortcut reads it and posts the day's steps to the
// health-steps function with a token made here. The goal and the habit sync;
// the token lives on the server, in your row.

import { h, clear, fmtDate } from '../../util.js';
import { state, commit, activeHabits } from '../../store.js';
import { toast, confirmDialog } from '../../ui.js';
import * as C from '../../cloud.js';
import * as HL from '../../health.js';
import { section, field } from './bits.js';

/** What a day of 0 nearly always means. The post got through, so it is the Shortcut. */
export const ZERO_HELP = 'The phone posted 0. That is the Shortcut summing nothing: in the Health app (your picture → Apps → Shortcuts) let it read Steps, and in the request body send the Sum from “Calculate Statistics” as a Number — not the samples, not text. Run the Shortcut by hand: the function now refuses anything it cannot read as a number and says what it got.';

export function renderSteps() {
  const s = state.settings;
  const stepsBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const paintSteps = async () => {
    clear(stepsBox);
    const habits = activeHabits();
    stepsBox.append(
      field('Steps a day', h('input', {
        type: 'number', min: 1000, step: 500, value: HL.stepsGoal(), style: { width: '110px' }, 'aria-label': 'Steps a day',
        onchange: (e) => { const n = Math.max(1, Math.round(+e.target.value || 0)); commit(() => { s.stepsGoal = n; }); toast(`${n.toLocaleString()} steps a day.`); }
      })),
      field('Ticks the habit', h('select', {
        'aria-label': 'Habit the steps tick',
        onchange: (e) => { commit(() => { s.stepsHabitId = e.target.value || null; }); }
      },
      h('option', { value: '', selected: !HL.stepsHabit() }, 'None'),
      ...habits.map((x) => h('option', { value: x.id, selected: x.id === HL.stepsHabit() }, x.name)))));
    const last = HL.latestSteps();
    if (last) stepsBox.append(h('p', { class: 'eyebrow', style: { margin: 0 } }, `Last from the phone: ${fmtDate(last.day)} · ${last.steps.toLocaleString()} steps`));
    // the number arrives, so the wiring is fine; a zero is the Shortcut summing nothing
    if (last && last.steps === 0) stepsBox.append(h('p', { class: 'help zero-steps', style: { margin: 0 } }, ZERO_HELP));
    if (!C.isSignedIn()) {
      stepsBox.append(h('p', { class: 'help', style: { margin: 0 } }, 'Sign in to cloud sync first: the steps come by way of your Supabase project.'));
      return;
    }
    let token = null, err = null;
    try { token = await C.healthToken(); } catch (e) { err = e; }
    if (err) { stepsBox.append(h('p', { style: { fontSize: '12.5px', color: 'var(--danger)', margin: 0 } }, HL.describeHealthError(err))); return; }
    const make = async () => {
      if (token && !await confirmDialog('Make a new token?', 'The Shortcut on your phone will need the new one.', 'Make a new one')) return;
      try { await C.makeHealthToken(); toast('Token made. Put it in the Shortcut.'); paintSteps(); }
      catch (e) { toast(HL.describeHealthError(e)); }
    };
    if (!token) {
      stepsBox.append(h('div', {}, h('button', { class: 'btn', onclick: make }, 'Make a token for the phone')));
      return;
    }
    const url = C.healthUrl();
    const copy = (text, said) => async () => { try { await navigator.clipboard.writeText(text); toast(said); } catch { toast('Could not copy — select it and copy by hand.'); } };
    stepsBox.append(
      h('div', { class: 'field' }, h('label', {}, 'Token'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('code', { style: { fontSize: '11px', wordBreak: 'break-all' } }, token),
          h('button', { class: 'btn sm', onclick: copy(token, 'Token copied.') }, 'Copy'),
          h('button', { class: 'btn sm ghost', onclick: make }, 'Make a new one'))),
      h('div', { class: 'field' }, h('label', {}, 'Where it posts'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('code', { style: { fontSize: '11px', wordBreak: 'break-all' } }, url),
          h('button', { class: 'btn sm', onclick: copy(url, 'URL copied.') }, 'Copy'))),
      h('details', { class: 'history' },
        h('summary', {}, 'The Shortcut, step by step'),
        h('ol', { style: { fontSize: '12.5px', color: 'var(--ink-2)', margin: '8px 0 0', paddingLeft: '18px', lineHeight: 1.5 } },
          h('li', {}, 'Shortcuts \u2192 Automation \u2192 + \u2192 Time of Day, every day, late (11:45 PM), Run Immediately.'),
          h('li', {}, 'In the Health app (your picture → Apps → Shortcuts) let Shortcuts read Steps, or every day sums to 0.'),
          h('li', {}, 'Add “Find Health Samples”: type Steps, Start Date is today, sorted by start date.'),
          h('li', {}, 'Add “Calculate Statistics” on that: Sum.'),
          h('li', {}, 'Add “Get Contents of URL”: the URL above, Method POST, Headers: x-planner-token = the token above, Request Body JSON: date = Current Date formatted yyyy-MM-dd, steps = the Sum from the step before, as a Number field (a list or text is refused).'),
          h('li', {}, 'Run it once by hand: an error there names what went wrong; tap Read now here and the day shows, and the habit ticks itself.'))),
      h('div', {}, h('button', {
        class: 'btn', onclick: async () => {
          try {
            const t = await HL.refreshHealth({ now: Date.now() });
            const l = HL.latestSteps();
            toast(`${t.days} ${t.days === 1 ? 'day' : 'days'} read${l ? ` · ${fmtDate(l.day)} ${l.steps.toLocaleString()} steps` : ''}${t.ticked ? ` · ${t.ticked} ticked` : ''}.`);
            paintSteps();
          }
          catch (e) { toast(HL.describeHealthError(e)); }
        }
      }, 'Read now')));
  };
  paintSteps();
  return section('Steps from your phone', [
    h('p', { class: 'help', style: { margin: '0 0 4px' } },
      'Apple Health is the phone\u2019s alone, but a Shortcut can read it and post the day\u2019s steps here. On every day the goal is met, the habit you pick ticks itself. Needs cloud sync, the health-steps function deployed (README), and the tables from supabase/upgrade.sql.'),
    stepsBox
  ]);
}
