-- Semester Planner — bring an existing database up to date.
--
-- Paste this whole file into the Supabase SQL editor and run it. It is
-- idempotent: running it twice, or running it on a database that is already
-- current, does nothing and reports no error.
--
-- Only run this if your project was created before the current schema.sql. A
-- database created from schema.sql today already has everything below.

-- Row kinds are constrained by the database, and a project created before
-- notecards existed still refuses `kind = 'card'`. Cards then fail to push and
-- the planner reports "Cloud problem — open Settings" on every sync.
--
-- Habits and saved links deliberately do NOT appear here: they travel inside
-- the `meta` row precisely so that adding them needs no migration.
alter table public.planner_rows
  drop constraint if exists planner_rows_kind_check;

alter table public.planner_rows
  add constraint planner_rows_kind_check
  check (kind in ('area', 'item', 'note', 'card', 'meta'));

-- Study logging was removed in schema 5. These rows can no longer be read by
-- any client, so they are dead weight in every pull.
delete from public.planner_rows where kind = 'session';

-- Realtime respects RLS only when replica identity carries the filter column.
-- A project created before this was added syncs correctly but never live.
alter table public.planner_rows replica identity full;
