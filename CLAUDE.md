# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no dependencies,
backed by `localStorage`, with optional Google Calendar and Supabase sync.
Schema **18**, service worker **planner-v29**.

## Working with me

**Ask instead of assuming.** When a request could reasonably mean two different
things — where something lives, whether it persists, what a new field carries —
ask before building. Ask early, ask all of it at once, and only about what
changes the work. Routine judgment calls are still yours.

## Working on it

The repo *is* the site — no build, no install: `python3 -m http.server 8000`.
Before pushing, click through the app and open **`/tests/`**; the Deploy
workflow only runs `node --check`, which proves the files *parse*. **Bump
`VERSION` in `sw.js` whenever a file in its `SHELL` changes**, add new
modules to `SHELL`, **and add the release to `js/changelog.js` in the same
commit**. The changelog's newest entry *is* the version; `version.test.html`
fails when it and `sw.js` disagree, or when an imported module is not cached.
Install fetches with `cache: 'reload'`, or Pages' `max-age=600` fills the new
cache with the files it replaces. **The fetch handler never writes to the
cache**, so all of one deploy; refreshing per file once let a page run one
version's JS against another's CSS.

**When a change appears not to take effect**, almost always a cache. A hash-only
navigation does not reload — `#/overview` when already there keeps the same
module instances, so `location.reload()`. `http.server` sends no
`Cache-Control` and Chrome invents freshness, so serve `no-store` on a fresh
port (a new origin is a clean cache). In production a tab keeps the cache it
started with; since v14 the app reloads once when a new worker takes over.
**Never verify with a cache-busting query string** — `sw.js` matches with
`ignoreSearch: true` and `fetch(cache:'reload')` still goes through the worker,
so both only *look* like network reads. The truth is DevTools → **Bypass for
network**, `await caches.keys()`, or `curl` from outside.

## State

`state` in [js/store.js](js/store.js) is the one live object. No reducers, no
per-view copies: views mutate it directly inside `commit(() => { … })`, which
persists (debounced 120ms) and notifies subscribers. Prefer the existing
selectors (`itemById`, `itemsDueOn`, `upcoming`, `classesOn`, `areasInCategory`,
`dayTimeline`, …) over re-filtering inline. `commit(fn, { source })` — `app.js`
re-renders only for `external`, `gcal`, `cloud`, `editor`; tag a commit made
from a floating panel, or the view underneath it will not repaint.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` against the
last successful sync. Changed rows push, vanished rows tombstone, conflicts are
last-write-wins per row (`updated_at` decides, `synced_at` is the pull cursor).
**No per-mutation bookkeeping** — never add dirty flags or `markChanged()`.

**The baseline is what was last *pushed*, not what state holds now.** Both have
been regressions: a row missing locally is "new from the cloud" *only* if the
baseline never had it, or adopting the server copy silently undoes a delete;
and the baseline must be the hashes `push()` actually sent, never a snapshot
taken afterwards, or a delete made mid-round-trip is lost.

**Never sync device credentials** — no Google tokens, Supabase URL/anon key or
cursors in `snapshotRows()`. Settings sync by allowlist (`SYNCED_SETTINGS`);
anything absent stays device-local, which is how `railClosed` and `railHidden`
stay per-device. Row kinds are constrained by Postgres — `area, item, note,
card, meta` — so **a new kind needs an `ALTER` the user must run**
(`supabase/upgrade.sql`, idempotent, named by `describeSyncError()` on a rejected
push). Hence habits, links, the wishlist and the chart's bands ride inside
`meta`, and `applyRow` takes `data.links`, `data.wishlist` and `data.sprints`
only when the key is **present**: an older device sends none, and absent is not
empty.

## Data model

| | |
|---|---|
| `state.items` | tasks. Either **scheduled** (`plan {date,start,mins}`) or a **deadline** (`due`, `dueTime`, `estMins`) — never both. Read via `!!item.plan.start`. |
| `state.areas` | courses/projects/etc. One `category`, plus `order`, `onChart`, `journal`, `freewrite` |
| `state.notes` | per-day `focus`, `text`, `tomorrow`, `top3`, `journal` (`areaId -> entry`), keyed by date — **not** the same as `state.cards`, which are notecards (`areaId: null` = unfiled) |
| `links` / `wishlist` / `sprints` | link piles; things wanted and the parcels they become; focuses and sprints on the chart. All three ride in `meta` |
| `habits` / `habitLog` · `events` / `outbox` | habits and `date -> [habitId]` · the Google mirror and queued writes |

**Only a `plan` block reaches Google Calendar.** A due date alone is never
pushed — the most common source of "why isn't it on my calendar". `ITEM_TYPES`
is four: `event`, `task`, `meeting`, `homework`; items have no `grade`; an item
or link with no area lands in General via `defaultAreaId()`. Each *seed* is
pinned to the version that introduced it — `if (from < 5)`, never
`< SCHEMA_VERSION`, or the next bump resurrects something deliberately deleted.
A *rename* is the opposite — `MERGED_CATEGORY` is unpinned, in `areaCategory()`
— because a dead category id must be translated every time it is read. What each
version did is in `migrate()` and `js/changelog.js`.

## Routing and views

`VIEWS` in `js/app.js`: overview, semester, week, habits, wishlist, settings.
Categories and areas are **data, not screens**, so `route()` resolves `#/week`,
`#/course` and `#/area/<id>`, falling back to Overview; `AREA_CATEGORIES` is the
single source for the sidebar, the breakdown and the editor's select. Habits and
the wishlist sit under Personal but are **not** areas: `CATEGORY_PINS` hangs them
off the group, outside the `reorderable()` host (a pinned row has no
`reorderId`). **A category row's caret goes after the label, never before** —
anything ahead of the glyph breaks the sidebar's one alignment.

