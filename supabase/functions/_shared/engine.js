// No-limit Texas Hold'em rules engine.
//
// Pure functions over a plain JSON state object: no randomness, no clock, no I/O.
// The deck is handed in already shuffled (see fair.js), so the same state + same deck
// + same actions always produce the same result. Shared by the server and the tests.

import { RANKS, FRESH_DECK } from './fair.js';

export class RuleError extends Error {}
const fail = msg => { throw new RuleError(msg); };

// ---------- hand evaluation ----------
const val = c => RANKS.indexOf(c[0]) + 2; // 2..14
export const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// Rank of exactly 5 cards as [category, ...tiebreakers]; compare left to right, higher wins.
export function rank5(cards) {
  const vals = cards.map(val).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  let straight = 0;
  if (new Set(vals).size === 5) {
    if (vals[0] - vals[4] === 4) straight = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straight = 5; // A-2-3-4-5
  }
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const groups = Object.entries(counts).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const kick = groups.map(g => g[1]);
  if (straight && flush) return [8, straight];
  if (groups[0][0] === 4) return [7, ...kick];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...kick];
  if (flush) return [5, ...vals];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, ...kick];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...kick];
  if (groups[0][0] === 2) return [1, ...kick];
  return [0, ...vals];
}
export function compareRanks(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
// Best 5-card hand out of 5 to 7 cards.
export function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]], rank = rank5(five);
      if (!best || compareRanks(rank, best.rank) > 0) best = { rank, cards: five };
    }
  return { ...best, name: HAND_NAMES[best.rank[0]] };
}

// ---------- odds ----------
// Each player's chance of having the best hand once the board is complete (ties count as a share).
// holes: [[c, c], ...] for the players still in; board: cards already out; dead: other cards known to be gone.
// Up to two cards to come it checks every possible board exactly. Before the flop there are 1.7 million
// boards, so it samples 4,000 of them with a fixed pseudo-random sequence (same cards, same answer everywhere).
export function equities(holes, board, dead = []) {
  const known = new Set([...holes.flat(), ...board, ...dead]);
  const rest = FRESH_DECK.filter(c => !known.has(c)), need = 5 - board.length, wins = holes.map(() => 0);
  let total = 0;
  const score = full => {
    const ranks = holes.map(h => bestHand([...h, ...full]).rank);
    const top = ranks.reduce((b, r) => compareRanks(r, b) > 0 ? r : b);
    const tied = ranks.map(r => compareRanks(r, top) === 0), k = tied.filter(Boolean).length;
    tied.forEach((t, i) => { if (t) wins[i] += 1 / k; });
    total++;
  };
  if (need === 0) score(board);
  else if (need === 1) for (const a of rest) score([...board, a]);
  else if (need === 2) for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([...board, rest[i], rest[j]]);
  else {
    let seed = [...known].join('').split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
    for (let s = 0; s < 4000; s++) {
      const pick = [...rest];
      for (let i = 0; i < need; i++) { const j = i + rnd(pick.length - i); [pick[i], pick[j]] = [pick[j], pick[i]]; }
      score([...board, ...pick.slice(0, need)]);
    }
  }
  return wins.map(w => w / total);
}
// For each player who is currently behind: the next cards that would put them in front (or level).
export function outs(holes, board, dead = []) {
  if (board.length < 3 || board.length > 4) return holes.map(() => []);
  const known = new Set([...holes.flat(), ...board, ...dead]);
  const rest = FRESH_DECK.filter(c => !known.has(c));
  const ahead = cards => { const r = holes.map(h => bestHand([...h, ...cards]).rank); return r.map(x => r.every(y => compareRanks(x, y) >= 0)); };
  const now = ahead(board), res = holes.map(() => []);
  for (const c of rest) ahead([...board, c]).forEach((a, i) => { if (a && !now[i]) res[i].push(c); });
  return res;
}

// ---------- table ----------
export function newTable(config = {}) {
  const cfg = { smallBlind: 1, bigBlind: 2, maxSeats: 8, startingStack: 200, actionSeconds: 30, ...config };
  return { config: cfg, seats: Array(cfg.maxSeats).fill(null), button: null, handNo: 0, hand: null, away: {} };
}
const liveHand = state => state.hand && state.hand.street !== 'done' ? state.hand : null;
export const seatOf = (state, profileId) => state.seats.findIndex(s => s && s.profileId === profileId);
const inHand = (state, profileId) => liveHand(state)?.players.find(p => p.profileId === profileId && !p.folded);

