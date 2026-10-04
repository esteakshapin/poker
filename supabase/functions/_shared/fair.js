// Provably fair shuffle.
//
// This exact file runs in three places: the server function that deals the cards,
// the browser (to verify hands), and Node (tests and the standalone verifier).
// It only uses the standard Web Crypto API. See FAIRNESS.md for the plain-English version.
//
// The scheme, per hand:
//   1. Before the hand, the server picks a random 32-byte SERVER SEED and publishes
//      its SHA-256 hash (the COMMITMENT). The seed itself stays secret.
//   2. After seeing the commitment, each player's browser sends its own random CLIENT SEED.
//   3. The deck order is computed from the server seed + all client seeds + table id + hand number.
//      Nothing else goes in: no clock, no player names, no stack sizes.
//   4. Later the server seed is revealed. Anyone can check that it hashes to the commitment
//      and that re-running the shuffle gives exactly the cards that were dealt.
//
// The server can't rig the deck because it committed to its seed before seeing the client seeds.
// A player can't rig it because they never know the server seed while the hand is live.

const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array((h.match(/../g) || []).map(b => parseInt(b, 16)));

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
// The unshuffled deck always starts in this fixed order: 2c 3c ... Ac 2d ... Ad 2h ... Ah 2s ... As.
export const FRESH_DECK = [...SUITS].flatMap(s => [...RANKS].map(r => r + s));

export function randomSeed(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a); // the platform's cryptographically secure random source
  return toHex(a);
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// The commitment published before the hand: SHA-256 of the server seed's hex string.
export const commitmentFor = serverSeed => sha256Hex(serverSeed);

// Client seeds are limited to letters and digits so the message below has exactly one reading.
export const cleanClientSeed = s => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);

// The public inputs to the shuffle, in one canonical string. Client seeds are sorted by player id.
export function shuffleMessage({ tableId, handNo, clientSeeds }) {
  const seeds = Object.keys(clientSeeds).sort().map(id => `${id}=${cleanClientSeed(clientSeeds[id])}`).join(',');
  return `table=${tableId};hand=${handNo};seeds=${seeds}`;
}

// Fisher-Yates shuffle of FRESH_DECK. Random numbers come from
// HMAC-SHA256(key = server seed, data = message + ";block=N") for N = 0, 1, 2, ...
// read 4 bytes at a time as big-endian unsigned integers.
export async function shuffledDeck(serverSeed, message) {
  const key = await crypto.subtle.importKey('raw', fromHex(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let block = new Uint8Array(0), pos = 0, counter = 0;
  async function nextUint32() {
    if (pos + 4 > block.length) {
      block = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${message};block=${counter++}`)));
      pos = 0;
    }
    const v = ((block[pos] << 24) | (block[pos + 1] << 16) | (block[pos + 2] << 8) | block[pos + 3]) >>> 0;
    pos += 4;
    return v;
  }
  // Uniform integer in [0, n). Values in the uneven tail are thrown away (rejection sampling),
  // so no card position is even slightly more likely than another.
  async function randomBelow(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    let v;
    do { v = await nextUint32(); } while (v >= limit);
    return v % n;
  }
  const deck = [...FRESH_DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = await randomBelow(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Where each card comes from in the shuffled deck, given the seats dealt in (in deal order:
// first seat left of the button first). One card each, then a second card each, then
// burn, 3 flop cards, burn, turn, burn, river.
export function dealPlan(dealOrder) {
  const n = dealOrder.length, hole = {};
  dealOrder.forEach((id, i) => { hole[id] = [i, n + i]; });
  const b = 2 * n;
  return { hole, board: [b + 1, b + 2, b + 3, b + 5, b + 7], burns: [b, b + 4, b + 6] };
}
// "Run it twice": the second board keeps the cards that were already out (`from` of them) and takes
// its remaining cards from the deck right after the first board, with a burn before each street.
export function secondBoardPlan(dealOrder, from) {
  const first = dealPlan(dealOrder).board, idx = first.slice(0, from);
  let pos = first[4] + 1;
  while (idx.length < 5) { pos++; const count = idx.length === 0 ? 3 : 1; for (let k = 0; k < count; k++) idx.push(pos++); }
  return idx;
}

// Re-checks a finished, revealed hand. Returns a list of {name, ok, detail} checks.
// `seenCommitment` is the commitment this device saw before the hand started (optional but stronger).
export async function verifyHand(hand, seenCommitment) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  if (!hand.server_seed) { add('Server seed revealed', false, 'Not revealed yet'); return checks; }
  const commitment = await commitmentFor(hand.server_seed);
  add('Server seed matches the commitment published before the hand', commitment === hand.commitment, commitment);
  if (seenCommitment) add('Commitment matches what this device saw before the hand', seenCommitment === hand.commitment, seenCommitment);
  const message = shuffleMessage({ tableId: hand.table_id, handNo: hand.hand_no, clientSeeds: hand.client_seeds || {} });
  const deck = await shuffledDeck(hand.server_seed, message);
  add('Deck is a complete 52-card deck', new Set(deck).size === 52 && deck.every(c => FRESH_DECK.includes(c)));
  if (hand.deck) add('Recorded deck equals the deck re-computed from the seeds', JSON.stringify(deck) === JSON.stringify(hand.deck));
  const rec = hand.record || {};
  const plan = dealPlan(rec.dealOrder || []);
  for (const p of rec.players || []) {
    if (!p.hole) continue; // only cards that were shown (or are yours) are in the record
    const expect = plan.hole[p.profileId]?.map(i => deck[i]);
    add(`Hole cards of ${p.profileId} match the deck`, JSON.stringify(expect) === JSON.stringify(p.hole), (expect || []).join(' '));
  }
  const board = rec.board || [];
  if (board.length) add('Board cards match the deck', board.every((c, i) => deck[plan.board[i]] === c), plan.board.slice(0, board.length).map(i => deck[i]).join(' '));
  if (rec.board2) {
    const idx = secondBoardPlan(rec.dealOrder || [], rec.runout?.from ?? 0);
    add('Second board (run it twice) matches the deck', rec.board2.every((c, i) => deck[idx[i]] === c), idx.map(i => deck[i]).join(' '));
  }
  return checks;
}
