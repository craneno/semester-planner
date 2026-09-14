// tests/smoke.mjs — the app itself, opened the way a person opens it.
//
// The suite drives the modules; this drives the page. A seeded store, every
// route, at phone size and at laptop size, in whichever browser you name:
// no uncaught error, no sideways scroll of the page, no box a phone would
// zoom the page for (under 16px), no tap target under 24px on the phone,
// and a screenshot of each route into tests/.smoke/ for the eye. Five of
// the findings in docs/bug-hunt-2026-09-04.md would have failed here.
//
//   python3 -m http.server 8000 &
//   node tests/smoke.mjs                       # Chromium
//   node tests/smoke.mjs --browser webkit      # the phone's engine

import * as pw from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const base = args.find((a) => /^https?:/.test(a)) || 'http://localhost:8000/';
const which = flag('browser', 'chromium');
const OUT = new URL('./.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ROUTES = ['overview', 'week', 'semester', 'habits', 'wishlist', 'settings', 'course', 'project', 'personal', 'area/a-cs'];
const SHAPES = [
  { name: 'phone', ...pw.devices['iPhone 13'] },
  { name: 'laptop', viewport: { width: 1366, height: 768 } }
];

/** Enough of a planner to draw every screen: two areas, a class, blocks, a
 *  deadline, a repeat, a habit with a tied task, a parcel, a note. */
async function seed(page) {
  await page.goto(base); await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const st = await import('./js/store.js');
    const u = await import('./js/util.js');
    const t = u.today(), dow = new Date(t + 'T12:00:00').getDay();
    st.commit(() => {
      st.state.semester = { name: 'Smoke term', start: u.addDays(t, -30), end: u.addDays(t, 60) };
      st.state.areas.push(
        { id: 'a-cs', name: 'CS 101', category: 'course', color: '#c33', order: 0, updatedAt: new Date().toISOString(),
          schedule: [{ days: [dow, (dow + 2) % 7], start: '09:00', end: '10:15', location: 'Room 1' }] },
        { id: 'a-proj', name: 'Side project', category: 'project', color: '#3a3', order: 1, schedule: [], updatedAt: new Date().toISOString() },
        { id: 'a-me', name: 'Gym', category: 'personal', color: '#33a', order: 2, schedule: [], updatedAt: new Date().toISOString() });
      st.upsertItem({ title: 'Block one', areaId: 'a-cs', plan: { date: t, start: '13:00', mins: 90 } });
      st.upsertItem({ title: 'Late block', areaId: 'a-proj', plan: { date: t, start: '23:00', mins: 120 } });
      st.upsertItem({ title: 'All day thing', areaId: 'a-me', plan: { date: t } });
      st.upsertItem({ title: 'Problem set', areaId: 'a-cs', due: u.addDays(t, 3), dueTime: '17:00' });
      st.upsertItem({ title: 'Daily standup', areaId: 'a-proj', plan: { date: t, start: '08:00', mins: 15 }, repeat: { freq: 'daily', every: 1 } });
      st.upsertItem({ title: 'Loose task with a fairly long title', areaId: 'a-proj' });
      const hb = st.addHabit('Lift');
      st.upsertItem({ title: 'Leg day', areaId: 'a-me', habitId: hb.id, plan: { date: u.addDays(t, 1) } });
      st.addWish('Nozzle heater $48.50 541958247270');
      st.addCard('a note to file');
      const n = st.note(t); n.focus = 'Ship it';
    });
  });
  await page.waitForTimeout(200);
}

const problems = [];
const say = (shape, route, what) => problems.push(`[${which} ${shape}] ${route}: ${what}`);

