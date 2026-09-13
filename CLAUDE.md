# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no deps, kept in
`localStorage`, with optional Google Calendar and Supabase sync.
Schema **20**, service worker **planner-v73**.

## Working with me

**Ask, don't guess.** When a request could mean two things — where a thing goes,
whether it sticks around, what a new field holds — ask before building: early,
all at once, and only about what changes the work. Small calls are still yours.

**Small words beat big ones.** Say it the short way — here, in commits, in code
comments — and keep the real names exact (`syncToken`, tombstone, occurrence).
This file may run to **500 lines**, kept tight; past that, cut a sentence and say what went.

## Working on it

The repo *is* the site — no build, no install: `python3 -m http.server 8000`.
Before you push, click through the app and open **`/tests/`**. The Deploy job
runs the same page headless (`tests/run.mjs`, Playwright): a red suite is no deploy.
**Bump `VERSION` in `sw.js` whenever a file in its `SHELL` changes**, add new
modules to `SHELL`, **and add the release to `js/changelog.js` in the same
commit** — `python scripts/release.py "Title" -n "note"` does the three files
at once, and the Deploy job stops a push that changed a shell file without
the bump (`scripts/check_shell.py`). The newest changelog entry *is* the version; `version.test.html` fails
when it and `sw.js` disagree, or when a module we import is not cached. Install
fetches with `cache: 'reload'` (Pages' `max-age=600` would fill the new cache
with the old files) and **the fetch handler never writes to the cache**, so a
page runs one whole deploy, never one version's JS against another's CSS.

`.githooks/pre-push` runs the same check before a push
(`git config core.hooksPath .githooks`, once; `.gitattributes` keeps it LF). A view that throws draws
"This page hit a problem" in `navigate()`, never a blank app.

