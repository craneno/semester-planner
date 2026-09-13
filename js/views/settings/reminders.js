// views/settings/reminders.js — the heads-up before things begin.
// A lead on this device only: the permission is the browser's, per site, and
// a phone and a laptop each get their own.

import { h } from '../../util.js';
import { state, commit } from '../../store.js';
import { toast } from '../../ui.js';
import * as R from '../../remind.js';
import { section, field } from './bits.js';

export function renderReminders({ navigate }) {
  const s = state.settings;
  const remindSel = h('select', {
    onchange: async (e) => {
      const v = +e.target.value;
      if (v) {
        const perm = await R.ask();
        if (perm !== 'granted') {
          toast(perm === 'denied' ? 'Notifications are blocked for this site — allow them in the browser first.' : 'Notifications are not available here.');
          e.target.value = String(R.lead());
          return;
        }
      }
      commit(() => { s.remindLead = v; });
      R.tick();
      toast(v ? `A heads-up ${v} minutes before.` : 'Reminders off.');
      navigate?.();
    }
  }, ...R.LEADS.map((m) => h('option', { value: m, selected: R.lead() === m }, m ? `${m} minutes before` : 'Off')));
  return section('Reminders', [
    h('p', { class: 'help', style: { margin: '0 0 12px' } },
      'A notification before a class, a calendar event or a planned block begins — on this device, since that is where it shows. The app has to be open somewhere: a tab, or installed on the home screen.'),
    field('Heads-up', remindSel),
    R.permission() === 'denied'
      ? h('p', { style: { fontSize: '12.5px', color: 'var(--danger)', margin: 0 } }, 'Blocked in the browser. Allow notifications for this site in its settings, then pick a lead.')
      : null
  ]);
}
