// tests/run.mjs — the suite, headless, for the Deploy job.
//
// Opens tests/index.html in Chromium, waits for the total, prints every
// failing line from every file, and exits non-zero on any failure. The suites
// themselves are unchanged: this is a browser pointed at the same page you
// open by hand, so what passes here is what passes there.
//
//   npm i --no-save playwright && npx playwright install --with-deps chromium
//   python3 -m http.server 8000 &
//   node tests/run.mjs http://localhost:8000/tests/

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8000/tests/';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));

await page.goto(url);
await page.waitForSelector('.total', { timeout: 300_000 });
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
console.log(total);

await browser.close();
process.exit(/FAILURE/.test(total) ? 1 : 0);