// `stack` is what the player brings; `bought` is how much of it was newly bought (for the buy-in ledger).
export function sit(state, profileId, seat, { stack, bought = 0 }) {
  if (seatOf(state, profileId) >= 0) fail('You are already seated.');
  if (!(seat >= 0 && seat < state.seats.length)) fail('No such seat.');
  if (state.seats[seat]) fail('That seat is taken.');
  // Someone who left and comes back gets the stack they left with (no pocketing winnings mid-session).
  const back = state.away[profileId];
  if (back) { delete state.away[profileId]; state.seats[seat] = { ...back, sittingOut: false, leaving: false }; return; }
  if (!(stack > 0)) fail('You need chips to sit down.');
  state.seats[seat] = { profileId, stack, carried: stack - bought, bought, sittingOut: false, leaving: false };
}
export function leave(state, profileId) {
  const i = seatOf(state, profileId);
  if (i < 0) fail('You are not seated.');
  const seat = state.seats[i];
  if (inHand(state, profileId)) { seat.leaving = true; seat.sittingOut = true; foldIfAbsent(state); return; }
  state.away[profileId] = { ...seat }; state.seats[i] = null;
}
export function setSittingOut(state, profileId, out) {
  const i = seatOf(state, profileId);
  if (i < 0) fail('You are not seated.');
  state.seats[i].sittingOut = !!out;
  if (out) foldIfAbsent(state);
}
export function rebuy(state, profileId, chips) {
  const i = seatOf(state, profileId);
  if (i < 0) fail('You are not seated.');
  if (state.seats[i].stack > 0) fail('You can only rebuy when you are out of chips.');
  if (inHand(state, profileId)) fail('Wait for the hand to finish.');
  state.seats[i].stack += chips; state.seats[i].bought += chips;
}

// ---------- hand ----------
const canPlay = s => s && !s.sittingOut && s.stack > 0;
function seatsFrom(state, from) { // seat indexes clockwise, starting just after `from`
  const n = state.seats.length;
  return Array.from({ length: n }, (_, k) => (from + 1 + k) % n);
}
export const playersReady = state => state.seats.filter(canPlay).length;

// deck: 52 cards already shuffled. id: the hand's id.
export function startHand(state, { id, deck }) {
  if (liveHand(state)) fail('A hand is already in progress.');
  if (playersReady(state) < 2) fail('Need at least two players with chips.');
  const { smallBlind, bigBlind } = state.config;
  state.button = seatsFrom(state, state.button ?? -1).find(i => canPlay(state.seats[i]));
  const order = seatsFrom(state, state.button).filter(i => canPlay(state.seats[i])); // deal order: left of the button first
  const n = order.length;
  const players = order.map((seat, i) => ({
    seat, profileId: state.seats[seat].profileId, hole: [deck[i], deck[n + i]],
    stack: state.seats[seat].stack, startStack: state.seats[seat].stack,
    bet: 0, total: 0, folded: false, allIn: false, acted: false, canRaise: true,
    vpip: false, pfr: false, sawFlop: false, showdown: false
  }));
  const headsUp = n === 2;
  const sb = headsUp ? state.button : order[0], bb = headsUp ? order[0] : order[1];
  const hand = state.hand = {
    id, no: ++state.handNo, street: 'preflop', deck, deckPos: 2 * n, board: [], players,
    button: state.button, sb, bb, currentBet: bigBlind, minRaise: bigBlind, toAct: null, actions: [], results: null
  };
  post(state, player(hand, sb), smallBlind, 'small blind');
  post(state, player(hand, bb), bigBlind, 'big blind');
  hand.toAct = nextToAct(state, bb);
  settle(state);
  return hand;
}
const player = (hand, seat) => hand.players.find(p => p.seat === seat);
function pay(state, p, chips) {
  p.stack -= chips; p.bet += chips; p.total += chips;
  if (p.stack === 0) p.allIn = true;
  state.seats[p.seat].stack = p.stack;
}
function post(state, p, blind, type) {
  const chips = Math.min(blind, p.stack);
  pay(state, p, chips);
  state.hand.actions.push({ street: 'preflop', seat: p.seat, profileId: p.profileId, type, chips, to: p.bet });
}
const canAct = p => !p.folded && !p.allIn;
function nextToAct(state, afterSeat) {
  const h = state.hand;
  for (const i of seatsFrom(state, afterSeat)) {
    const p = player(h, i);
    if (p && canAct(p) && (!p.acted || p.bet < h.currentBet)) return i;
  }
  return null;
}
function roundDone(h) {
  const actors = h.players.filter(canAct);
  if (actors.every(p => p.acted && p.bet === h.currentBet)) return true;
  // One player left who could act, but nobody can respond and they owe nothing: nothing to decide.
  if (actors.length === 1) {
    const others = h.players.filter(p => !p.folded && p !== actors[0]);
    return actors[0].bet >= Math.max(0, ...others.map(p => p.bet));
  }
  return false;
}

