// @ts-check
// views/wishlist.js — things wanted, and the parcels they turn into.
//
// One list rather than a wishlist and a separate deliveries page: wanting
// something and waiting for it are the same object at two points in its life,
// so ordering it is a status change and never a retype. What is on its way
// sorts to the top by ETA, because that is the part with a clock on it.

import { h, clear, fmtTime } from '../util.js';
import {
  state, commit, WISH_STATUSES, WISH_IN_FLIGHT, addWish, updateWish, deleteWish,
  wishesInFlight, wishesWanted, wishesDelivered, wishTotal, etaState, CARRIERS, trackingUrl
} from '../store.js';
import { confirmDialog, toast } from '../ui.js';
import { refreshTracking, tracked } from '../tracking.js';

const STATUS_LABEL = {
  wanted: 'Wanted', ordered: 'Ordered', shipped: 'Shipped', delivered: 'Delivered'
};

const money = (n) => '$' + n.toFixed(2).replace(/\.00$/, '');

export function renderWishlist(root, { navigate }) {
  clear(root);
  const pad = h('div', { class: 'pad' });

  const flight = wishesInFlight();
  const wanted = wishesWanted();
  const delivered = wishesDelivered();

  const sub = [];
  if (flight.length) sub.push(`${flight.length} on the way`);
  if (wanted.length) sub.push(`${wanted.length} wanted`);

  pad.append(h('div', { class: 'page-h' },
    h('div', {},
      h('h1', {}, 'Wishlist'),
      h('div', { class: 'eyebrow' }, sub.join(' · ') || 'Nothing on the list')),
    h('div', { style: { flex: 1 } })));

  /* add */
  const input = h('input', {
    class: 'wish-new', 'aria-label': 'Add to the wishlist',
    placeholder: 'Nozzle heater $48.50 mcmaster.com/1234',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      submit(e.target.value);
    }
  });
  const submit = (text) => {
    /** @type {import('../types.js').Wish|null} */
    let made = null;
    commit(() => { made = addWish(text); });
    if (!made) { toast('Give it a name first.'); return; }
    input.value = '';
    navigate();
    // a tracking number is asked about at once; the answer redraws the page
    if (made.tracking) refreshTracking({ only: made.id }).then(sayTally).catch(() => {});
  };
  pad.append(h('div', { class: 'wish-add' }, input,
    h('button', {
      class: 'btn primary',
      onclick: () => (input.value.trim() ? submit(input.value) : toast('Give it a name first.'))
    }, 'Add')));

  if (!state.wishlist.length) {
    pad.append(h('div', { class: 'empty', style: { marginTop: '18px' } },
      h('h3', {}, 'Nothing on the list'),
      h('p', { style: { margin: '4px 0 0', color: 'var(--ink-2)' } },
        'Add something you want. When you buy it, move it to Ordered and give it '
        + 'an ETA — it moves to the top and counts down from there.')));
    root.append(pad);
    return;
  }

  section(pad, 'On the way', flight, navigate, {
    total: flight.length ? wishTotal(flight) : 0,
    empty: 'Nothing ordered.',
    // the carriers are asked once a day by themselves; this is for the day
    // you are waiting by the door
    action: tracked().length ? h('button', {
      class: 'btn sm', title: 'Ask the carriers where every tracked parcel is',
      onclick: (e) => {
        e.currentTarget.disabled = true;
        refreshTracking().then(sayTally).catch((err) => toast(err.message || 'Could not check.'));
      }
    }, 'Check parcels') : null
  });
  section(pad, 'Wanted', wanted, navigate, {
    total: wishTotal(wanted),
    empty: 'Nothing on the list right now.'
  });
  if (delivered.length) {
    section(pad, 'Delivered', delivered, navigate, { total: 0, empty: '' });
  }

  root.append(pad);
}

/** What a round of asking came to, in one line. */
function sayTally(t) {
  if (!t || !t.asked) return;
  const bits = [];
  if (t.delivered) bits.push(`${t.delivered} delivered`);
  if (t.moved) bits.push(`${t.moved} ${t.moved === 1 ? 'date' : 'dates'} changed`);
  if (t.failed) bits.push(`${t.failed} could not be checked`);
  toast(bits.length ? bits.join(' · ') : 'No news from the carriers.');
}

function section(pad, label, list, rerender, { total, empty, action = null }) {
  if (!list.length && !empty) return;
  pad.append(h('div', { class: 'group-h' },
    h('h2', {}, label),
    h('span', { class: 'eyebrow num' }, String(list.length)),
    h('div', { style: { flex: 1 } }),
    action,
    total ? h('span', { class: 'eyebrow num' }, money(total)) : null));

  if (!list.length) {
    pad.append(h('div', { class: 'area-none' }, empty));
    return;
  }
  for (const w of list) pad.append(wishRow(w, rerender));
}

