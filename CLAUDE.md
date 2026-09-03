# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no deps, kept in
`localStorage`, with optional Google Calendar and Supabase sync.
Schema **20**, service worker **planner-v44**.

## Working with me

**Ask, don't guess.** When a request could mean two things — where a thing goes,
whether it sticks around, what a new field holds — ask before building: early,
all at once, and only about what changes the work. Small calls are still yours.

**Small words beat big ones.** Say it the short way — here, in commits, in code
comments. Keep the real names exact (`syncToken`, tombstone, occurrence) and
drop the dress-up around them. This file may run to **300 lines**; past that,
cut a sentence and say what went.

## Working on it

The repo *is* the site — no build, no install: `python3 -m http.server 8000`.
Before you push, click through the app and open **`/tests/`**. The Deploy job
runs the same page headless (`tests/run.mjs`, Playwright) and stops on any
failure, so a red suite means no deploy until it is green.
**Bump `VERSION` in `sw.js` whenever a file in its `SHELL` changes**, add new
modules to `SHELL`, **and add the release to `js/changelog.js` in the same
commit**. The newest changelog entry *is* the version; `version.test.html` fails
when it and `sw.js` disagree, or when a module we import is not cached. Install
fetches with `cache: 'reload'` (Pages' `max-age=600` would fill the new cache
with the old files) and **the fetch handler never writes to the cache**, so a
page runs one whole deploy, never one version's JS against another's CSS.

**When a change seems not to land**, it is nearly always a cache. A hash-only
move does not reload — `#/overview` when you are already there keeps the same
module instances, so `location.reload()`. Serve `no-store` on a new port: a new
origin is a clean cache. **Never check with a cache-busting query string** —
`sw.js` matches with `ignoreSearch: true` and `fetch(cache:'reload')` still goes
through the worker, so both only *look* like reads off the network. The truth is
DevTools → **Bypass for network**, `await caches.keys()`, or `curl` from outside.

## State

