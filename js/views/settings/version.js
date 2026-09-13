// views/settings/version.js — what is running, what changed, what went wrong.
// Last on the page on purpose: each answers a question you go looking for.

import { h, clear } from '../../util.js';
import { CHANGELOG, APP_VERSION } from '../../changelog.js';
import { problems, clearProblems } from '../../problems.js';
import { section } from './bits.js';

export function renderVersion() {
  const [current, ...older] = CHANGELOG;
  return [
    section(`Version ${APP_VERSION}`, [
      release(current),
      h('p', { class: 'help', style: { margin: '2px 0 0' } },
        'This is the version this browser has actually loaded — the offline shell is '
        + 'cached whole, one deploy at a time. A new one takes over on the next reload.'),
      older.length
        ? h('details', { class: 'history' },
          h('summary', {}, `Earlier versions (${older.length})`),
          ...older.map(release))
        : null
    ]),
    problemsCard()
  ];
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

/* The last things that went wrong here. A sync that failed, a feed that
   would not read, a page that broke: each was a console.warn, which is gone
   once DevTools closes, and a phone has none. So `js/problems.js` keeps the
   last twenty on the device, and this is where they are read. */
function problemsCard() {
  const box = h('div', {});
  const paint = () => {
    clear(box);
    const rows = problems();
    if (!rows.length) { box.append(h('p', { class: 'help', style: { margin: 0 } }, 'Nothing has gone wrong on this device.')); return; }
    for (const r of rows) {
      box.append(h('div', { class: 'problem' },
        h('span', { class: 'num' }, new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
        h('span', { class: 'eyebrow' }, r.tag),
        h('span', { class: 'what' }, r.text)));
    }
    box.append(h('button', { class: 'btn sm ghost', style: { marginTop: '8px' }, onclick: () => { clearProblems(); paint(); } }, 'Clear'));
  };
  paint();
  return section('Problems', [
    h('p', { class: 'help', style: { margin: 0 } },
      'The last twenty things that went wrong on this device — a sync that failed, a feed that would not read, a page that broke. Kept here, since the console is gone once it is closed.'),
    box
  ]);
}
