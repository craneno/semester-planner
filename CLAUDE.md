# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no dependencies,
backed by `localStorage`, with optional Google Calendar and Supabase sync.
Schema **18**, service worker **planner-v32**.

## Working with me

**Ask instead of assuming.** When a request could reasonably mean two different
things — where something lives, whether it persists, what a new field carries —
ask before building: early, all at once, and only about what changes the work.
Routine judgment calls are still yours.

## Working on it

The repo *is* the site — no build, no install: `python3 -m http.server 8000`.
Before pushing, click through the app and open **`/tests/`**; the Deploy workflow
only runs `node --check`, which proves the files *parse*. **Bump `VERSION` in
`sw.js` whenever a file in its `SHELL` changes**, add new modules to `SHELL`,
**and add the release to `js/changelog.js` in the same commit**. The changelog's
newest entry *is* the version; `version.test.html` fails when it and `sw.js`
disagree, or when an imported module is not cached. Install fetches with
`cache: 'reload'`, or Pages' `max-age=600` fills the new cache with the files it
replaces. **The fetch handler never writes to the cache**, so a page runs all of
one deploy — refreshing per file once ran one version's JS against another's CSS.

**When a change appears not to take effect**, almost always a cache. A hash-only
navigation does not reload — `#/overview` when already there keeps the same
module instances, so `location.reload()`. `http.server` sends no `Cache-Control`
and Chrome invents freshness, so serve `no-store` on a fresh port (a new origin
is a clean cache). **Never verify with a cache-busting query string** — `sw.js`
matches with `ignoreSearch: true` and `fetch(cache:'reload')` still goes through
the worker, so both only *look* like network reads. The truth is DevTools →
**Bypass for network**, `await caches.keys()`, or `curl` from outside.

## State

`state` in [js/store.js](js/store.js) is the one live object. No reducers, no
per-view copies: views mutate it directly inside `commit(() => { … })`, which
persists (debounced 120ms) and notifies subscribers. Prefer the existing
selectors (`itemById`, `itemsDueOn`, `upcoming`, `classesOn`, `dayTimeline`, …)
over re-filtering inline. `commit(fn, { source })` — `app.js` re-renders only for
`external`, `gcal`, `cloud`, `editor`; tag a commit made from a floating panel,
or the view underneath it will not repaint.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` against the
last successful sync. Changed rows push, vanished rows tombstone, conflicts are
last-write-wins per row (`updated_at` decides, `synced_at` is the pull cursor).
**No per-mutation bookkeeping** — never add dirty flags or `markChanged()`.

**A repaint is for news, not for every sync.** `pull()` drops a row that hashes
to what we already hold — our own write, back down the realtime channel — since
`applyRow` reports a change for any live row and the re-render takes the caret
out of the box whose typing caused it. `gcal.js` tags its commit `gcal` only when
something arrived, for the same reason.

**The baseline is what was last *pushed*, not what state holds now.** Both have
been regressions: a row missing locally is "new from the cloud" *only* if the
baseline never had it, or adopting the server copy undoes a delete; and the
baseline must be the hashes `push()` sent, never a snapshot taken afterwards, or
a delete made mid-round-trip is lost.

**Never sync device credentials** — no Google tokens, Supabase URL/anon key or
cursors in `snapshotRows()`. Settings sync by allowlist (`SYNCED_SETTINGS`);
anything absent stays device-local, which is how `railHidden` stays per-device.
Row kinds are constrained by Postgres — `area, item, note, card, meta` — so
**a new kind needs an `ALTER` the user must run** (`supabase/upgrade.sql`,
idempotent, named by `describeSyncError()`). Hence habits, links, the wishlist
and the chart's bands ride inside `meta`, and `applyRow` takes `data.links`,
`data.wishlist` and `data.sprints` only when **present**: an older device sends
none, and absent is not empty.

## Data model

| | |
|---|---|
| `state.items` | tasks. **Scheduled** (`plan {date,start,mins}`), **all day** (`plan.date`, no `start`), or a **deadline** (`due`, `dueTime`, `estMins`) — never two at once, and all three read off the data, not a field beside it |
| `state.areas` | courses/projects/etc. One `category`, plus `order`, `onChart`, `journal`, `freewrite` |
| `state.notes` | per-day `focus`, `text`, `tomorrow`, `top3`, `journal` (`areaId -> entry`), keyed by date — **not** the same as `state.cards`, which are notecards (`areaId: null` = unfiled) |
| `links` / `wishlist` / `sprints` | link piles; things wanted and the parcels they become; focuses and sprints on the chart. All three ride in `meta` |
| `habits` / `habitLog` · `events` / `outbox` | habits and `date -> [habitId]` · the Google mirror and queued writes |

**Only a `plan` block reaches Google Calendar.** A due date alone is never
pushed — the most common source of "why isn't it on my calendar". An all-day
plan does go, as `start`/`end` **dates** with the end the morning *after*, which
is how Google says a whole day. `ITEM_TYPES` is four: `event`, `task`, `meeting`,
`homework`; an item or link with no area lands in General. Each *seed* is
pinned to the version that introduced it — `if (from < 5)`, never
`< SCHEMA_VERSION`, or the next bump resurrects something deliberately deleted.
A *rename* is the opposite — `MERGED_CATEGORY`, unpinned in `areaCategory()` —
because a dead id must be translated every time it is read.

## Routing and views

`VIEWS` in `js/app.js`: overview, semester, week, habits, wishlist, settings.
Categories and areas are **data, not screens**, so `route()` resolves `#/week`,
`#/course` and `#/area/<id>`, falling back to Overview; `AREA_CATEGORIES` is the
single source for the sidebar, the breakdown and the editor's select. Habits and
the wishlist sit under Personal but are **not** areas: `CATEGORY_PINS` hangs them
off the group, outside the `reorderable()` host (a pinned row has no
`reorderId`). **A category row's caret goes after the label** — anything ahead of
the glyph breaks the sidebar's one alignment.