export function legalActions(state, profileId) {
  const h = liveHand(state);
  const p = h && h.toAct !== null && player(h, h.toAct);
  if (!p || p.profileId !== profileId) return null;
  const toCall = Math.min(h.currentBet - p.bet, p.stack), maxTo = p.bet + p.stack;
  const opponents = h.players.some(o => o !== p && canAct(o));
  const raise = p.canRaise && maxTo > h.currentBet && opponents;
  return {
    canCheck: toCall === 0, callAmount: toCall,
    canRaise: raise, minTo: raise ? Math.min(h.currentBet + h.minRaise, maxTo) : null, maxTo: raise ? maxTo : null,
    isBet: h.currentBet === 0
  };
}

// action: {type: 'fold' | 'check' | 'call' | 'raise', amount}. For raise (or bet), amount is the
// total the player's bet goes TO on this street.
export function act(state, profileId, action) {
  const h = liveHand(state) || fail('No hand in progress.');
  const p = h.toAct !== null && player(h, h.toAct);
  if (!p || p.profileId !== profileId) fail('It is not your turn.');
  const legal = legalActions(state, profileId), street = h.street;
  let chips = 0, type = action.type;
  if (type === 'fold') p.folded = true;
  else if (type === 'check') { if (!legal.canCheck) fail('You cannot check, there is a bet to call.'); }
  else if (type === 'call') {
    if (legal.canCheck) fail('Nothing to call.');
    chips = legal.callAmount; pay(state, p, chips);
    if (street === 'preflop') p.vpip = true;
  } else if (type === 'raise' || type === 'bet') {
    const to = Math.floor(Number(action.amount));
    if (!legal.canRaise) fail('You cannot raise here.');
    if (!(to > h.currentBet && to <= legal.maxTo)) fail('Invalid raise amount.');
    const size = to - h.currentBet, full = size >= h.minRaise;
    if (!full && to !== legal.maxTo) fail(`Minimum raise is to ${legal.minTo}.`);
    type = h.currentBet === 0 ? 'bet' : 'raise';
    chips = to - p.bet; pay(state, p, chips);
    for (const o of h.players) {
      if (o === p || !canAct(o)) continue;
      if (full) { o.acted = false; o.canRaise = true; }
      else if (o.bet < to) { if (o.acted) o.canRaise = false; o.acted = false; } // short all-in doesn't reopen raising
    }
    if (full) h.minRaise = size;
    h.currentBet = to;
    if (street === 'preflop') { p.vpip = true; p.pfr = true; }
  } else fail('Unknown action.');
  p.acted = true;
  h.actions.push({ street, seat: p.seat, profileId, type, chips, to: p.bet, ...(p.allIn && chips ? { allIn: true } : {}), ...(action.auto ? { auto: true } : {}) });
  h.toAct = nextToAct(state, p.seat);
  settle(state);
}

// What the server does when a player runs out of time: check if free, otherwise fold.
export function autoAct(state) {
  const h = liveHand(state);
  if (h?.awaiting) return resolveRunout(state);
  if (!h || h.toAct === null) return false;
  const p = player(h, h.toAct), legal = legalActions(state, p.profileId);
  act(state, p.profileId, { type: legal.canCheck ? 'check' : 'fold', auto: true });
  return true;
}
// Players who left or sat out mid-hand fold as soon as it is their turn.
function foldIfAbsent(state) {
  let h;
  while ((h = liveHand(state)) && h.toAct !== null && state.seats[h.toAct]?.sittingOut) {
    act(state, state.seats[h.toAct].profileId, { type: 'fold', auto: true });
  }
}

