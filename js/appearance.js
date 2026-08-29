// appearance.js — themes and typography, applied as CSS variables.
// Course colors live on the areas themselves and are never touched here.

import { state } from './store.js';
import { readableOn, hexAlpha } from './util.js';

export const THEMES = {
  graphite: { label: 'Graphite', swatch: '#35566B' },
  linen:    { label: 'Linen',    swatch: '#8A6A4B' },
  sage:     { label: 'Sage',     swatch: '#4E6E58' },
  rose:     { label: 'Rose',     swatch: '#8E5560' },
  lavender: { label: 'Lavender', swatch: '#61568A' },
  bluebell: { label: 'Bluebell', swatch: '#3B5F82' },
  butter:   { label: 'Butter',   swatch: '#8A7328' },
  ink:      { label: 'Ink (dark)', swatch: '#7FA8C4' }
};

export const FONT_STACKS = [
  { label: 'System (default)', value: '' },
  { label: 'System serif', value: 'ui-serif, Georgia, Cambria, "Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Baskerville / Palatino', value: 'Baskerville, "Palatino Linotype", Palatino, serif' },
  { label: 'Iowan Old Style', value: '"Iowan Old Style", "Constantia", Georgia, serif' },
  { label: 'Helvetica Neue', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Avenir Next', value: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", system-ui, sans-serif' },
  { label: 'Monospace', value: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace' }
];

export function applyAppearance() {
  const s = state.settings;
  const root = document.documentElement;

  root.dataset.theme = s.theme || 'graphite';
  root.style.setProperty('--scale', String(s.scale || 1));

  // clear previous overrides, then reapply
  for (const v of ['--paper', '--surface', '--surface-2', '--accent', '--accent-soft', '--accent-ink', '--ink', '--ink-2', '--ink-3']) {
    root.style.removeProperty(v);
  }
  const c = s.colors || {};
  if (c.paper) { root.style.setProperty('--paper', c.paper); }
  if (c.surface) {
    root.style.setProperty('--surface', c.surface);
    root.style.setProperty('--surface-2', c.surface);
  }
  if (c.accent) {
    root.style.setProperty('--accent', c.accent);
    root.style.setProperty('--accent-soft', hexAlpha(c.accent, 0.12));
    root.style.setProperty('--accent-ink', readableOn(c.accent));
  }
  if (c.ink) {
    root.style.setProperty('--ink', c.ink);
    root.style.setProperty('--ink-2', hexAlpha(c.ink, 0.68));
    root.style.setProperty('--ink-3', hexAlpha(c.ink, 0.45));
  }

  const f = s.fonts || {};
  const custom = f.custom ? `"${f.custom.replace(/"/g, '')}", ` : '';
  const baseHeading = f.heading || '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", Inter, Roboto, system-ui, sans-serif';
  const baseBody = f.body || '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Inter, Roboto, system-ui, sans-serif';
  root.style.setProperty('--font-heading', custom + baseHeading);
  root.style.setProperty('--font-body', custom + baseBody);

  // keep the installed PWA's status bar in step with the page
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--paper').trim() || '#F6F6F4';
}