**When a change seems not to land**, it is a cache. On localhost the worker
serves nothing — every file is the one on disk. A hash-only move does not
reload — `#/overview` when already there keeps the module instances, so
`location.reload()`. A new port is a clean cache (serve it `no-store`).
**Never check with a cache-busting query string** — `sw.js` matches with
`ignoreSearch: true` and `fetch(cache:'reload')` still goes through the
worker, so both only *look* like the network. The truth is DevTools →
**Bypass for network**, `await caches.keys()`, or `curl` from outside.

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
edits, the selectors over items and the sync rows stay in `store.js`. Use the
selectors that are already there (`itemById`, `itemsDueOn`, `upcoming`,
`classesOn`, `dayTimeline`, …) instead of filtering by hand again.
`commit(fn, { source })` — `app.js` redraws only for `external`, `gcal`,
`cloud`, `editor`, `restore`, `undo`, `redo`, `canvas`; tag one made from a
floating panel, or the view under it will not repaint (`set()` in the editor
and `tickItem` are). `modal()` focuses the first control in its *body*, never
the ✕.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` against the
last good sync. Changed rows push, rows that went away leave a tombstone, and a
clash goes to whoever wrote last, row by row (`updated_at` decides, `synced_at`
is the pull cursor). **No book-keeping per change** — never add dirty flags or
`markChanged()`.

**Back from the background, ask for the session first** (`resume()`): an iOS
app that slept wakes with an expired token, and a sync fired straight away got
a 401 before supabase-js had refreshed it. A sync that meets one refreshes and
goes once more, once (`authRetried`). **Sync watches itself.** `cloud.log` is the last thirty syncs; the loop breaker halts after `LOOP_MAX` pushes in a row with nothing
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

**The baseline is what we last *pushed*, not what state holds now.** A row
missing here is "new from the cloud" *only* if the baseline never had it, or
taking the server copy undoes a delete; and the baseline is the hashes
`push()` sent, never a snapshot taken after, or a delete made mid-trip is lost.

**A migration is not an edit, and this one cost real data.** The baseline hashes
each row, so a migration that adds a field — `tz` on every class meeting — makes
every row it touched look edited, and the first device to open the new build
pushes its whole copy over everyone else's. So `cloud.js` records the schema its
baseline was built under, and a bump throws the baseline away: with none, the
cloud wins every row, and the new shape goes up only once we agree with the
server. `push()` sends `rowStamp()`, never the clock at send; `rowStamp()` must
know every kind that carries one, and **`migrate()` must carry `updatedAt`
through** — the area normaliser once did not. Postgres has the last word: `planner_rows_keep_newest` drops a write older
than the row it lands on (`supabase/upgrade.sql`; a delete still passes, being
its own decision). **The baseline is a short hash per row** (cyrb53, keys
sorted first, as jsonb comes back sorted), held in memory as well as
localStorage. `AGREED` is schema *and* hash shape, so an old one goes too.

**Sync is fan-out, not safety.** `keepBackups()` copies the raw state *before
`migrate()` reads it* — one a day, five kept, plus `before-v<n>` as an upgrade
runs, under their own keys, out of sync's reach.

**Never sync device credentials** — no Google tokens, no Supabase URL or anon
key, no cursors in `snapshotRows()`. Settings sync by list (`SYNCED_SETTINGS`);
the device's own are the other list (`DEVICE_SETTINGS`), and `version.test`
reads the sources so a key in neither is a red suite. Postgres only allows the row kinds
it was built with, so **a new kind needs an `ALTER` the user has to run**
(`supabase/upgrade.sql`, safe to run twice, named by `describeSyncError()`);
so does a new table (`planner_feeds`, `planner_health`, `planner_health_tokens`).
Links, the wishlist, sprints, habits and each day's ticks (`habitlog:<date>`)
are rows of their own since schema 20, each with a clock in `rowStamp()`;
`meta` is only the semester and `SYNCED_SETTINGS`. `push()` reads back what the server
kept: a row that comes back different was refused by the trigger, and is taken
up here, its hash recorded, or it would be pushed again for ever. **An item
from the cloud goes through `normalItem()`** (migrate's shape) in `applyRow`,
so an older build cannot put an old shape in state; a row already in shape
must come out the same bytes, or every pull would push it back up.

## Data model

| | |
|---|---|
| `state.items` | tasks. **Scheduled** (`plan {date,start,mins}`, drawn to midnight and its tail at the top of the next day), **all day** (`plan.date`, no `start`; `plan.end` makes it a stretch of days, on each of them in `itemsPlannedOn`), or a **deadline** (`due`, `dueTime`, `estMins`) — never two at once, and all three read off the data. `repeat` makes it a series; `color` is its own, else the area's (`itemColor`); `habitId` ties it to a habit, and `toggleItem` ticks that habit for the task's day (`tickHabitFor`), never a day ahead, and an untick leaves a day the phone's steps earned |
| `state.areas` | courses/projects/etc. One `category`, plus `order`, `onChart`, `journal`, `freewrite`, and a `schedule` of meetings, each stamped with the `tz` it is written in, with `ex[date]` for one day of it (`null` cancelled, `{start,end,location}` moved — `setClassDay`); `from`/`until` (keys only when set) are the days it meets, else the term's (`termOf`) |
| `state.semester` · `state.calendar` | the term (`name`, `start`, `end`) is for **courses only**: when classes meet, the chart, the Canvas import · `calendar.start` is the day the planner began (worked out once, from the earliest row): Google is read from it, the Week tray drops work due before it. Both in the `meta` row |
| `state.notes` | per-day `focus`, `text`, `tomorrow`, `top3`, `journal` (`areaId -> entry`), keyed by date — **not** the same as `state.cards`, which are notecards (`areaId: null` = unfiled) |
| `links` / `wishlist` / `sprints` | link piles; things wanted and the parcels they turn into — a wish with `tracking` is asked about once a day per device (`js/tracking.js`, `track-parcel` on the edge, `trackingAt` device-only); focuses and sprints on the chart |
| `habits` / `habitLog` · `events` / `outbox` · `health` | habits and `date -> [habitId]`; `health` is `date -> steps` from the phone (`js/health.js`), read from `planner_health` once an hour per device (`healthAt`), **never pushed**, ticking `settings.stepsHabitId` at `stepsGoal` — both synced · the Google mirror — edited in place by `editEvent`/`removeEvent` (`js/eventedit.js` is the dialog), which patch it at once and queue a PATCH/DELETE keyed `event:<id>`; a pull lays the queue over what came down — and writes waiting to go |

**Only a `plan` block goes to Google Calendar.** A due date on its own is never
pushed — the top source of "why isn't it on my calendar". **A push is a queue,
never a request**: `pushItem()` puts the item in `state.outbox` (one row per
item) and `flushOutbox()` sends the lot `pushSettings.wait` after the last
change — a drag session hit Google's rate limit when every drop went out at
once. A 403 `rateLimitExceeded` is a pause (`backoffUntil`, doubling), not an
error. An all-day plan goes as `start`/`end` **dates**, the end being the
morning *after*. **Google is read over `pullWindow()`** — `calendar.start` to
a year ahead, never the term — and a token only reports the window it was
made under, so `gcal.window` is kept beside it and `windowMoved()` starts
over. **A sign-in keeps through `google-token`** (`supabase/functions/`, the
client secret on the edge): with a cloud session `signIn()` goes the code way
and keeps the refresh token beside the access token, device-only; it is tried
first, a 401 spends the hour not the grant (`expireToken`), and
`invalid_grant` drops it. **A held grant that failed today is waited on**:
`signIn(false)` throws `retry` (status `waiting`) and the minute timer tries
again, never Google's window — that window once a minute *was* the "sign
in again" — and the quiet way is tried once per spell (`quietTried`). Under
a consent screen in Testing Google ends a grant after seven days. `ITEM_TYPES` is `event`, `task`, `meeting`,
`homework`; no area puts it in General. `eventsOn` drops a Google event that **shadows a class** on the
schedule that day (same start, and same end or a shared word), since a
schedule read off Google is on Google still. The Canvas import keeps to the term (`inTerm`, two weeks'
slack): the feed carries every course still enrolled in. Each *seed*
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
`js/actions.js`** — tick, move, push forward (`pushTarget`: today from
behind, else tomorrow) — each with an Undo of its
own that puts the old *when* back through `upsertItem`. A Canvas
assignment is a deadline with `canvasId` (`js/canvas.js`); a re-import
refreshes the date and title and leaves the area, the tick and the notes alone
(an `.ics` file's event is the same with `icsUid`, `js/icsimport.js`). With no
area named a new thing goes to `areaForNew()`: `settings.lastAreaId`, the area
last opened or added to on this device, never synced.
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
series. `ex[key].mode` (`'plan'`/`'due'`) makes one occurrence the other kind
from its series, so `itemsDueOn`/`itemsPlannedOn` ask every series. "This and
after" from the first occurrence is all of them; ending a series before its
first day deletes it, or a rule that never fires sits in every sync unseen. **An occurrence is a copy** — writing to it throws the change away, so
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
`#/course` and `#/area/<id>`, falling back to Overview (and putting the hash
right when an open area is deleted); `AREA_CATEGORIES` is the one source for
the sidebar, the breakdown and the editor's select. Habits and the wishlist sit
under Personal but are **not** areas: `CATEGORY_PINS` hangs them off the group,
outside the `reorderable()` host.

