# Is the online game fair? How it works and how to check

Nobody should have to take anyone's word that the cards are random. Every hand played online
leaves a proof behind that any player can re-check, in the app or with their own code.

## The short version

1. **Before a hand, the server locks in its shuffle seed** and publishes a fingerprint of it.
2. **Then every player's browser adds its own random seed.**
3. **The deck is computed from all of those seeds** with a fixed public formula.
4. **Afterwards the server's seed is revealed.** Anyone can confirm it matches the fingerprint and
   re-run the shuffle to get exactly the cards that were dealt.

Because the server commits first and the players contribute second, neither side can steer the deck.

## Step by step

### 1. The commitment (before the hand)

The server generates 32 random bytes (the **server seed**) from the platform's cryptographic
random generator and publishes

    fingerprint = SHA-256(server_seed as a hex string)

The table shows this fingerprint before the hand is dealt, and each player's browser saves a copy
on their own device at that moment. SHA-256 can't be reversed, and nobody can find a second seed
with the same fingerprint, so from here on the server is stuck with that seed.

### 2. The players' seeds

After the fingerprint is public, each seated player's browser generates 16 random bytes and sends
them as that player's **client seed**. The server stores the seeds with the hand when it starts, and
every player can see their own seed in the hand record.

### 3. The shuffle

    input  = "table=<table id>;hand=<hand number>;seeds=<player id>=<seed>,<player id>=<seed>,…"
             (player seeds sorted by player id)
    deck   = 2c 3c 4c … Ac 2d … Ad 2h … Ah 2s … As        (always starts in this order)

    random(n):
        read 4 bytes at a time, as a big-endian unsigned number, from
        HMAC-SHA256(key = server_seed, data = input + ";block=0"), then ";block=1", and so on
        if the number is ≥ the largest multiple of n that fits in 2^32, skip it
        otherwise return number mod n

    for i = 51 down to 1:
        j = random(i + 1)
        swap deck[i] and deck[j]

This is the standard Fisher–Yates shuffle. Skipping the numbers in the uneven tail (rejection
sampling) is what makes every position exactly equally likely instead of almost equally likely.

Nothing else feeds the shuffle: no clock, no player names, no stack sizes, no hidden state.

### 4. The deal

Cards come off the top of the shuffled deck in a fixed order:

- one card to each player, starting with the first seat left of the button, then a second card each
- burn one, three flop cards, burn one, the turn, burn one, the river

So once the seeds are fixed, every card of the hand is fixed too, including cards nobody has seen yet.

### All-ins and "run it twice"

When everyone left in a hand is all-in (or one player has the rest covered) there is no more betting.
The players first choose whether to deal the rest of the board once or twice, while all hands are
still face down and no odds are shown, so nobody can choose based on who is ahead. It is only run
twice if every player still in the hand agrees; if anyone picks once, or the choice times out, it is
run once. Then the hands are turned face up, the table shows each player's chance to win, and the
board is dealt.

Running it twice does not use any new randomness. The second board keeps the cards that were already
out and takes its remaining cards from the same shuffled deck, straight after the first board, with a
burn before each street. Each board plays for half of each pot. The verification re-derives the
second board from the deck in the same way as the first.

The win chances and "outs" shown during an all-in are worked out from the face-up cards only. With
one or two cards to come every possible board is counted exactly. Before the flop there are too many
boards, so 1,500 of them are sampled, which is accurate to within two or three percent.

### 5. The reveal

The server seed is published when the session ends (the default) or after each hand, depending
on how the table was opened. Revealing a seed exposes that hand's whole deck, including the cards
people folded, which is why the default waits until the session is over.

## What each rule protects against

| Worry | Why it can't happen |
|---|---|
| The server deals itself or a friend a good hand | It committed to its seed before it knew the players' seeds. One different player seed gives a completely different deck. |
| A player steers the deck with their seed | They don't know the server seed until afterwards, so they can't predict what any seed will do. |
| Cards get swapped during the hand | The whole deck is fixed by seeds locked in before the first card. A changed card would not match the re-computed deck. |
| The server swaps its seed afterwards | The revealed seed must hash to the fingerprint each player's own device saved before the hand. |
| The shuffle favours some cards or seats | Fisher–Yates with rejection sampling is uniform. The test suite deals 20,000 decks and checks every card lands in every position equally often. |
| The record is edited later | Fingerprints are stored on each player's device, and the full deck is re-derived from the seeds, not read from the record. |

## What this does not prove

It proves the deck was random and was not changed. It cannot prove that nobody **looked**.
Whoever administers the database could in principle read the deck of a hand in progress, the same
way the host of a home game could peek at the deck. What the system does guarantee:

- A player's browser never receives another player's hole cards or the undealt deck.
  The database rules refuse those reads, and the simulation test checks it on every hand.
- All game actions go through one server function that checks whose turn it is and what is legal.

Removing that last bit of trust needs "mental poker", where all players encrypt the deck together
so that no single party, not even the server, can read it. That is a possible next step.

## How to check a hand yourself

**In the app:** open *Hand history*, pick a hand. Once its seed is revealed the page re-runs every
check in your browser: seed matches fingerprint, fingerprint matches what your device saw before the
hand, deck re-computes to the recorded deck, your hole cards, shown cards and the board all sit at
the right positions in that deck. *Verify all revealed hands* does it for a whole session.

**Outside the app:** the hand page shows every value needed. Save them as JSON and run

    node scripts/verify-hand.mjs hand.json [fingerprint-you-saw]

or re-implement the formula above in any language; it is about 20 lines.

## Where the code is

| File | What it does |
|---|---|
| `supabase/functions/_shared/fair.js` | The shuffle and the verification. The same file is used by the server to deal and by your browser to verify. |
| `supabase/functions/_shared/engine.js` | The rules of the game. No randomness in here; the deck is handed in. |
| `supabase/functions/game/index.ts` | The server function: commits, collects seeds, deals, enforces turns. |
| `supabase/migrations/20261004000000_game.sql` | Who may read what (your own cards only; no deck). |
| `test/fair.test.mjs` | Tests: determinism, tamper detection (including the second board), uniformity over 20,000 shuffles. |
| `scripts/simulate.mjs` | Plays full sessions against a local server and checks privacy, chip conservation and verification on every hand. |
