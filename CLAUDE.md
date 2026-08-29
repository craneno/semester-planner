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
