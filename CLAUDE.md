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

The install handler fetches with `cache: 'reload'` so the new cache is filled
from the network. Keep it that way — a plain `c.add(u)` reads through the HTTP
cache, and since Pages sends `max-age=600` a freshly bumped `VERSION` can be
populated with the very files it was bumped to replace.

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

**Do not verify with a cache-busting query string.** `sw.js` matches with
`ignoreSearch: true`, so `?x=Math.random()` is ignored and you are handed the
cached copy. `fetch(url, { cache: 'reload' })` is no better: the request still
goes through the worker, which returns its hit before touching the network. On
a controlled page both *look* like network reads and are not.

What actually tells you the truth:

- **DevTools → Application → Service workers → Bypass for network.** Page
  fetches then skip the worker entirely, so you see what the server has. This
  is the one in-browser check that is not lying to you.
- `await caches.keys()` in the console — which `VERSION` is live here.
- From outside the browser, where no worker can intercept:
  `curl -s https://craneno.github.io/semester-planner/js/cloud.js | grep -c 'some new string'`

While developing, tick **Update on reload** in that same panel. The worker then
updates every reload and the two-load behaviour above stops applying.

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

Serve the repo and open **`/tests/`** — it runs every suite and prints one
total. There is no runner and nothing to install.

| file | covers |
|---|---|
| `tests/harness.js` | the whole framework: `suite()`, the guards, `freshStore()` |
| `tests/store.test.html` | migration, categories, ordering, selectors |
| `tests/parse.test.html` | quick add: dates, time ranges, types, area matching |
| `tests/capture.test.html` | notecards, filing, card sync, the version-pinned seeds |
| `tests/gcal.test.html` | deriving a schedule from recurring calendar events |
| `tests/sync.test.html` | delete durability against a stand-in Supabase |

Suites drive the real modules, so they clobber app state as they run. Two
guards make that safe and **both must stay**: they refuse to run outside
localhost, and `localStorage` is restored afterwards. The restore waits out
`save()` (debounced 120ms) and `pushSoon` (1500ms) first — restoring before
those fire just lets them overwrite it. `tests/` is excluded from the deploy so
the pages never reach the live site.

`store.js` reads `localStorage` once, at import, so `migrate()` can only be
exercised on a fresh module instance. `freshStore()` imports it with a new
query string to get one; `storeWith(raw)` seeds storage and does that in a
step. A fresh instance has its own `state`, so a suite that pokes state and
then calls into `gcal.js` or `cloud.js` must use `sharedStoreWith()` instead —
those modules import the canonical store, and two instances never see each
other.

## Never sync device credentials

`snapshotRows()` must never emit Google tokens, Supabase URL/anon key, or sync
cursors. Those belong to the device, not the account. Settings are synced by
explicit allowlist — `SYNCED_SETTINGS` in [js/store.js](js/store.js) — so
`state.settings.gcal` and `state.settings.cloud` stay local by construction.
When adding a setting, decide which side of that line it falls on; only add it
to `SYNCED_SETTINGS` if it is user preference, not device credential.

## Areas and categories

Every area belongs to exactly one **category** — `course`, `ner`, `project`,
`personal` — defined by `AREA_CATEGORIES` in [js/store.js](js/store.js). That
list is the single source for the sidebar's top level, the overview breakdown,
and the category select in the area editor. Add an entry and it appears in all
three with no other change; add a glyph in `CATEGORY_GLYPH` in `js/app.js` too.

Categories and areas are **data, not screens**, so they are not in `VIEWS`.
`route()` in `js/app.js` resolves three shapes:

| hash | renders |
|---|---|
| `#/today` | a view from `VIEWS` |
| `#/course` | that category's page — its areas, each with its next deadlines |
| `#/area/<id>` | one area's full list |

Schema 4 filed areas under a free-form `kind`; `migrate()` maps it through
`KIND_TO_CATEGORY` and drops `kind`. Study logging (`state.sessions`,
`logSession`, the Study view) was removed in schema 5 — don't reintroduce a
sessions array without also handling the `session` rows still sitting in
existing Supabase accounts.

Areas carry an explicit **`order`**, and `areasInCategory()` sorts by it. Array
position is local — only a field on the row itself reaches another device — so
never reorder `state.areas` in place and expect it to sync. `reorderAreas()`
rewrites the numbers for one category; values are only ever compared within a
category, so they need not be unique across all areas.

Drag-to-reorder is `reorderable()` in [js/ui.js](js/ui.js), used by both the
category pages and the sidebar. It reorders the real nodes as the pointer
crosses each neighbour's midpoint — the list is its own preview, so there is no
ghost element to keep in sync. The grip must `preventDefault()` on
`pointerdown` or the browser starts a text selection and the drag reads as a
highlight.

**Seeds are pinned to the version that introduced them**, never to
`SCHEMA_VERSION`: `if (from < 5) seed('Rocket', 'project')`. Writing the guard
against `SCHEMA_VERSION` means the next bump resurrects a seed the user
deliberately deleted.

