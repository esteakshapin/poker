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
  for (let game = 0; game < 300; game++) {
    const n = 2 + rnd(5), t = table(Array.from({ length: n }, () => 20 + rnd(400)), { smallBlind: 1 + rnd(3), bigBlind: 4 + rnd(4) });
    const total = chips(t);
    for (let hand = 0; hand < 25 && E.playersReady(t) >= 2; hand++) {
      const deck = [...FRESH_DECK];
      for (let i = 51; i > 0; i--) { const j = rnd(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      E.startHand(t, { id: `g${game}h${hand}`, deck });
      let steps = 0;
      while (t.hand.street !== 'done') {
        assert.ok(++steps < 500, 'hand did not finish');
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
      const pub = JSON.stringify(E.publicView(t));
      for (const p of t.hand.players) if (!t.hand.results.shown.includes(p.profileId)) assert.ok(!pub.includes(`"${p.hole[0]}","${p.hole[1]}"`), 'mucked cards leaked');
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
