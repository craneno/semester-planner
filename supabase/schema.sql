-- Semester Planner — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- One table, not five. The client owns the shape of a task; Postgres provides
-- durability, auth, and fan-out between devices. A `kind` discriminator plus a
-- jsonb payload means adding a field to a task later is a client-side change
-- with no migration here.

create table if not exists public.planner_rows (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  kind       text        not null check (kind in ('area', 'item', 'note', 'card', 'meta')),
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


-- Already have a project from an earlier version of this file? Run
-- `upgrade.sql` beside this one instead. It is idempotent, and it is what the
-- planner points you at when a push is rejected.