## Overview is the day

There is no Today page. Overview's left column is today as it will happen —
classes, calendar events, planned work — and the right column is what you
decide about it: focus and today's three, open work by category, the
end-of-day note. `#/today` is not a route; unknown hashes fall back to
Overview, so an old link still lands somewhere sensible.

### The day grid

Overview's left column is a real clock, not a list: all 24 hours, opened at
8am with the small hours a scroll above, so an empty afternoon reads as empty
space. Hour height is `--day-hour-h` and the JS reads that variable rather
than hard-coding it, so the mobile override stays in step.

`restoreDayScroll()` runs **synchronously after the tree is appended**, not in
a `requestAnimationFrame`. Two reasons: `scrollTop` is ignored on an element
with no layout yet, and rAF never fires at all in a background tab — which is
exactly when a restored session renders. Scroll position is remembered in a
module variable so ticking a checkbox (which re-renders the page) does not
throw away where you were; recording is gated on `trackScroll` because a
freshly mounted scroller fires `scroll` at 0 and would erase it.

## Captured notes

`state.cards` are notecards: `{ id, text, areaId, createdAt, updatedAt }`, with
`areaId: null` meaning unfiled. Distinct from `state.notes`, which is the
per-day focus text keyed by date — same word, different thing.

Capture lives in [js/capture.js](js/capture.js) and appears on Overview and on
the Notes page. Enter is the contract: it must stay the shortest path out, so
it files to unfiled and never asks a question. Shift+Enter is a newline;
everything else is one Tab away.

`cardToItem()` runs the card's text through `parseQuickAdd()`, so a capture
dates itself exactly as the top bar would. `as: 'timed'` also books a `plan`
block — **a due date alone is never pushed to Google Calendar**, only planned
work is, so the block is what puts it on the calendar.

Card rows sync as `kind: 'card'`, which the Supabase CHECK constraint must
allow; see the migration note at the bottom of `supabase/schema.sql`.

## Recognising courses from the calendar

`recurringSeries()` in [js/gcal.js](js/gcal.js) groups `state.events` by
`recurringEventId` and reads the schedule back off the instances. We sync with
`singleEvents: true`, so a weekly lecture arrives as one event per week rather
than as an RRULE — reading the instances is both easier and truer than parsing
a rule, and it catches a course that also meets for a Friday lab under the same
parent event. A slot seen only once is dropped, so one rescheduled week doesn't
become a phantom weekly meeting.

The picker expands *inside* the area editor rather than opening its own modal:
`ui.js` keeps one modal at a time, so a modal on top would close the editor
underneath it.

## Scheduled or a deadline, never both

An item is one of two things and the editor makes you pick:

- **Scheduled** — `plan: { date, start, mins }`. Has a start and an end, and is
  the only shape that reaches Google Calendar.
- **Deadline** — `due` + `dueTime` + `estMins`. Owed by a time; **a due date is
  never pushed to the calendar.**

Which one it is is read off the data (`!!item.plan.start`), not stored
separately, so there is no third field to keep honest. Switching modes carries
the date and time across — dropping them silently loses the time the user set.

`ITEM_TYPES` is four: `event`, `task`, `meeting`, `homework`. Schema 7 and
earlier had eleven; `LEGACY_TYPE` maps them. Anything unrecognised becomes
`task`. Items no longer carry a `grade`.

Quick add understands a **time range** — "12-7", "2:30-4pm", "9 to 11am" — and
a range means scheduled, not due. `parseRange()` must run before `parseWhen()`:
otherwise one half is claimed as a due time and the other is stranded in the
title, which is how "fly to boston aug 29 12-7" once became "fly to boston 12
to", due 7pm. Bare hours read the way people say them (7–11 morning, 12 noon,
1–6 afternoon), and a range preceded by ch/page/problem/section is left alone
so "read ch 3-4" is not an afternoon meeting.

An item created with no area lands in the **Personal** area
(`defaultAreaId()`), seeded on the upgrade into schema 8.

## Adding a field to a task

1. Add it to the object literal in `upsertItem()` in `js/store.js`.
2. Add a fallback in `migrate()` so existing saved data still loads.
3. Add a row to the properties list in `js/editor.js`.

Cloud sync ships whatever shape the object has, so nothing else is needed.

## Where things live

| I want to change… | Edit |
|---|---|
| how a screen looks | `js/views/<screen>.js` |
| category pages, one area's page | `js/views/areas.js` |
| the capture box | `js/capture.js` |
| today's agenda, focus, end-of-day | `js/views/overview.js` |
| drag-to-reorder | `reorderable()` in `js/ui.js` |
| the notes page | `js/views/notes.js` |
| the set of categories | `AREA_CATEGORIES` in `js/store.js` |
| shell, router, sidebar, quick add | `js/app.js` |
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
