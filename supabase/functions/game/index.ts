// The dealer. Every game action goes through this one server function:
// it checks who is calling, applies the rules (engine.js), shuffles (fair.js) and saves the result.
// Players' browsers never see the deck or anyone else's hole cards.
//
// The same code runs locally (`supabase functions serve`) and in production.

import { createClient } from 'npm:@supabase/supabase-js@2';
import * as E from '../_shared/engine.js';
import * as F from '../_shared/fair.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
class UserError extends Error {}
const fail = (msg: string): never => { throw new UserError(msg); };
const must = <T>(res: { data: T; error: { message: string } | null }): T => { if (res.error) throw new Error(res.error.message); return res.data; };

type Caller = { email: string; profileId: string | null; isAdmin: boolean };

async function whoIs(req: Request): Promise<Caller> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user?.email) fail('Please sign in.');
  const email = data.user!.email!.toLowerCase();
  const [profile, admin] = await Promise.all([
    db.from('poker_profiles').select('id').eq('email', email).maybeSingle(),
    db.from('poker_admins').select('email').eq('email', email).maybeSingle(),
  ]);
  return { email, profileId: must(profile)?.id ?? null, isAdmin: !!must(admin) };
}

// ---------- seeds ----------
async function freshCommitment() {
  const serverSeed = F.randomSeed(32);
  return { serverSeed, commitment: await F.commitmentFor(serverSeed) };
}

// ---------- public view ----------
// deno-lint-ignore no-explicit-any
type Priv = any;
function publicState(p: Priv) {
  const view = E.publicView(p.table);
  if (view.hand) (view.hand as Priv).commitment = p.current?.commitment ?? null;
  return {
    ...view, status: p.status, revealMode: p.revealMode, tournamentId: p.tournamentId ?? null,
    nextCommitment: p.next?.commitment ?? null,      // published BEFORE the next hand is dealt
    seedsIn: Object.keys(p.seeds || {}),             // who has sent a client seed for the next hand
    deadline: p.deadline ?? null, nextHandAt: p.nextHandAt ?? null, played: p.played || {},
  };
}

// ---------- load / save with optimistic locking ----------
type Step = { newHand?: unknown; endHand?: unknown; after?: () => Promise<void> };
async function mutate(tableId: string, fn: (p: Priv) => Promise<Step | void> | Step | void) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = must(await db.from('game_private').select('state,version').eq('table_id', tableId).maybeSingle());
    if (!row) fail('No such table.');
    const p = row!.state;
    const step = (await fn(p)) || {};
    const pub = publicState(p);
    const { data, error } = await db.rpc('game_commit', {
      p_table: tableId, p_version: row!.version, p_private: p, p_public: pub,
      p_new_hand: step.newHand ?? null, p_end_hand: step.endHand ?? null,
    });
    if (!error) { if (step.after) await step.after(); return { state: pub, version: data }; }
    if (!/conflict/.test(error.message)) throw new Error(error.message);
  }
  throw new Error('The table is busy, try again.');
}

// Called after anything that may have finished the hand.
async function afterMove(p: Priv): Promise<Step> {
  const hand = p.table.hand;
  if (!hand) return {};
  if (hand.street !== 'done') {
    // The clock restarts only when the action actually moved on.
    const turn = `${hand.id}:${hand.actions.length}`;
    if (p.turn !== turn) { p.turn = turn; p.deadline = Date.now() + p.table.config.actionSeconds * 1000; }
    return {};
  }
  if (p.recorded === hand.id) return {};
  p.recorded = hand.id;
  p.deadline = null;
  p.nextHandAt = Date.now() + (hand.results.endedBy === 'showdown' ? 7000 : 3500);
  p.next = await freshCommitment();   // commit to the NEXT hand's seed now, before players send theirs
  p.seeds = {};
  p.current = { commitment: p.current.commitment };
  for (const pl of hand.players) p.played[pl.profileId] = (p.played[pl.profileId] || 0) + 1;
  return { endHand: { id: hand.id, record: E.handRecord(p.table), reveal: p.revealMode === 'hand' } };
}

// ---------- tournament link ----------
// deno-lint-ignore no-explicit-any
type Tournament = any;
async function loadTracker() {
  const row = must(await db.from('poker_state').select('data,version').eq('id', 'main').maybeSingle());
  return { data: row?.data || { tournaments: [] }, version: row?.version ?? 0 };
}
const findTournament = (data: Priv, id: string): Tournament => (data.tournaments || []).find((t: Tournament) => t.id === id);
function tournamentStack(t: Tournament, profileId: string): number {
  for (let s = t.sessions.length; s >= 1; s--) {
    const v = t.chips?.[s]?.[profileId];
    if (v !== undefined && v !== null && v !== '') return Number(v);
  }
  return 0;
}

