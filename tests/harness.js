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

/** Seed localStorage with a planner payload, then load a store that reads it. */
export async function storeWith(raw) {
  if (raw === null) localStorage.removeItem('semesterPlanner.v1');
  else localStorage.setItem('semesterPlanner.v1', JSON.stringify(raw));
  return freshStore();
}
