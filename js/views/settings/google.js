// views/settings/google.js — Google Calendar: the client, the calendar, the sign-in.

import { h, clear, debounce } from '../../util.js';
import { state, commit } from '../../store.js';
import { toast } from '../../ui.js';
import * as G from '../../gcal.js';
import { section, field, toggle } from './bits.js';

/* One listener for the life of the page, that calls whichever painter the
   latest render made. Subscribing from inside the render stacked one more
   painter per visit to Settings, each rebuilding detached DOM on every
   status change. */
let paint = null;
G.onGcal(() => paint?.());

export function renderGoogle({ navigate }) {
  const g = state.settings.gcal;
  const statusLine = h('div', { class: 'eyebrow', style: { marginBottom: '10px' } });
  const calPicker = h('select', { onchange: (e) => { commit(() => { g.calendarId = e.target.value; g.syncToken = ''; }); G.sync({ full: true }); } });

  function paintStatus() {
    const map = {
      off: 'Not configured', 'signed-out': 'Signed out', connecting: 'Connecting…',
      ready: g.lastSync ? `Synced ${new Date(g.lastSync).toLocaleTimeString()}` : 'Connected',
      syncing: 'Syncing…', error: 'Error: ' + G.gcal.message, offline: 'Offline — changes queued',
      waiting: G.gcal.message
    };
    statusLine.textContent = map[G.gcal.status] || G.gcal.status;
    statusLine.style.color = G.gcal.status === 'error' ? 'var(--danger)' : 'var(--ink-3)';

    clear(calPicker);
    const cals = G.gcal.calendars.length ? G.gcal.calendars : [{ id: 'primary', name: 'Primary calendar', writable: true }];
    for (const c of cals) {
      calPicker.append(h('option', { value: c.id, selected: c.id === g.calendarId },
        c.name + (c.writable ? '' : ' (read-only)')));
    }
  }
  paint = paintStatus;

  const card = section('Google Calendar', [
    statusLine,
    field('OAuth client ID', h('input', {
      type: 'text', placeholder: '1234567890-abc.apps.googleusercontent.com', value: g.clientId,
      oninput: debounce((e) => commit(() => { g.clientId = e.target.value.trim(); }), 400)
    })),
    h('p', { class: 'help', style: { margin: '2px 0 12px' } },
      'From Google Cloud Console → Credentials → OAuth client ID (Web application). Add this exact origin — ',
      h('code', { class: 'mono' }, location.origin),
      ' — to both Authorised JavaScript origins and Authorised redirect URIs. With cloud sync signed in and google-token deployed, a sign-in keeps for a week or more. See README.md.'),
    field('Calendar', calPicker),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            commit(() => { g.enabled = true; });
            await G.signIn(true);
            await G.listCalendars();
            await G.sync({ full: true });
            await G.start();
            toast('Google Calendar connected.');
            navigate();
          } catch (err) { toast(err.message); }
        }
      }, G.isSignedIn() ? 'Reconnect' : 'Connect Google Calendar'),
      h('button', { class: 'btn', onclick: () => { G.sync({ full: true }); toast('Resyncing…'); } }, 'Force full resync'),
      h('button', {
        class: 'btn ghost', onclick: () => {
          G.forgetToken();
          commit(() => { g.enabled = false; g.syncToken = ''; state.events = []; });
          G.stop();
          navigate();
        }
      }, 'Disconnect')),
    toggle('Two-way sync', 'Pull events in, and push planned work blocks out as calendar events.', g.pushPlans,
      (v) => commit(() => { g.pushPlans = v; }))
  ]);
  paintStatus();
  return card;
}
