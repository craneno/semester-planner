# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no deps, kept in
`localStorage`, with optional Google Calendar and Supabase sync.
Schema **20**, service worker **planner-v36**.

## Working with me

**Ask, don't guess.** When a request could mean two things — where a thing goes,
whether it sticks around, what a new field holds — ask before building: early,
all at once, and only about what changes the work. Small calls are still yours.

**Small words beat big ones.** Say it the short way — here, in commits, in code
comments. Keep the real names exact (`syncToken`, tombstone, occurrence) and
drop the dress-up around them. This file may run to **250 lines**; past that,
cut a sentence and say what went.

## Working on it

The repo *is* the site — no build, no install: `python3 -m http.server 8000`.
Before you push, click through the app and open **`/tests/`**; the Deploy job
only runs `node --check`, which proves the files *parse* and nothing more.
**Bump `VERSION` in `sw.js` whenever a file in its `SHELL` changes**, add new
modules to `SHELL`, **and add the release to `js/changelog.js` in the same
commit**. The newest changelog entry *is* the version; `version.test.html` fails
when it and `sw.js` disagree, or when a module we import is not cached. Install
fetches with `cache: 'reload'`, or Pages' `max-age=600` fills the new cache with
the very files it is meant to replace. **The fetch handler never writes to the
cache**, so a page runs one whole deploy — refreshing file by file once ran one
version's JS against another's CSS.

**When a change seems not to land**, it is nearly always a cache. A hash-only
move does not reload — `#/overview` when you are already there keeps the same
module instances, so `location.reload()`. `http.server` sends no `Cache-Control`
and Chrome makes up its own freshness, so serve `no-store` on a new port (a new
origin is a clean cache). **Never check with a cache-busting query string** —
`sw.js` matches with `ignoreSearch: true` and `fetch(cache:'reload')` still goes
through the worker, so both only *look* like reads off the network. The truth is
DevTools → **Bypass for network**, `await caches.keys()`, or `curl` from outside.

## State

`state` in [js/store.js](js/store.js) is the one live object. No reducers, no
per-view copies: views change it in place inside `commit(() => { … })`, which
saves (waits 120ms) and tells subscribers. Use the selectors that are already
there (`itemById`, `itemsDueOn`, `upcoming`, `classesOn`, `dayTimeline`, …)
instead of filtering by hand again. `commit(fn, { source })` — `app.js` redraws
only for `external`, `gcal`, `cloud`, `editor`; tag a commit made from a
floating panel, or the view under it will not repaint.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` against the
last good sync. Changed rows push, rows that went away leave a tombstone, and a
clash goes to whoever wrote last, row by row (`updated_at` decides, `synced_at`
is the pull cursor). **No book-keeping per change** — never add dirty flags or
`markChanged()`.

**Redraw for news, not for every sync.** `pull()` drops a row that hashes to
what we already hold — our own write, come back down the realtime channel —
since `applyRow` calls any live row a change, and the redraw takes the caret out
of the box being typed in. `gcal.js` tags `gcal` only when something arrived.

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
its own decision).

**Sync is fan-out, not safety.** An upsert keeps no history and reaches every
device in seconds. `keepBackups()` copies the raw state *before `migrate()`
reads it* — one a day, five kept, plus one named `before-v<n>` the moment an
upgrade is about to run. `events`/`outbox` are left out (rebuilt from Google,
and most of the bytes), and the copies sit under their own keys so nothing
syncable can reach them.

**Never sync device credentials** — no Google tokens, no Supabase URL or anon
key, no cursors in `snapshotRows()`. Settings sync by list (`SYNCED_SETTINGS`);
anything off the list stays on the device — that is how `railHidden` and
`tzSeen` stay put. Postgres only allows the row kinds it was built with —
`area, item, note, card, meta` — so **a new kind needs an `ALTER` the user has
to run** (`supabase/upgrade.sql`, safe to run twice, named by
`describeSyncError()`). Links, the wishlist, sprints, habits and each day's
ticks (`habitlog:<date>`) are rows of their own since schema 20, each with a
clock in `rowStamp()`; `meta` is only the semester and `SYNCED_SETTINGS`, and
`applyRow` **ignores** the lists an old device still sends in it. `push()`
reads back what the server kept: a row that comes back different was refused
by the trigger, and is taken up here, its hash recorded, or it would be pushed
again for ever.

## Data model

| | |
|---|---|
| `state.items` | tasks. **Scheduled** (`plan {date,start,mins}`), **all day** (`plan.date`, no `start`), or a **deadline** (`due`, `dueTime`, `estMins`) — never two at once, and all three read off the data. `repeat` makes it a series |
| `state.areas` | courses/projects/etc. One `category`, plus `order`, `onChart`, `journal`, `freewrite`, and a `schedule` of meetings, each stamped with the `tz` it is written in |
| `state.notes` | per-day `focus`, `text`, `tomorrow`, `top3`, `journal` (`areaId -> entry`), keyed by date — **not** the same as `state.cards`, which are notecards (`areaId: null` = unfiled) |
| `links` / `wishlist` / `sprints` | link piles; things wanted and the parcels they turn into; focuses and sprints on the chart |
| `habits` / `habitLog` · `events` / `outbox` | habits and `date -> [habitId]` · the Google mirror and writes waiting to go |

**Only a `plan` block goes to Google Calendar.** A due date on its own is never
pushed — the top source of "why isn't it on my calendar". An all-day plan does
go, as `start`/`end` **dates**, the end being the morning *after*. `ITEM_TYPES`
is four: `event`, `task`, `meeting`, `homework`; no area puts it in General.
Each *seed* is pinned to the version that added it — `if (from < 5)`, never
`< SCHEMA_VERSION`, or the next bump brings back something deleted on purpose.
A *rename* is the other way round (`MERGED_CATEGORY`, not pinned, in
`areaCategory()`): a dead id has to be turned into a live one every time it is
read.

**The small edits live in `js/actions.js`** — tick, move, push to tomorrow —
each with an Undo that puts the old *when* back through `upsertItem`. A Canvas
assignment is a deadline with `canvasId` (`js/canvas.js`, brought in as a file:
Instructure sends no CORS headers); a re-import refreshes the date and title and
leaves the area, the tick and the notes alone.

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
  tab, which is exactly when a restored session draws.
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
  `touchmove`, only once the hold is out. On touch the mode is always `move`: an
  8px resize edge is finer than a fingertip, and the sidebar's swipe stays at the
  left edge for the same reason.
- **Pixels per hour come from CSS, never a number in the JS.** `--hour-h` and
  `--day-hour-h` draw the gridlines; `cssPx()` places the blocks. A hard-coded 52
  put every block most of an hour below its own line on a phone, where the media
  query makes the hour 46. Crossing that breakpoint redraws, or the layout maths
  stays that of the size it was born in.
- **Never size a textarea that has no width.** One measured at zero wraps every
  word onto its own line and reports tens of thousands of pixels; `fitBoxes()`
  watches width only. `body.rail-hidden` makes `#app` **one column** — `0 1fr`
  would leave main in the zero-wide column and draw a blank page.