`state` in [js/store.js](js/store.js) is the one live object. No reducers, no
per-view copies: views change it in place inside `commit(() => { … })`, which
saves (waits 120ms) and tells subscribers. **`js/store/` is the store in
slices**, and `store.js` stays the one API: pure modules (`constants`, `urls`,
`migrate`, `backups`, the parsers in `quickadd`) and slices that take the
state as their first argument (`areas`, `cards`, `links`, `wishlist`,
`sprints`, `habits`), bound to the live `state` by `bind()`. **A slice never
owns state**: `storeWith` busts only `store.js`, so a slice that kept its own
would be shared by every fresh instance in the tests. Items, notes, areas'
edits, the selectors over items and the sync rows stay in `store.js`. A new
slice goes in `sw.js`'s `SHELL` too, or `version.test.html` fails. Use the selectors that are already
there (`itemById`, `itemsDueOn`, `upcoming`, `classesOn`, `dayTimeline`, …)
instead of filtering by hand again. `commit(fn, { source })` — `app.js` redraws
only for `external`, `gcal`, `cloud`, `editor`, `restore`, `undo`, `redo`,
`canvas`; tag one made from a
floating panel, or the view under it will not repaint.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` against the
last good sync. Changed rows push, rows that went away leave a tombstone, and a
clash goes to whoever wrote last, row by row (`updated_at` decides, `synced_at`
is the pull cursor). **No book-keeping per change** — never add dirty flags or
`markChanged()`.

**Back from the background, ask for the session first** (`resume()`): an iOS
app that slept wakes with an expired token, and a sync fired straight away got
a 401 before supabase-js had refreshed it. A sync that meets one refreshes and
goes once more, once (`authRetried`). **Sync watches itself.** `cloud.log` is the last thirty syncs (Settings → Sync
log); the loop breaker halts after `LOOP_MAX` pushes in a row with nothing
edited here, and `sync({ manual })` starts it again. `pull()` hands `push()` the
hashes it took, or every row from another device went straight back up. The
server keeps replaced rows thirty days (`planner_rows_history`); `restore()`
stamps a version now so the trigger takes it.

**Redraw for news, not for every sync.** `pull()` drops a row that hashes to
what we already hold — our own write, come back down the realtime channel —
since `applyRow` calls any live row a change, and the redraw takes the caret out
of the box being typed in. `gcal.js` tags `gcal` only when something arrived.
**A save seen from another tab is not an edit either**: the cloud subscriber
skips `external`, or two tabs on one device push each other's `lastSync` for
ever, and Settings twitches with every round. A `<details>` a view builds must
keep its open state outside the DOM (`everythingOpen`), or a sync shuts it.

**The baseline is what we last *pushed*, not what state holds now.** Both ways
round have been bugs we shipped: a row missing here is "new from the cloud"
*only* if the baseline never had it, or taking the server copy undoes a delete;
and the baseline must be the hashes `push()` sent, never a snapshot taken after,
or a delete made mid-trip is lost.

**A migration is not an edit, and this one cost real data.** The baseline hashes
each row, so a migration that adds a field — `tz` on every class meeting — makes
every row it touched look edited, and the first device to open the new build
pushes its whole copy over everyone else's. So `cloud.js` records the schema its
baseline was built under, and a bump throws the baseline away: with none, the
cloud wins every row, and the new shape goes up only once we agree with the
server. `push()` sends `rowStamp()`, never the clock at send; `rowStamp()` must
know every kind that carries one, and **`migrate()` must carry `updatedAt`
through** — the area normaliser did not, which left every area with no clock at
all. Postgres has the last word: `planner_rows_keep_newest` drops a write older
than the row it lands on (`supabase/upgrade.sql`; a delete still passes, being
its own decision). **The baseline is a short hash per row** (cyrb53, keys
sorted first — jsonb comes back sorted, and a raw-bytes hash had push read its
own row back as "changed" for ever), held in memory as well as localStorage.
`AGREED` is schema *and* hash shape, so an old baseline is thrown away too.

**Sync is fan-out, not safety.** An upsert keeps no history and reaches every
device in seconds. `keepBackups()` copies the raw state *before `migrate()`
reads it* — one a day, five kept, plus `before-v<n>` as an upgrade runs;
`events`/`outbox` left out, and under their own keys, out of sync's reach.

**Never sync device credentials** — no Google tokens, no Supabase URL or anon
key, no cursors in `snapshotRows()`. Settings sync by list (`SYNCED_SETTINGS`);
anything off the list stays on the device. Postgres only allows the row kinds
it was built with, so **a new kind needs an `ALTER` the user has to run**
(`supabase/upgrade.sql`, safe to run twice, named by `describeSyncError()`).
Links, the wishlist, sprints, habits and each day's ticks (`habitlog:<date>`)
are rows of their own since schema 20, each with a clock in `rowStamp()`;
`meta` is only the semester and `SYNCED_SETTINGS`, and `applyRow` **ignores**
the lists an old device still sends in it. `push()` reads back what the server
kept: a row that comes back different was refused by the trigger, and is taken
up here, its hash recorded, or it would be pushed again for ever.

## Data model

| | |
|---|---|
| `state.items` | tasks. **Scheduled** (`plan {date,start,mins}`), **all day** (`plan.date`, no `start`), or a **deadline** (`due`, `dueTime`, `estMins`) — never two at once, and all three read off the data. `repeat` makes it a series |
| `state.areas` | courses/projects/etc. One `category`, plus `order`, `onChart`, `journal`, `freewrite`, and a `schedule` of meetings, each stamped with the `tz` it is written in |
| `state.notes` | per-day `focus`, `text`, `tomorrow`, `top3`, `journal` (`areaId -> entry`), keyed by date — **not** the same as `state.cards`, which are notecards (`areaId: null` = unfiled) |
| `links` / `wishlist` / `sprints` | link piles; things wanted and the parcels they turn into; focuses and sprints on the chart |
| `habits` / `habitLog` · `events` / `outbox` | habits and `date -> [habitId]` · the Google mirror and writes waiting to go |

**Only a `plan` block goes to Google Calendar.** A due date on its own is never
pushed — the top source of "why isn't it on my calendar". **A push is a queue,
never a request**: `pushItem()` puts the item in `state.outbox` (one row per
item) and `flushOutbox()` sends the lot `pushSettings.wait` after the last
change — a drag session hit Google's rate limit when every drop went out at
once. A 403 `rateLimitExceeded` is a pause (`backoffUntil`, doubling), not an
error. An all-day plan goes
as `start`/`end` **dates**, the end being the morning *after*. `ITEM_TYPES` is
`event`, `task`, `meeting`, `homework`; no area puts it in General. Each *seed*
is pinned to the version that added it — `if (from < 5)`, never
`< SCHEMA_VERSION`, or the next bump brings back something deleted on purpose.
A *rename* (`MERGED_CATEGORY` in `areaCategory()`) is not pinned: a dead id is
turned into a live one every time it is read.

**Undo is in the store**: `commit(fn)` keeps a copy of the tracked keys first
(`UNDO_KEYS`, ten deep, commits within 800ms as one step), and `undo()` puts
one back and **stamps every row that differs with now**, or the server refuses
the old clock as stale and the next sync undoes the undo. A commit from outside
(`FOREIGN`, `external`) clears the stack. `undo`/`redo` are sources of their
own: redrawn, pushed, never remembered. **The small edits live in
`js/actions.js`** — tick, move, push to tomorrow — each with an Undo of its
own that puts the old *when* back through `upsertItem`. A Canvas
assignment is a deadline with `canvasId` (`js/canvas.js`); a re-import
refreshes the date and title and leaves the area, the tick and the notes alone.
**The course teaches by example**: an assignment sits where the import put it
(`canvasArea`) until moved by hand, which nulls the key — even back to the
same area; moving one still unmoved takes the rest of its course along
(`followCourse` in `upsertItem`), and `homeFor()` files the next import where
the moved ones sit. Neither key is written when absent, or every row would
look edited to sync.
The feed comes in as a file, or by itself: Instructure sends no CORS headers
and the link carries a token, so the link lives in `planner_feeds` on the
server, **never in state**, and the `canvas-feed` Edge Function
(`supabase/functions/`) fetches it. `refreshIfDue()` runs after any sync that
ends `ready`, once a day per device (`canvasFeedAt`, off `SYNCED_SETTINGS`),
in one commit tagged `canvas` — redrawn, `FOREIGN` to undo.

**A repeat is a rule, never copies.** `repeat` sits on the item (`js/repeat.js`
is the plain date maths); the screens draw **occurrences**, made on the spot and
named `<id>@<the day the rule gave it>`. A series never draws itself, or its
first occurrence lands on the page twice. Only `plan`, `due`, `title` and `done`
can belong to one occurrence, in `repeat.ex[key]`; the rest belongs to the
series. **An occurrence is a copy** — writing to it throws the change away, so
writes go through `upsertItem`/`toggleItem`/`deleteItem`, and views must ask the
selectors (`itemsPlannedOn`, `itemsDueOn`, `upcoming`) rather than filter
`state.items`, which holds only the rule. Google gets **one plain event per
occurrence** — `gcalIds` maps the rule's day to its event id, `pushSeries()`
works out the difference, and the term is the far end, since a repeat with no
end has no last one. **This and after** is `splitSeriesAt()`: the old series
ends the day before, a new one starts at the occurrence with the edit.

## Routing and views

`VIEWS` in `js/app.js`: overview, semester, week, habits, wishlist, settings.
Categories and areas are **data, not screens**, so `route()` handles `#/week`,
`#/course` and `#/area/<id>`, falling back to Overview; `AREA_CATEGORIES` is the
one source for the sidebar, the breakdown and the editor's select. Habits and
the wishlist sit under Personal but are **not** areas: `CATEGORY_PINS` hangs
them off the group, outside the `reorderable()` host (a pinned row has no
`reorderId`). **A category row's caret goes after the label** — anything ahead
of the glyph breaks the sidebar's one line-up.

