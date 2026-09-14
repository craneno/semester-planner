// @ts-check
// views/settings.js — the page, one card per file under views/settings/.
// Each section takes { navigate } and gives back its card, or a few; bits.js
// holds `section`, `field` and `toggle`, which every one of them is built from.

import { h, clear } from '../util.js';
import { renderTerm } from './settings/term.js';
import { renderGoogle } from './settings/google.js';
import { renderCloud } from './settings/cloud.js';
import { renderAppearance } from './settings/appearance.js';
import { renderData } from './settings/data.js';
import { renderReminders } from './settings/reminders.js';
import { renderSteps } from './settings/steps.js';
import { renderCalendarFile } from './settings/calendarfile.js';
import { renderCanvas } from './settings/canvas.js';
import { renderVersion } from './settings/version.js';

export function renderSettings(root, ctx) {
  clear(root);
  root.append(h('div', { class: 'pad', style: { maxWidth: '760px' } },
    h('h1', { style: { marginBottom: '16px' } }, 'Settings'),
    renderTerm(ctx),
    renderGoogle(ctx),
    renderCloud(ctx),
    renderAppearance(ctx),
    renderData(ctx),
    renderReminders(ctx),
    renderSteps(),
    renderCalendarFile(ctx),
    renderCanvas(ctx),
    renderVersion()));
}