**Overview is the day**: a 24-hour clock opened at 8am beside focus, top three,
open work, end-of-day note. The topbar's `#nextup` says what is on now or next,
on every screen, repainted on every commit and on a 30s clock. **The end-of-day
note is the only thing that crosses a day**: `tomorrow` becomes the next
morning's `focus` via `carryForward()`, from the render *before* anything reads
the note and only when `pendingTomorrow()` says so — an unconditional `commit()`
would sync a row every visit. Tagged `{ source: 'carry' }` so `app.js` does not
re-render mid-build, and spent (`tomorrowUsed`) even when the day has a focus.
**A journal entry lives in the day it was written**, `notes[date].journal[areaId]`,
so a term of writing syncs as small rows rather than one resent whole; the
**freewrite** is the opposite, one string on the area. **The day begins at 3am**
— `DAY_RESET_HOUR` and `today(now)` in `js/util.js`, the one place it is decided
— so an entry written at 1am files under the day it is about. `sweepDone()`
deletes work ticked *before* that reset, behind an Undo toast from `navigate()`;
`settings.sweepDone` turns it off.

**Semester is a chart, the old list behind a switch.** Bands are the three
categories, lanes are areas, `area.onChart` (absent reads as true) picks which
appear. Geometry is **whole days from the first day of term**, times `--day-w` at
the last moment — which keeps `chartRange`, `itemSpan`, `bandSpan`, `packLanes`,
`monthBands` and `fitDayWidth` pure and testable. A bar too narrow for its title
writes it outside, *left* if the end of term is near, hence `head` as well as
`reserve` — and bands follow that rule too (`bandRows`), or a fortnight-long
sprint reads "CH…". **A focus or a sprint is a stretch of weeks in one area's
lane**, swept out horizontally the way a block is on the calendar — same object,
`kind` deciding whether deliverables are asked for, drawn *above* the work.

## Gotchas worth keeping

- `restoreDayScroll()` runs **synchronously after append**: `scrollTop` does
  nothing before layout and rAF never fires in a background tab, which is exactly
  when a restored session renders. `ui.js` keeps one modal at a time.
