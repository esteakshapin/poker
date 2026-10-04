// Plays real hands against the LOCAL Supabase with the test accounts, through the same
// server function the browser uses, then checks the results.
//
//   npm run sim            (needs: npm run db, npm run functions, npm run seed)
//
// It checks, for every hand: chips are conserved, no player can read another's cards or the deck
// while the hand is live, and after the seeds are revealed every hand passes the fairness check.
import assert from 'node:assert/strict';
import { localEnv, localUsers, client } from './seed-local.mjs';
import * as F from '../supabase/functions/_shared/fair.js';

const env = localEnv(), { password, users } = localUsers();
const HANDS = Number(process.argv[2] || 40);
const ok = r => { if (r.error) throw new Error(r.error.message); return r.data; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(u) {
  const sb = client(env.url, env.anon);
  const { data, error } = await sb.auth.signInWithPassword({ email: u.email, password });
  if (error) throw new Error(`${u.email}: ${error.message}`);
  const call = async (action, body = {}) => {
    const res = await fetch(`${env.url}/functions/v1/game`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.anon, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ action, ...body })
    });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error || res.status), { status: res.status });
    return json;
  };
  return { ...u, sb, call };
}

const people = await Promise.all(users.map(login));
const admin = people.find(p => p.admin), players = people.filter(p => !p.admin).slice(0, 4);
const byId = Object.fromEntries(people.map(p => [p.id, p]));
let rnd = 42; const rand = n => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % n; };

async function playSession({ tournamentId, revealMode, hands }) {
  const { tableId } = await admin.call('create_table', { name: `Sim ${revealMode} ${Date.now()}`, smallBlind: 1, bigBlind: 2, startingStack: 200, actionSeconds: 10, tournamentId, revealMode });
  let S;
  for (const [i, p] of players.entries()) S = (await p.call('sit', { tableId, seat: i * 2 })).state;
  const total = () => S.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) + (S.hand && S.hand.street !== 'done' ? S.hand.pot : 0);
  let chips = total(), bought = 0;
  const seenCommit = {}, mySeeds = {};

  // Rule checks that must be refused
  await assert.rejects(players[0].call('sit', { tableId, seat: 1 }), /already seated/);
  await assert.rejects(players[1].call('create_table', { name: 'x' }), /Only the admin/);
  await assert.rejects(players[1].call('close', { tableId }), /Only the admin/);

  for (let n = 1; n <= hands; n++) {
    // rebuy anyone who busted
    for (const s of S.seats) if (s && s.stack === 0) { S = (await byId[s.profileId].call('rebuy', { tableId })).state; bought += S.config.startingStack; }
    chips = total();
    // seeds: sent only after the commitment is public
    assert.ok(S.nextCommitment, 'commitment must be published before the hand');
    seenCommit[n] = S.nextCommitment;
    for (const p of players) { const seed = F.randomSeed(16); mySeeds[`${n}:${p.id}`] = seed; S = (await p.call('seed', { tableId, seed })).state; }
    // deal (respect the pause between hands)
    for (;;) {
      try { S = (await players[rand(players.length)].call('start', { tableId })).state; break; }
      catch (e) { if (!/in a moment/.test(e.message)) throw e; await sleep(400); }
    }
    assert.equal(S.hand.no, n);
    assert.equal(S.hand.commitment, seenCommit[n], 'the hand must use the commitment that was published');
    const handId = S.hand.id;

    // privacy while the hand is live
    const p0 = players[0];
    const visible = ok(await p0.sb.from('game_hole_cards').select('profile_id,cards').eq('hand_id', handId));
    assert.deepEqual(visible.map(v => v.profile_id), S.hand.players.some(x => x.profileId === p0.id) ? [p0.id] : [], 'a player sees only their own hole cards');
    for (const secret of ['game_secrets', 'game_private']) {
      const r = await p0.sb.from(secret).select('*');
      assert.ok(r.error ? /permission denied/.test(r.error.message) : r.data.length === 0, `${secret} is not readable by players`);
    }
    const row = ok(await p0.sb.from('game_hands').select('server_seed,deck,client_seeds').eq('id', handId).single());
    if (S.hand.street !== 'done') assert.ok(row.server_seed === null && row.deck === null, 'seed stays secret during the hand');
    for (const p of S.hand.players) assert.equal(row.client_seeds[p.profileId], mySeeds[`${n}:${p.profileId}`], 'each player\'s seed is the one they sent');
    if (S.hand.street !== 'done') assert.ok(S.hand.players.every(p => p.hole === null), 'no hole cards in the public state');

    // out-of-turn action is refused
    if (S.hand.street !== 'done') {
      const notTurn = S.hand.players.find(p => p.seat !== S.hand.toAct);
      await assert.rejects(byId[notTurn.profileId].call('act', { tableId, type: 'fold' }), /not your turn/);
    }
    // play it out with random legal actions
    let steps = 0;
    while (S.hand.street !== 'done') {
      assert.ok(++steps < 200);
      const h = S.hand, me = h.players.find(p => p.seat === h.toAct), who = byId[me.profileId];
      const toCall = Math.min(h.currentBet - me.bet, me.stack), maxTo = me.bet + me.stack, minTo = Math.min(h.currentBet + h.minRaise, maxTo);
      const others = h.players.some(o => o !== me && !o.folded && !o.allIn), r = rand(10);
      let action;
      if (r < 3 && maxTo > h.currentBet && others) action = { type: 'raise', amount: minTo + rand(Math.max(1, Math.min(maxTo - minTo + 1, 60))) };
      else if (toCall === 0) action = { type: 'check' };
      else action = r < 8 ? { type: 'call' } : { type: 'fold' };
      try { S = (await who.call('act', { tableId, ...action })).state; }
      catch (e) { if (/cannot raise|Minimum raise|Invalid raise/.test(e.message)) S = (await who.call('act', { tableId, type: toCall === 0 ? 'check' : 'call' })).state; else throw e; }
      assert.equal(total(), chips, 'chips are conserved');
    }
    assert.equal(S.hand.players.reduce((a, p) => a + p.net, 0), 0);
    const after = ok(await p0.sb.from('game_hands').select('server_seed').eq('id', handId).single());
    assert.equal(!!after.server_seed, revealMode === 'hand', 'seed revealed only per the table setting');
    if (n % 10 === 0) console.log(`  hand ${n}: stacks ${S.seats.filter(Boolean).map(s => s.stack).join(' / ')}`);
  }

  // timeout: nobody acts; after the clock runs out the server folds/checks for them
  for (const p of players) { try { S = (await p.call('seed', { tableId, seed: F.randomSeed(16) })).state; } catch (e) {} }
  for (;;) { try { S = (await players[0].call('start', { tableId })).state; break; } catch (e) { if (!/in a moment|chips/.test(e.message)) throw e; if (/chips/.test(e.message)) break; await sleep(400); } }
  if (S.hand.street !== 'done') {
    const before = S.hand.actions.length;
    S = (await players[0].call('timeout', { tableId })).state;
    assert.equal(S.hand.actions.length, before, 'timeout is ignored before the clock runs out');
    await sleep(S.deadline - Date.now() + 300);
    S = (await players[0].call('timeout', { tableId })).state;
    assert.ok(S.hand.actions.length > before && S.hand.actions[before].auto, 'server acts for the player after the clock runs out');
    while (S.hand.street !== 'done') { const me = S.hand.players.find(p => p.seat === S.hand.toAct); S = (await byId[me.profileId].call('act', { tableId, type: S.hand.currentBet - me.bet > 0 ? 'fold' : 'check' })).state; }
  }

  // close: seeds revealed, everything verifies
  await assert.rejects(players[0].call('close', { tableId }), /Only the admin/);
  S = (await admin.call('close', { tableId })).state;
  const all = ok(await players[0].sb.from('game_hands').select('*').eq('table_id', tableId).order('hand_no'));
  for (const h of all) {
    assert.ok(h.server_seed && h.deck, 'all seeds revealed at close');
    const checks = await F.verifyHand(h, seenCommit[h.hand_no]);
    assert.ok(checks.every(c => c.ok), `hand ${h.hand_no} failed: ${JSON.stringify(checks.filter(c => !c.ok))}`);
    // every player's private cards match the deck too
    const plan = F.dealPlan(h.record.dealOrder);
    for (const p of players) {
      const mine = ok(await p.sb.from('game_hole_cards').select('cards').eq('hand_id', h.id).eq('profile_id', p.id).maybeSingle());
      if (mine) assert.deepEqual(mine.cards, plan.hole[p.id].map(i => h.deck[i]));
    }
  }
  await assert.rejects(players[0].call('start', { tableId }), /closed/);
  return { tableId, hands: all.length, final: S.seats.filter(Boolean).map(s => [s.profileId, s.stack, s.bought]) };
}

