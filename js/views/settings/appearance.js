// views/settings/appearance.js — theme, colours, fonts, the clock and the week.

import { h, debounce, fmtTime, fromMin, DAY_RESET_HOUR } from '../../util.js';
import { state, commit } from '../../store.js';
import { toast } from '../../ui.js';
import { applyAppearance, THEMES, FONT_STACKS } from '../../appearance.js';
import { section, field, toggle } from './bits.js';

export function renderAppearance({ navigate }) {
  const s = state.settings;
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

  return section('Appearance', [
    h('div', { class: 'eyebrow', style: { marginBottom: '8px' } }, 'Theme'),
    swatches,
    h('p', { class: 'help', style: { margin: '10px 0 0' } },
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
    field('Week opens at', hourSelect(navigate)),
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
  ]);
}

function fontSelect(role) {
  const s = state.settings;
  return h('select', {
    onchange: (e) => { commit(() => { s.fonts[role] = e.target.value; }); applyAppearance(); }
  }, ...FONT_STACKS.map((f) => h('option', { value: f.value, selected: s.fonts[role] === f.value }, f.label)));
}

/* The week draws all 24 hours; `dayStart` is only where it opens. */
function hourSelect(navigate) {
  const s = state.settings;
  return h('select', {
    onchange: (e) => { commit(() => { s.dayStart = +e.target.value; }); navigate?.(); }
  },
  ...Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: s.dayStart === i }, String(i).padStart(2, '0') + ':00')));
}