**The month in the sidebar** (`js/minimonth.js`) is drawn by `paintChrome()`,
marks the week on screen (`weekAnchor()`), and is a drop target: `dragBlock`'s
`over()` names a landing off the grid, and the page turner ignores a pointer
well past the grid's edge, or the sidebar would turn the week.
**A reminder is the device's** (`js/remind.js`): `remindLead` is off
`SYNCED_SETTINGS`, the lead is asked for from a click, and what was said is
kept per day in `localStorage`, so a reload does not say it twice. The
worker shows it (`showNotification`) and a tap focuses the open tab.
`js/icsexport.js` writes the range out (UTC stamps, folded lines);
`js/share.js` draws the week on a canvas by hand, `layoutWeek()` first.
**Settings is one card per file** under `js/views/settings/`: each takes
`{ navigate }` and gives back its card, `bits.js` holds `section`, `field`,
`toggle`, and `settings.js` only lays them out. **`js/problems.js` keeps the
last twenty things that went wrong on the device** — `warn(tag, err)` in
place of `console.warn`, and what nothing caught (`watchWindow()`) — and
the Problems card at the foot of Settings shows them, since a phone has no
console. Device-only, never a row.
**Week follows the day** (`follows`) until prev/next let go of it. It draws
all 24 hours, opened at the settings' `dayStart` (or a little before now);
a block past midnight is drawn to midnight. A click or tap on the empty
all-day rail makes an all-day plan (`newBlockPrompt({ allDay })`); a click on
the empty grid is `inlineCreate` — an hour, named in place. **The week
turns under a drag** (`pageTurner`): held at the grid's edge or over ‹ ›, the
columns take the next week's dates and blocks in place — a rebuild would lose
the touch — and the block in hand stays put; called off, the drag goes back.
`overdue()` is deadlines gone by
*and* plain blocks booked on a day gone by with no deadline, unticked — a
series only for its deadlines. **The end-of-day note is the only thing that
crosses a day**: `tomorrow` becomes the next morning's `focus` by way of `carryForward()`, from
the draw *before* anything reads the note, only when `pendingTomorrow()` says
so (a `commit()` with no check would sync a row every visit), tagged
`{ source: 'carry' }`, and marked spent (`tomorrowUsed`) either way.
**Every note writer calls `touchNote(date)`**, or the note has no clock and
an old copy beats a new one. **The day starts at 3am** — `DAY_RESET_HOUR` and
`today(now)` in `js/util.js`, the one place that decides it — so an entry
written at 1am files under the day it is about. `sweepDone()` deletes work
ticked off *before* that reset, behind an Undo from `navigate()`.

**Semester is a chart, with the list behind a switch.** Bands are the three
categories, lanes are areas, and `area.onChart` (missing reads as true) picks
which. The maths is **whole days from the first day of term**, times `--day-w`
at the last moment, so `chartRange`, `itemSpan`, `packLanes` stay plain to
test. A **series draws as its run**, first occurrence to last. A **focus or a
sprint is a stretch of weeks in one area's lane**, dragged out like a block;
`kind` decides whether we ask for deliverables.

