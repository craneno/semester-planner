// views/settings.js — semester, Google Calendar, appearance, data.

import { h, clear, debounce, fmtTime, fromMin, DAY_RESET_HOUR, tz, zoneLabel, zoneShift, fmtDuration } from '../util.js';
import { state, commit, exportJson, importJson, scheduleZones, shiftSchedules, stampSchedules, listBackups, readBackup } from '../store.js';
import { toast, confirmDialog } from '../ui.js';
import { applyAppearance, THEMES, FONT_STACKS } from '../appearance.js';
import { CHANGELOG, APP_VERSION } from '../changelog.js';
import * as G from '../gcal.js';
import * as C from '../cloud.js';
import { importCanvas, refreshFeed, isFeedUrl } from '../canvas.js';

// open state of the two cloud panels, outside the DOM: a sync rebuilds them
let syncLogOpen = false;
let historyOpen = false;
// whether a Canvas feed link is saved on the server: null until asked, then
// the time it was set or false. Kept here so a redraw does not ask again
let feedKnown = null;

export function renderSettings(root, { navigate }) {
  clear(root);
  const p = h('div', { class: 'pad', style: { maxWidth: '760px' } });
  const s = state.settings;

  p.append(h('h1', { style: { marginBottom: '16px' } }, 'Settings'));

  /* ---------- semester ---------- */
  p.append(section('Semester', [
    field('Name', h('input', {
      type: 'text', value: state.semester.name,
      oninput: debounce((e) => commit(() => { state.semester.name = e.target.value; }), 400)
    })),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('First day', h('input', {
        type: 'date', value: state.semester.start,
        onchange: (e) => { commit(() => { state.semester.start = e.target.value; }); navigate(); }
      })),
      field('Last day', h('input', {
        type: 'date', value: state.semester.end,
        onchange: (e) => { commit(() => { state.semester.end = e.target.value; }); navigate(); }
      }))),
    zoneRow(navigate)
  ]));

  /* ---------- google calendar ---------- */
  const g = s.gcal;
  const statusLine = h('div', { class: 'eyebrow', style: { marginBottom: '10px' } });
  const calPicker = h('select', { onchange: (e) => { commit(() => { g.calendarId = e.target.value; g.syncToken = ''; }); G.sync({ full: true }); } });

  function paintStatus() {
    const map = {
      off: 'Not configured', 'signed-out': 'Signed out', connecting: 'Connecting…',
      ready: g.lastSync ? `Synced ${new Date(g.lastSync).toLocaleTimeString()}` : 'Connected',
      syncing: 'Syncing…', error: 'Error: ' + G.gcal.message, offline: 'Offline — changes queued'
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
  G.onGcal(paintStatus);

  p.append(section('Google Calendar', [
    statusLine,
    field('OAuth client ID', h('input', {
      type: 'text', placeholder: '1234567890-abc.apps.googleusercontent.com', value: g.clientId,
      oninput: debounce((e) => commit(() => { g.clientId = e.target.value.trim(); }), 400)
    })),
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '2px 0 12px' } },
      'From Google Cloud Console → Credentials → OAuth client ID (Web application). Add this exact origin — ',
      h('code', { class: 'mono' }, location.origin),
      ' — to both Authorised JavaScript origins and Authorised redirect URIs. See README.md.'),
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
  ]));
  paintStatus();


  /* ---------- cloud sync ---------- */
  const cl = s.cloud;
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
              await C.sync({ full: true });
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
              commit(() => { cl.enabled = true; });
              await C.signIn(emailIn.value.trim(), pwIn.value);
              await C.start();
              toast('Signed in — syncing.');
              navigate();
            } catch (err) { toast(err.message || 'Could not sign in.'); }
          }
        }, 'Sign in'),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              commit(() => { cl.enabled = true; });
              const r = await C.signUp(emailIn.value.trim(), pwIn.value);
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
  C.onCloud(paintCloud);

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
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '4px 0 0' } },
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
    if (!rows.length) { histBox.append(h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '4px 0 0' } }, 'Nothing replaced yet.')); return; }
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
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '4px 0 0' } },
      'Every version a row had before it was written over, for thirty days. Putting one back makes it the newest, so every device takes it.'),
    histBox);
  if (historyOpen) paintHistory();

  p.append(section('Cloud sync', [
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
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '2px 0 0' } },
      'From your Supabase project → Settings → API. The anon key is meant to be public; row level security is what keeps your rows yours. Run ',
      h('code', { class: 'mono' }, 'supabase/schema.sql'),
      ' in the SQL editor once before signing in.'),
    field('Email', emailIn),
    field('Password', pwIn),
    authRow,
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '10px 0 0' } },
      'Everything keeps working offline and syncs when you get back. Signing out leaves this device\'s data untouched.'),
    logPanel,
    histPanel
  ]));
  paintCloud();

  /* ---------- appearance ---------- */
  const swatches = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    ...Object.entries(THEMES).map(([key, t]) => h('button', {
      class: 'preset', 'aria-pressed': String(s.theme === key),
      onclick: () => { commit(() => { s.theme = key; s.colors = {}; }); applyAppearance(); navigate(); }
    },
    h('span', { class: 'dot', style: { background: t.swatch, marginRight: '6px', display: 'inline-block' } }), t.label)));

  const colorRow = (label, key, fallbackVar) => h('div', { class: 'prop' },
    h('label', {}, label),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('input', {
        type: 'color',
        value: s.colors[key] || getComputedStyle(document.documentElement).getPropertyValue(fallbackVar).trim() || '#ffffff',
        style: { width: '44px', height: '26px', padding: '2px' },
        oninput: (e) => { commit(() => { s.colors[key] = e.target.value; }); applyAppearance(); }
      }),
      s.colors[key] ? h('button', {
        class: 'btn ghost sm',
        onclick: () => { commit(() => { delete s.colors[key]; }); applyAppearance(); navigate(); }
      }, 'Reset') : null));

  p.append(section('Appearance', [
    h('div', { class: 'eyebrow', style: { marginBottom: '8px' } }, 'Theme'),
    swatches,
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '10px 0 0' } },
      'Parchment is the gentlest for a long session: dark text on light, because '
      + 'light-on-dark haloes if you have any astigmatism; an off-white rather than '
      + 'pure white, which is a glare source at normal screen brightness; contrast '
      + 'around 10:1 instead of black-on-white’s 21:1; and warm, so it throws off '
      + 'less blue at night. Ambient light still matters more than any of it — match '
      + 'the screen to the room.'),
    h('div', { class: 'props', style: { marginTop: '16px' } },
      colorRow('Page', 'paper', '--paper'),
      colorRow('Cards', 'surface', '--surface'),
      colorRow('Accent', 'accent', '--accent'),
      colorRow('Text', 'ink', '--ink')),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('Heading font', fontSelect('heading')),
      field('Body font', fontSelect('body'))),
    field('Custom font name (installed on this device)', h('input', {
      type: 'text', placeholder: 'e.g. Avenir Next, Iowan Old Style', value: s.fonts.custom || '',
      oninput: debounce((e) => { commit(() => { s.fonts.custom = e.target.value; }); applyAppearance(); }, 400)
    })),
    field(`Text size — ${Math.round(s.scale * 100)}%`, h('input', {
      type: 'range', min: '0.85', max: '1.3', step: '0.05', value: s.scale, style: { padding: 0 },
      oninput: (e) => { commit(() => { s.scale = +e.target.value; }); applyAppearance(); },
      onchange: () => navigate()
    })),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('Week starts on', h('select', { onchange: (e) => { commit(() => { s.weekStart = +e.target.value; }); navigate(); } },
        h('option', { value: '1', selected: s.weekStart === 1 }, 'Monday'),
        h('option', { value: '0', selected: s.weekStart === 0 }, 'Sunday'))),
      field('Clock', h('select', { onchange: (e) => { commit(() => { s.hour12 = e.target.value === '12'; }); navigate(); } },
        h('option', { value: '12', selected: s.hour12 }, '12-hour'),
        h('option', { value: '24', selected: !s.hour12 }, '24-hour')))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('Day grid starts', hourSelect('dayStart')),
      field('Day grid ends', hourSelect('dayEnd'))),
    /* The one setting here that deletes something, so it says both what and
       when — "at the reset" means nothing without the hour beside it. */
    toggle(
      `Clear finished work at the ${fmtTime(fromMin(DAY_RESET_HOUR * 60), s.hour12)} day reset`,
      'Anything ticked before the reset is deleted. Today’s stays until tomorrow.',
      s.sweepDone !== false,
      (v) => { commit(() => { s.sweepDone = v; }); navigate(); }),
    h('button', {
      class: 'btn ghost', style: { marginTop: '10px' },
      onclick: () => {
        commit(() => { s.theme = 'graphite'; s.colors = {}; s.fonts = { heading: '', body: '', custom: '' }; s.scale = 1; });
        applyAppearance(); navigate(); toast('Appearance reset.');
      }
    }, 'Reset appearance')
  ]));

  /* ---------- data ---------- */
  const fileInput = h('input', {
    type: 'file', accept: 'application/json', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        const merge = await confirmDialog('Merge or replace?',
          'Merge keeps what is already here and adds anything new. Replace overwrites this device.', 'Merge');
        importJson(text, { merge });
        toast(merge ? 'Backup merged.' : 'Backup restored.');
        navigate();
      } catch (err) { toast('That file could not be read: ' + err.message); }
      e.target.value = '';
    }
  });

  p.append(section('Data', [
    h('p', { style: { fontSize: '13px', color: 'var(--ink-2)', margin: '0 0 12px' } },
      `Everything lives in this browser's storage: ${state.items.length} tasks and ${state.areas.length} areas. Export before you clear site data.`),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn primary', onclick: () => {
          const blob = new Blob([exportJson()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `planner-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
      }, 'Export backup'),
      h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Restore from file'),
      fileInput,
      h('button', {
        class: 'btn ghost danger', onclick: async () => {
          if (await confirmDialog('Erase everything on this device?', 'Tasks, areas, and settings. Export first if you want them back.', 'Erase')) {
            localStorage.removeItem('semesterPlanner.v1');
            location.reload();
          }
        }
      }, 'Erase all data')),
    backupList()
  ]));

  /* ---------- Canvas ----------
     As a file, or by itself. Instructure sends no CORS headers, so the feed
     URL cannot be read from here; a file needs nothing kept anywhere, and the
     link, which carries a token, goes to the user's own row on the server and
     is fetched there by the canvas-feed function. It is never put in state. */
  function tellImport(res) {
    const bits = [];
    if (res.added) bits.push(`${res.added} new`);
    if (res.updated) bits.push(`${res.updated} updated`);
    if (!bits.length) bits.push('nothing new');
    toast(`Canvas: ${bits.join(', ')}${res.unfiled.length ? ` · ${res.unfiled.length} to file` : ''}`, { ms: 5000 });
    if (res.unfiled.length) {
      toast(`Unfiled: ${res.unfiled.slice(0, 3).join(' · ')}${res.unfiled.length > 3 ? ' …' : ''} — move one and the rest of its course go along.`, { ms: 9000 });
    }
  }
  const icsInput = h('input', {
    type: 'file', accept: '.ics,text/calendar', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const res = importCanvas(await f.text());
        navigate();
        tellImport(res);
      } catch (err) {
        toast('That did not read as a calendar file.');
        console.warn('canvas import', err);
      }
      e.target.value = '';
    }
  });
  const fromCanvas = state.items.filter((t) => t.canvasId).length;

  const feedIn = h('input', { type: 'url', placeholder: 'https://….instructure.com/feeds/calendars/user_….ics', autocomplete: 'off' });
  const feedStatus = h('div', { class: 'eyebrow' });
  const feedBtns = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });
  const feedErr = (err) => { toast(C.describeSyncError(err), { ms: 8000 }); console.warn('canvas feed', err); };
  const refreshNow = async () => {
    toast('Fetching…');
    try {
      const res = await refreshFeed();
      if (res) tellImport(res); else toast('No feed link saved.');
    } catch (err) { feedErr(err); }
    paintFeed();
  };
  function paintFeed() {
    clear(feedBtns);
    if (!C.isSignedIn()) {
      feedStatus.textContent = 'Sign in to cloud sync first: the link is kept in your own row there.';
      return;
    }
    feedBtns.append(h('button', {
      class: 'btn primary', onclick: async () => {
        const url = feedIn.value.trim();
        if (!isFeedUrl(url)) { toast('That is not a Canvas feed link: https, on your school’s instructure.com.', { ms: 6000 }); return; }
        try {
          await C.saveFeedUrl(url);
          feedIn.value = '';
          feedKnown = new Date().toISOString();
          await refreshNow();
        } catch (err) { feedErr(err); }
      }
    }, 'Save link'));
    if (feedKnown === null) {
      feedStatus.textContent = 'Checking…';
      C.feedSaved().then((at) => { feedKnown = at || false; paintFeed(); })
        .catch((err) => { feedStatus.textContent = C.describeSyncError(err); });
      return;
    }
    if (!feedKnown) { feedStatus.textContent = 'No link saved yet.'; return; }
    const at = s.canvasFeedAt;
    feedStatus.textContent = 'Link saved'
      + (at ? ` · brought in ${new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '');
    feedBtns.append(
      h('button', { class: 'btn', onclick: refreshNow }, 'Refresh now'),
      h('button', {
        class: 'btn ghost', onclick: async () => {
          try { await C.saveFeedUrl(''); feedKnown = false; toast('Link forgotten.'); paintFeed(); }
          catch (err) { feedErr(err); }
        }
      }, 'Forget link'));
  }
  p.append(section('Canvas', [
    h('p', { style: { fontSize: '13px', color: 'var(--ink-2)', margin: '0 0 8px' } },
      'Every assignment in your Canvas feed becomes a deadline in the right course. '
      + 'Bring the feed in again whenever you like: what you have already filed, ticked or written on stays as it is.'),
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '0 0 12px' } },
      'In Canvas: Calendar → Calendar Feed → open the link → save the .ics file. Then pick it here.'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', onclick: () => icsInput.click() }, 'Import feed file'),
      icsInput,
      fromCanvas ? h('span', { class: 'eyebrow num' }, `${fromCanvas} from Canvas`) : null),
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '12px 0 0' } },
      'Or let it fetch the feed for you: copy the Calendar Feed link and paste it here. The link is kept in your own row on the server, '
      + 'never on this device, and a small function there reads Canvas for you, once a day and whenever you press Refresh. Deploy it once from the repo: ',
      h('code', { class: 'mono' }, 'supabase functions deploy canvas-feed'),
      ', after running ',
      h('code', { class: 'mono' }, 'supabase/upgrade.sql'),
      '.'),
    field('Feed link', feedIn),
    feedBtns,
    feedStatus
  ]));
  paintFeed();

  /* ---------- version history ----------
     Last on the page on purpose: it answers "what am I running, and what
     changed" and nothing else, and that is a question you go looking for. */
  const [current, ...older] = CHANGELOG;
  p.append(section(`Version ${APP_VERSION}`, [
    release(current),
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '2px 0 0' } },
      'This is the version this browser has actually loaded — the offline shell is '
      + 'cached whole, one deploy at a time. A new one takes over on the next reload.'),
    older.length
      ? h('details', { class: 'history' },
        h('summary', {}, `Earlier versions (${older.length})`),
        ...older.map(release))
      : null
  ]));

  root.append(p);
}