console.log(`Practice table, seeds revealed per session, ${HANDS} hands…`);
console.log(' ', await playSession({ revealMode: 'session', hands: HANDS }));
console.log('Practice table, seeds revealed after each hand, 8 hands…');
console.log(' ', await playSession({ revealMode: 'hand', hands: 8 }));

console.log('Tournament table, 12 hands…');
const before = ok(await admin.sb.from('poker_state').select('data').eq('id', 'main').single()).data.tournaments[0];
const res = await playSession({ tournamentId: 'test-tournament', revealMode: 'session', hands: 12 });
const t = ok(await admin.sb.from('poker_state').select('data').eq('id', 'main').single()).data.tournaments[0];
const no = t.sessions.length;
assert.equal(no, before.sessions.length + 1, 'closing a tournament table adds one session');
for (const [pid, stack] of res.final) assert.equal(t.chips[no][pid], stack, 'final stacks become the session chip counts');
// tracker chip check: brought in + buy-ins = counted
const carried = id => { for (let s = no - 1; s >= 1; s--) if (t.chips[s]?.[id] !== undefined) return t.chips[s][id]; return 0; };
const ids = Object.keys(t.chips[no]);
const expected = ids.reduce((a, id) => a + carried(id), 0) + t.buyIns.filter(b => b.session === no).reduce((a, b) => a + b.count * t.settings.chipsPerBuyIn, 0);
assert.equal(ids.reduce((a, id) => a + t.chips[no][id], 0), expected, 'tracker chip check balances');
console.log(' ', res, `→ saved as session ${no} of "${t.settings.name}"`);
console.log('\nAll checks passed.');