## Things that bit us

- `restoreDayScroll()` runs **right after append, in the same tick**:
  `scrollTop` does nothing before layout, and rAF never fires in a background
  tab. **A redraw under a finger loses the touch**: the node it began on is
  gone, so `navigate()` waits while `body.nav-dragging`.
- Both drags — `dragCreate()`, `dragSpan()` — fire only on the **empty grid
  itself**, never on a block in it, never on touch (there the drag scrolls);
  `pointercancel` and Escape must not open the prompt. `dragBlock()` is the
  other half: middle moves, edges resize, `grabMode` keeping a third for the
  middle. **It owns the click** the browser fires after every drag.
- A tray chip is planned only when let go **over a day** (`inside` from
  `hit()`). On touch `draggable({ hold })` waits, so a swipe along the tray
  scrolls it. A dialog a tap opens ignores the scrim for `SCRIM_GRACE_MS`.
  On a phone `.week-wrap` is `max-content` wide: a sticky head is hit-tested
  inside its own box, and a screen-wide box let taps on the rail through.
- **A finger says what it means by waiting.** A tap opens a block, a press held
  `HOLD_MS` picks it up, and moving before that hands the touch back to the
  scroller — so `.blk` keeps `touch-action: pan-x pan-y` (`none` would let a
  block eat the scroll) and `dragBlock` takes it, with `preventDefault()` on
  `touchmove`, only once the hold is out. On touch the mode is always `move`.
- **Pixels per hour come from CSS, never a number in the JS.** `--hour-h` and
  `--day-hour-h` draw the gridlines; `cssPx()` places the blocks. A hard-coded
  52 put every block an hour off on a phone. Crossing the breakpoint redraws.
- **Never size a textarea that has no width.** Measured at zero it wraps every
  word and reports tens of thousands of pixels; `fitBoxes()` watches width only.
  `body.rail-hidden` makes `#app` **one column**, or main sits in a zero-wide one.
- Quick add checks `parseLinkAdd()` **first** (a URL at the front is a bookmark)
  and `parseRange()` before `parseWhen()`, or half of "12-7" becomes a due time.
  A repeat ("every mon", "daily") is taken out *before* the date words, or "mon"
  reads as one next Monday. Only `http`/`https` are stored, or a saved
  `javascript:` URL would run as the app.
- **A wall-clock time needs the zone it was written in.** Every `area.schedule`
  slot carries `tz`; `scheduleDrift()` spots a device that has moved and
  `shiftSchedules()` rewrites the times, carrying the weekday across midnight.
  `state.events` holds wall clock worked out at fetch time, so a move
  (`settings.tzSeen`, device-only) drops the sync token.
- **Blocks that overlap**: `packBlocks()` is plain maths — clumps of things
  that touch, a column each. Begun together (`SAME_START`) they share the
  width, `LAP` running all but the last under its neighbour; begun apart the
  later sits over the earlier, set in by `CASCADE`, so both titles show.
  `applyLanes()` writes it as `--lane-x/w/z`.
- Capture's **Enter must stay the shortest way out** — an unfiled note, never a
  question. There is no Notes page: `unfiledQueue()` on Overview, `noteCard()`
  on the area's page; delete either and captures have nowhere to show.

## Tests

Serve the repo, open `/tests/`: no runner in the page, no deps, 1586 checks,
left out of the deploy; CI opens the same page in Chromium. A file reports to
`tests/index.html` **once its last suite has finished**, and its suites **run
one at a time** (`queue` in `suite()`), or their `storeWith` seeds clobber.

Suites drive the real modules and wipe app state, so **both guards must stay**:
refuse to run anywhere but localhost, and put `localStorage` back afterwards,
waiting out `save()` (120ms) — and `pushSoon` (1500ms) only when a suite
signed in, which leaves a cloud or Google key behind. `store.js` reads
`localStorage` once, at import, so `migrate()` needs a fresh instance —
`storeWith(raw)`, which **checks** its seed. A file that has not reported in
90s is a **failure**. A fresh instance has its own `state`, so a suite that
pokes state *and* calls any other module must use `sharedStoreWith()` —
once per page, since `import()` caches. A view is drawn with
`renderInto(render)`: a stage, the hosts a panel writes to, and a `go` that
remembers where it was sent.

## House rules

Days are `'YYYY-MM-DD'` **local**, times `'HH:MM'` 24h, timestamps ISO
(`js/util.js`). DOM by `h()`, never template strings. No framework, JSX or
TypeScript — but the shapes are JSDoc in `js/types.js`, and a module that
says `// @ts-check` at its top is read by `tsc` in the Deploy job
(`jsconfig.json`; the pure ones, the store, sync and Google do; the views
not yet). A new field on a task
goes in the `Item` typedef too.