function wishRow(w, rerender) {
  const urgency = etaState(w);

  const title = w.url
    ? h('a', {
      class: 'title link-title', href: w.url, title: w.url,
      target: '_blank', rel: 'noopener noreferrer'
    }, w.title)
    : h('span', { class: 'title' }, w.title);

  // The name is worth editing in place — a parcel often arrives called
  // something shorter than whatever the shop called it.
  const name = h('span', { class: 'wish-name' }, title,
    h('button', {
      class: 'btn sm ghost', title: 'Rename', 'aria-label': `Rename ${w.title}`,
      onclick: (e) => renameInPlace(e.currentTarget.closest('.wish-row'), w, rerender)
    }, '✎'));

  const price = h('input', {
    class: 'wish-price num', type: 'text', inputmode: 'decimal',
    value: Number.isFinite(w.price) ? String(w.price) : '',
    placeholder: '—', 'aria-label': `Price of ${w.title}`,
    onchange: (e) => {
      commit(() => updateWish(w.id, { price: e.target.value.replace(/^\$/, '') }));
      rerender();
    }
  });

  const status = h('select', {
    class: 'wish-status', 'aria-label': `Status of ${w.title}`,
    onchange: (e) => {
      commit(() => updateWish(w.id, { status: e.target.value }));
      rerender();
    }
  }, ...WISH_STATUSES.map((s) => h('option', {
    value: s, selected: s === w.status ? '' : null
  }, STATUS_LABEL[s])));

  // Only something bought and not yet here has an ETA to give.
  const eta = WISH_IN_FLIGHT.includes(w.status)
    ? h('input', {
      class: 'wish-eta' + (urgency ? ' is-' + urgency : ''), type: 'date',
      value: w.eta || '', 'aria-label': `Expected arrival of ${w.title}`,
      onchange: (e) => { commit(() => updateWish(w.id, { eta: e.target.value || null })); rerender(); }
    })
    : h('span', { class: 'wish-eta-none eyebrow' },
      w.status === 'delivered' ? 'arrived' : '');

  return h('div', { class: 'row wish-row', dataset: { wishId: w.id } },
    name,
    price,
    status,
    eta,
    h('button', {
      class: 'btn sm ghost', title: 'Remove', 'aria-label': `Remove ${w.title}`,
      onclick: async () => {
        if (await confirmDialog('Remove this?', w.title, 'Remove')) {
          commit(() => deleteWish(w.id));
          rerender();
        }
      }
    }, '✕'),
    w.tracking ? trackLine(w) : null);
}

/** "2h ago", "yesterday" — when the carrier was last asked. */
function ago(iso, now = Date.now()) {
  const mins = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  const d = Math.round(mins / (24 * 60));
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/* The carrier's line under a tracked parcel: which carrier and the number
   (a link to its page), where it is in the carrier's words, the hour it
   lands, and when we last asked. An error stays on the line, never on the
   date: a carrier that would not answer is not a parcel that is late. */
function trackLine(w) {
  const t = w.tracking;
  const hour12 = state.settings.hour12;
  const bits = [
    h('a', {
      class: 'eyebrow wish-track', href: trackingUrl(t.carrier, t.number), target: '_blank', rel: 'noopener noreferrer',
      title: 'Open on the carrier’s site'
    }, `${CARRIERS[t.carrier] || t.carrier} · ${t.number}`)
  ];
  if (t.summary) bits.push(h('span', { class: 'eyebrow' + (t.status === 'out' ? ' is-live' : '') }, t.summary));
  if (w.status !== 'delivered') {
    if (t.window) bits.push(h('span', { class: 'eyebrow num' }, `${fmtTime(t.window.from, hour12)}–${fmtTime(t.window.to, hour12)}`));
    else if (t.etaTime) bits.push(h('span', { class: 'eyebrow num' }, `by ${fmtTime(t.etaTime, hour12)}`));
  }
  if (t.error) {
    const why = /sign in|supabase url/i.test(t.error) ? 'set up cloud sync to check'
      : /not set up|not deployed/i.test(t.error) ? 'tracking is not set up on the server (README)'
        : t.error;
    bits.push(h('span', { class: 'eyebrow is-err', title: t.error }, why));
  } else if (t.checkedAt) {
    bits.push(h('span', { class: 'eyebrow', title: new Date(t.checkedAt).toLocaleString() }, `checked ${ago(t.checkedAt)}`));
  } else {
    bits.push(h('span', { class: 'eyebrow' }, 'not checked yet'));
  }
  return h('div', { class: 'wish-track' }, ...bits);
}

/** Swap the name for a box, and put it back however the edit ends. */
function renameInPlace(row, w, rerender) {
  const host = row.querySelector('.wish-name');
  if (!host) return;
  let cancelled = false;
  const box = h('input', {
    class: 'wish-rename', value: w.title, 'aria-label': 'Name',
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
      // blur fires as the redraw removes the box; the flag stops it saving
      // what was just rejected
      if (e.key === 'Escape') { e.preventDefault(); cancelled = true; rerender(); }
    },
    onblur: () => {
      if (cancelled) return;
      commit(() => updateWish(w.id, { title: box.value }));
      rerender();
    }
  });
  clear(host).append(box);
  box.focus();
  box.select();
}
