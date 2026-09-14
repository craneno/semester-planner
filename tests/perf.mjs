// tests/perf.mjs — what a term-sized planner costs, in numbers, so a change
// meant to make it faster has a before and an after instead of a feeling.
//
// Seeds 1,500 tasks, 120 days of notes and eight areas, then times: one
// commit with its undo snapshot, a save, and a full redraw of each heavy
// view, ten times over, on the phone's viewport. Prints a table. Nothing is
// asserted; compare against the last run.
//
//   python3 -m http.server 8000 &
//   node tests/perf.mjs [--browser webkit] [--items 3000]

import * as pw from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const base = args.find((a) => /^https?:/.test(a)) || 'http://localhost:8000/';
const which = flag('browser', 'chromium');
const ITEMS = +flag('items', 1500);

const browser = await pw[which].launch();
const ctx = await browser.newContext({ ...pw.devices['iPhone 13'], timezoneId: 'America/New_York' });
const page = await ctx.newPage();
await page.goto(base); await page.waitForTimeout(300);

const seeded = await page.evaluate(async (ITEMS) => {
  const st = await import('./js/store.js'); const u = await import('./js/util.js');
  const t = u.today();
  st.commit(() => {
    for (let a = 0; a < 8; a++) {
      st.state.areas.push({ id: 'a' + a, name: 'Area ' + a, category: a < 4 ? 'course' : 'project', color: '#3a6', order: a,
        schedule: a < 4 ? [{ days: [1, 3], start: '09:00', end: '10:15' }] : [], updatedAt: new Date().toISOString() });
    }
    for (let i = 0; i < ITEMS; i++) {
      st.upsertItem({
        title: 'Task ' + i + ' with a title of ordinary length', areaId: 'a' + (i % 8), notes: 'some notes '.repeat(5),
        plan: i % 3 ? { date: u.addDays(t, (i % 90) - 45), start: '09:00', mins: 60 } : null,
        due: i % 3 ? null : u.addDays(t, (i % 60) - 20)
      });
    }
    for (let d = 0; d < 120; d++) {
      const n = st.note(u.addDays(t, -d));
      n.text = 'evening notes '.repeat(20); n.journal = { a0: 'journal '.repeat(40) };
    }
  });
  const time = (fn, n = 10) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return +((performance.now() - t0) / n).toFixed(2); };
  return {
    items: st.state.items.length,
    stateKB: Math.round(JSON.stringify(st.state).length / 1024),
    // the snapshot is taken only when a commit is not coalesced with the
    // last, so each timed commit is 900ms apart in the store's eyes
    commitMs: time(() => { st.undoSettings.coalesceMs = 0; st.commit(() => { st.state.items[0].title = 'x' + Math.random(); }); st.undoSettings.coalesceMs = 800; }),
    // the same commit, saying what it touches: undo copies that key alone
    commitTouchesMs: time(() => { st.undoSettings.coalesceMs = 0; st.commit(() => { st.state.notes[t].text += '.'; }, { touches: ['notes'] }); st.undoSettings.coalesceMs = 800; }),
    saveMs: time(() => JSON.stringify(st.state), 5)
  };
}, ITEMS);

const rows = [];
for (const view of ['overview', 'week', 'semester', 'course', 'habits']) {
  await page.goto(base + '#/' + view); await page.waitForTimeout(300);
  rows.push(await page.evaluate((view) => {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) window.dispatchEvent(new HashChangeEvent('hashchange'));
    return { view, redrawMs: +((performance.now() - t0) / 10).toFixed(1), nodes: document.querySelectorAll('*').length };
  }, view));
}
await browser.close();

console.log(`${which} · ${seeded.items} tasks · state ${seeded.stateKB} KB`);
console.log(`commit + undo snapshot  ${seeded.commitMs} ms   (touches: ['notes']  ${seeded.commitTouchesMs} ms)`);
console.log(`save (stringify)        ${seeded.saveMs} ms`);
for (const r of rows) console.log(`redraw ${r.view.padEnd(10)} ${String(r.redrawMs).padStart(6)} ms   ${r.nodes} nodes`);
