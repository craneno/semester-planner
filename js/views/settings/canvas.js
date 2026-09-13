// views/settings/canvas.js — the Canvas feed, as a file or by itself.
// Instructure sends no CORS headers, so the feed URL cannot be read from
// here; a file needs nothing kept anywhere, and the link, which carries a
// token, goes to the user's own row on the server and is fetched there by
// the canvas-feed function. It is never put in state.

import { h, clear } from '../../util.js';
import { state } from '../../store.js';
import { toast } from '../../ui.js';
import * as C from '../../cloud.js';
import { importCanvas, refreshFeed, isFeedUrl } from '../../canvas.js';
import { warn } from '../../problems.js';
import { section, field } from './bits.js';

// whether a Canvas feed link is saved on the server: null until asked, then
// the time it was set or false. Kept here so a redraw does not ask again
let feedKnown = null;

export function renderCanvas({ navigate }) {
  const s = state.settings;
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
        warn('canvas import', err);
      }
      e.target.value = '';
    }
  });
  const fromCanvas = state.items.filter((t) => t.canvasId).length;

  const feedIn = h('input', { type: 'url', placeholder: 'https://….instructure.com/feeds/calendars/user_….ics', autocomplete: 'off' });
  const feedStatus = h('div', { class: 'eyebrow' });
  const feedBtns = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });
  const feedErr = (err) => { toast(C.describeSyncError(err), { ms: 8000 }); warn('canvas feed', err); };
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

  const card = section('Canvas', [
    h('p', { style: { fontSize: '13px', color: 'var(--ink-2)', margin: '0 0 8px' } },
      'Every assignment in your Canvas feed becomes a deadline in the right course. '
      + 'Bring the feed in again whenever you like: what you have already filed, ticked or written on stays as it is.'),
    h('p', { class: 'help', style: { margin: '0 0 12px' } },
      'In Canvas: Calendar → Calendar Feed → open the link → save the .ics file. Then pick it here.'),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', onclick: () => icsInput.click() }, 'Import feed file'),
      icsInput,
      fromCanvas ? h('span', { class: 'eyebrow num' }, `${fromCanvas} from Canvas`) : null),
    h('p', { class: 'help', style: { margin: '12px 0 0' } },
      'Or let it fetch the feed for you: copy the Calendar Feed link and paste it here. The link is kept in your own row on the server, '
      + 'never on this device, and a small function there reads Canvas for you, once a day and whenever you press Refresh. Deploy it once from the repo: ',
      h('code', { class: 'mono' }, 'supabase functions deploy canvas-feed'),
      ', after running ',
      h('code', { class: 'mono' }, 'supabase/upgrade.sql'),
      '.'),
    field('Feed link', feedIn),
    feedBtns,
    feedStatus
  ]);
  paintFeed();
  return card;
}