**Overview is the day**: a 24-hour clock, opened at 8am, next to focus, top
three, open work and the end-of-day note; `#nextup` says what is on now or next,
on every screen. **The end-of-day note is the only thing that crosses a day**:
`tomorrow` becomes the next morning's `focus` by way of `carryForward()`, from
the draw *before* anything reads the note, and only when `pendingTomorrow()`
says so — a `commit()` with no check would sync a row every visit. Tagged
`{ source: 'carry' }` so `app.js` does not redraw mid-build, and marked spent
(`tomorrowUsed`) even when the day already has a focus.
**A journal entry lives in the day it was written**, `notes[date].journal[areaId]`,
so a term of writing syncs as small rows instead of one big one sent again and
again; the **freewrite** is one string on the area. **The day starts at 3am** —
`DAY_RESET_HOUR` and `today(now)` in `js/util.js`, the one place that decides it
— so an entry written at 1am files under the day it is about. `sweepDone()`
deletes work ticked off *before* that reset, behind an Undo from `navigate()`.

**Semester is a chart, with the list behind a switch.** Bands are the three
categories, lanes are areas, and `area.onChart` (missing reads as true) picks
which. The maths is **whole days from the first day of term**, times `--day-w`
at the last moment — which keeps `chartRange`, `itemSpan`, `bandSpan`,
`packLanes`, `monthBands` and `fitDayWidth` plain and easy to test. A bar too
narrow for its title writes it outside, and *left* near the end of term, hence
`head` as well as `reserve`; bands do the same (`bandRows`). A **series draws as
its run**, first occurrence to last, not one bar at its anchor. **A focus or a
sprint is a stretch of weeks in one area's lane**, dragged out the way a block
is on the calendar — `kind` decides whether we ask for deliverables.