// Move the hand forward as far as it can go without a player decision.
function settle(state) {
  const h = state.hand;
  while (h.street !== 'done') {
    const alive = h.players.filter(p => !p.folded);
    if (alive.length === 1) return finish(state, 'fold');
    if (h.awaiting) break;
    if (!roundDone(h)) { if (h.toAct === null) h.toAct = nextToAct(state, h.button); break; }
    // Betting round over: next street.
    for (const p of h.players) { p.bet = 0; p.acted = false; p.canRaise = true; }
    h.currentBet = 0; h.minRaise = state.config.bigBlind;
    if (h.street === 'river') return finish(state, 'showdown');
    if (alive.filter(canAct).length < 2) {
      // Everyone is all-in (or one player has everyone covered): no more betting. Cards go face up
      // and the players choose whether to run the rest of the board once or twice.
      const eq = equities(alive.map(p => p.hole), h.board);
      h.awaiting = { from: h.board.length, votes: {}, equity: Object.fromEntries(alive.map((p, i) => [p.profileId, eq[i]])) };
      h.toAct = null;
      break;
    }
    h.deckPos++; // burn one
    const count = h.street === 'preflop' ? 3 : 1;
    h.board.push(...h.deck.slice(h.deckPos, h.deckPos + count)); h.deckPos += count;
    h.street = { preflop: 'flop', flop: 'turn', turn: 'river' }[h.street];
    if (h.street === 'flop') alive.forEach(p => { p.sawFlop = true; });
    h.toAct = nextToAct(state, h.button);
  }
  foldIfAbsent(state);
}

// A player's choice for an all-in runout. One "once" settles it; twice needs everyone still in to agree.
export function voteRunout(state, profileId, times) {
  const h = liveHand(state);
  if (!h?.awaiting) fail('Nothing to choose right now.');
  if (!h.players.some(p => p.profileId === profileId && !p.folded)) fail('You are not in this hand.');
  h.awaiting.votes[profileId] = times === 2 ? 2 : 1;
  const alive = h.players.filter(p => !p.folded);
  if (times !== 2 || alive.every(p => h.awaiting.votes[p.profileId] === 2)) resolveRunout(state);
}
// Deal the rest of the board (once, or twice if everyone agreed) and finish the hand.
// The second run continues from the next cards in the same deck: burn, cards, burn, cards...
export function resolveRunout(state) {
  const h = liveHand(state);
  if (!h?.awaiting) return false;
  const alive = h.players.filter(p => !p.folded), base = [...h.board], holes = alive.map(p => p.hole);
  const times = alive.every(p => h.awaiting.votes[p.profileId] === 2) ? 2 : 1;
  const boards = [];
  for (let r = 0; r < times; r++) {
    const b = [...base];
    while (b.length < 5) { h.deckPos++; const count = b.length === 0 ? 3 : 1; b.push(...h.deck.slice(h.deckPos, h.deckPos + count)); h.deckPos += count; }
    boards.push(b);
  }
  // Odds and outs at every step of each run, for display and for the hand record.
  const ids = alive.map(p => p.profileId);
  const runs = boards.map((full, r) => {
    const dead = r ? boards[0].slice(base.length) : [], stages = [];
    for (const len of [...new Set([base.length, 3, 4, 5])].filter(l => l >= base.length)) {
      const board = full.slice(0, len), eq = equities(holes, board, dead), o = outs(holes, board, dead);
      stages.push({ len, equity: Object.fromEntries(ids.map((id, i) => [id, eq[i]])), outs: Object.fromEntries(ids.map((id, i) => [id, o[i]]).filter(([, v]) => v.length)) });
    }
    return { board: full, stages };
  });
  h.runout = { times, from: base.length, votes: h.awaiting.votes, runs };
  h.board = boards[0]; h.board2 = boards[1] || null;
  h.awaiting = null;
  alive.forEach(p => { p.sawFlop = true; });
  finish(state, 'showdown');
  return true;
}

