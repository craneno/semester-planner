# Semester Planner

A static PWA: Notion-style database views over a Google Calendar–style time grid.
One task object feeds Overview, Semester, Week, and course progress — you never enter it twice.

No build step, no framework, no bundler. Plain ES modules, one CSS file, one service worker.

---

## Run it

```bash
cd semester-planner
python3 -m http.server 8000
# open http://localhost:8000
```

`file://` will not work — ES modules, the service worker, and Google OAuth all require an `http(s)` origin.

## Deploy it

Drop the folder into any static host. Vercel:

```bash
npx vercel deploy --prod
```

No config needed. The whole app is static files.

## Install it

- **iPhone:** open the site in Safari → Share → Add to Home Screen. Launches standalone.
- **Windows:** Chrome/Edge → install icon in the address bar.

Data is per-origin. `localhost:8000` and your deployed URL are separate stores until you sign in to
cloud sync on both — after that they are the same account. Without an account, **Settings → Export
backup** moves data between them.

---

## Connect Google Calendar

You need your own OAuth client — there's no server, so there's nowhere to hide a shared secret.

1. **Google Cloud Console** → create or pick a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External → fill in app name and your email.
   Under **Audience**, add your own Google account as a **Test user**. Staying in "Testing" is fine
   for personal use; tokens expire more often but everything works.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
   Add your origin to **both** lists, with no trailing slash:

   | Field | Value |
   |---|---|
   | Authorised JavaScript origins | `http://localhost:8000` |
   | Authorised redirect URIs | `http://localhost:8000/index.html` |

   Add your production origin the same way (`https://your-app.vercel.app` and `https://your-app.vercel.app/index.html`).
   The redirect URI is only used by the installed-PWA sign-in path, but Google rejects the request if it's missing.
5. Copy the client ID into **Settings → Google Calendar → OAuth client ID**, then **Connect Google Calendar**.
6. Pick which calendar to sync. Default is `primary`.

### How the sync actually works

**Pulling in.** First connect does a bounded full sync across your semester dates and stores Google's
`syncToken`. After that it's incremental — only what changed. It polls every 60 seconds while the tab
is visible, plus on tab focus and on reconnect. If Google expires the token (HTTP 410) it silently
re-runs a full sync.

**Pushing out.** Any task with a planned date *and* a start time becomes a calendar event, tagged
`extendedProperties.private.plannerItemId`. That tag is what makes the round trip safe: when the event
comes back on the next sync it's matched to the task instead of being imported as a duplicate. Move or
resize the block in Google Calendar and the planner picks up the new time. Turn this off with
**Two-way sync** if you only want to read.

**Offline.** Writes queue in an outbox and flush when you're back online and signed in.

### Limits worth knowing

- **Polling, not push.** True instant push needs a server to receive Google's webhooks. 60-second
  polling is as live as a static site gets.
- **Tokens last about an hour.** The app refreshes silently in the background. In a browser tab this
  is invisible. In the installed iOS PWA, popups can't hand a result back to a standalone window, so
  it falls back to a full-page redirect — you'll occasionally see a Google page flash by.
- The access token is kept in `localStorage`. Reasonable for a personal planner on your own devices;
  don't run this on a shared machine.
- Only events inside your semester date range are mirrored.


---

## Cloud sync (Supabase)

Google Calendar covers anything with a time on it. Supabase covers everything
else — tasks with no planned slot, subtasks, notes, your theme —
and makes the planner genuinely the same app on your laptop and your phone.

Local-first: `localStorage` stays the working copy, so the app is instant and
works with no signal. Postgres is durable storage plus the fan-out between
devices.

### Set it up

1. Create a project at **supabase.com** (the free tier is plenty).
2. **SQL Editor** → paste `supabase/schema.sql` → Run. One table, one policy,
   one trigger.
3. **Settings → API** → copy the **Project URL** and the **anon public** key
   into the planner's Settings → Cloud sync.
4. Enter an email and password → **Create account**. If your project has email
   confirmation on (the default), confirm, then **Sign in**.
5. Repeat steps 3–4 on your phone with the same account.

The anon key is designed to be public. Row level security is what protects your
data: the policy in `schema.sql` restricts every read and write to
`auth.uid() = user_id`, so the key alone gets an attacker nothing.

### How it works

