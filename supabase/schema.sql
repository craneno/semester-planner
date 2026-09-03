-- Semester Planner — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- One table, not five. The client owns the shape of a task; Postgres provides
-- durability, auth, and fan-out between devices. A `kind` discriminator plus a
-- jsonb payload means adding a field to a task later is a client-side change
-- with no migration here.

create table if not exists public.planner_rows (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  kind       text        not null check (kind in ('area', 'item', 'note', 'card', 'meta', 'link', 'wish', 'sprint', 'habit', 'habitlog')),
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),  -- writing client's clock: settles conflicts
  synced_at  timestamptz not null default now(),  -- server clock: the pull cursor
  primary key (user_id, kind, id)
);

-- The pull is always "everything after this cursor", so index for exactly that.
create index if not exists planner_rows_cursor_idx
  on public.planner_rows (user_id, synced_at);

-- synced_at must come from the server on every write, never from the client.
create or replace function public.planner_touch()
returns trigger
language plpgsql
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists planner_rows_touch on public.planner_rows;
create trigger planner_rows_touch
  before insert or update on public.planner_rows
  for each row execute function public.planner_touch();

-- Nothing older may overwrite something newer.
--
-- Conflicts are settled last-write-wins by the client, which holds right up
-- until a client is wrong about what it has. A schema upgrade that adds a
-- field to every row makes each one look freshly edited, and the first device
-- to open the new build would push its whole copy over everyone else's — with
-- no history to undo it. This is the backstop: the database keeps whichever
-- version was written last and drops a stale write. A delete always passes; a
-- tombstone is a real decision and carries its own newer stamp.
--
-- Runs before planner_touch (triggers of the same timing fire in name order),
-- so a rejected write still gets its synced_at bumped and nothing else.
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
  for each row execute function public.planner_rows_keep_newest();

-- Row level security: you can only ever see and write your own rows.
alter table public.planner_rows enable row level security;

drop policy if exists "planner_rows owner" on public.planner_rows;
create policy "planner_rows owner"
  on public.planner_rows
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Live updates between your laptop and your phone.
alter publication supabase_realtime add table public.planner_rows;

-- Realtime respects RLS only when replica identity carries the filter column.
alter table public.planner_rows replica identity full;


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


-- Already have a project from an earlier version of this file? Run
-- `upgrade.sql` beside this one instead. It is idempotent, and it is what the
-- planner points you at when a push is rejected.