/** One deploy: what it was called, when it landed, and what changed. */
function release(r) {
  return h('div', { class: 'release' },
    h('div', { class: 'release-h' },
      h('span', { class: 'ver-tag' }, r.version),
      h('h3', {}, r.title),
      h('span', { class: 'eyebrow num', style: { marginLeft: 'auto' } }, r.date)),
    h('ul', {}, ...r.notes.map((n) => h('li', {}, n))));
}

/* ---------- bits ---------- */

/* Copies this device kept on its own.
   Sync is fan-out, not safety: a bad row reaches every device in seconds and
   the server keeps no history. These are taken before the app touches
   anything — one a day, plus one the moment a schema upgrade is about to run,
   which is when every row changes shape at once. They never leave the device
   and nothing that syncs can reach them. */

/** Bytes this origin holds in localStorage — a phone's quota is about 5 MB. */
function storageUsed() {
  let n = 0;
  try {
    for (const k of Object.keys(localStorage)) n += (k.length + (localStorage.getItem(k) || '').length) * 2;
  } catch { /* blocked */ }
  return n;
}

function backupList() {
  const backups = listBackups();
  const mb = (storageUsed() / 1048576).toFixed(1);
  const room = h('p', { style: { fontSize: '12.5px', color: C.cloud.storageFull ? 'var(--danger)' : 'var(--ink-3)', margin: '6px 0 0' } },
    `${mb} MB held on this device.`
    + (C.cloud.storageFull ? ' That is all it will hold: sync cannot remember what it sent, so it sends everything. Save a copy, then free some space.' : ''));
  if (!backups.length) return room;

  const rows = backups.map((b) => {
    const pre = b.label.startsWith('before-');
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' } },
      h('span', { class: 'num', style: { fontSize: '12.5px', minWidth: '110px' } },
        pre ? 'before ' + b.label.slice(7) : b.label),
      h('span', { style: { fontSize: '12px', color: 'var(--ink-3)', flex: 1 } },
        pre ? 'taken as the upgrade ran' : `${Math.round(b.size / 1024)} KB`),
      h('button', {
        class: 'btn sm', onclick: () => {
          const text = readBackup(b.key);
          if (!text) return toast('That copy is gone.');
          const blob = new Blob([text], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `planner-${b.label}.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
      }, 'Save'));
  });

  return h('div', { style: { marginTop: '6px' } },
    h('div', { class: 'eyebrow', style: { marginBottom: '4px' } }, 'Copies kept on this device'),
    h('p', { style: { fontSize: '12.5px', color: 'var(--ink-3)', margin: '0 0 6px' } },
      'Taken before anything is read, so a bad sync cannot reach them. Save one, '
      + 'then Restore from file to put it back.'),
    ...rows, room);
}

/* The zone a class schedule is written in.
   The app asks by itself when a device turns up somewhere new, but that only
   works for times it saw stamped. Anything imported before there was a stamp
   claims whichever zone first read it, so this is where a wrong claim is put
   right — and where a shift can be made on purpose, without moving house. */

function zoneRow(navigate) {
  const claimed = scheduleZones();
  if (!claimed.length) return null;
  const from = claimed[0];
  const options = [...new Set([...claimed, tz(), ...zoneChoices()])];
  const note = h('div', { class: 'eyebrow', style: { marginTop: '6px' } });
  const paint = (pick) => {
    const mins = zoneShift(pick, tz());
    note.textContent = pick === from
      ? `Shown as written. This device is on ${zoneLabel(tz())}.`
      : mins
        ? `Every class moves ${fmtDuration(Math.abs(mins))} ${mins > 0 ? 'later' : 'earlier'}.`
        : 'Same clock — nothing moves.';
  };
  paint(from);

  const pick = h('select', {
    onchange: (e) => {
      /* Two steps, and the order is the whole of it: first agree that the
         times mean `said` — a relabel, nothing moves — and only then read
         them here, which is the shift. Doing it the other way round would
         move times that were never in the zone they were leaving. */
      const said = e.target.value;
      const moved = zoneShift(said, tz());
      commit(() => { stampSchedules(said); shiftSchedules(said, tz()); });
      toast(moved
        ? `Class times moved ${fmtDuration(Math.abs(moved))} ${moved > 0 ? 'later' : 'earlier'}.`
        : 'Class times unchanged.', {
        action: 'Undo',
        onAction: () => {
          commit(() => { shiftSchedules(tz(), said); stampSchedules(from); });
          navigate();
        }
      });
      navigate();
    }
  }, ...options.map((z) => h('option', { value: z, selected: z === from }, zoneLabel(z) + ' — ' + z)));
  pick.addEventListener('input', (e) => paint(e.target.value));

  return h('div', {}, field('Class times were set in', pick), note);
}

/** A short list to choose from where the browser will not enumerate them. */
function zoneChoices() {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    if (all && all.length) return all;
  } catch { /* older browsers answer with the ones people actually move between */ }
  return [
    'America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago',
    'America/New_York', 'America/Halifax', 'Europe/London', 'Europe/Paris',
    'Europe/Berlin', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC'
  ];
}

function section(title, children) {
  return h('section', { class: 'card', style: { marginBottom: '18px' } },
    h('div', { class: 'card-h' }, h('h2', {}, title)),
    h('div', { class: 'card-b', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, ...children));
}

function field(label, control) {
  return h('div', { class: 'field' }, h('label', {}, label), control);
}

function toggle(label, help, value, onchange) {
  return h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', marginTop: '4px' } },
    h('input', { type: 'checkbox', class: 'check', checked: value, onchange: (e) => onchange(e.target.checked) }),
    h('span', {}, h('div', { style: { fontSize: '13.5px' } }, label),
      h('div', { style: { fontSize: '12.5px', color: 'var(--ink-3)' } }, help)));
}

function fontSelect(role) {
  const s = state.settings;
  return h('select', {
    onchange: (e) => { commit(() => { s.fonts[role] = e.target.value; }); applyAppearance(); }
  }, ...FONT_STACKS.map((f) => h('option', { value: f.value, selected: s.fonts[role] === f.value }, f.label)));
}

function hourSelect(key) {
  const s = state.settings;
  return h('select', { onchange: (e) => { commit(() => { s[key] = +e.target.value; }); } },
    ...Array.from({ length: 25 }, (_, i) => h('option', { value: i, selected: s[key] === i }, String(i).padStart(2, '0') + ':00')));
}