- Both sweeps — `dragCreate()`, `dragSpan()` — fire only on the **empty grid
  itself**, never on a block in it, never on touch (the gesture scrolls);
  `pointercancel` and Escape must not open the prompt. `dragBlock()` is the
  other half: middle moves, edges resize, `grabMode` keeping a third for the
  middle so a quarter-hour block can still be picked up. **It owns the click**
  — the browser fires one after every drag, so a block with its own `onclick`
  would open the panel each time.
- **A finger says which gesture it means by waiting.** A tap opens a block, a
  press held `HOLD_MS` picks it up, and movement before that hands the gesture
  back to the scroller — so `.blk` keeps `touch-action: pan-x pan-y` (`none`
  would let a block eat the scroll) and `dragBlock` takes it, by
  `preventDefault()` on `touchmove`, only once the hold is out. On touch the mode
  is always `move`: an 8px resize edge is finer than a fingertip, and the
  sidebar's swipe stays at the left edge for the same reason.
- **Pixels per hour come from CSS, never a constant.** `--hour-h` and
  `--day-hour-h` draw the gridlines; `cssPx()` places the blocks. A hard-coded 52
  put every block most of an hour below its own line on a phone, where the media
  query makes the hour 46. Crossing that breakpoint re-renders, or the geometry
  stays that of the layout it was born in.
- **Never autosize a textarea with no width.** One measured at zero wraps every
  word onto its own line and reports tens of thousands of pixels; `fitBoxes()`
  watches width only. `body.rail-hidden` makes `#app` **single-column** — `0 1fr`
  would leave main in the zero-width column and render a blank page.
- Quick add checks `parseLinkAdd()` **first** — a URL at the front is a bookmark
  — and `parseRange()` before `parseWhen()`, or half of "12-7" becomes a due time
  and the rest is stranded in the title. A link's title comes from its URL alone
  (a page's own is unreadable across origins), so the guess is meant to be
  corrected; only `http`/`https` are stored, or a saved `javascript:` URL would
  run as the app.
- Capture's **Enter must stay the shortest path out** — an unfiled note, never a
  question. There is no Notes page: `unfiledQueue()` renders under the box on
  Overview and `noteCard()` on the area's page; deleting either strands captures.

## Tests

Serve the repo, open `/tests/`. No runner, no dependencies, 582 checks, and
`tests/` is excluded from the deploy. One suite per file, named for what it
covers and headed by why; `tests/index.html` runs them all.

Suites drive the real modules and clobber app state, so **both guards must
stay**: refuse to run outside localhost, and restore `localStorage` afterwards,
waiting out `save()` (120ms) and `pushSoon` (1500ms) first. `store.js` reads
`localStorage` once at import, so `migrate()` needs a fresh instance —
`storeWith(raw)`, which **verifies** its seed rather than timing it: a leftover
`save()` can land between the write and the async `import()`. A fresh instance
has its own `state`, so a suite that pokes state *and* calls `gcal.js`/`cloud.js`
must use `sharedStoreWith()` — once per page, since `import()` caches. To add a
field to a task: `upsertItem()`, a fallback in `migrate()`, a row in
`js/editor.js`. Sync ships whatever shape it has.

## Where things live

| I want to change… | Edit |
|---|---|
| shell, router, sidebar and its swipe, quick add, next-up · state, schema, migrations, parser, the day boundary | `js/app.js` · `js/store.js`, `js/util.js` |
| a screen · an area's page, its links and freewrite · the capture box, the unfiled queue, a note card · the task panel | `js/views/<screen>.js` · `views/areas.js` · `js/capture.js` · `js/editor.js` |
| sweeping, moving or resizing a block · a band on the chart · toasts, modals, peek, reorder, patch notes | `js/timegrid.js` · `views/semester.js`, `js/sprint.js` · `js/ui.js`, `js/changelog.js` |
| Google Calendar / Supabase sync · colours, themes, fonts | `js/gcal.js`, `js/cloud.js`, `supabase/*.sql` · `css/app.css`, `js/appearance.js` |

Calendar days are `'YYYY-MM-DD'` **local**, times `'HH:MM'` 24h, timestamps ISO
(`js/util.js`). Build DOM with `h()`, not template strings. No framework, no
JSX, no TypeScript. Match the surrounding style.