**Overview is the day**: a 24-hour clock opened at 8am (`--day-hour-h`, read
from CSS) beside focus, top three, open work, end-of-day note. The topbar's
`#nextup` says what is on now or next, on every screen, repainted on every
commit and on a 30s clock. **The end-of-day note is the only thing that crosses
a day**: `tomorrow` becomes the next morning's `focus` via `carryForward()`,
called from the render *before* anything reads the note and only when
`pendingTomorrow()` says there is something — an unconditional `commit()` would
sync a row every visit. Tagged `{ source: 'carry' }` so `app.js` does not
re-render mid-build, and spent (`tomorrowUsed`) even when the day already has a
focus, or it would arrive a day late. **A journal entry lives in the day it was
written**, as `notes[date].journal[areaId]`, so a term of writing syncs as small
rows rather than one row resent whole, and `emptyNote()` counts it. The
**freewrite** is the opposite shape: one string on the area, no history.

**Semester is a chart, the old list behind a switch.** Bands are the three
categories, lanes are areas, `area.onChart` (absent reads as true) picks which
appear. Geometry is **whole days from the first day of term**, times `--day-w`
at the last moment — which is what makes `chartRange`, `itemSpan`, `bandSpan`,
`packLanes`, `monthBands` and `fitDayWidth` pure and testable. `--day-w` comes
from JS because `packLanes` measures titles in those same pixels; a bar within
a title's width of the end of term writes its title *left*, hence `head` as well
as `reserve` — and bands follow that rule too (`bandRows`), or a fortnight-long
sprint reads "CH…". **A focus or a sprint is a stretch of weeks in one area's
lane**, swept out horizontally the way a block is swept out on the calendar —
same object, `kind` deciding whether deliverables are asked for, drawn *above*
the work with item lanes offset by their height. SMART lives in the wording of
a deliverable, not in five labelled fields.

## Gotchas worth keeping

- `restoreDayScroll()` runs **synchronously after append**: `scrollTop` does
  nothing before layout, and rAF never fires in a background tab — exactly when
  a restored session renders. `ui.js` keeps **one modal at a time**; a second
  `modal()` closes the first. A drag grip must `preventDefault()` on
  `pointerdown`, or the drag reads as a text selection.
