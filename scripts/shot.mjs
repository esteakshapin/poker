// Dev helper: screenshots of a LOCAL table at desktop and phone sizes, signed in as the test admin.
//   node scripts/shot.mjs <table id> <output folder> [myturn|showdown|any]
import { chromium } from 'playwright-core';
import { localUsers } from './seed-local.mjs';

const [tableId, out, when = 'any'] = process.argv.slice(2);
const { password } = localUsers();
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto('http://127.0.0.1:3000/index.html');
await page.fill('#login-email', 'admin@poker.test'); await page.fill('#login-pass', password);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app:not(.hidden)');
await page.goto(`http://127.0.0.1:3000/play.html#table/${tableId}`);
await page.waitForSelector('.seat');
const back = page.locator('[data-out="0"]'); if (await back.count()) await back.click();
const sit = page.locator('[data-sit]'); if (await sit.count()) await sit.last().click();
const cond = { myturn: '[data-raise-open]', showdown: '.seat.winner', any: '.seat' }[when];
// keep the game moving until the moment we want
for (let i = 0; i < 300; i++) {
  if (await page.locator(cond).count()) break;
  for (const sel of ['[data-act="start"]', '[data-act="check"]:not([disabled])', '[data-act="call"]:not([disabled])', '[data-act="rebuy"]', '[data-out="0"]'])
    if (when !== 'myturn' || !sel.includes('check') && !sel.includes('call')) { const b = page.locator(sel); if (await b.count()) { await b.first().click().catch(() => {}); break; } }
  await page.waitForTimeout(400);
}
await page.waitForTimeout(when === 'showdown' ? 1200 : 2500);
await page.screenshot({ path: `${out}/desktop-${when}.png` });
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/phone-${when}.png` });
if (when === 'myturn') { await page.click('[data-raise-open]').catch(() => {}); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/phone-raise.png` });
  await page.setViewportSize({ width: 1440, height: 810 }); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/desktop-raise.png` }); }
await browser.close();
console.log('done');