## Things that bit us

- `restoreDayScroll()` runs **right after append, in the same tick**:
  `scrollTop` does nothing before layout, and rAF never fires in a background
  tab, which is exactly when a restored session draws. **A redraw under a
  finger loses the touch**: the node it began on is gone, so `navigate()`
  waits while `body.nav-dragging`, and a stuck menu settles on the next touch.
- Both drags — `dragCreate()`, `dragSpan()` — fire only on the **empty grid
  itself**, never on a block in it, never on touch (there the drag scrolls);
  `pointercancel` and Escape must not open the prompt. `dragBlock()` is the
  other half: middle moves, edges resize, `grabMode` keeping a third for the
  middle. **It owns the click** — the browser fires one after every drag, so a
  block with its own `onclick` would open the panel each time.
- **A finger says what it means by waiting.** A tap opens a block, a press held
  `HOLD_MS` picks it up, and moving before that hands the touch back to the
  scroller — so `.blk` keeps `touch-action: pan-x pan-y` (`none` would let a
  block eat the scroll) and `dragBlock` takes it, with `preventDefault()` on
  `touchmove`, only once the hold is out. On touch the mode is always `move`:
  an 8px resize edge is finer than a fingertip.
- **Pixels per hour come from CSS, never a number in the JS.** `--hour-h` and
  `--day-hour-h` draw the gridlines; `cssPx()` places the blocks. A hard-coded
  52 put every block an hour off on a phone, where the hour is 46. Crossing
  that breakpoint redraws, or the maths stays that of the size it was born in.
- **Never size a textarea that has no width.** Measured at zero it wraps every
  word and reports tens of thousands of pixels; `fitBoxes()` watches width only.
  `body.rail-hidden` makes `#app` **one column**, or main sits in a zero-wide one.
- Quick add checks `parseLinkAdd()` **first** (a URL at the front is a bookmark)
  and `parseRange()` before `parseWhen()`, or half of "12-7" becomes a due time.
  A repeat ("every mon", "daily") is taken out *before* the date words, or "mon"
  reads as one next Monday; its first day is settled last, after them. Only
  `http`/`https` are stored, or a saved `javascript:` URL would run as the app.
- **A wall-clock time needs the zone it was written in.** Every `area.schedule`
  slot carries `tz`; `scheduleDrift()` spots a device that has moved and
  `shiftSchedules()` rewrites the times, carrying the weekday across midnight.
  `state.events` holds wall clock worked out at fetch time, so a move
  (`settings.tzSeen`, device-only) drops the sync token.
- **Blocks that overlap share the width**, or the later one is drawn flat over
  the earlier. `packBlocks()` is plain maths — clumps of things that touch, a
  column each, `LAP` running all but the last under its neighbour; `applyLanes()`
  writes it as `--lane-x/w/z`.
- Capture's **Enter must stay the shortest way out** — an unfiled note, never a
  question. There is no Notes page: `unfiledQueue()` on Overview, `noteCard()` on
  the area's page; delete either and captures have nowhere to show.

## Tests

Serve the repo, open `/tests/`. No runner in the page, no deps, 1035 checks, and
`tests/` is left out of the deploy; CI opens the same page in Chromium. A file reports to `tests/index.html` **once its last
suite has finished** — taking the first hid a failure in a later one — and its
suites **run one at a time** (`queue` in `suite()`): started together, their
`storeWith` seeds clobbered each other, now and then, for months.

Suites drive the real modules and wipe app state, so **both guards must stay**:
refuse to run anywhere but localhost, and put `localStorage` back afterwards,
waiting out `save()` (120ms) and `pushSoon` (1500ms) first. `store.js` reads
`localStorage` once, at import, so `migrate()` needs a fresh instance —
`storeWith(raw)`, which **checks** its seed rather than sleeping and hoping.
A file that has not reported in 90s is a **failure**, whatever it passed so
far. A tab hidden five minutes gets Chrome's one-timer-a-minute throttling,
so a long run in a background pane stalls; CI is the gate, not the pane.
A fresh instance has its own `state`, so a suite that pokes state
*and* calls `gcal.js`/`cloud.js` must use `sharedStoreWith()` — once per page,
since `import()` caches. To add a field to a task: `upsertItem()`, a fallback in
`migrate()`, a row in `js/editor.js`.

## House rules

Calendar days are `'YYYY-MM-DD'` **local**, times `'HH:MM'` 24h, timestamps ISO
(`js/util.js`). Build DOM with `h()`, not template strings. No framework, no
JSX, no TypeScript. Match the style around you.
