// tests/run.mjs — the suite, headless, for the Deploy job and for you.
//
// Opens tests/index.html in a browser, waits for the page to finish, prints
// every failing line from every file, and exits non-zero on any failure —
// or on any uncaught error in any frame, since a test that throws outside a
// check and still counts as passed is not a gate. The suites themselves are
// unchanged: this is a browser pointed at the same page you open by hand.
//
//   npm i --no-save playwright && npx playwright install --with-deps chromium webkit
//   python3 -m http.server 8000 &
//   node tests/run.mjs                                   # Chromium
//   node tests/run.mjs --browser webkit                  # the phone's engine
//   node tests/run.mjs http://localhost:8123/tests/      # another port

import * as pw from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = args.find((a) => /^https?:/.test(a)) || 'http://localhost:8000/tests/';
const which = flag('browser', 'chromium');
if (!pw[which]) { console.error(`no such browser: ${which} (chromium, webkit, firefox)`); process.exit(2); }

const browser = await pw[which].launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => {
  const where = (e.stack || '').split('\n').find((l) => /localhost/.test(l)) || '';
  errors.push(`${e.message}  ${where.trim()}`);
});

await page.goto(url);
// the total is on the page from the start, saying "running…"; wait for the count
await page.waitForFunction(
  () => { const t = document.querySelector('.total'); return t && !/running/i.test(t.textContent); },
  null, { timeout: 300_000 }
);
const total = await page.textContent('.total');

const perFile = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => {
  try {
    const text = f.contentDocument.body.innerText;
    return [f.src.split('/').pop(), text.split('\n').filter((l) => /^(FAIL|ERROR)|FAILURE/.test(l))];
  } catch { return [f.src, ['(could not read the frame)']]; }
}));
for (const [file, lines] of perFile) {
  if (lines.length) console.log(`${file}\n  ${lines.join('\n  ')}`);
}
if (errors.length) {
  console.log(`${errors.length} uncaught error(s) on the page:`);
  for (const e of errors) console.log('  ' + e);
}
console.log(`${which}: ${total}`);

await browser.close();
process.exit(/FAILURE/.test(total) || errors.length ? 1 : 0);
