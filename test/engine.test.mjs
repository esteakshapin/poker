import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../supabase/functions/_shared/engine.js';
import { FRESH_DECK } from '../supabase/functions/_shared/fair.js';

const rank = s => E.bestHand(s.split(' '));
const beats = (a, b) => E.compareRanks(rank(a).rank, rank(b).rank);

test('hand rankings order correctly', () => {
  const hands = ['As Kd 9h 7c 3s', 'As Ad 9h 7c 3s', 'As Ad 9h 9c 3s', 'As Ad Ah 7c 3s', '5s 4d 3h 2c As',
    '9s 8d 7h 6c 5s', 'As Ks 9s 7s 3s', 'As Ad Ah 7c 7s', 'As Ad Ah Ac 3s', '5s 4s 3s 2s As', 'As Ks Qs Js Ts'];
  for (let i = 1; i < hands.length; i++) assert.ok(beats(hands[i], hands[i - 1]) > 0, `${hands[i]} should beat ${hands[i - 1]}`);
  assert.equal(rank('As Ks Qs Js Ts').name, 'Straight flush');
  assert.equal(beats('As Kd 9h 7c 3s', 'Ah Kc 9d 7s 3c'), 0);       // same ranks, different suits: tie
  assert.ok(beats('As Ad Kh 7c 3s', 'Ah Ac Qd 7s 3c') > 0);        // kicker decides
  assert.equal(rank('As Ad Kh Kc 3s 3d 2c').rank.join(), '2,14,13,3'); // best two pair out of three pairs
  assert.equal(rank('2s 3s 4s 5s 6s 7s 8s').rank.join(), '8,8');       // best straight flush out of 7
});

// Build a deck that deals the given hole cards (in deal order) and board, burns filled with leftovers.
function stack(holes, board) {
  const n = holes.length, used = new Set([...holes.flat(), ...board]);
  const rest = FRESH_DECK.filter(c => !used.has(c));
  const deck = [...holes.map(h => h[0]), ...holes.map(h => h[1]), rest.pop(), ...board.slice(0, 3), rest.pop(), board[3], rest.pop(), board[4], ...rest];
  assert.equal(new Set(deck).size, 52);
  return deck;
}
function table(stacks, cfg) {
  const t = E.newTable({ smallBlind: 1, bigBlind: 2, ...cfg });
  stacks.forEach((s, i) => E.sit(t, 'p' + i, i, { stack: s, bought: s }));
  return t;
}
const chips = t => t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) + Object.values(t.away).reduce((a, s) => a + s.stack, 0)
  + (t.hand && t.hand.street !== 'done' ? t.hand.players.reduce((a, p) => a + p.total, 0) : 0);

test('heads-up: button posts the small blind and acts first preflop, last postflop', () => {
  const t = table([200, 200]);
  E.startHand(t, { id: 'h1', deck: FRESH_DECK });
  const h = t.hand;
  assert.equal(h.sb, h.button);
  assert.equal(h.toAct, h.button);
  E.act(t, t.seats[h.button].profileId, { type: 'call' });
  assert.equal(h.toAct, h.bb);                       // big blind gets the option
  E.act(t, t.seats[h.bb].profileId, { type: 'check' });
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, h.bb);                       // non-button first after the flop
});

test('three-handed: blinds, action order and a fold-out win', () => {
  const t = table([200, 200, 200]);
  E.startHand(t, { id: 'h1', deck: FRESH_DECK });
  const h = t.hand;                                  // button seat 0, sb 1, bb 2, first to act 0
  assert.deepEqual([h.button, h.sb, h.bb, h.toAct], [0, 1, 2, 0]);
  E.act(t, 'p0', { type: 'raise', amount: 6 });
  assert.throws(() => E.act(t, 'p2', { type: 'call' }), /not your turn/);
  assert.throws(() => E.act(t, 'p1', { type: 'raise', amount: 8 }), /Minimum raise/); // must be to 10+
  E.act(t, 'p1', { type: 'fold' });
  E.act(t, 'p2', { type: 'fold' });
  assert.equal(h.street, 'done');
  assert.deepEqual(t.seats.filter(Boolean).map(s => s.stack), [203, 199, 198]);  // wins the blinds; uncalled 4 comes back
  assert.equal(h.results.shown.length, 0);                       // no showdown, nothing revealed
});

test('side pots: short all-in wins only the main pot', () => {
  const t = table([50, 200, 200]);
  // deal order is seats 1, 2, 0 (left of button first). p0 (short) has aces, p1 kings, p2 queens.
  const deck = stack([['Kc', 'Kd'], ['Qc', 'Qd'], ['Ac', 'Ad']], ['2h', '7s', '9c', '3d', '4s']);
  E.startHand(t, { id: 'h1', deck });
  E.act(t, 'p0', { type: 'raise', amount: 50 });   // all-in
  E.act(t, 'p1', { type: 'raise', amount: 150 });
  E.act(t, 'p2', { type: 'call' });
  for (const s of ['flop', 'turn', 'river']) {
    assert.equal(t.hand.street, s);
    E.act(t, 'p1', { type: 'check' }); E.act(t, 'p2', { type: 'check' });
  }
  assert.equal(t.hand.street, 'done');
  const pots = t.hand.results.pots;
  assert.deepEqual(pots.map(p => [p.amount, p.winners]), [[150, ['p0']], [200, ['p1']]]);
  assert.deepEqual(t.seats.filter(Boolean).map(s => s.stack), [150, 250, 50]);
  assert.equal(chips(t), 450);
});

