# CLAUDE.md

A local-first semester planner: static PWA, plain ES modules, no dependencies,
backed by `localStorage`, with optional Google Calendar and Supabase sync.
Currently schema **15**, service worker **planner-v25**.

## Working on it

The repo *is* the site — no build, no install. Edit a file, reload.

```bash
python3 -m http.server 8000     # then http://localhost:8000
```

Before pushing: click through the app, and open **`/tests/`** (runs every suite,
prints one total). The Deploy workflow only runs `node --check` — it proves the
files *parse*, not that they work.

**Bump `VERSION` in `sw.js` whenever a file in its `SHELL` list changes**, and
add new modules to `SHELL`. Without it browsers keep serving the cached copy.

**Add the release to `js/changelog.js` in the same commit.** It is what
Settings shows, and its newest entry *is* the version — `version.test.html`
fails when it and `sw.js` disagree, and when a module the app imports is
missing from `SHELL`.

## When a change appears not to take effect

Almost always a cache or a stale module, not your code. In order of how often
each one has actually been the culprit:

1. **A hash-only navigation does not reload the page.** Going to `#/overview`
   when already at `#/overview` re-renders but keeps the *same module
   instances*, holding whatever state they accumulated. `location.reload()`.
2. **Local `http.server` sends no `Cache-Control`.** Chrome applies heuristic
   freshness (~10% of the file's age) and stops revalidating, serving stale
   modules for hours. `location.reload(true)` does not help — the argument is
   ignored. Serve with `Cache-Control: no-store` when it matters.
3. **In production a tab keeps the cache it started with.** Since v14 the app
   reloads itself once when a new worker takes over, so one load is usually
   enough.

**Never verify with a cache-busting query string.** `sw.js` matches with
`ignoreSearch: true`, so `?x=…` is dropped and you get the cached copy;
`fetch(url, {cache:'reload'})` is no better, since the request still passes
through the worker. Both *look* like network reads. What actually tells the
truth: **DevTools → Application → Service workers → Bypass for network**,
`await caches.keys()`, or `curl` from outside the browser. Tick **Update on
reload** in that panel while developing.

Nuclear reset (leaves `localStorage`, so no data loss):

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

## Service worker rules

- Install fetches with `cache: 'reload'`. A plain `c.add(u)` reads the HTTP
  cache, and Pages sends `max-age=600`, so a bumped `VERSION` could be filled
  with the files it was bumped to replace.
- **The fetch handler never writes to the cache.** A cache is filled once at
  install and never again, so everything it serves came from one deploy. It
  used to refresh per file, which let a page run one version's JS against
  another's CSS — that shipped, and an event with no `.day-lanes` rule sized
  itself to the whole viewport.
- `app.js` reloads once on `controllerchange`, guarded on a previous controller
  existing.

## State

`state` in [js/store.js](js/store.js) is the one live object. No reducers, no
per-view copies: views mutate state directly inside `commit()`, which persists
(debounced 120ms) and notifies subscribers.

```js
commit(() => { item.done = true; item.doneAt = new Date().toISOString(); });
```

Prefer the existing selectors (`itemById`, `itemsDueOn`, `upcoming`,
`classesOn`, `areasInCategory`, …) over re-filtering `state.items` inline.

`commit(fn, { source })` — `app.js` re-renders only for `external`, `gcal`,
`cloud`, `editor`. Tag a commit made from a floating panel or the view
underneath it will not repaint.

## Cloud sync

[js/cloud.js](js/cloud.js) hashes every row from `snapshotRows()` and compares
against the last successful sync. Changed rows push; vanished rows tombstone.
**No per-mutation bookkeeping** — never add dirty flags or `markChanged()`
calls; they would rot immediately. Conflicts are last-write-wins per row:
`updated_at` decides, `synced_at` is the pull cursor.

**The baseline is what was last *pushed*, not what state holds now.** Both of
these have been regressions:

- A row missing locally is "new from the cloud" *only* if the baseline never
  had it. If the baseline had it, it was deleted here and the tombstone has not
  gone up — adopting the server copy silently undoes the delete.
- Store the hashes `push()` actually sent, never a snapshot taken after it
  returns, or a delete made mid-round-trip looks already-synced and is lost.

There is no baseline on a first sync or after "Rebuild sync", so the cloud wins
by design and an unpushed deletion does not survive a rebuild.

**Never sync device credentials.** `snapshotRows()` must not emit Google
tokens, the Supabase URL/anon key, or sync cursors. Settings sync by allowlist
(`SYNCED_SETTINGS`); anything absent stays device-local, which is how
`settings.railClosed` and `settings.railHidden` stay per-device.

Links and the wishlist ride in `meta` for the same reason habits do — see
below. `applyRow` takes `data.links` and `data.wishlist` only when the key is
**present**: a device on an older schema sends neither, and absent must not
read as empty or its next meta push wipes the lot.

Row kinds are constrained by Postgres. `supabase/schema.sql` allows
`area, item, note, card, meta` — **a new kind needs an `ALTER` the user must
run**, which is why habits and links ride inside the `meta` row instead.
`supabase/upgrade.sql` is that migration for a database made before the current
schema; it is idempotent, and `describeSyncError()` names it when a push is
rejected rather than surfacing the constraint name.

## Data model

| | |
|---|---|
| `state.items` | tasks. Either **scheduled** (`plan {date,start,mins}`) or a **deadline** (`due`, `dueTime`, `estMins`) — never both. Read via `!!item.plan.start`. |
| `state.areas` | courses/projects/etc. One `category` each, plus an `order` and `onChart` |
| `state.cards` | notecards. `areaId: null` = unfiled |
| `state.notes` | per-day `focus`, `text`, `tomorrow` and `top3`, keyed by date — **not** the same as cards |
| `state.links` | saved links, `areaId` naming the pile. Rides in the `meta` row |
| `state.wishlist` | things wanted and the parcels they become — one object, `status` moves along `WISH_STATUSES`. Rides in `meta` |
| `state.habits` / `habitLog` | habits and `date -> [habitId]` |
| `state.events` / `outbox` | Google mirror, and queued writes |

**Only a `plan` block reaches Google Calendar.** A due date alone is never
pushed — this is the single most common source of "why isn't it on my
calendar".

`ITEM_TYPES` is four: `event`, `task`, `meeting`, `homework` (`LEGACY_TYPE`
maps the pre-schema-8 eleven). Items have no `grade`. An item created with no
area lands in the first personal area — General — via `defaultAreaId()`, and
so does a link with no area named after it.

### Schema history

Each *seed* is pinned to the version that introduced it — `if (from < 5)`,
never `< SCHEMA_VERSION`, or the next bump resurrects something the user
deliberately deleted. A *rename* is the opposite: `MERGED_CATEGORY` is applied
unpinned, in `areaCategory()`, because a category id that no longer exists has
to be translated every time one is read — including in `applyRow()`, since a
device still on the old schema keeps pushing the old name.

| v | change |
|---|---|
| 5 | `kind` → `category`; study logging removed; seeds Rocket |
| 6 | notecards; seeded NER Meetings (the seed is gone; the area survives) |
| 7 | `order` on areas |
| 8 | four item types; `grade` dropped; seeds a Personal area |
| 9 | habits; seeds the first five |
| 10 | seeds Sunscreen |
| 11 | the `ner` category folds into `project` (`MERGED_CATEGORY`) |
| 12 | links; the Personal area is renamed General; seeds Job search |
| 13 | the wishlist |
| 14 | `onChart` on areas — which ones the semester chart draws |
| 15 | `tomorrow` on a day's note, and the focus it becomes the next morning |

## Routing and views

`VIEWS` in `js/app.js`: overview, semester, week, habits, wishlist, settings.
Categories and areas are **data, not screens**, so `route()` resolves three
shapes: `#/week` (a view), `#/course` (a category page), `#/area/<id>`. Unknown
hashes fall back to Overview, so old links still land.

`AREA_CATEGORIES` in store.js is the single source for the sidebar, the
overview breakdown and the editor's select; add an entry plus a
`CATEGORY_GLYPH` in app.js and it appears everywhere.

Habits and the wishlist sit under Personal in the sidebar but are **not**
areas — no work is ever due in them. `CATEGORY_PINS` in app.js hangs a plain
view off a category group, outside the `reorderable()` host: a pinned row has
no `reorderId`, and a drop that swept it up would have nowhere to write the
order.

A category row is a top-level row like Overview, so **the caret is appended
after the label, never prepended**. Anything in front of the glyph pushes the
whole row right and breaks the one alignment the sidebar has; only areas are
indented (`.area-chip`, 33px — glyph width plus the gap).

**Overview is the day** — there is no Today page. Left column is a 24-hour
clock opened at 8am (`--day-hour-h`, read from CSS rather than hard-coded);
right column is focus, top three, open work, end-of-day note.

**The end-of-day note is the only thing that crosses a day.** `tomorrow` is
carried into the next morning's `focus` by `carryForward()`, called from the
render *before* anything reads the note and only when `pendingTomorrow()` says
there is something — an unconditional `commit()` there would write and sync a
row on every visit. It is tagged `{ source: 'carry' }` so `app.js` does not
re-render the page mid-build. The line is spent (`tomorrowUsed`) even when the
day already has a focus, or it would arrive a day late; `carriedFrom` records
where a focus came from. `emptyNote()` counts `tomorrow`, or a note holding
only that line would be dropped from the sync and never reach another device.

**Semester is a chart, with the old list behind a switch.** Bands are the
three categories, lanes are areas, and `area.onChart` (default true, absent
reads as true) decides which appear — the chips above the chart, or the area
editor. Geometry is kept in **whole days from the first day of term** and
multiplied by `--day-w` at the last moment, which is what makes `chartRange`,
`itemSpan`, `packLanes`, `monthBands` and `fitDayWidth` pure and testable.
`--day-w` is written from JS rather than set in CSS because `packLanes`
measures titles in those same pixels; if the two disagreed, bars would be
stacked for a width the page does not use. A bar within a title's width of the
end of term writes its title to its *left* and is anchored by `right` — hence
`head` as well as `reserve` in the packing.

## Gotchas worth keeping

- `restoreDayScroll()` runs **synchronously after append**, not in a
  `requestAnimationFrame`: `scrollTop` is ignored before layout, and rAF never
  fires in a background tab — exactly when a restored session renders.
- `ui.js` keeps **one modal at a time**; a second `modal()` closes the first.
  The calendar picker expands inline inside the area editor for this reason.
- A drag grip must `preventDefault()` on `pointerdown`, or the browser starts a
  text selection and the drag reads as a highlight.
- `dragCreate()` in `js/timegrid.js` fires only when the press lands **on the
  column itself** (`only: '.daycol'` / `'.day-lanes'`), never on a block drawn
  inside it, and never on touch — the same gesture scrolls the grid there. The
  day and the column are fixed at the press: following the pointer sideways
  into tomorrow would silently move the block being drawn.
- `body.rail-hidden` makes `#app` a **single-column** grid. `display:none`
  removes the sidebar from the grid, so `0 1fr` would leave main in the
  zero-width column and render a blank page.
- Quick add checks `parseLinkAdd()` **first**: a line starting with a URL is a
  bookmark, not something to do. Trailing words name the area (`… ner`), and
  words that name none become the title rather than being dropped.
- A link's title comes from its URL and nothing else. The page's own `<title>`
  is unreadable across origins, so the guess is meant to be corrected — and
  only `http`/`https` are stored, since a saved `javascript:` URL would run as
  the app the moment it was clicked.
- A Google Drive URL has no name in it, only a 33-character id, which the
  hash rule would throw away and leave the bare host. `linkTitleFromUrl` names
  the *kind* instead — Google Doc, Drive file, Drive folder. Reading the real
  name needs a Drive scope this app does not ask for, and asking for one would
  re-prompt for the calendar consent it already has.
- `parseRange()` runs before `parseWhen()` in quick add, or one half of "12-7"
  becomes a due time and the other is stranded in the title. Bare hours read as
  people say them (7–11 morning, 12 noon, 1–6 afternoon); a range after
  ch/page/problem/section is not a time.
- Capture's **Enter must stay the shortest path out** — saves an unfiled note,
  never asks a question. Shift+Enter is a newline.
- There is no Notes page. `unfiledQueue()` in `capture.js` renders under the box
  on Overview, and a filed note shows on its area's page via the same exported
  `noteCard()` — so removing the page cost nothing. Deleting the queue or that
  export would strand every capture with no way to file, edit or delete it.
- `.pad` is `margin-inline: auto`. Left-aligned it clings to one side and every
  right-anchored control stops at the 1180px cap, which on a wide screen looks
  like the middle; collapsing the sidebar then changes nothing visible.
- `habitStreak()` forgives an untouched today (the day is not over) but not a
  missed yesterday. `habitRemaining()` counts down to `HABIT_TARGET` (21).
- `recurringSeries()` reads a schedule off calendar *instances* (we sync
  `singleEvents: true`), not an RRULE. A slot seen once is dropped so a
  rescheduled week is not a phantom meeting.

## Tests

Serve the repo, open `/tests/`. No runner, no dependencies. 403 checks.

| file | covers |
|---|---|
| `harness.js` | `suite()`, the guards, `freshStore()` / `sharedStoreWith()` |
| `store.test.html` | migration, categories, ordering, selectors |
| `parse.test.html` | quick add: dates, time ranges, types, areas |
| `capture.test.html` | notecards, filing, card sync, version-pinned seeds |
| `habits.test.html` | ticking, streaks, the 21-day countdown, meta-row sync |
| `links.test.html` | what parses as a link, which pile it lands in, titles |
| `wishlist.test.html` | one-line add, the status lifecycle, ETA urgency, totals |
| `chart.test.html` | the term window, spans and clipping, lane packing, month bands |
| `timegrid.test.html` | a swept range: direction, quarter hours, the ends of the day |
| `gcal.test.html` | deriving a schedule from recurring events |
| `sync.test.html` | delete durability against a stand-in Supabase; error text |
| `version.test.html` | changelog vs `sw.js`, `SHELL` vs the import graph |

Suites drive the real modules and clobber app state, so **both guards must
stay**: refuse to run outside localhost, and restore `localStorage` afterwards
— waiting out `save()` (120ms) and `pushSoon` (1500ms) first, or they overwrite
the restore. `tests/` is excluded from the deploy.

`store.js` reads `localStorage` once at import, so `migrate()` needs a fresh
module instance: `storeWith(raw)`. But a fresh instance has its own `state`, so
a suite that pokes state *and* calls into `gcal.js`/`cloud.js` must use
`sharedStoreWith()` — those import the canonical store and two instances never
see each other.

## Adding a field to a task

1. Add it to the literal in `upsertItem()` in `js/store.js`.
2. Add a fallback in `migrate()` so saved data still loads.
3. Add a row to the properties list in `js/editor.js`.

Sync ships whatever shape the object has; nothing else is needed.

## Where things live

| I want to change… | Edit |
|---|---|
| shell, router, sidebar, quick add | `js/app.js` |
| state, schema, migrations, parser | `js/store.js` |
| a screen | `js/views/<screen>.js` |
| category pages, one area's page, its link pile | `js/views/areas.js` |
| today's clock, focus, end-of-day | `js/views/overview.js` |
| the capture box, the unfiled queue, a note card | `js/capture.js` |
| dragging out a time range on either grid | `js/timegrid.js` |
| the semester chart | `js/views/semester.js` |
| patch notes, and what version this is | `js/changelog.js` |
| toasts, modals, peek, drag, reorder | `js/ui.js` |
| the task detail panel | `js/editor.js` |
| Google Calendar | `js/gcal.js` |
| Supabase sync | `js/cloud.js`, `supabase/schema.sql`, `supabase/upgrade.sql` |
| colours, spacing, grids | `css/app.css` |
| themes and fonts | `js/appearance.js`, `[data-theme]` in `css/app.css` |

## Conventions

- Calendar days are `'YYYY-MM-DD'` in **local** time; times are `'HH:MM'` 24h;
  timestamps are ISO. See `js/util.js`.
- Build DOM with `h()` from `js/util.js`, not template strings.
- No framework, no JSX, no TypeScript. Match the surrounding style.