**Change detection is a snapshot diff.** After each save the client hashes every
row and compares against the hashes from the last successful sync. Changed rows
get pushed; rows that disappeared become tombstones. The alternative — flagging
each row as dirty at the point of mutation — needs every one of the dozens of
`commit(() => { t.done = true })` call sites across the views to remember to do
it, and would silently rot the first time someone forgot. This way there is
nothing to forget.

**Conflicts settle last-write-wins per row.** Each row carries two timestamps:

| Column | Clock | Used for |
|---|---|---|
| `updated_at` | the writing device | deciding who wins a conflict |
| `synced_at` | the server | the pull cursor |

Splitting them matters. If the cursor used device clocks, a phone running three
minutes fast would make the laptop skip changes forever. With a server cursor,
skew can at worst settle a genuine simultaneous edit the wrong way — and both
devices are yours, so that window is small.

A local row only contests a remote one if it actually changed since the last
sync. On a device's **first** sync there is no baseline to judge against, so the
established cloud copy wins any true conflict, while rows that exist only
locally are still pushed up. Signing in on a new device merges; it never
clobbers.

**Realtime.** The client subscribes to `postgres_changes` on your own rows, so a
change on the laptop lands on the phone in about a second. A 5-minute interval
sits behind it as a safety net for a dropped socket, and drops to 60 seconds if
realtime never connects.

**What does not sync, deliberately.** Google OAuth tokens, the Supabase URL and
key, and both sync cursors stay on the device that owns them. Semester dates,
areas and their category, tasks, subtasks, notes, theme, fonts and text size
all sync.

### If the two ever drift apart

Settings → Cloud sync → **Rebuild sync**. It clears this device's bookkeeping,
pulls the whole account down again, and re-uploads. No data is deleted.

Signing out leaves everything on the device. The planner keeps working offline
exactly as it did before you ever connected an account.

---

## Putting it on GitHub

The repo *is* the site — no build step, so the workflow is just edit, commit, push.

```bash
gh repo create semester-planner --private --source=. --push
# or, without the gh CLI:
git remote add origin git@github.com:<you>/semester-planner.git
git push -u origin main
```

The folder ships with a commit already made, so `git log` will show one entry
before you have touched anything.

### Publish it with GitHub Pages

`.github/workflows/deploy.yml` publishes on every push to `main`. Turn it on
once: **repo → Settings → Pages → Source: GitHub Actions**. Your site lands at
`https://<you>.github.io/semester-planner/`.

The workflow parses every module and the manifest before publishing, so a typo
fails the build instead of shipping a blank page.

Relative paths are used throughout, so the `/semester-planner/` subpath Pages
gives you works with no configuration. Add that URL — and
`https://<you>.github.io/semester-planner/index.html` — to your Google OAuth
client if you want Calendar sync on the deployed copy.

### Day to day

```bash
git add -A
git commit -m "what changed"
git push
```

Editing notes are in `CONTRIBUTING.md`. The short version: hard-reload after
edits, and bump `VERSION` in `sw.js` whenever you change the file list it
caches, or browsers will keep serving the old copy.

---

## Files

```
index.html                 shell
css/app.css                all styling, themes as CSS variables
sw.js                      offline cache (same-origin only; Google and CDN always hit the network)
manifest.webmanifest

js/store.js                state, persistence, schema migration, selectors, quick-add parser
js/util.js                 dates, DOM helper, formatting
js/ui.js                   toasts, modals, peek panel, pointer drag
js/editor.js               task detail panel
js/gcal.js                 Google Calendar auth + two-way sync
js/cloud.js                Supabase auth + snapshot-diff sync + realtime
supabase/schema.sql        run once in the Supabase SQL editor
js/appearance.js           themes and typography
js/syllabus.js             PDF text extraction + date detection + review step
js/views/*.js              one file per screen
```

### Data model

One `Work Item`, never duplicated across views:

```js
{
  id, title, areaId, type,          // assignment | reading | exam | quiz | paper | ...
  due, dueTime,                     // the deadline
  plan: { date, start, mins },      // when you intend to do it — separate concept
  priority, estMins, done, doneAt,
  subtasks: [{ id, title, done }],
  notes, grade: { score, outOf, category },
  gcalId                            // set once pushed to Google
}
```

`due` and `plan` stay independent. Dragging a block in the Week view moves `plan` only; the deadline
never moves by accident.

An `Area` is a course, research project, job, application push — anything work belongs to. Areas carry
their own color, which is independent of the global theme: switching from Graphite to Lavender never
overwrites a course color.

