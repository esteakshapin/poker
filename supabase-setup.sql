-- Home Game Tracker: one-time Supabase setup.
-- 1. Replace ADMIN@EXAMPLE.COM below with the email you'll sign in with as admin.
-- 2. Paste this whole file into Supabase > SQL Editor and click Run.
--
-- Who can do what:
--   admin   (emails in poker_admins)      view + edit everything
--   player  (email set on a profile)      view everything, edit only their own profile
--   anyone else (even if signed up)       sees nothing

-- ---------- tables ----------
-- Tournaments, sessions, buy-ins and chip counts: one JSON document.
create table if not exists public.poker_state (
  id text primary key,
  data jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.poker_state (id) values ('main') on conflict (id) do nothing;

-- Player profiles, one row each so players can edit their own.
create table if not exists public.poker_profiles (
  id text primary key,
  first text not null default '',
  last text not null default '',
  display text not null default '',
  avatar text,
  notes text not null default '',
  email text unique,  -- the login that owns this profile (set by the admin)
  updated_at timestamptz not null default now()
);

create table if not exists public.poker_admins (email text primary key);
insert into public.poker_admins (email) values (lower('ADMIN@EXAMPLE.COM')) on conflict do nothing;

-- ---------- helpers ----------
create or replace function public.auth_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from poker_admins where email = auth_email());
$$;

create or replace function public.can_view() returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from poker_profiles where lower(email) = auth_email());
$$;

-- What the signed-in user is: {"role": "admin" | "player" | "none", "profile_id": ...}
create or replace function public.my_access() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'role', case when is_admin() then 'admin'
                 when exists (select 1 from poker_profiles where lower(email) = auth_email()) then 'player'
                 else 'none' end,
    'profile_id', (select id from poker_profiles where lower(email) = auth_email() limit 1));
$$;

-- Saves the tournament data: admin only, and only if nobody else saved in between.
create or replace function public.save_state(p_data jsonb, p_version integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update poker_state set data = p_data, version = version + 1, updated_at = now()
   where id = 'main' and version = p_version
  returning version into v;
  if v is null then raise exception 'conflict'; end if;
  return v;
end $$;

-- Players can't change which login owns a profile.
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() and (new.email is distinct from old.email or new.id <> old.id) then
    raise exception 'only the admin can change a profile''s email';
  end if;
  new.email := nullif(lower(trim(new.email)), '');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists guard_profile on public.poker_profiles;
create trigger guard_profile before update on public.poker_profiles for each row execute function public.guard_profile();

-- ---------- row level security ----------
alter table public.poker_state enable row level security;
alter table public.poker_profiles enable row level security;
alter table public.poker_admins enable row level security;  -- no policies: not readable via the API

drop policy if exists "members read state" on public.poker_state;
create policy "members read state" on public.poker_state for select to authenticated using (can_view());

drop policy if exists "members read profiles" on public.poker_profiles;
drop policy if exists "admin adds profiles" on public.poker_profiles;
drop policy if exists "admin or owner edits profile" on public.poker_profiles;
drop policy if exists "admin deletes profiles" on public.poker_profiles;
create policy "members read profiles" on public.poker_profiles for select to authenticated using (can_view());
create policy "admin adds profiles" on public.poker_profiles for insert to authenticated with check (is_admin());
create policy "admin or owner edits profile" on public.poker_profiles for update to authenticated
  using (is_admin() or lower(email) = auth_email()) with check (is_admin() or lower(email) = auth_email());
create policy "admin deletes profiles" on public.poker_profiles for delete to authenticated using (is_admin());

revoke all on public.poker_state, public.poker_profiles, public.poker_admins from anon;
grant select on public.poker_state to authenticated;
grant select, insert, update, delete on public.poker_profiles to authenticated;
revoke all on function public.save_state(jsonb, integer) from public, anon;
grant execute on function public.save_state(jsonb, integer) to authenticated;
grant execute on function public.my_access() to authenticated;

-- To add another admin later:
-- insert into public.poker_admins (email) values (lower('someone@example.com'));
