// views/settings/cloud.js — cloud sync: the project, the account, the log, the history.

import { h, clear, debounce } from '../../util.js';
import { state, commit } from '../../store.js';
import { toast, confirmDialog } from '../../ui.js';
import * as C from '../../cloud.js';
import { section, field } from './bits.js';

// one listener for the life of the page; see google.js
let paint = null;
C.onCloud(() => paint?.());

// open state of the two panels, outside the DOM: a sync rebuilds them
let syncLogOpen = false;
let historyOpen = false;

export function renderCloud({ navigate }) {
  const cl = state.settings.cloud;
  const cloudStatus = h('div', { class: 'eyebrow', style: { marginBottom: '10px' } });
  const emailIn = h('input', { type: 'text', placeholder: 'you@northeastern.edu', autocomplete: 'username', value: C.cloud.email || '' });
  const pwIn = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password' });
  const authRow = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } });

  function paintCloud() {
    const map = {
      off: 'Not configured',
      'signed-out': 'Signed out — this device works offline on its own',
      connecting: 'Connecting…',
      ready: (C.cloud.email ? C.cloud.email + ' · ' : '')
        + (cl.lastSync ? 'synced ' + new Date(cl.lastSync).toLocaleTimeString() : 'connected')
        + (C.cloud.live ? ' · live' : ''),
      // the very same text as ready: on a phone the ready line wraps and a
      // shorter one does not, and each sync nudged the whole page up and back.
      // The LED in the top bar is what pulses while a sync runs.
      syncing: (C.cloud.email ? C.cloud.email + ' · ' : '')
        + (cl.lastSync ? 'synced ' + new Date(cl.lastSync).toLocaleTimeString() : 'connected')
        + (C.cloud.live ? ' · live' : ''),
      error: 'Error: ' + C.cloud.message,
      offline: 'Offline — changes sync when you reconnect'
    };
    cloudStatus.textContent = map[C.cloud.status] || C.cloud.status;
    cloudStatus.style.color = C.cloud.status === 'error' ? 'var(--danger)' : 'var(--ink-3)';
    paintLog();

    clear(authRow);
    if (C.isSignedIn()) {
      authRow.append(
        h('button', { class: 'btn', onclick: () => { C.sync({ manual: true }); toast('Syncing…'); } }, 'Sync now'),
        h('button', {
          class: 'btn', onclick: async () => {
            if (await confirmDialog('Rebuild sync from scratch?',
              'Pulls everything down again and re-uploads this device. Useful if the two ever drift apart. No data is deleted.', 'Rebuild')) {
              C.resetLocalSyncState();
              // start, not sync: the reset drops the client, and only start
              // stands the realtime channel up again
              await C.start();
              toast('Sync rebuilt.');
              navigate();
            }
          }
        }, 'Rebuild sync'),
        h('button', {
          class: 'btn ghost', onclick: async () => { await C.signOut(); navigate(); }
        }, 'Sign out'));
    } else {
      authRow.append(
        h('button', {
          class: 'btn primary', onclick: async () => {
            try {
              await C.signIn(emailIn.value.trim(), pwIn.value);
              // on only once the sign-in took: left on after a failure, the
              // strip said "sign in to sync" of a device that never was
              commit(() => { cl.enabled = true; });
              await C.start();
              toast('Signed in — syncing.');
              navigate();
            } catch (err) { toast(err.message || 'Could not sign in.'); }
          }
        }, 'Sign in'),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const r = await C.signUp(emailIn.value.trim(), pwIn.value);
              commit(() => { cl.enabled = true; });
              if (r.needsConfirmation) toast('Check your email to confirm, then sign in.');
              else { await C.start(); toast('Account created — syncing.'); }
              navigate();
            } catch (err) { toast(err.message || 'Could not create the account.'); }
          }
        }, 'Create account'),
        h('button', {
          class: 'btn ghost', onclick: async () => {
            try { await C.sendReset(emailIn.value.trim()); toast('Reset email sent.'); }
            catch (err) { toast(err.message || 'Could not send the reset email.'); }
          }
        }, 'Forgot password'));
    }
  }
  paint = paintCloud;

  /* The sync log: what each sync did. A loop shows here in the first minute
     — "up 40" a second with nothing edited — where the status line only ever
     said "synced". Open state kept outside the DOM; a sync rebuilds this. */
  const logBox = h('div', { style: { fontSize: '12px', fontFamily: 'var(--mono)', color: 'var(--ink-3)', marginTop: '6px' } });
  function paintLog() {
    clear(logBox);
    if (!C.cloud.log.length) { logBox.append(h('div', {}, 'No syncs yet on this device.')); return; }
    for (const e of C.cloud.log) {
      const bits = [new Date(e.at).toLocaleTimeString(), `${e.ms}ms`, `up ${e.up}`, `down ${e.down}`];
      if (e.adopted) bits.push(`took ${e.adopted} back`);
      if (e.full) bits.push('full');
      if (e.error) bits.push(e.error === 'loop' ? 'STOPPED — loop' : 'error: ' + e.error);
      logBox.append(h('div', { style: { color: e.error ? 'var(--danger)' : '', padding: '1px 0' } }, bits.join(' · ')));
    }
  }
  const logPanel = h('details', {
    style: { marginTop: '12px' }, open: syncLogOpen ? true : null,
    ontoggle: (e) => { syncLogOpen = e.target.open; }
  },
    h('summary', { class: 'eyebrow', style: { cursor: 'pointer' } }, 'Sync log'),
    h('p', { class: 'help', style: { margin: '4px 0 0' } },
      'The last thirty syncs from this device. "Up" with nothing edited here, sync after sync, is a loop — and sync stops itself after five.'),
    logBox);

  /* What the server used to hold. An upsert has no undo; the history table
     (supabase/upgrade.sql) is it. Loaded when opened, never on every draw. */
  const histBox = h('div', { style: { marginTop: '6px' } });
  async function paintHistory() {
    clear(histBox);
    histBox.append(h('div', { class: 'eyebrow' }, 'Loading…'));
    let rows;
    try { rows = await C.history(); } catch (err) {
      clear(histBox);
      histBox.append(h('p', { style: { fontSize: '12.5px', color: 'var(--danger)', margin: '4px 0 0' } }, C.describeSyncError(err)));
      return;
    }
    clear(histBox);
    if (!rows.length) { histBox.append(h('p', { class: 'help', style: { margin: '4px 0 0' } }, 'Nothing replaced yet.')); return; }
    for (const r of rows) {
      const d = r.data || {};
      const label = d.title || d.name || (typeof d.text === 'string' && d.text.slice(0, 48)) || d.focus || r.id;
      histBox.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0', fontSize: '12.5px' } },
        h('span', { class: 'num', style: { fontSize: '12px', minWidth: '84px', color: 'var(--ink-3)' } },
          new Date(r.replaced_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          h('span', { style: { color: 'var(--ink-3)' } }, r.kind + (r.deleted ? ' (deleted) ' : ' ')), label),
        h('button', {
          class: 'btn sm', onclick: () => {
            if (C.restore(r)) toast('Put back — it goes up on the next sync.');
            else toast('Could not put that back.');
          }
        }, 'Put back')));
    }
  }
  const histPanel = h('details', {
    style: { marginTop: '8px' }, open: historyOpen ? true : null,
    ontoggle: (e) => { historyOpen = e.target.open; if (e.target.open) paintHistory(); }
  },
    h('summary', { class: 'eyebrow', style: { cursor: 'pointer' } }, 'What the server used to hold'),
    h('p', { class: 'help', style: { margin: '4px 0 0' } },
      'Every version a row had before it was written over, for thirty days. Putting one back makes it the newest, so every device takes it.'),
    histBox);
  if (historyOpen) paintHistory();

  const card = section('Cloud sync', [
    cloudStatus,
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('Supabase project URL', h('input', {
        type: 'text', placeholder: 'https://abcdefgh.supabase.co', value: cl.url,
        oninput: debounce((e) => commit(() => { cl.url = e.target.value.trim(); }), 400)
      })),
      field('Anon public key', h('input', {
        type: 'text', placeholder: 'eyJhbGciOi…', value: cl.anonKey,
        oninput: debounce((e) => commit(() => { cl.anonKey = e.target.value.trim(); }), 400)
      }))),
    h('p', { class: 'help', style: { margin: '2px 0 0' } },
      'From your Supabase project → Settings → API. The anon key is meant to be public; row level security is what keeps your rows yours. Run ',
      h('code', { class: 'mono' }, 'supabase/schema.sql'),
      ' in the SQL editor once before signing in.'),
    field('Email', emailIn),
    field('Password', pwIn),
    authRow,
    h('p', { class: 'help', style: { margin: '10px 0 0' } },
      'Everything keeps working offline and syncs when you get back. Signing out leaves this device\'s data untouched.'),
    logPanel,
    histPanel
  ]);
  paintCloud();
  return card;
}