Storage key: `semesterPlanner.v1`. On first load the app looks for older keys (`plannerData`,
`semester-planner`, `planner`, …) and migrates them in without deleting the original.

---

## Using it

**Quick add** (top bar, or press `/` or `n`) parses as you'd write it:

```
Thermofluids II PS4 due fri 5pm 2h !high
Read chapter 9 due tomorrow
Midterm 10/14 3h
Draft abstract plan tue due sep 12
```

Understood: `due <when>`, `plan <when>` / `work <when>`, weekdays, `Sep 12`, `10/14`, `today`,
`tomorrow`, times (`5pm`, `at 14:30`), durations (`2h`, `45m`), `!high` / `!low`, `#area` or a bare
course name, and a type keyword.

**Week view.** Drag from the Unscheduled tray onto a day to plan work. Drag a block to move it, drag
its bottom edge to resize, double-click empty space for a new block. Blocks you own are filled; Google
Calendar events are outlined with a dashed edge. Everything is pointer-based, so it works the same on
an iPhone and a trackpad.

**Syllabus import.** Courses → Import syllabus. Upload a PDF (parsed in-browser with PDF.js) or paste
the schedule table. Nothing is added until you approve it in the review list — edit titles, fix dates,
uncheck bad detections.

**Categories.** Every area — a course, a project, something personal — is filed under
one of three categories, which are the sidebar's top level. A category page lists its areas with each
one's next few deadlines under it; clicking an area opens everything in it.

**Course recognition.** Adding an area offers **Pull from calendar**: it groups the repeating events on
your Google Calendar and fills the name, room, meeting days and times from one of them. It reads the
schedule off the event's actual instances, so a course that also meets for a lab comes back as two
meeting blocks, and a single rescheduled week is ignored. Works for any area — a lecture, a lab, a
weekly NER meeting.

**Links.** Paste a link into the Add bar and it is saved rather than turned into a task —
the tabs you mean to come back to, filed where the work is. A word after it names the area
(`nasa.gov/... ner`), anything else becomes the title, and with nothing after it the link goes to
**General**. Every area page has its pile at the bottom; the title is guessed from the URL and can be
edited in place, since a page's real title cannot be read from another origin.

**Wishlist.** Personal → Wishlist. One list for things you want and the parcels they turn into —
ordering something is a status change, never a retype. Add in one line (`Nozzle heater $48.50
mcmaster.com/1234`); the price and the link are pulled out and the rest is the name. Anything ordered
or shipped sorts to the top by ETA, and that date goes amber within two days and red once it is late.

**Capture.** Write in the box on Overview and press Enter; it becomes a notecard, unfiled, in the
queue directly under the box, and you decide later. Once filed it moves to that area's page. Without leaving the box you can instead file it straight to an area, to a task,
or to a task with a deadline and a time blocked — that last one lands on your calendar. Shift+Enter is a
newline, Tab reaches the filing buttons.

**Overview is the day.** Today runs down the left as a clock — classes, calendar events and the work you
planned, laid out on the hour with the gaps left visible, opened at 8am and scrollable to the rest. On the right: your focus and today's three, open work split by category, and a place to write
what moved. There is no separate Today page.

**Scheduled or due.** A task is one or the other. *Scheduled* has a date, a start and an end, and goes on
your Google Calendar. *Deadline* has a due date and an estimate of how long it will take. Quick add reads a
time range directly — `fly to boston aug 29 12-7` books noon to seven — while `problem set 3 due fri 5pm 2h`
makes a deadline. Four kinds of thing: event, task, meeting, homework.

**Habits.** Its own page, no areas involved: habits down the side, the week across the top, one tick per
day, and a streak that forgives today because the day is not over. Drag to reorder, rename in place.

**Sidebar.** A caret on each category folds its areas away, and the chevron in the top bar hides the
sidebar altogether — click it again to bring it back.

**Reordering.** Drag the grip on a course to move it up or down, either on its category page or in the
sidebar. The order is stored on the area itself, so it follows you to your phone.

**Keyboard.** `1`–`3` switch views, `/` or `n` focus quick add, `Esc` closes panels.

---

## Not built

- Push notifications and reminders (needs a server that can hold a schedule).
- Weighted grade categories. Grades are per-task with a simple per-course percentage.
- Server-side LLM syllabus parsing. Current detection is regex heuristics — it will miss things, which
  is exactly why the review step is mandatory.
