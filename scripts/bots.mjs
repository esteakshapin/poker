// Seats test players at a LOCAL table and has them play simple poker, so you can try the
// table screen on your own.
//
//   npm run bots -- <table id from the address bar>  [how many bots, default 3]
//
// The bots check or call most of the time, sometimes raise, sometimes fold. Stop with Ctrl+C.
import { localEnv, localUsers, client } from './seed-local.mjs';
import * as F from '../supabase/functions/_shared/fair.js';

const tableId = process.argv[2], count = Number(process.argv[3] || 3);
if (!tableId) { console.error('usage: npm run bots -- <table id> [count]'); process.exit(2); }
const env = localEnv(), { password, users } = localUsers();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bots = [];
for (const u of users.filter(u => !u.admin).slice(0, count)) {
  const sb = client(env.url, env.anon);
  const { data, error } = await sb.auth.signInWithPassword({ email: u.email, password });
  if (error) throw new Error(error.message);
  bots.push({ ...u, sb, call: async (action, body = {}) => {
    const res = await fetch(`${env.url}/functions/v1/game`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anon, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ action, tableId, ...body }) });
    const json = await res.json(); if (!res.ok) throw new Error(json.error); return json.state;
  } });
}
const read = async () => (await bots[0].sb.from('game_public').select('state').eq('table_id', tableId).single()).data.state;

let S = await read();
for (const b of bots) {
  if (S.seats.some(s => s && s.profileId === b.id)) continue;
  const seat = S.seats.findIndex(s => !s);
  try { S = await b.call('sit', { seat }); console.log(`${b.first} sat down in seat ${seat + 1}`); } catch (e) { console.log(`${b.first}: ${e.message}`); }
}
const seeded = {};
for (;;) {
  await sleep(700 + Math.random() * 900);   // think for a moment, like a person
  try {
    S = await read();
    if (S.status !== 'open') { console.log('Table closed.'); break; }
    const live = S.hand && S.hand.street !== 'done';
    for (const b of bots) {
      const seat = S.seats.find(s => s && s.profileId === b.id); if (!seat) continue;
      if (!live) {
        if (seat.stack === 0) { S = await b.call('rebuy'); console.log(`${b.first} rebuys`); }
        else if (seat.sittingOut) S = await b.call('sit_out', { out: false });
        else if (S.nextCommitment && !S.seedsIn.includes(b.id) && seeded[b.id] !== S.handNo + 1) { seeded[b.id] = S.handNo + 1; S = await b.call('seed', { seed: F.randomSeed(16) }); }
        continue;
      }
      const h = S.hand, me = h.players.find(p => p.profileId === b.id);
      if (h.awaiting && me && !me.folded && !h.awaiting.votes[b.id]) { // all-in: bots are happy to run it twice
        await sleep(1500); S = await b.call('runout', { times: 2 }); console.log(`${b.first} chooses to run it twice`); break;
      }
      if (!me || h.toAct !== me.seat) continue;
      const toCall = Math.min(h.currentBet - me.bet, me.stack), maxTo = me.bet + me.stack, minTo = Math.min(h.currentBet + h.minRaise, maxTo), r = Math.random();
      const others = h.players.some(o => o !== me && !o.folded && !o.allIn);
      let action = toCall === 0 ? { type: 'check' } : r < 0.75 || toCall <= S.config.bigBlind ? { type: 'call' } : { type: 'fold' };
      if (r > 0.85 && maxTo > h.currentBet && others) action = { type: 'raise', amount: Math.min(maxTo, minTo + Math.floor(Math.random() * 3) * S.config.bigBlind) };
      try { S = await b.call('act', action); } catch (e) { S = await b.call('act', { type: toCall === 0 ? 'check' : 'call' }); }
      console.log(`${b.first} ${action.type}${action.amount ? ' to ' + action.amount : ''}`);
      break;
    }
  } catch (e) { console.log('…', e.message); }
}
