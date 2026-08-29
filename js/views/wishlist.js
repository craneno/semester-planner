// views/wishlist.js — things wanted, and the parcels they turn into.
//
// One list rather than a wishlist and a separate deliveries page: wanting
// something and waiting for it are the same object at two points in its life,
// so ordering it is a status change and never a retype. What is on its way
// sorts to the top by ETA, because that is the part with a clock on it.

import { h, clear } from '../util.js';
import {
  state, commit, WISH_STATUSES, WISH_IN_FLIGHT, addWish, updateWish, deleteWish,
  wishesInFlight, wishesWanted, wishesDelivered, wishTotal, etaState
} from '../store.js';
import { confirmDialog, toast } from '../ui.js';

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
    let made;
    commit(() => { made = addWish(text); });
    if (!made) { toast('Give it a name first.'); return; }
    input.value = '';
    navigate();
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
    empty: 'Nothing ordered.'
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

function section(pad, label, list, rerender, { total, empty }) {
  if (!list.length && !empty) return;
  pad.append(h('div', { class: 'group-h' },
    h('h2', {}, label),
    h('span', { class: 'eyebrow num' }, String(list.length)),
    h('div', { style: { flex: 1 } }),
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
    }, '✕'));
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
