// Dev helper: goes all-in at a LOCAL table (bots must be running) and screenshots the runout.
//   node scripts/shot-allin.mjs <table id> <output folder> [phone]
import { chromium } from 'playwright-core';
import { localUsers } from './seed-local.mjs';

const [tableId, out, size, minBoard = '0'] = process.argv.slice(2); // minBoard: shove only once this many board cards are out
const { password } = localUsers();
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: size === 'phone' ? { width: 390, height: 780 } : { width: 1440, height: 810 } });
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto('http://127.0.0.1:3000/index.html');
await page.fill('#login-email', 'admin@poker.test'); await page.fill('#login-pass', password);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app:not(.hidden)');
await page.goto(`http://127.0.0.1:3000/play.html#table/${tableId}`);
await page.waitForSelector('.seat');
const tag = (size === 'phone' ? 'phone' : 'desktop') + (minBoard !== '0' ? `-from${minBoard}` : '');
const click = async sel => { const b = page.locator(sel); if (await b.count()) { await b.first().click().catch(() => {}); return true; } return false; };
let voted = false;
for (let i = 0; i < 600 && !voted; i++) {
  if (await page.locator('[data-run]').count()) { voted = true; break; }
  if (await click('[data-out="0"]') || await click('[data-sit]') || await click('[data-act="start"]') || await click('[data-act="rebuy"]')) { await page.waitForTimeout(600); continue; }
  const onBoard = await page.locator('.slot:not(.discard) .pc3d').count();
  if (onBoard >= +minBoard && await page.locator('[data-raise-open]:not([disabled])').count()) {
    await page.click('[data-raise-open]'); await page.waitForTimeout(150);
    await page.locator('[data-preset]').last().click(); await page.waitForTimeout(150);
    await page.click('#raise-btn');
  } else await click('[data-act="check"]:not([disabled])') || await click('[data-act="call"]:not([disabled])');
  await page.waitForTimeout(400);
}
if (!voted) { console.log('never got an all-in call'); await browser.close(); process.exit(1); }
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/${tag}-allin-vote.png` });
await page.click('[data-run="2"]');
for (let i = 0; i < 40; i++) { if (!(await page.locator('[data-run]').count())) break; await page.waitForTimeout(300); }
// a burst right after the choice, to catch the burn / deal / flip / spread in motion
for (let i = 0; i < 9; i++) { await page.waitForTimeout(330); await page.screenshot({ path: `${out}/${tag}-deal-${i}.png` }); }
for (const [name, wait] of [['1-flop', 1500], ['2-turn', 5200], ['3-river', 5200], ['4-second', 5200], ['5-second-b', 5200], ['6-second-c', 5200], ['7-result', 6500]]) {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${tag}-allin-${name}.png` });
}
console.log('done', await page.locator('.center .msg').innerText());
await browser.close();