- Quick add checks `parseLinkAdd()` **first** — a URL at the front is a bookmark
  — and `parseRange()` before `parseWhen()`, or half of "12-7" becomes a due time
  and the rest is stuck in the title. A link's title comes from its URL alone and
  is meant to be fixed by hand; only `http`/`https` are stored, or a saved
  `javascript:` URL would run as the app.
- **A wall-clock time needs the zone it was written in.** Every `area.schedule`
  slot carries `tz`; `scheduleDrift()` spots a device that has moved and
  `shiftSchedules()` rewrites the times, carrying the weekday across midnight.
  The stamp is the answer as well as the question — it stops a second device
  asking the same thing. `state.events` holds wall clock worked out at fetch
  time, so a move (`settings.tzSeen`, device-only) drops the sync token.
- **Blocks that overlap share the width**, or the later one is drawn flat over
  the earlier. `packBlocks()` is plain maths — clumps of things that touch, a
  column each, `LAP` running all but the last under its neighbour; `applyLanes()`
  writes it as `--lane-x/w/z`. Too narrow for both, a short block keeps its name,
  not its time.
- Capture's **Enter must stay the shortest way out** — an unfiled note, never a
  question. There is no Notes page: `unfiledQueue()` on Overview, `noteCard()` on
  the area's page; delete either and captures have nowhere to show.

## Tests

Serve the repo, open `/tests/`. No runner, no deps, 852 checks, and `tests/` is
left out of the deploy. A file holds several suites, and reports to
`tests/index.html` **once the last one has finished** — taking the first hid a
failure in a later one.

Suites drive the real modules and wipe app state, so **both guards must stay**:
refuse to run anywhere but localhost, and put `localStorage` back afterwards,
waiting out `save()` (120ms) and `pushSoon` (1500ms) first. `store.js` reads
`localStorage` once, at import, so `migrate()` needs a fresh instance —
`storeWith(raw)`, which **checks** its seed rather than sleeping and hoping —
and ask for few, since each instance sets off a `save()` that lands on the next
one's fixture. A fresh instance has its own `state`, so a suite that pokes state
*and* calls `gcal.js`/`cloud.js` must use `sharedStoreWith()` — once per page,
since `import()` caches. To add a field to a task: `upsertItem()`, a fallback in
`migrate()`, a row in `js/editor.js`. Sync ships whatever shape it finds.

## House rules

Calendar days are `'YYYY-MM-DD'` **local**, times `'HH:MM'` 24h, timestamps ISO
(`js/util.js`). Build DOM with `h()`, not template strings. No framework, no
JSX, no TypeScript. Match the style around you.