test('split pot gives the odd chip to the first winner left of the button', () => {
  const t = table([100, 100, 100], { smallBlind: 1, bigBlind: 3 });
  const deck = stack([['As', 'Kd'], ['Ah', 'Kc'], ['7c', '2d']], ['Qh', 'Js', 'Tc', '3d', '4s']); // p1 and p2 both make broadway
  E.startHand(t, { id: 'h1', deck });
  E.act(t, 'p0', { type: 'call' });                 // p0 puts in 3
  E.act(t, 'p1', { type: 'call' });
  E.act(t, 'p2', { type: 'check' });
  E.act(t, 'p1', { type: 'check' }); E.act(t, 'p2', { type: 'check' }); E.act(t, 'p0', { type: 'fold' });
  for (let i = 0; i < 2; i++) { E.act(t, 'p1', { type: 'check' }); E.act(t, 'p2', { type: 'check' }); }
  assert.deepEqual(t.seats.filter(Boolean).map(s => s.stack), [97, 102, 101]);  // 9 chips: 5 to p1 (first in deal order), 4 to p2
});

test('a short all-in raise does not reopen raising for players who already acted', () => {
  const t = table([200, 200, 25]);
  E.startHand(t, { id: 'h1', deck: FRESH_DECK });   // button 0, sb 1, bb 2
  E.act(t, 'p0', { type: 'raise', amount: 20 });
  E.act(t, 'p1', { type: 'call' });
  E.act(t, 'p2', { type: 'raise', amount: 25 });    // all-in for 5 more: not a full raise
  const legal = E.legalActions(t, 'p0');
  assert.equal(legal.callAmount, 5);
  assert.equal(legal.canRaise, false);
  assert.throws(() => E.act(t, 'p0', { type: 'raise', amount: 60 }), /cannot raise/);
});

test('leaving mid-hand folds you and remembers your stack', () => {
  const t = table([200, 200, 200]);
  E.startHand(t, { id: 'h1', deck: FRESH_DECK });
  E.leave(t, 'p1');                                 // small blind walks away; not their turn yet
  E.act(t, 'p0', { type: 'call' });                 // now p1 auto-folds, action on p2
  assert.equal(t.hand.toAct, 2);
  E.act(t, 'p2', { type: 'check' });
  E.act(t, 'p2', { type: 'bet', amount: 2 }); E.act(t, 'p0', { type: 'fold' });
  assert.equal(t.seats[1], null);
  assert.equal(t.away.p1.stack, 199);
  E.sit(t, 'p1', 5, { stack: 9999 });               // comes back with what they left with, not more
  assert.equal(t.seats[5].stack, 199);
  assert.equal(chips(t), 600);
});

test('random play: chips are conserved and every hand finishes', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let game = 0; game < 40; game++) { // every all-in also computes odds, so keep this modest
    const n = 2 + rnd(5), t = table(Array.from({ length: n }, () => 20 + rnd(400)), { smallBlind: 1 + rnd(3), bigBlind: 4 + rnd(4) });
    const total = chips(t);
    for (let hand = 0; hand < 25 && E.playersReady(t) >= 2; hand++) {
      const deck = [...FRESH_DECK];
      for (let i = 51; i > 0; i--) { const j = rnd(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      E.startHand(t, { id: `g${game}h${hand}`, deck });
      let steps = 0;
      while (t.hand.street !== 'done') {
        assert.ok(++steps < 500, 'hand did not finish');
        if (t.hand.awaiting) { // all-in: everyone picks once or twice
          const twice = rnd(2) === 0;
          for (const p of t.hand.players.filter(p => !p.folded)) if (t.hand.awaiting) E.voteRunout(t, p.profileId, twice ? 2 : 1);
          if (twice) { assert.equal(t.hand.runout.times, 2); assert.equal(new Set([...t.hand.board, ...t.hand.board2.slice(t.hand.runout.from)]).size, 10 - t.hand.runout.from); }
          continue;
        }
        const pid = t.seats[t.hand.toAct].profileId, legal = E.legalActions(t, pid), r = rnd(10);
        if (legal.canRaise && r < 3) E.act(t, pid, { type: 'raise', amount: legal.minTo + rnd(legal.maxTo - legal.minTo + 1) });
        else if (legal.canCheck) E.act(t, pid, { type: 'check' });
        else if (r < 8) E.act(t, pid, { type: 'call' });
        else E.act(t, pid, { type: 'fold' });
        assert.equal(chips(t), total);
        assert.ok(t.seats.every(s => !s || s.stack >= 0));
      }
      assert.equal(t.hand.players.reduce((a, p) => a + p.net, 0), 0);
      assert.equal(t.hand.results.pots.reduce((a, p) => a + p.amount, 0), t.hand.players.reduce((a, p) => a + p.total, 0));
      for (const p of E.publicView(t).hand.players) assert.equal(p.hole !== null, t.hand.results.shown.includes(p.profileId), 'only shown hands are public');
    }
  }
});

