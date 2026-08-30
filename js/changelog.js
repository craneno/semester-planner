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
    version: 'v22', date: '2026-08-29',
    title: 'The semester as a chart',
    notes: [
      'Semester is now a Gantt chart across the whole term, in three bands — courses, projects, personal. Planned work draws as a bar, a deadline as a diamond, and today as a line down the page.',
      'An area can sit the chart out without being archived: the chips above the chart, or the checkbox in the area editor.',
      'The list with its filters and search is still there, behind the Chart / List switch.',
      'Google Drive links are named by what they are — Google Doc, Drive file, Drive folder — instead of by the file id, which read as a hash and got thrown away.',
      'Overview opens with a line worth reading rather than a weather report. One quote a week.',
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
