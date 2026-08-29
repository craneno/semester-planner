# CLAUDE.md

A local-first semester planner: a static PWA (plain ES modules, no dependencies)
backed by localStorage, with optional Google Calendar and Supabase sync.

## No build step

The repo *is* the site. Edit a file, reload the page — there is nothing to
install, bundle, or transpile. Everything is native ES modules loaded from
`index.html` via `<script type="module" src="./js/app.js">`.

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Verify changes at localhost:8000 before pushing. The `Deploy` workflow only
runs `node --check` on each module — it proves the files *parse*, not that they
*work*, so a runtime error ships happily.

## Bump `VERSION` in sw.js

`sw.js` serves its `SHELL` list cache-first. If you change any file listed in
`SHELL` — including `index.html`, `css/app.css`, or any `js/**` module — bump
`VERSION` in `sw.js` in the same commit, or browsers keep serving the cached
copy and your change appears to do nothing.

Adding a new module? Add it to `SHELL` *and* bump `VERSION`.

### When a change appears not to take effect

Almost always a cache, not your code. Two different ones bite, in two places:

**In production, an open tab needs two loads.** `sw.js` is cache-first, so a tab
is served entirely from the *previous* version's cache. The first reload lets
the new worker install; the second is served by it. A tab left open for hours —
or an installed PWA window — never gets there on its own. To settle it in one
step, from DevTools console on the page:

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

That clears the worker and its asset caches only — `localStorage`, and so all
planner data, is untouched.

**Locally, `python3 -m http.server` sends no `Cache-Control`.** Chrome then
applies heuristic freshness — roughly 10% of the file's age since
`Last-Modified` — so once files are a few weeks old it stops revalidating and
serves stale modules indefinitely. `location.reload(true)` will not help; that
argument is ignored in modern browsers. Symptom: you edit a module, reload, and
watch the *old* behaviour. Serve with no-store headers when it matters:

```python
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
```

Before concluding a fix does not work, confirm the browser is running it:
`fetch('./js/ui.js?x=' + Math.random()).then(r => r.text()).then(t => console.log(t.includes('some new string')))`

## js/store.js is the source of truth

`state` in [js/store.js](js/store.js) is the one live object. Views do not keep
their own copies and there is no reducer or action layer: they mutate state
objects directly inside `commit()`, which persists to localStorage (debounced)
and notifies subscribers.

```js
commit(() => { item.done = true; item.doneAt = new Date().toISOString(); });
```

Read through the selectors (`itemById`, `itemsDueOn`, `upcoming`, `classesOn`, …)
rather than re-filtering `state.items` inline where a selector already exists.

## Cloud sync detects changes by snapshot diff

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` after each
save and compares against the hashes from the last successful sync. Changed
rows get pushed; rows that vanished become tombstones.

**This means no per-mutation bookkeeping.** Do not add "dirty" flags, change
queues, or `markChanged()` calls at mutation sites — since every view mutates
state directly inside `commit()`, any scheme requiring each call site to
remember something would rot immediately. Just mutate and commit.

Conflicts settle last-write-wins per row: `updated_at` (writing client's clock)
decides who wins, `synced_at` (server clock) is the pull cursor.

**The baseline is what was last *pushed*, not what state holds now.** Two rules
follow, and both have been regressions:

- A row missing locally is only "new from the cloud" if the baseline never had
  it. If the baseline *did* have it, it was deleted here and its tombstone has
  not gone up yet — adopting the server's live copy silently undoes the delete.
- Store the hashes `push()` actually sent, never a fresh snapshot taken after
  it returns. A delete made during the round trip would otherwise look
  already-synced, and its tombstone would never be sent at all.

There is no baseline on a device's first sync or after `resetLocalSyncState()`
("Rebuild sync"). Neither rule can apply then, so the cloud wins by design — an
unpushed local deletion does not survive a rebuild.

### Tests

`tests/sync.test.html` covers the above. There is no runner and no dependency:
serve the repo and open `/tests/sync.test.html`. It drives the real `cloud.js`
with a stand-in Supabase client injected through the `_setClient()` seam.

It refuses to run anywhere but localhost and restores `localStorage` when it
finishes, because it clobbers app state as it runs. If you add to it, keep both
guards — and remember `save()` is debounced 120ms and `pushSoon` 1500ms, so the
restore has to wait those out or they overwrite it. `tests/` is excluded from
the deploy so the page never reaches the live site.

## Never sync device credentials

`snapshotRows()` must never emit Google tokens, Supabase URL/anon key, or sync
cursors. Those belong to the device, not the account. Settings are synced by
explicit allowlist — `SYNCED_SETTINGS` in [js/store.js](js/store.js) — so
`state.settings.gcal` and `state.settings.cloud` stay local by construction.
When adding a setting, decide which side of that line it falls on; only add it
to `SYNCED_SETTINGS` if it is user preference, not device credential.

## Adding a field to a task

1. Add it to the object literal in `upsertItem()` in `js/store.js`.
2. Add a fallback in `migrate()` so existing saved data still loads.
3. Add a row to the properties list in `js/editor.js`.

Cloud sync ships whatever shape the object has, so nothing else is needed.

## Where things live

| I want to change… | Edit |
|---|---|
| how a screen looks | `js/views/<screen>.js` |
| shell, router, quick add | `js/app.js` |
| toasts, modals, peek panel, drag | `js/ui.js` |
| colours, spacing, the week grid | `css/app.css` |
| what a task stores | `js/store.js`, then `js/editor.js` |
| the task detail panel | `js/editor.js` |
| Google Calendar behaviour | `js/gcal.js` |
| Supabase sync | `js/cloud.js` and `supabase/schema.sql` |
| themes and fonts | `js/appearance.js` |

## Conventions

- Calendar days are `'YYYY-MM-DD'` strings in **local** time; times of day are
  `'HH:MM'` 24h strings; timestamps are ISO strings. See `js/util.js`.
- Build DOM with the `h()` helper from `js/util.js`, not template strings.
- No framework, no JSX, no TypeScript. Match the surrounding style.
