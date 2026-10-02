-- Home Game Tracker: one-time Supabase setup.
-- 1. Replace CHANGE-ME below with the passcode you want for editing.
-- 2. Paste this whole file into Supabase > SQL Editor and click Run.
-- Anyone with the app link can VIEW the data. Saving requires the passcode,
-- which is stored only as a hash and checked inside the database.

create extension if not exists pgcrypto with schema extensions;

-- The whole app state is one JSON document.
create table if not exists public.poker_state (
  id text primary key,
  data jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.poker_state (id) values ('main') on conflict (id) do nothing;

-- Passcode hash. No policies, so it can't be read through the API.
create table if not exists public.poker_secret (
  id integer primary key check (id = 1),
  hash text not null
);
insert into public.poker_secret (id, hash)
values (1, extensions.crypt('CHANGE-ME', extensions.gen_salt('bf')))
on conflict (id) do update set hash = excluded.hash;

alter table public.poker_state enable row level security;
alter table public.poker_secret enable row level security;
drop policy if exists "anyone can read" on public.poker_state;
create policy "anyone can read" on public.poker_state for select using (true);
grant select on public.poker_state to anon, authenticated;
-- No insert/update/delete policies: writes only go through save_state below.

create or replace function public.check_passcode(p_passcode text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (select 1 from poker_secret where id = 1 and hash = crypt(p_passcode, hash));
$$;

-- Saves only with the right passcode, and only if nobody else saved in between (version check).
create or replace function public.save_state(p_passcode text, p_data jsonb, p_version integer)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v integer;
begin
  if not check_passcode(p_passcode) then
    raise exception 'bad passcode';
  end if;
  update poker_state
     set data = p_data, version = version + 1, updated_at = now()
   where id = 'main' and version = p_version
  returning version into v;
  if v is null then
    raise exception 'conflict';
  end if;
  return v;
end;
$$;

revoke all on function public.save_state(text, jsonb, integer) from public;
revoke all on function public.check_passcode(text) from public;
grant execute on function public.save_state(text, jsonb, integer) to anon, authenticated;
grant execute on function public.check_passcode(text) to anon, authenticated;

-- To change the passcode later, run just this line with the new value:
-- update public.poker_secret set hash = extensions.crypt('NEW-PASSCODE', extensions.gen_salt('bf')) where id = 1;