const browser = await pw[which].launch();
for (const shape of SHAPES) {
  const ctx = await browser.newContext({ ...shape, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  let route = 'boot';
  page.on('pageerror', (e) => say(shape.name, route, 'uncaught: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|serviceWorker|sw\.js/i.test(m.text())) say(shape.name, route, 'console.error: ' + m.text()); });
  await seed(page);

  for (route of ROUTES) {
    await page.goto(base + '#/' + route);
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const de = document.scrollingElement;
      const onScreen = (b) => b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
      const small = [...document.querySelectorAll('input, textarea, select')]
        .filter((el) => el.offsetParent && !['checkbox', 'radio', 'range', 'hidden'].includes(el.type))
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => (el.className || el.id || el.tagName) + '@' + getComputedStyle(el).fontSize);
      // the box a finger can land on: the shape, plus whatever around it still
      // hit-tests to the same control (a padded ::before, a label around a
      // checkbox). Probed outward, since a pseudo-element has no rect of its own.
      const hitBox = (el) => {
        const b = el.closest('label')?.getBoundingClientRect() || el.getBoundingClientRect();
        const box = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
        const mine = (x, y) => { const at = document.elementFromPoint(x, y); return !!at && (at === el || el.contains(at)); };
        for (const pad of [1, 2, 3, 4, 5, 6, 7, 8]) {
          if (mine(cx, b.top - pad)) box.top = b.top - pad;
          if (mine(cx, b.bottom + pad)) box.bottom = b.bottom + pad;
          if (mine(b.left - pad, cy)) box.left = b.left - pad;
          if (mine(b.right + pad, cy)) box.right = b.right + pad;
        }
        return { width: box.right - box.left, height: box.bottom - box.top, cx, cy };
      };
      const tiny = [...document.querySelectorAll('button, a, input[type=checkbox], [role=button]')]
        .filter((el) => el.offsetParent && onScreen(el.getBoundingClientRect()))
        // a link inside a line of text is exempt (WCAG 2.5.8), and a control
        // under another one — the parked sidebar, a closed sheet — is not tappable at all
        .filter((el) => getComputedStyle(el).display !== 'inline')
        .map((el) => [el, hitBox(el)])
        .filter(([el, h]) => { const at = document.elementFromPoint(h.cx, h.cy); return at && (at === el || el.contains(at)); })
        .filter(([, h]) => h.height < 24 || h.width < 24)
        .map(([el, h]) => `${(el.className || el.tagName).toString().split(' ')[0]}${el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 12) + '"' : ''} ${Math.round(h.width)}×${Math.round(h.height)}`);
      return {
        empty: !document.querySelector('#view')?.children.length,
        wide: de.scrollWidth > de.clientWidth + 1 ? `page scrolls sideways (${de.scrollWidth} > ${de.clientWidth})` : '',
        small: small.slice(0, 5), tiny: [...new Set(tiny)].slice(0, 8),
        title: document.title
      };
    });
    if (r.empty) say(shape.name, route, 'the view drew nothing');
    if (r.wide) say(shape.name, route, r.wide);
    if (shape.name === 'phone' && r.small.length) say(shape.name, route, 'boxes under 16px zoom the page on iOS: ' + r.small.join(', '));
    if (shape.name === 'phone' && r.tiny.length) say(shape.name, route, 'tap targets under 24px: ' + r.tiny.join(', '));
    await page.screenshot({ path: `${OUT}${which}-${shape.name}-${route.replace('/', '_')}.png` });
  }

  // the two interactions that broke on the phone before: a tap on the
  // all-day rail makes a prompt that stays; the sidebar opens and closes
  if (shape.name === 'phone') {
    route = 'week (tap the rail)';
    await page.goto(base + '#/week'); await page.waitForTimeout(400);
    const cell = await page.evaluate(() => {
      // an empty cell — a flag in one is that flag's to open — scrolled into view
      const cells = [...document.querySelectorAll('.allday-rail .cell')];
      const c = cells.find((x) => !x.children.length) || cells[0];
      c.scrollIntoView({ inline: 'center', block: 'nearest' });
      const b = c.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const at = document.elementFromPoint(x, y); return { x, y, at: at ? at.tagName + '.' + at.className : 'nothing' };
    });
    await page.touchscreen.tap(cell.x, cell.y);
    await page.waitForTimeout(150);
    const soon = await page.evaluate(() => !!document.querySelector('.modal'));
    await page.waitForTimeout(600);
    const still = await page.evaluate(() => !!document.querySelector('.modal'));
    if (!still) say(shape.name, route, soon ? 'the prompt closed itself' : `no prompt (tapped ${Math.round(cell.x)},${Math.round(cell.y)} on ${cell.at})`);
    await page.keyboard.press('Escape');
    route = 'menu';
    await page.goto(base + '#/overview'); await page.waitForTimeout(300);
    await page.tap('#menu-btn'); await page.waitForTimeout(300);
    if (!await page.evaluate(() => document.getElementById('sidebar').classList.contains('open'))) say(shape.name, route, 'the menu button did not open the menu');
    await page.tap('#nav-scrim').catch(() => {}); await page.waitForTimeout(300);
  }
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await ctx.close();
}
await browser.close();

if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`${which}: smoke passed — ${ROUTES.length} routes at ${SHAPES.map((s) => s.name).join(' and ')} size`);
