// views/settings/bits.js — the pieces every section is built from.

import { h } from '../../util.js';

export function section(title, children) {
  return h('section', { class: 'card', style: { marginBottom: '18px' } },
    h('div', { class: 'card-h' }, h('h2', {}, title)),
    h('div', { class: 'card-b', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, ...children));
}

export function field(label, control) {
  return h('div', { class: 'field' }, h('label', {}, label), control);
}

export function toggle(label, help, value, onchange) {
  return h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', marginTop: '4px' } },
    h('input', { type: 'checkbox', class: 'check', checked: value, onchange: (e) => onchange(e.target.checked) }),
    h('span', {}, h('div', { style: { fontSize: '13.5px' } }, label),
      h('div', { class: 'help' }, help)));
}
