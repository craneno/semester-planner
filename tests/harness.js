// tests/harness.js — the whole test framework. No runner, no dependencies.
//
// Suites drive the real modules, which means they overwrite planner state as
// they run. Two guards make that safe: they refuse to run anywhere but
// localhost, and localStorage is put back exactly as it was found.

const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** store.js reads localStorage once, at import. A fresh query string gets a
 *  fresh module instance, which is the only way to exercise migrate(). */
let nonce = 0;
export const freshStore = () => import(`../js/store.js?t=${++nonce}`);

/**
 * @param {string} title   shown at the top of the page
 * @param {(t) => Promise<void>} body  receives { check, log, freshStore }
 */
export async function suite(title, body) {
  const out = document.createElement('div');
  document.body.append(out);
  const line = (msg, cls = '') => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = msg;
    out.append(el);
  };

  document.title = title;
  const head = document.createElement('h1');
  head.textContent = title;
  document.body.insertBefore(head, out);

  if (!LOCAL) {
    line('Refusing to run outside localhost — this suite overwrites planner state.', 'fail');
    return report(title, 1, 0);
  }

  let failed = 0, passed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { passed++; line(`PASS  ${name}`, 'pass'); }
    else { failed++; line(`FAIL  ${name} ${detail}`, 'fail'); }
  };

  const backup = { ...localStorage };
  try {
    await body({ check, log: line, freshStore });
  } catch (e) {
    failed++;
    line(`ERROR ${e.message}`, 'fail');
    console.error(e);
  } finally {
    // store.js debounces save() by 120ms and cloud.js pushSoon by 1500ms.
    // Restoring before those fire just lets them overwrite the restore.
    await new Promise((r) => setTimeout(r, 2000));
    localStorage.clear();
    for (const [k, v] of Object.entries(backup)) localStorage.setItem(k, v);
  }

  const el = document.createElement('div');
  el.className = 'total ' + (failed ? 'fail' : 'pass');
  el.textContent = failed ? `${failed} FAILURE(S), ${passed} passed` : `ALL PASS (${passed})`;
  out.append(el);
  return report(title, failed, passed);
}

/** Let tests/index.html aggregate suites it runs in iframes. */
function report(title, failed, passed) {
  const result = { suite: title, failed, passed };
  window.__result = result;
  if (window.parent !== window) window.parent.postMessage({ testResult: result }, '*');
  return result;
}

/**
 * Seed localStorage with a planner payload, then load a store that reads it.
 *
 * Verified rather than timed. Every instance a suite has finished with is
 * garbage, but a `save()` it scheduled is not: store.js debounces by 120ms and
 * `import()` is asynchronous, so a leftover timer can land *between* the seed
 * and the module that reads it, handing the new instance the old fixture's
 * state. Sleeping past the debounce only narrows the window — under the twelve
 * iframes of tests/index.html the timers are throttled and it opens again,
 * which is how this suite passed alone and failed in the runner.
 *
 * So: write, load, and check the payload is still the one in storage. If it is
 * not, something wrote over it, and the instance just built read that instead.
 * Throw it away and take a fresh one.
 */
export async function storeWith(raw) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const written = seed(raw);
    const mod = await freshStore();
    if (localStorage.getItem(KEY) === written) return mod;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('storeWith: a stale save() kept clobbering the fixture');
}

/**
 * Same, but returns the *canonical* store module — the instance gcal.js and
 * cloud.js import. A fresh instance has its own `state`, so a suite that pokes
 * state and then calls into another module has to share this one or the two
 * never see each other. Only usable before anything else imports store.js.
 */
export async function sharedStoreWith(raw) {
  // no retry is possible here — import() caches, so a second call hands back
  // the instance already built. Safe because a suite calls this before it has
  // committed anything, so there is no save() of its own in flight yet.
  seed(raw);
  return import('../js/store.js');
}

const KEY = 'semesterPlanner.v1';

/** Write a payload for the next store instance to read; returns what it wrote. */
function seed(raw) {
  if (raw === null) { localStorage.removeItem(KEY); return null; }
  const json = JSON.stringify(raw);
  localStorage.setItem(KEY, json);
  return json;
}