// When a tournament table closes, it becomes one session in the tracker:
// final stacks are that session's chip counts and chips bought at the table become buy-ins.
async function writeTournamentSession(p: Priv, tableName: string) {
  const everyone = [...p.table.seats.filter(Boolean), ...Object.values(p.table.away)] as Priv[];
  const rows = everyone.filter(s => (p.played[s.profileId] || 0) > 0 || s.bought > 0);
  if (!rows.length) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, version } = await loadTracker();
    const t = findTournament(data, p.tournamentId);
    if (!t) return;
    const per = t.settings.chipsPerBuyIn;
    t.sessions.push({ date: new Date().toISOString().slice(0, 10), online: tableName });
    const no = t.sessions.length;
    t.chips = t.chips || {}; t.chips[no] = {};
    for (const s of rows) {
      t.chips[no][s.profileId] = s.stack;
      if (!t.players.some((x: Priv) => x.id === s.profileId)) t.players.push({ id: s.profileId });
      if (s.bought > 0) t.buyIns.push({ id: crypto.randomUUID().slice(0, 8), playerId: s.profileId, session: no, count: s.bought / per });
    }
    const { error } = await db.from('poker_state').update({ data, version: version + 1, updated_at: new Date().toISOString() }).eq('id', 'main').eq('version', version).select('version').single();
    if (!error) return;
  }
  throw new Error('Could not save the session to the tournament.');
}

// ---------- actions ----------
// deno-lint-ignore no-explicit-any
type Body = any;
const seated = (c: Caller) => c.profileId ?? fail('Your login is not linked to a player profile yet.');