// Split the money into main and side pots from what each player put in.
export function buildPots(players) {
  const levels = [...new Set(players.filter(p => !p.folded).map(p => p.total))].sort((a, b) => a - b);
  const top = Math.max(0, ...players.map(p => p.total));
  if (levels.at(-1) !== top) levels.push(top);
  const pots = []; let prev = 0;
  for (const level of levels) {
    const amount = players.reduce((a, p) => a + Math.max(0, Math.min(p.total, level) - prev), 0);
    let eligible = players.filter(p => !p.folded && p.total >= level);
    if (!eligible.length) eligible = players.filter(p => !p.folded); // folded money above every live stack
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function finish(state, endedBy) {
  const h = state.hand, alive = h.players.filter(p => !p.folded);
  const showdown = endedBy === 'showdown';
  const boards = showdown ? [h.board, h.board2].filter(Boolean) : [];
  if (showdown) alive.forEach(p => { p.showdown = true; p.bests = boards.map(b => bestHand([...p.hole, ...b])); p.best = p.bests[0]; });
  const payout = new Map(h.players.map(p => [p, 0]));
  const pots = buildPots(h.players).map(pot => {
    // Run twice: each board plays for half of the pot (the first board gets the odd chip).
    const halves = boards.length === 2 ? [Math.ceil(pot.amount / 2), Math.floor(pot.amount / 2)] : [pot.amount];
    const runs = halves.map((amount, r) => {
      let winners = pot.eligible;
      if (showdown && winners.length > 1) {
        const top = winners.reduce((b, p) => compareRanks(p.bests[r].rank, b.bests[r].rank) > 0 ? p : b);
        winners = winners.filter(p => compareRanks(p.bests[r].rank, top.bests[r].rank) === 0);
      }
      // Odd chips go one at a time to winners in deal order (closest to the left of the button first).
      const share = Math.floor(amount / winners.length); let odd = amount - share * winners.length;
      for (const p of h.players) if (winners.includes(p)) payout.set(p, payout.get(p) + share + (odd-- > 0 ? 1 : 0));
      return { amount, winners: winners.map(p => p.profileId) };
    });
    return { amount: pot.amount, winners: [...new Set(runs.flatMap(r => r.winners))], contested: pot.eligible.length > 1, ...(runs.length > 1 ? { runs } : {}) };
  });
  for (const p of h.players) {
    p.stack += payout.get(p); p.won = payout.get(p); p.net = p.stack - p.startStack;
    state.seats[p.seat].stack = p.stack;
  }
  h.street = 'done'; h.toAct = null;
  h.results = { endedBy, pots, shown: showdown ? alive.map(p => p.profileId) : [] };
  // Leavers cash out now; their stack is remembered in case they come back.
  state.seats.forEach((s, i) => { if (s?.leaving) { state.away[s.profileId] = { ...s, leaving: false }; state.seats[i] = null; } });
}

// ---------- views ----------
// What everyone may see. Hole cards appear only for players who reached showdown.
export function publicView(state) {
  const h = state.hand;
  // Cards are face up at showdown, and as soon as an all-in leaves nothing more to bet.
  const shown = !h ? [] : h.awaiting ? h.players.filter(p => !p.folded).map(p => p.profileId) : h.results?.shown || [];
  return {
    config: state.config, handNo: state.handNo, button: state.button,
    seats: state.seats.map(s => s && { profileId: s.profileId, stack: s.stack, sittingOut: s.sittingOut, bought: s.bought, carried: s.carried }),
    hand: h && {
      id: h.id, no: h.no, street: h.street, board: h.board, board2: h.board2 || null, button: h.button, sb: h.sb, bb: h.bb,
      awaiting: h.awaiting || null, runout: h.runout || null,
      pot: h.players.reduce((a, p) => a + p.total, 0), currentBet: h.currentBet, minRaise: h.minRaise, toAct: h.toAct,
      players: h.players.map(p => ({
        seat: p.seat, profileId: p.profileId, stack: p.stack, bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn,
        hole: shown.includes(p.profileId) ? p.hole : null,
        handName: h.results?.shown.includes(p.profileId) ? p.best?.name : null,
        handName2: h.board2 && h.results?.shown.includes(p.profileId) ? p.bests[1].name : null, won: p.won, net: p.net
      })),
      actions: h.actions, results: h.results
    }
  };
}

// The permanent record of a finished hand (public part). Mucked hole cards are left out;
// they become checkable once the server seed is revealed.
export function handRecord(state) {
  const h = state.hand, shown = h.results.shown;
  return {
    no: h.no, button: h.button, sb: h.sb, bb: h.bb, blinds: [state.config.smallBlind, state.config.bigBlind],
    dealOrder: h.players.map(p => p.profileId), board: h.board, actions: h.actions, results: h.results,
    ...(h.runout ? { board2: h.board2, runout: h.runout } : {}),
    players: h.players.map(p => ({
      profileId: p.profileId, seat: p.seat, startStack: p.startStack, endStack: p.stack, net: p.net, won: p.won, put: p.total,
      hole: shown.includes(p.profileId) ? p.hole : null, handName: shown.includes(p.profileId) ? p.best.name : null,
      vpip: p.vpip, pfr: p.pfr, sawFlop: p.sawFlop, showdown: p.showdown, folded: p.folded
    }))
  };
}
