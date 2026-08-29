# Working on this

There is no build step and no dependencies to install. Edit a file, reload the page.

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Hard-reload (Cmd/Ctrl + Shift + R) after editing, or the service worker will
serve you the cached copy. When you change anything in `sw.js`'s `SHELL` list,
bump `VERSION` in the same file so browsers fetch the new files.

## Where things live

| I want to change… | Edit |
|---|---|
| how a screen looks | `js/views/<screen>.js` |
| category pages, one area's page | `js/views/areas.js` |
| the categories themselves | `AREA_CATEGORIES` in `js/store.js` |
| colours, spacing, the week grid | `css/app.css` |
| what a task stores | `js/store.js` (add to `upsertItem`, then the editor) |
| the task detail panel | `js/editor.js` |
| Google Calendar behaviour | `js/gcal.js` |
| Supabase sync | `js/cloud.js` and `supabase/schema.sql` |
| themes and fonts | `js/appearance.js` |

## Adding a field to a task

1. Add it to the object literal in `upsertItem()` in `js/store.js`.
2. Add a fallback for it in `migrate()` so existing saved data still loads.
3. Add a row to the properties list in `js/editor.js`.

Nothing else is needed — cloud sync ships whatever shape the object has, and
the Semester and Week views read from the same object.

## Before you push

```bash
node --check js/store.js   # or just let the deploy workflow catch it
```

The `Deploy` workflow parses every module before publishing, so a syntax error
fails the build instead of shipping a blank page. It proves the files parse,
not that they work — so also open `/tests/` and check the suites still pass,
and click through the app at `localhost:8000`.
