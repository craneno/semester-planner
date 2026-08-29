# Semester Planner

A static PWA: Notion-style database views over a Google Calendar–style time grid.
One task object feeds Overview, Semester, Week, Today, and course progress — you never enter it twice.

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

Data is per-origin. `localhost:8000` and your Vercel URL are separate stores; use **Settings → Export backup** to move between them.

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

**Study.** Pomodoro (25/5, 45/10, 50/10) or free stopwatch. All timing is computed from wall-clock
timestamps, not an interval counter, so it stays accurate when the phone locks or Safari throttles the
tab. Only focus periods are logged; breaks aren't.

**Keyboard.** `1`–`7` switch views, `/` or `n` focus quick add, `Esc` closes panels.

---

## Not built

- Supabase accounts and cloud sync — Google Calendar covers cross-device for anything with a time on it,
  but tasks without a planned time still live per-device. Export/import is the bridge for now.
- Push notifications and reminders (needs a server).
- Weighted grade categories. Grades are per-task with a simple per-course percentage.
- Server-side LLM syllabus parsing. Current detection is regex heuristics — it will miss things, which
  is exactly why the review step is mandatory.
