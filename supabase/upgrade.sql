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
-- Schema 20 gave links, the wishlist, sprints, habits and each day's habit
-- ticks kinds of their own. They used to ride together inside `meta` so that
-- adding one needed no migration — which made the whole pile one row with no
-- clock, settled by whoever pushed last, and a loss was the lot of them.
alter table public.planner_rows
  drop constraint if exists planner_rows_kind_check;

alter table public.planner_rows
  add constraint planner_rows_kind_check
  check (kind in ('area', 'item', 'note', 'card', 'meta', 'link', 'wish', 'sprint', 'habit', 'habitlog'));

-- Study logging was removed in schema 5. These rows can no longer be read by
-- any client, so they are dead weight in every pull.
delete from public.planner_rows where kind = 'session';

-- Realtime respects RLS only when replica identity carries the filter column.
-- A project created before this was added syncs correctly but never live.
alter table public.planner_rows replica identity full;

-- Nothing older may overwrite something newer.
--
-- The client decides conflicts last-write-wins, which works right up until a
-- client is wrong about what it holds. A schema upgrade that adds a field to
-- every row makes each one look freshly edited; the first device to open the
-- new version then pushes its whole copy over everyone else's, and an upsert
-- keeps no history to undo it with. A freewrite was lost that way.
--
-- The client is now careful about this, but "careful" is not a guarantee and a
-- bad build reaches every device at once. This is the guarantee: the database
-- itself keeps whichever version was written last, and a stale write is
-- dropped rather than applied. A delete is always allowed through — a
-- tombstone is a real decision, and it carries its own newer stamp.
create or replace function public.planner_rows_keep_newest()
returns trigger
language plpgsql
as $$
begin
  if NEW.deleted is distinct from true
     and OLD.updated_at is not null
     and NEW.updated_at is not null
     and NEW.updated_at < OLD.updated_at then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists planner_rows_keep_newest on public.planner_rows;

create trigger planner_rows_keep_newest
  before update on public.planner_rows
  for each row
  execute function public.planner_rows_keep_newest();


-- Every version a row has had, kept 30 days. An upsert keeps no history of
-- its own, and a bad sync reaches every device in seconds; this is the way
-- back. The app lists the last of these under Settings and can put one back.
create table if not exists public.planner_rows_history (
  hid bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz,
  replaced_at timestamptz not null default now()
);

create index if not exists planner_rows_history_user_time
  on public.planner_rows_history (user_id, replaced_at desc);

alter table public.planner_rows_history enable row level security;

drop policy if exists "planner_rows_history owner" on public.planner_rows_history;
create policy "planner_rows_history owner"
  on public.planner_rows_history
  for select
  using (auth.uid() = user_id);

-- Runs as the table owner: the policy above lets a user read, never write,
-- and the trigger is the only thing that writes.
create or replace function public.planner_rows_keep_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- the same bytes again is not a version (a stale write that
  -- planner_rows_keep_newest turned into a no-op lands here too)
  if TG_OP = 'UPDATE'
     and OLD.data = NEW.data
     and OLD.deleted is not distinct from NEW.deleted then
    return null;
  end if;
  insert into public.planner_rows_history (user_id, kind, id, data, deleted, updated_at)
    values (OLD.user_id, OLD.kind, OLD.id, OLD.data, coalesce(OLD.deleted, false), OLD.updated_at);
  -- now and then, sweep what is older than 30 days
  if random() < 0.02 then
    delete from public.planner_rows_history
      where user_id = OLD.user_id and replaced_at < now() - interval '30 days';
  end if;
  return null;
end;
$$;

drop trigger if exists planner_rows_keep_history on public.planner_rows;

create trigger planner_rows_keep_history
  after update or delete on public.planner_rows
  for each row
  execute function public.planner_rows_keep_history();

-- Your Canvas calendar feed link, so the app can bring assignments in by
-- itself. The link carries a per-user token, so it lives here, in your own
-- row, and never on a device; only the canvas-feed Edge Function reads it,
-- as you (supabase/functions/canvas-feed).
create table if not exists public.planner_feeds (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  url        text        not null,
  updated_at timestamptz not null default now()
);

alter table public.planner_feeds enable row level security;

drop policy if exists "planner_feeds owner" on public.planner_feeds;
create policy "planner_feeds owner"
  on public.planner_feeds
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