const actions: Record<string, (b: Body, c: Caller) => Promise<unknown>> = {
  async create_table(b, c) {
    if (!c.isAdmin) fail('Only the admin can open a table.');
    const cfg: Priv = {
      smallBlind: Math.max(1, Math.floor(b.smallBlind || 1)), bigBlind: Math.max(2, Math.floor(b.bigBlind || 2)),
      startingStack: Math.max(1, Math.floor(b.startingStack || 200)), actionSeconds: Math.min(300, Math.max(10, Math.floor(b.actionSeconds || 30))),
      maxSeats: Math.min(9, Math.max(2, Math.floor(b.maxSeats || 8))),
    };
    if (cfg.bigBlind < cfg.smallBlind) fail('The big blind must be at least the small blind.');
    let tournamentId = null;
    if (b.tournamentId) {
      const t = findTournament((await loadTracker()).data, b.tournamentId) ?? fail('No such tournament.');
      if (t.status === 'ended') fail('That tournament has ended.');
      const open = must(await db.from('game_tables').select('id').eq('tournament_id', b.tournamentId).eq('status', 'open'));
      if (open!.length) fail('That tournament already has an open table. Close it first.');
      tournamentId = t.id; cfg.startingStack = t.settings.chipsPerBuyIn;
    }
    const name = String(b.name || 'Table').slice(0, 60);
    const table = must(await db.from('game_tables').insert({ name, config: cfg, tournament_id: tournamentId, created_by: c.email }).select('id').single())!;
    const p = {
      status: 'open', revealMode: b.revealMode === 'hand' ? 'hand' : 'session', tournamentId,
      table: E.newTable(cfg), seeds: {}, next: await freshCommitment(), current: null, played: {}, deadline: null, nextHandAt: null,
    };
    must(await db.from('game_private').insert({ table_id: table.id, state: p }));
    must(await db.from('game_public').insert({ table_id: table.id, state: publicState(p) }));
    return { tableId: table.id };
  },

  async sit(b, c) {
    const me = seated(c);
    let tournament: Tournament = null;
    return await mutate(b.tableId, async p => {
      if (p.status !== 'open') fail('This table is closed.');
      let stack = p.table.config.startingStack, bought = stack;
      if (p.tournamentId) {
        tournament ??= findTournament((await loadTracker()).data, p.tournamentId) ?? fail('Tournament not found.');
        const carried = tournamentStack(tournament, me);
        if (carried > 0) { stack = carried; bought = 0; }           // bring your tournament stack
        else { stack = bought = tournament.settings.chipsPerBuyIn; } // otherwise this is a buy-in
      }
      E.sit(p.table, me, Number(b.seat), { stack, bought });
    });
  },
  leave: (b, c) => mutate(b.tableId, async p => { E.leave(p.table, seated(c)); delete p.seeds[c.profileId!]; return await afterMove(p); }),
  sit_out: (b, c) => mutate(b.tableId, async p => { E.setSittingOut(p.table, seated(c), !!b.out); return await afterMove(p); }),
  rebuy: (b, c) => mutate(b.tableId, p => { E.rebuy(p.table, seated(c), p.table.config.startingStack); }),

  // A player's own randomness for the next hand. Only accepted between hands, after the
  // server's commitment for that hand is already public.
  seed: (b, c) => mutate(b.tableId, p => {
    const me = seated(c);
    if (E.seatOf(p.table, me) < 0) fail('Sit down first.');
    if (p.table.hand && p.table.hand.street !== 'done') fail('The hand has already started.');
    const seed = F.cleanClientSeed(b.seed);
    if (seed.length < 8) fail('Seed is too short.');
    p.seeds[me] = seed;
  }),

  start: (b, c) => mutate(b.tableId, async p => {
    if (p.status !== 'open') fail('This table is closed.');
    if (!c.isAdmin && E.seatOf(p.table, seated(c)) < 0) fail('Only seated players can deal.');
    if (p.table.hand && p.table.hand.street !== 'done') return;         // already running: nothing to do
    if (p.nextHandAt && Date.now() < p.nextHandAt - 250) fail('The next hand starts in a moment.');
    if (E.playersReady(p.table) < 2) fail('Need at least two players with chips.');
    const id = crypto.randomUUID(), handNo = p.table.handNo + 1;
    // Only seeds of players actually dealt into this hand count.
    const dealt = p.table.seats.filter((s: Priv) => s && !s.sittingOut && s.stack > 0).map((s: Priv) => s.profileId);
    const clientSeeds = Object.fromEntries(dealt.filter((id: string) => p.seeds[id]).map((id: string) => [id, p.seeds[id]]));
    const { serverSeed, commitment } = p.next;
    const deck = await F.shuffledDeck(serverSeed, F.shuffleMessage({ tableId: b.tableId, handNo, clientSeeds }));
    const hand = E.startHand(p.table, { id, deck });
    p.current = { commitment }; p.next = null; p.nextHandAt = null;
    const holes = Object.fromEntries(hand.players.map((pl: Priv) => [pl.profileId, pl.hole]));
    const end = await afterMove(p);
    return { ...end, newHand: { id, hand_no: handNo, commitment, client_seeds: clientSeeds, server_seed: serverSeed, deck, holes } };
  }),

  act: (b, c) => mutate(b.tableId, async p => { E.act(p.table, seated(c), { type: b.type, amount: b.amount }); return await afterMove(p); }),

  // Anyone at the table may call this once the clock has run out; the server checks the clock itself.
  timeout: (b, _c) => mutate(b.tableId, async p => {
    const hand = p.table.hand;
    if (!hand || hand.street === 'done' || hand.toAct === null) return;
    if (!p.deadline || Date.now() < p.deadline) return;
    const seat = hand.toAct, before = hand.actions.length;
    E.autoAct(p.table);
    if (hand.actions[before]?.type === 'fold' && p.table.seats[seat]) p.table.seats[seat].sittingOut = true;
    return await afterMove(p);
  }),

  // End the session: no more hands, seeds of every hand are revealed, tournament tables are written to the tracker.
  async close(b, c) {
    if (!c.isAdmin) fail('Only the admin can close a table.');
    const table = must(await db.from('game_tables').select('name,status').eq('id', b.tableId).maybeSingle()) ?? fail('No such table.');
    return await mutate(b.tableId, p => {
      if (p.table.hand && p.table.hand.street !== 'done') fail('Wait for the current hand to finish.');
      if (p.status === 'closed') return;
      p.status = 'closed'; p.next = null; p.nextHandAt = null; p.seeds = {};
      return {
        after: async () => {
          const hands = must(await db.from('game_hands').select('id').eq('table_id', b.tableId).is('server_seed', null))!;
          for (const h of hands) must(await db.rpc('game_reveal_hand', { p_hand: h.id }));
          if (p.tournamentId) await writeTournamentSession(p, table!.name);
          must(await db.from('game_tables').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', b.tableId));
        },
      };
    });
  },
};

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json();
    const handler = actions[body.action] ?? fail('Unknown action.');
    return json(await handler(body, await whoIs(req)));
  } catch (e) {
    const known = e instanceof UserError || e instanceof E.RuleError;
    if (!known) console.error(e);
    return json({ error: (e as Error).message }, known ? 400 : 500);
  }
});