test('public view never contains the deck or unshown hole cards mid-hand', () => {
  const t = table([200, 200, 200]);
  E.startHand(t, { id: 'h1', deck: FRESH_DECK });
  const pub = E.publicView(t);
  assert.equal(pub.hand.deck, undefined);
  assert.ok(pub.hand.players.every(p => p.hole === null));
});

test('all-in: cards go face up, players choose, run it twice splits the pot by board', () => {
  const t = table([100, 100]);
  // heads-up deal order: seat 1 (big blind) first, then seat 0 (button). p1 has aces, p0 has kings.
  const used = ['As', 'Ad', 'Ks', 'Kd', '2c', '7d', '9h', '3s', '4c', 'Kh', '5d', '6c'];
  const rest = FRESH_DECK.filter(c => !used.includes(c));
  // hole cards, burn, flop, burn, turn, burn, river | second run: burn, turn, burn, river
  const deck = ['As', 'Ks', 'Ad', 'Kd', rest[0], '2c', '7d', '9h', rest[1], '3s', rest[2], '4c', rest[3], 'Kh', rest[4], '5d', ...rest.slice(5), '6c'];
  E.startHand(t, { id: 'h1', deck });
  E.act(t, 'p0', { type: 'call' }); E.act(t, 'p1', { type: 'check' });          // see the flop: 2c 7d 9h
  E.act(t, 'p1', { type: 'bet', amount: 98 }); E.act(t, 'p0', { type: 'call' }); // all-in on the flop
  const h = t.hand;
  assert.ok(h.awaiting && h.toAct === null && h.street === 'flop');
  assert.equal(E.publicView(t).hand.players.filter(p => p.hole).length, 2);     // both hands face up
  assert.ok(h.awaiting.equity.p1 > 0.85 && Math.abs(h.awaiting.equity.p0 + h.awaiting.equity.p1 - 1) < 1e-9);
  E.voteRunout(t, 'p0', 2);
  assert.ok(t.hand.awaiting);                                                    // needs both to agree
  E.voteRunout(t, 'p1', 2);
  assert.equal(h.street, 'done');
  assert.deepEqual(h.board, ['2c', '7d', '9h', '3s', '4c']);                     // run 1: aces hold
  assert.deepEqual(h.board2, ['2c', '7d', '9h', 'Kh', '5d']);                    // run 2: kings hit a set
  assert.deepEqual(t.seats.filter(Boolean).map(s => s.stack), [100, 100]);       // one board each
  assert.deepEqual(h.results.pots[0].runs.map(r => r.winners), [['p1'], ['p0']]);
  const st = h.runout.runs[0].stages;
  assert.deepEqual(st.map(x => x.len), [3, 4, 5]);
  assert.deepEqual(st[0].outs.p0.sort(), ['Kc', 'Kh']);                          // kings need a king
  assert.equal(st[2].equity.p1, 1);
  assert.equal(h.runout.runs[1].stages.at(-1).equity.p0, 1);
});

test('one vote for "once" settles it; a timed-out choice also runs once', () => {
  for (const viaTimeout of [false, true]) {
    const t = table([60, 200]);
    E.startHand(t, { id: 'h1', deck: FRESH_DECK });
    E.act(t, 'p0', { type: 'raise', amount: 60 }); E.act(t, 'p1', { type: 'call' }); // preflop all-in
    assert.equal(t.hand.awaiting.from, 0);
    if (viaTimeout) E.autoAct(t); else { E.voteRunout(t, 'p1', 2); E.voteRunout(t, 'p0', 1); }
    assert.equal(t.hand.street, 'done');
    assert.equal(t.hand.runout.times, 1);
    assert.equal(t.hand.board.length, 5); assert.equal(t.hand.board2, null);
    assert.equal(chips(t), 260);
  }
});

test('odds: known match-ups', () => {
  const pre = E.equities([['As', 'Ah'], ['Ks', 'Kh']], []);                      // aces vs kings is about 82 / 18
  assert.ok(pre[0] > 0.78 && pre[0] < 0.86, String(pre[0]));
  const flop = E.equities([['As', 'Ah'], ['7s', '6s']], ['8s', '9d', '2s']);     // open-ended straight flush draw is a small favourite
  assert.ok(flop[1] > 0.5 && flop[1] < 0.6, String(flop[1]));
  const river = E.equities([['As', 'Ah'], ['Ks', 'Kh']], ['2c', '3d', '7h', '9s', 'Jc']);
  assert.deepEqual(river, [1, 0]);
  const turnOuts = E.outs([['As', 'Ah'], ['Ks', 'Qs']], ['2s', '7s', '9h', 'Jc']); // nine spades or a ten for the straight
  assert.equal(turnOuts[0].length, 0);
  assert.equal(turnOuts[1].length, 8 + 3);                                       // 8 spades left (the ace is in the other hand) + Td Th Tc
});
