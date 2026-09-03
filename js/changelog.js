// changelog.js — what changed, and when, in the app that changed.
//
// The version is the service worker's cache name with the `planner-` prefix
// taken off, because that is the only version a browser can actually be
// running: the shell is cached per VERSION and served whole. So these two
// move together, and tests/version.test.html fails the build if they drift.
//
// Newest first. Each entry is one deploy.

export const CHANGELOG = [
  {
    version: 'v44', date: '2026-09-03',
    title: 'Canvas, by itself',
    notes: [
      'Paste your Canvas calendar feed link under Settings → Canvas and the app brings your assignments in by itself: once a day on each device, and whenever you press Refresh now. The link is kept in your own row on the server, never on the device, and a small function there does the fetching, since Canvas will not talk to a page directly.',
      'Needs supabase/upgrade.sql run once more, and the function deployed once: supabase functions deploy canvas-feed. The file import still works as before.'
    ]
  },
  {
    version: 'v43', date: '2026-09-03',
    title: 'Say when, say how often',
    notes: [
      'Quick add reads more: “tmrw”, “in 3 days”, “in a week”, “next week”, “in a month”, “this fri”.',
      'And repeats: “gym every mon”, “lab every tue and thu 2-4pm”, “laundry every other week”, “standup every weekday 9am”, “vitamins daily”. The rule goes on the task; the first one lands on the nearest day it fits.',
      'Coming back to the app after hours no longer starts with a sync error: the session is refreshed first, and a sync that meets an expired token refreshes it and goes once more.'
    ]
  },
  {
    version: 'v42', date: '2026-09-03',
    title: 'Undo, and a tap',
    notes: [
      'Ctrl+Z undoes the last change, whatever it was: an edit, a delete, a drag, a tick. Ctrl+Shift+Z or Ctrl+Y redoes. Ten steps deep; typing close together counts as one. A change that arrives from another device clears it.',
      'On a phone, a tap on empty grid — the day clock on Overview, or a column on Week — asks for an hour-long block at that time. The drag still scrolls.'
    ]
  },
  {
    version: 'v41', date: '2026-09-03',
    title: 'The store in pieces',
    notes: [
      'Nothing to see: store.js was one 2,000-line file and is now a set of small ones under js/store/. Every screen works as before. If anything looks off, say which screen.'
    ]
  },
  {
    version: 'v40', date: '2026-09-03',
    title: 'Sync that watches itself',
    notes: [
      'Settings has a sync log: the last thirty syncs from this device, with how many rows went up and came down. A loop shows there in the first minute.',
      'Sync stops itself if it sends rows on five syncs in a row with nothing edited here. Sync now starts it again.',
      'The server keeps every version of every row for thirty days. Settings lists what it used to hold, and a Put back button makes any old version the newest. Run supabase/upgrade.sql once to turn it on.',
      'A row that came down from another device is no longer sent straight back up.'
    ]
  },
  {
    version: 'v39', date: '2026-09-02',
    title: 'The sync a second, for real this time',
    notes: [
      'Found it. The server stores each row with its fields in sorted order, so every row came back in a different order than it went up. Since v36 a push reads its rows back, saw each as “changed”, and sent it again on the next sync — and each send woke the next sync. The fingerprint now ignores the order of fields.',
      'The cloud status line in Settings shows the same text while a sync runs, so the page no longer nudges up and down on a phone. The dot in the top bar is what pulses.'
    ]
  },
  {
    version: 'v38', date: '2026-09-02',
    title: 'A sync that would not stop',
    notes: [
      'Sync remembered what it had sent by keeping every row’s whole text on the device. On a phone that ran the device out of room, the memory quietly failed to save, every sync sent everything, and every send came back as one more sync — one a second. It keeps a short fingerprint per row now, holds it in memory as well, and Settings says how much room the app is using.',
      'The sidebar no longer sticks halfway if the page is redrawn under your finger. A redraw waits until you let go, and a menu left mid-way settles on the next touch or after a moment.'
    ]
  },
  {
    version: 'v37', date: '2026-09-02',
    title: 'The menu follows your finger',
    notes: [
      'On a phone the sidebar now slides in as you swipe, and slides the rest of the way when you let go. It used to snap.',
      '“Everything today” stays open. It was rebuilt closed every time a sync brought news, which on a busy day was every few seconds.',
      'Two tabs of the planner on one device no longer sync each other for ever. Each sync wrote a time the other tab took for an edit and pushed, round and round, and Settings twitched with every round.'
    ]
  },
  {
    version: 'v36', date: '2026-09-02',
    title: 'Canvas, find, and a way back',
    notes: [
      'Canvas. Settings → Canvas takes the .ics feed file Canvas gives you (Calendar → Calendar Feed) and turns every assignment into a deadline in the right course. Bring it in again any time; what you have filed, ticked or written on is left alone.',
      'Find. Press / anywhere — tasks, notes, cards, links and areas in one box, Enter opens the first hit. Press ? for the other keys: n to add, t for today, arrows to move weeks, Esc to close.',
      'Undo, for the small things too. A tick, a dragged block, a push to tomorrow — each gets the same Undo a delete has had.',
      'Push to tomorrow. The → on any row moves it a day: a block keeps its time, a deadline moves, a thing with no date gets tomorrow.',
      'This and after. A repeating event can now be changed from one occurrence on — the room moves in October, September stays put. And any task can be duplicated from its panel.',
      '@thermo files it. An area tag in quick add now takes the start of a name or of any word in it, with @ as well as #.',
      'A red line on the week grid for now, favicons on saved links, and on a phone the quick add box sits above the tabs where your thumb is.',
      'Under the hood: links, the wishlist, sprints, habits and each day’s ticks are now rows of their own in the cloud rather than one bag, each with its own clock — run supabase/upgrade.sql once more. And after every push the app reads back what the server actually kept, so a write the database refused is taken up here rather than pushed again for ever.'
    ]
  },
  {
    version: 'v35', date: '2026-09-02',
    title: 'Nothing older wins',
    notes: [
      'A bug of mine deleted a freewrite. Yesterday’s upgrade stamped a timezone onto every class meeting; sync spots changes by hashing rows, so every area looked freshly edited, and the first device to open it pushed its whole copy over the other one’s. This release is the fix and the guard against the next one.',
      'An upgrade is no longer an edit. The sync layer remembers which schema it last agreed with the server about, and when that moves it adopts the server’s copy first and sends the new shape after.',
      'Areas now keep the time they were really edited — the old code threw that away on every load, so a stale copy could beat a fresh one with nothing to compare. A push carries that time instead of the clock at send.',
      'Your database can now refuse a stale write outright. Run supabase/upgrade.sql once in the SQL editor: it adds a trigger that keeps whichever version was written last, so a bad build cannot do this again even if the app is wrong.',
      'And copies. Before the app reads anything it keeps a copy on the device — one a day, five days back, plus one taken the moment a schema upgrade is about to run. Settings → Data lists them. Nothing that syncs can reach them.'
    ]
  },
  {
    version: 'v34', date: '2026-09-01',
    title: 'Where you are, and what is under what',
    notes: [
      'A class schedule now records the timezone it was written in. Open the planner somewhere else and it says so — “these were set in Pacific, you are on Eastern” — and moves every meeting by the difference on one tap, or leaves them where they are if the trip is not a move.',
      'Settings → Semester has the same thing by hand, for a schedule imported before any of this existed and still on the old clock. Say where the times came from and they move once, with an Undo.',
      'Moving between zones also re-reads the Google calendar from scratch, since its times were worked out where you used to be.',
      'Two things at the same hour no longer sit on top of each other. They share the width, the way a calendar does — which on a phone is the difference between seeing the 9:30 and not knowing it was there.'
    ]
  },
  {
    version: 'v33', date: '2026-08-31',
    title: 'Things that happen again',
    notes: [
      'Anything with a date can repeat: daily, weekly on the weekdays you pick, every other week, monthly on the date, yearly — ending never, on a day, or after a number of times. The panel has it under Repeat.',
      'Open one of them and you are editing that one. The switch at the top says so, and says how the series runs; “All of them” is a tap away when you mean the lot.',
      'Move a Tuesday, skip a week, tick one off — none of it touches the others. Deleting asks whether you meant this one, this one and everything after, or all of them.',
      'Every occurrence goes to Google Calendar as its own event, so moving one here moves that one there and leaves the rest alone. The term is the horizon: a repeat with no end fills the semester, not the rest of your life.',
      'A term of Mondays is one row, not fifty. It syncs, and takes up space, like a single item.'
    ]
  },
  {
    version: 'v32', date: '2026-08-31',
    title: 'Press and hold to pick a block up',
    notes: [
      'Hold a block for a moment on a phone and it lifts; carry it where it should go and let go. A tap still opens it — waiting is how a finger says which of the two it means.',
      'Blocks stopped swallowing the scroll. A finger that comes down on one and keeps going now scrolls the grid, as it does everywhere else; only a finger that stays put takes hold.',
      'A finger always moves a block, never stretches it. The 8px edges that resize under a mouse are finer than a fingertip, and the panel is where a time gets typed.'
    ]
  },
  {
    version: 'v31', date: '2026-08-31',
    title: 'The phone, fixed',
    notes: [
      'Blocks in the Week view sat almost an hour below their own gridline on a phone: the grid drew a shorter hour there than the blocks were placed for. Both read the same number now.',
      'Tap a block to open it. Touch never started a drag, and the drag was the only thing listening for a tap — so on a phone a block could not be opened at all.',
      'Habits: the name gets a line of its own and the week sits under it, ticks full width. Seven boxes and two numbers had left the name reading four characters wide.',
      'Drag in from the left edge for the menu, and back to the left to put it away. Tapping beside it closes it too.',
      'Writing is no longer interrupted. Sync heard its own change come back from the server and repainted the page for it — every few seconds while you typed, which takes the caret with it. The same went for a quiet minute on Google Calendar.',
      'All-day events. Say “all day” when you add one, or pick it in the panel beside Scheduled and Deadline. It sits in the all-day row above the grid and goes to Google Calendar as a real all-day event.'
    ]
  },
  {
    version: 'v30', date: '2026-08-30',
    title: 'The day now ends at 3am',
    notes: [
      'The planner’s day begins at 3am, not midnight. At 1am it is still showing yesterday — so a journal entry written after midnight files under the day you are writing about, a habit ticked on the way to bed credits the day you were awake for, and nothing is overdue an hour early.',
      'Finished tasks are deleted at that reset. Tick one at 2pm and it stays all day; at 3am, or the next time you open the app after 3am, it goes — with an Undo on the toast that says how many went.',
      'The first reset after this update clears everything you had already ticked off on an earlier day. Settings → Appearance has a switch to turn the whole thing off first.',
      'A swept task with a block on your Google Calendar leaves the event behind, exactly as deleting one by hand always has.'
    ]
  },
  {
    version: 'v29', date: '2026-08-30',
    title: 'Take hold of a block',
    notes: [
      'Drag a planned block by its middle to move it — to another time, and in the Week view to another day. Drag it by its top or bottom edge to change when it starts or ends, the way a calendar does.',
      'Overview’s clock could not do any of this before; the Week view could only move a block, and only resize it from a handle drawn on it.',
      'Classes and Google events stay put: one comes from an area’s recurring schedule, the other is a read-only mirror, so dragging either would edit something the grid is not showing.',
      'A band on the semester chart now writes its name beside itself when it is too narrow to hold it — the rule task bars already followed. Bands are taller and stronger too, and no longer read “CH…”.'
    ]
  },
  {
    version: 'v28', date: '2026-08-30',
    title: 'Focuses, sprints, and what is on now',
    notes: [
      'Drag sideways across an area’s lane on the semester chart to block out a stretch of weeks. A focus is the theme of those weeks; a sprint is a work package, and carries the deliverables that say when it is finished — ticking them fills the bar.',
      'Every area page ends in a freewrite box. No prompt, no dates, nothing to press: it saves itself and syncs like everything else.',
      'The top right of every screen says what is on now, or what is next, or that there is nothing today.',
      'The week starts on Sunday. Settings can still put it back.',
      'The week number and the percent-of-term elapsed are gone from the sidebar, Overview and the week bar. They measured the calendar, not you.'
    ]
  },
  {
    version: 'v27', date: '2026-08-29',
    title: 'Something to write in',
    notes: [
      'The Journal page opens on a box for today, with no prompt above it — a journal that asks a question is a form.',
      'Earlier days sit behind a dropdown, one entry each, still editable.',
      'Any area can keep one: the switch is in the area editor. A lab notebook for a project works the same way.',
      'Entries ride in the day they were written, so they sync a day at a time rather than as one block that grows all term.'
    ]
  },
  {
    version: 'v26', date: '2026-08-29',
    title: 'A Journal under Personal',
    notes: [
      'A Journal area, beside General and Job search. Captured notes filed there show on its page, and links and work can go there like anywhere else.',
      'Seeded once, on this version only — delete it and it stays deleted.'
    ]
  },
  {
    version: 'v25', date: '2026-08-29',
    title: 'Draw on the calendar',
    notes: [
      'Press on empty grid and drag — on Overview’s clock or in the Week view — to sweep out a time range, then name it. The range follows the pointer in quarter hours and reads out its own start and end while you draw it.',
      'Double-clicking empty grid does the same thing for an hour. It used to drop an untitled block on the page and open the panel.',
      'Dragging up works as well as down, and a press that never moves leaves nothing behind. Touch is untouched — the same gesture scrolls the grid there.'
    ]
  },
  {
    version: 'v24', date: '2026-08-29',
    title: 'The end of one day starts the next',
    notes: [
      'End of day now asks two things: what moved, and what tomorrow needs. The second one is a single line, and in the morning it is already sitting in today’s focus, marked with the night it came from.',
      'It was write-only before — the note was saved and synced and never read back by anything, so a line about tomorrow went nowhere.',
      'A Friday night reaches Monday morning; a line older than a week does not. One you set yourself is never overwritten.'
    ]
  },
  {
    version: 'v23', date: '2026-08-29',
    title: 'The week’s quote taken back out',
    notes: [
      'Overview opens on the sentence about the week again. The quote is gone — a line you did not choose, in the largest type on the page, every time you open it.'
    ]
  },
  {
    version: 'v22', date: '2026-08-29',
    title: 'The semester as a chart',
    notes: [
      'Semester is now a Gantt chart across the whole term, in three bands — courses, projects, personal. Planned work draws as a bar, a deadline as a diamond, and today as a line down the page.',
      'An area can sit the chart out without being archived: the chips above the chart, or the checkbox in the area editor.',
      'The list with its filters and search is still there, behind the Chart / List switch.',
      'Google Drive links are named by what they are — Google Doc, Drive file, Drive folder — instead of by the file id, which read as a hash and got thrown away.',
      'This list, at the bottom of Settings.'
    ]
  },
  {
    version: 'v21', date: '2026-08-29',
    title: 'Notes page dropped, content centred',
    notes: [
      'The Notes page is gone — it was one more row in the sidebar for something already on Overview. Unfiled captures sit under the capture box; filed ones show on their area\u2019s page, still editable.',
      'The page is centred in the window again. Collapsing the sidebar now visibly widens it, and right-anchored controls sit at the right edge instead of stopping in the middle of a wide screen.',
      'Parchment: a theme built for reading for hours — dark on light, off-white rather than #FFF, contrast near 10:1, and warm.'
    ]
  },
  {
    version: 'v20', date: '2026-08-29',
    title: 'Wishlist, and a straighter sidebar',
    notes: [
      'A wishlist that turns into a delivery tracker: one line to add, a status from wanted to delivered, and an ETA that goes amber the day before and red when it is late.',
      'Courses, Projects and Personal now start at the same left edge as Overview, Semester and Week; only areas are indented. The caret moved to the right of the label.'
    ]
  },
  {
    version: 'v19', date: '2026-08-29',
    title: 'Links, General, Job search',
    notes: [
      'Paste a URL into the bar up top and it is filed as a link rather than read as a task. A word after it names the pile — "\u2026 ner" puts it with NER.',
      'Link titles are guessed from the URL and can be corrected in place; only http and https are ever stored.',
      'The Personal area became General, Job search was added beside it, and Habits moved under Personal.'
    ]
  },
  {
    version: 'v17', date: '2026-08-29',
    title: 'NER folded into Projects',
    notes: [
      'NER stopped being a heading of its own — a subteam is a project like any other. Existing NER areas were moved, not deleted, and a device still on the old schema has its category translated on the way in.'
    ]
  },
  {
    version: 'v16', date: '2026-08-29',
    title: '21 days',
    notes: [
      'Each habit counts down to 21 days rather than only showing a streak. An untouched today is forgiven; a missed yesterday is not.',
      'Sunscreen added. Dead code swept out.'
    ]
  },
  {
    version: 'v15', date: '2026-08-29',
    title: 'Habits, and a sidebar that folds',
    notes: [
      'A habit tracker with a week of ticks and a running streak.',
      'The sidebar folds away, per device — it never syncs.'
    ]
  },
  {
    version: 'v14', date: '2026-08-29',
    title: 'One version\u2019s files, or none',
    notes: [
      'The service worker cache is filled once at install and never written to again, so a page can no longer run one deploy\u2019s JavaScript against another\u2019s CSS.',
      'A tab reloads itself once when a new worker takes over, so one load is enough to be on the new version.'
    ]
  },
  {
    version: 'v13', date: '2026-08-29',
    title: 'Today as a clock',
    notes: [
      'Overview\u2019s left column is a 24-hour day opened at 8am, with classes, calendar events and planned work drawn where they actually fall.'
    ]
  },
  {
    version: 'v12', date: '2026-08-29',
    title: 'Real events from quick add',
    notes: [
      'Quick add books an event on the calendar, not just a task with a date.',
      'The task panel cut down to what it needs.'
    ]
  },
  {
    version: 'v11', date: '2026-08-29',
    title: 'Drag courses into order',
    notes: [
      'Areas reorder by dragging, and the order syncs as a field on the row rather than as array position.',
      'Today folded into Overview.'
    ]
  },
  {
    version: 'v10', date: '2026-08-29',
    title: 'Courses from the calendar',
    notes: [
      'A recurring calendar event can become an area\u2019s schedule — days, times and room all come from what the event actually does.',
      'Capture: Enter saves a note, Shift+Enter is a newline.'
    ]
  },
  {
    version: 'v9', date: '2026-08-28',
    title: 'Categories instead of study logging',
    notes: [
      'Every area belongs to one category, which is what the sidebar groups by. Study logging was removed.'
    ]
  },
  {
    version: 'v8', date: '2026-08-28',
    title: 'Cache past the cache',
    notes: [
      'The worker fetches the shell with cache: reload at install, so a freshly bumped version cannot be filled with the files it was bumped to replace.'
    ]
  },
  {
    version: 'v7', date: '2026-08-28',
    title: 'Deletes stay deleted',
    notes: [
      'Cloud sync stopped resurrecting deleted rows: a row missing locally is new from the cloud only if the last push never had it.'
    ]
  },
  {
    version: 'v6', date: '2026-08-28',
    title: 'Confirm dialogs answer honestly',
    notes: [
      'A confirm dialog no longer settles false before you have answered it.'
    ]
  },
  {
    version: 'v5', date: '2026-08-28',
    title: 'First deploy',
    notes: [
      'The planner: a static PWA with local-first storage, Google Calendar two-way sync, and optional Supabase sync across devices.'
    ]
  }
];

/** What this build is. Matched against sw.js by the tests. */
export const APP_VERSION = CHANGELOG[0].version;
export const CURRENT = CHANGELOG[0];
