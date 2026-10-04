// Standalone fairness check, independent of the web app.
//
//   node scripts/verify-hand.mjs hand.json
//
// hand.json is one row of the game_hands table (the hand page shows all the values; or export
// the row from Supabase). It needs: table_id, hand_no, commitment, client_seeds, server_seed,
// and optionally deck and record. Exit code 0 means every check passed.
import { readFileSync } from 'node:fs';
import { verifyHand } from '../supabase/functions/_shared/fair.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/verify-hand.mjs hand.json [fingerprint-you-saw]'); process.exit(2); }
const hand = JSON.parse(readFileSync(file, 'utf8'));
const checks = await verifyHand(hand, process.argv[3]);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
