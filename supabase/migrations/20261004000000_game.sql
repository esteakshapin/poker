-- Online poker tables.
--
-- Who can see what:
--   game_public      what everyone at the site may see about a table (seats, bets, board). Members read.
--   game_hands       hand history. Members read. server_seed and deck stay NULL until revealed.
--   game_hole_cards  each player's own hole cards. Only that player reads them.
--   game_private     full game state incl. the undealt deck.  \  Nobody reads these through the API;
--   game_secrets     server seeds of unrevealed hands.         /  only the server function (service role).
-- All writes go through the `game` server function.

create table if not exists public.game_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  config jsonb not null,
  tournament_id text,           -- tracker tournament this session counts toward (null = practice chips)
  created_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.game_public (
  table_id uuid primary key references public.game_tables on delete cascade,
  state jsonb not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.game_private (
  table_id uuid primary key references public.game_tables on delete cascade,
  state jsonb not null,
  version integer not null default 0
);

create table if not exists public.game_hands (
  id uuid primary key,
  table_id uuid not null references public.game_tables on delete cascade,
  hand_no integer not null,
  commitment text not null,     -- SHA-256 of the server seed, published before the hand
  client_seeds jsonb not null,  -- each player's seed, fixed when the hand starts
  server_seed text,             -- revealed after the hand / session
  deck jsonb,                   -- full shuffled deck, revealed with the seed
  record jsonb,                 -- actions, board, results (filled in when the hand ends)
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (table_id, hand_no)
);

create table if not exists public.game_secrets (
  hand_id uuid primary key references public.game_hands on delete cascade,
  server_seed text not null,
  deck jsonb not null
);

create table if not exists public.game_hole_cards (
  hand_id uuid not null references public.game_hands on delete cascade,
  profile_id text not null,
  cards jsonb not null,
  primary key (hand_id, profile_id)
);

alter table public.game_tables enable row level security;
alter table public.game_public enable row level security;
alter table public.game_private enable row level security;   -- no policies
alter table public.game_secrets enable row level security;   -- no policies
alter table public.game_hands enable row level security;
alter table public.game_hole_cards enable row level security;

drop policy if exists "members read tables" on public.game_tables;
drop policy if exists "members read table state" on public.game_public;
drop policy if exists "members read hands" on public.game_hands;
drop policy if exists "players read own cards" on public.game_hole_cards;
create policy "members read tables" on public.game_tables for select to authenticated using (can_view());
create policy "members read table state" on public.game_public for select to authenticated using (can_view());
create policy "members read hands" on public.game_hands for select to authenticated using (can_view());
create policy "players read own cards" on public.game_hole_cards for select to authenticated
  using (profile_id in (select id from public.poker_profiles where lower(email) = auth_email()));

revoke all on public.game_tables, public.game_public, public.game_private, public.game_hands, public.game_secrets, public.game_hole_cards from anon, authenticated;
grant select on public.game_tables, public.game_public, public.game_hands, public.game_hole_cards to authenticated;
grant all on public.game_tables, public.game_public, public.game_private, public.game_hands, public.game_secrets, public.game_hole_cards to service_role;
grant all on public.poker_state, public.poker_profiles, public.poker_admins to service_role;

-- Publish a finished hand's server seed and deck so anyone can verify it.
create or replace function public.game_reveal_hand(p_hand uuid) returns void
language sql security definer set search_path = public as $$
  update game_hands h set server_seed = s.server_seed, deck = s.deck
    from game_secrets s where s.hand_id = h.id and h.id = p_hand and h.ended_at is not null;
$$;

-- One atomic step of a game: only succeeds if nobody else moved the table in between.
create or replace function public.game_commit(
  p_table uuid, p_version integer, p_private jsonb, p_public jsonb,
  p_new_hand jsonb default null,   -- {id, hand_no, commitment, client_seeds, server_seed, deck, holes: {profile_id: [cards]}}
  p_end_hand jsonb default null    -- {id, record, reveal: bool}
) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  update game_private set state = p_private, version = version + 1
   where table_id = p_table and version = p_version returning version into v;
  if v is null then raise exception 'conflict'; end if;
  update game_public set state = p_public, version = v, updated_at = now() where table_id = p_table;

  if p_new_hand is not null then
    insert into game_hands (id, table_id, hand_no, commitment, client_seeds)
    values ((p_new_hand->>'id')::uuid, p_table, (p_new_hand->>'hand_no')::int, p_new_hand->>'commitment', p_new_hand->'client_seeds');
    insert into game_secrets (hand_id, server_seed, deck)
    values ((p_new_hand->>'id')::uuid, p_new_hand->>'server_seed', p_new_hand->'deck');
    insert into game_hole_cards (hand_id, profile_id, cards)
    select (p_new_hand->>'id')::uuid, key, value from jsonb_each(p_new_hand->'holes');
  end if;

  if p_end_hand is not null then
    update game_hands set record = p_end_hand->'record', ended_at = now() where id = (p_end_hand->>'id')::uuid;
    if (p_end_hand->>'reveal')::boolean then perform game_reveal_hand((p_end_hand->>'id')::uuid); end if;
  end if;
  return v;
end $$;

revoke all on function public.game_commit(uuid, integer, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.game_reveal_hand(uuid) from public, anon, authenticated;
grant execute on function public.game_commit(uuid, integer, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.game_reveal_hand(uuid) to service_role;

-- Live updates: clients subscribe to changes of the public table state.
do $$ begin
  alter publication supabase_realtime add table public.game_public;
exception when duplicate_object then null; when undefined_object then null; end $$;
