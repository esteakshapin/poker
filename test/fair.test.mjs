import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../supabase/functions/_shared/fair.js';

const msg = F.shuffleMessage({ tableId: 't1', handNo: 7, clientSeeds: { bob: 'bbb', alice: 'aaa' } });

test('message is canonical: sorted by player id, seeds sanitised', () => {
  assert.equal(msg, 'table=t1;hand=7;seeds=alice=aaa,bob=bbb');
  assert.equal(F.shuffleMessage({ tableId: 't1', handNo: 7, clientSeeds: { x: 'a=b,c;d' } }), 'table=t1;hand=7;seeds=x=abcd');
});

test('commitment is SHA-256 of the seed (known vector)', async () => {
  assert.equal(await F.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('same inputs give the same deck; any change gives a different one', async () => {
  const seed = '00'.repeat(32);
  const a = await F.shuffledDeck(seed, msg), b = await F.shuffledDeck(seed, msg);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 52);
  assert.deepEqual([...a].sort(), [...F.FRESH_DECK].sort());
  const otherSeed = await F.shuffledDeck('01' + '00'.repeat(31), msg);
  const otherClient = await F.shuffledDeck(seed, F.shuffleMessage({ tableId: 't1', handNo: 7, clientSeeds: { bob: 'bbc', alice: 'aaa' } }));
  const otherHand = await F.shuffledDeck(seed, F.shuffleMessage({ tableId: 't1', handNo: 8, clientSeeds: { bob: 'bbb', alice: 'aaa' } }));
  for (const d of [otherSeed, otherClient, otherHand]) assert.notDeepEqual(d, a);
});

test('deal plan matches how the engine deals', async () => {
  const E = await import('../supabase/functions/_shared/engine.js');
  const deck = await F.shuffledDeck(F.randomSeed(), msg);
  const t = E.newTable();
  ['a', 'b', 'c', 'd'].forEach((id, i) => E.sit(t, id, i * 2, { stack: 200, bought: 200 }));
  E.startHand(t, { id: 'h', deck });
  const order = t.hand.players.map(p => p.profileId), plan = F.dealPlan(order);
  for (const p of t.hand.players) assert.deepEqual(p.hole, plan.hole[p.profileId].map(i => deck[i]));
  while (t.hand.street !== 'done') { const pid = t.seats[t.hand.toAct].profileId; E.act(t, pid, { type: E.legalActions(t, pid).canCheck ? 'check' : 'call' }); }
  assert.deepEqual(t.hand.board, plan.board.map(i => deck[i]));
});

test('verifyHand passes for an honest hand and fails if anything is altered', async () => {
  const server_seed = F.randomSeed(), client_seeds = { a: F.randomSeed(8), b: F.randomSeed(8) };
  const base = { table_id: 'tbl', hand_no: 3, client_seeds, commitment: await F.commitmentFor(server_seed) };
  const deck = await F.shuffledDeck(server_seed, F.shuffleMessage({ tableId: 'tbl', handNo: 3, clientSeeds: client_seeds }));
  const plan = F.dealPlan(['a', 'b']);
  const record = { dealOrder: ['a', 'b'], board: plan.board.map(i => deck[i]), players: [{ profileId: 'a', hole: plan.hole.a.map(i => deck[i]) }, { profileId: 'b', hole: null }] };
  const good = { ...base, server_seed, deck, record };
  assert.ok((await F.verifyHand(good, base.commitment)).every(c => c.ok));
  const swapped = [...deck]; [swapped[0], swapped[40]] = [swapped[40], swapped[0]];
  const bad = [
    { ...good, server_seed: F.randomSeed() },                                   // different seed than committed
    { ...good, deck: swapped },                                                 // deck tampered
    { ...good, record: { ...record, board: [deck[51], ...record.board.slice(1)] } }, // board card swapped
    { ...good, client_seeds: { ...client_seeds, a: 'changed' } },               // a player's seed replaced
  ];
  for (const h of bad) assert.ok((await F.verifyHand(h)).some(c => !c.ok));
  assert.ok((await F.verifyHand(good, 'something-else')).some(c => !c.ok));     // commitment swapped after the fact
});

test('shuffle is uniform: every card is equally likely in every position', async () => {
  const N = 20000, counts = Array.from({ length: 52 }, () => new Array(52).fill(0));
  const seed = F.randomSeed();
  for (let i = 0; i < N; i++) {
    const deck = await F.shuffledDeck(seed, `uniformity;hand=${i}`);
    deck.forEach((c, pos) => { counts[pos][F.FRESH_DECK.indexOf(c)]++; });
  }
  const expected = N / 52; let chi2 = 0;
  for (const row of counts) for (const c of row) chi2 += (c - expected) ** 2 / expected;
  // 51 * 51 = 2601 degrees of freedom: mean 2601, sd ~72. Anything biased blows far past this.
  assert.ok(chi2 > 2250 && chi2 < 2950, `chi-square ${chi2.toFixed(0)} outside the expected range`);
});

test('run it twice: the second board is verified against the deck too', async () => {
  const E = await import('../supabase/functions/_shared/engine.js');
  for (const street of [0, 3, 4]) {
    const server_seed = F.randomSeed(), client_seeds = { a: 'aaaaaaaa', b: 'bbbbbbbb' };
    const deck = await F.shuffledDeck(server_seed, F.shuffleMessage({ tableId: 'tbl', handNo: 1, clientSeeds: client_seeds }));
    const t = E.newTable(); E.sit(t, 'a', 0, { stack: 100, bought: 100 }); E.sit(t, 'b', 1, { stack: 100, bought: 100 });
    E.startHand(t, { id: 'h', deck });
    const act = type => { const pid = t.seats[t.hand.toAct].profileId, l = E.legalActions(t, pid); E.act(t, pid, type === 'shove' ? { type: 'raise', amount: l.maxTo } : { type: l.canCheck ? 'check' : 'call' }); };
    while (t.hand.board.length < street) act('check');
    act('shove'); act('call');
    assert.equal(t.hand.awaiting.from, street);
    E.voteRunout(t, 'a', 2); E.voteRunout(t, 'b', 2);
    const hand = { table_id: 'tbl', hand_no: 1, client_seeds, commitment: await F.commitmentFor(server_seed), server_seed, deck, record: E.handRecord(t) };
    const checks = await F.verifyHand(hand);
    assert.ok(checks.some(c => /Second board/.test(c.name)) && checks.every(c => c.ok), JSON.stringify(checks.filter(c => !c.ok)));
    const tampered = { ...hand, record: { ...hand.record, board2: [...hand.record.board2.slice(0, 4), hand.record.board[4]] } };
    assert.ok((await F.verifyHand(tampered)).some(c => !c.ok));
  }
});