- Both sweeps — `dragCreate()` in `js/timegrid.js`, `dragSpan()` in
  `views/semester.js` — fire only on the **empty grid itself**, never on a block
  in it, never on touch (the gesture scrolls); `pointercancel` and Escape must
  not open the prompt. `dragBlock()` is the other half: middle moves, edges
  resize, `grabMode` keeping a third for the middle so a quarter-hour block can
  still be picked up. It owns the click too — the browser fires one after every
  drag, so a block with its own `onclick` would open the panel each time.
- **Never autosize a textarea with no width.** One measured at zero wraps every
  word onto its own line and reports tens of thousands of pixels; `fitBoxes()`
  watches width only. `body.rail-hidden` makes `#app` a **single-column** grid —
  `0 1fr` would leave main in the zero-width column and render a blank page.
- Quick add checks `parseLinkAdd()` **first** — a URL at the front is a bookmark
  — and `parseRange()` before `parseWhen()`, or half of "12-7" becomes a due time
  and the rest is stranded in the title.
- A link's title comes from its URL and nothing else — a page's own `<title>` is
  unreadable across origins, so the guess is meant to be corrected. Only
  `http`/`https` are stored, or a saved `javascript:` URL would run as the app;
  a Drive URL holds only an id, so `linkTitleFromUrl` names the *kind* instead.
- Capture's **Enter must stay the shortest path out** — an unfiled note, never a
  question. There is no Notes page: `unfiledQueue()` renders under the box on
  Overview, `noteCard()` shows a filed note on its area's page, and deleting
  either strands every capture.
- `recurringSeries()` reads a schedule off calendar *instances* (we sync
  `singleEvents: true`), not an RRULE; a slot seen once is dropped, so a
  rescheduled week is not a phantom meeting.

## Tests

Serve the repo, open `/tests/`. No runner, no dependencies, 524 checks, and
`tests/` is excluded from the deploy. One suite per file, each named for what it
covers and headed by a comment saying why; `tests/index.html` runs them all.

Suites drive the real modules and clobber app state, so **both guards must
stay**: refuse to run outside localhost, and restore `localStorage` afterwards,
waiting out `save()` (120ms) and `pushSoon` (1500ms) first. `store.js` reads
`localStorage` once at import, so `migrate()` needs a fresh instance —
`storeWith(raw)`, which **verifies** its seed rather than timing it: `import()`
is async, a leftover `save()` lands between the write and the module that reads
it, and sleeping past the debounce only narrows that window (the runner's twelve
iframes throttle timers, and it reopens). A fresh instance has its own `state`,
so a suite that pokes state *and* calls `gcal.js`/`cloud.js` must use
`sharedStoreWith()` — once per page, since `import()` caches. To add a field to
a task: the literal in `upsertItem()`, a fallback in `migrate()` so saved data
still loads, a row in `js/editor.js`. Sync ships whatever shape it has.

## Where things live

| I want to change… | Edit |
|---|---|
| shell, router, sidebar, quick add, the next-up line | `js/app.js` |
| state, schema, migrations, parser | `js/store.js` |
| a screen · category pages, an area's page, its links and freewrite | `js/views/<screen>.js` · `views/areas.js` |
| the capture box, the unfiled queue, a note card · the task panel | `js/capture.js` · `js/editor.js` |
| sweeping, moving or resizing a block · a band on the chart | `js/timegrid.js` · `views/semester.js`, `js/sprint.js` |
| toasts, modals, peek, reorder · patch notes and the version | `js/ui.js` · `js/changelog.js` |
| Google Calendar / Supabase sync | `js/gcal.js`, `js/cloud.js`, `supabase/*.sql` |
| colours, spacing, grids · themes and fonts | `css/app.css` · `js/appearance.js` |

Calendar days are `'YYYY-MM-DD'` in **local** time; times `'HH:MM'` 24h;
timestamps ISO — see `js/util.js`. Build DOM with `h()`, not template strings.
No framework, no JSX, no TypeScript. Match the surrounding style.
