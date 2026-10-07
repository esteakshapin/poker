// Online poker client. All rules and the shuffle live on the server (supabase/functions/game);
// this file only shows the table, sends your actions, and lets you verify hands in your own browser.
import * as F from './supabase/functions/_shared/fair.js';
import { bestHand } from './supabase/functions/_shared/engine.js';

const CFG = window.POKER_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key);
const $ = id => document.getElementById(id);
const view = $('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n).toLocaleString();
const signed = v => (v > 0 ? '+' : '') + num(v);
const COLORS = ['#1f77b4', '#d95f02', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f', '#393b79', '#e7ba52'];

let session = null, me = null, isAdmin = false, profiles = {};

// ---------- people ----------
function prof(id) {
  const p = profiles[id] || { id, first: '?', last: '' };
  const idx = Object.keys(profiles).indexOf(id);
  return { ...p, name: p.display || (p.last ? `${p.first} ${p.last[0].toUpperCase()}.` : p.first), color: COLORS[(idx < 0 ? 0 : idx) % COLORS.length] };
}
function avatar(p, size = 26) {
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (p.avatar) return `<img class="av" src="${p.avatar}" alt="" style="${st}">`;
  return `<span class="av" style="${st};background:${p.color}">${esc(((p.first || '?')[0] + (p.last ? p.last[0] : '')).toUpperCase())}</span>`;
}
const who = id => { const p = prof(id); return `<span class="row" style="display:inline-flex;gap:6px;flex-wrap:nowrap">${avatar(p, 22)}${esc(p.name)}</span>`; };

// ---------- cards ----------
const SUIT = { c: '♣', d: '♦', h: '♥', s: '♠' };
function cardHtml(c, cls = '') {
  if (!c) return `<span class="pc back ${cls}"></span>`;
  return `<span class="pc ${'dh'.includes(c[1]) ? 'red' : ''} ${cls}"><span class="r">${c[0] === 'T' ? '10' : c[0]}</span><span class="s">${SUIT[c[1]]}</span></span>`;
}
const cardsHtml = (cs, cls) => (cs || []).map(c => cardHtml(c, cls)).join('');

// ---------- sound ----------
// Every effect is synthesised in the browser, so there are no audio files to load.
const Sound = (() => {
  let ctx = null, hiss = null, muted = false;
  try { muted = localStorage.getItem('poker-muted') === '1'; } catch (e) {}
  // Browsers only allow sound after the first tap or key press.
  const wake = () => { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch (e) {} };
  ['pointerdown', 'keydown', 'touchend'].forEach(ev => window.addEventListener(ev, wake, { passive: true }));
  const env = (t, dur, vol) => { const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); g.connect(ctx.destination); return g; };
  function tone(t, freq, dur, vol = 0.2, type = 'sine', slideTo = 0) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    o.connect(env(t, dur, vol)); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(t, dur, freq, vol = 0.3, kind = 'bandpass', q = 1) {
    if (!hiss) { hiss = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = hiss.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(); src.buffer = hiss; f.type = kind; f.frequency.value = freq; f.Q.value = q;
    src.connect(f); f.connect(env(t, dur, vol)); src.start(t, Math.random() * 0.5, dur + 0.02);
  }
  const chip = (t, vol = 0.16) => { tone(t, 2300 + Math.random() * 500, 0.05, vol, 'triangle'); noise(t, 0.03, 5200, vol, 'bandpass', 3); };
  const kit = {
    card: t => { noise(t, 0.09, 2600, 0.3, 'highpass'); noise(t + 0.01, 0.05, 900, 0.14); },
    chips: t => { chip(t); chip(t + 0.06); chip(t + 0.13, 0.11); },
    allin: t => { for (let i = 0; i < 7; i++) chip(t + i * 0.05, 0.17); tone(t, 110, 0.5, 0.22, 'sawtooth', 55); },
    check: t => { tone(t, 190, 0.07, 0.4, 'sine', 90); tone(t + 0.13, 190, 0.07, 0.4, 'sine', 90); },
    fold: t => noise(t, 0.2, 1400, 0.16, 'lowpass'),
    turn: t => { tone(t, 660, 0.16, 0.22, 'triangle'); tone(t + 0.14, 880, 0.16, 0.22, 'triangle'); tone(t + 0.28, 1320, 0.32, 0.2, 'triangle'); },
    tick: t => { tone(t, 1000, 0.06, 0.2, 'square'); tone(t + 0.22, 1000, 0.06, 0.2, 'square'); },
    win: t => { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.1, f, 0.3, 0.2, 'triangle')); for (let i = 0; i < 6; i++) chip(t + 0.45 + i * 0.06, 0.11); },
    pot: t => { for (let i = 0; i < 6; i++) chip(t + i * 0.06, 0.12); }
  };
  return {
    play(name, delayMs = 0) { if (muted || !ctx || ctx.state !== 'running') return; try { kit[name](ctx.currentTime + 0.01 + delayMs / 1000); } catch (e) {} },
    get muted() { return muted; },
    toggle() { muted = !muted; try { localStorage.setItem('poker-muted', muted ? '1' : '0'); } catch (e) {} wake(); return muted; }
  };
})();

// ---------- server calls ----------
async function call(action, body = {}) {
  const res = await fetch(`${CFG.url}/functions/v1/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CFG.key, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Server error (${res.status})`);
  return data;
}
const q = async query => { const { data, error } = await query; if (error) throw new Error(error.message); return data; };

// ---------- what this device saw (for verification) ----------
// The commitment for every hand is saved here the moment it is published, before the hand is dealt.
const seenKey = t => `poker-seen:${t}`;
function seen(tableId) { try { return JSON.parse(localStorage.getItem(seenKey(tableId)) || '{}'); } catch (e) { return {}; } }
function remember(tableId, handNo, patch) {
  const all = seen(tableId); all[handNo] = { ...(all[handNo] || {}), ...patch };
  try { localStorage.setItem(seenKey(tableId), JSON.stringify(all)); } catch (e) {}
}

// ---------- routing ----------
let cleanup = () => {};
async function route() {
  cleanup(); cleanup = () => {};
  const [name, arg] = (location.hash.slice(1) || 'lobby').split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + name));
  try {
    if (name === 'table') await tableView(arg);
    else if (name === 'hands') await handsView(arg);
    else if (name === 'hand') await handView(arg);
    else if (name === 'stats') await statsView(arg);
    else if (name === 'fair') fairView();
    else await lobbyView();
  } catch (e) { view.innerHTML = `<div class="card-box"><b>Something went wrong.</b><div class="err">${esc(e.message)}</div></div>`; }
}
window.addEventListener('hashchange', route);

// ---------- lobby ----------
async function lobbyView() {
  const [tables, states, tracker] = await Promise.all([
    q(sb.from('game_tables').select('*').order('created_at', { ascending: false })),
    q(sb.from('game_public').select('table_id,state')),
    q(sb.from('poker_state').select('data').eq('id', 'main').maybeSingle())
  ]);
  const st = Object.fromEntries(states.map(s => [s.table_id, s.state]));
  const tournaments = (tracker?.data?.tournaments || []).filter(t => t.status !== 'ended');
  const tName = id => (tracker?.data?.tournaments || []).find(t => t.id === id)?.settings.name;
  const row = t => {
    const s = st[t.id], seats = s ? s.seats.filter(Boolean) : [];
    return `<tr class="click" data-go="#${t.status === 'open' ? 'table' : 'hands'}/${t.id}"><td><b>${esc(t.name)}</b></td>
      <td>${t.status === 'open' ? '<span class="pill ok">Open</span>' : '<span class="pill">Closed</span>'}</td>
      <td>${t.config.smallBlind}/${t.config.bigBlind}</td>
      <td>${t.tournament_id ? esc(tName(t.tournament_id) || 'Tournament') : '<span class="muted">Practice chips</span>'}</td>
      <td>${seats.map(x => avatar(prof(x.profileId), 22)).join(' ') || '<span class="muted">Empty</span>'}</td>
      <td class="num">${s ? s.handNo : 0}</td></tr>`;
  };
  view.innerHTML = `
    <div class="card-box"><h2>Tables</h2>
      <div class="table-wrap"><table><thead><tr><th>Table</th><th>Status</th><th>Blinds</th><th>Counts toward</th><th>Players</th><th class="num">Hands</th></tr></thead>
      <tbody>${tables.length ? tables.map(row).join('') : `<tr><td colspan="6" class="muted">No tables yet.${isAdmin ? ' Open one below.' : ' Ask the admin to open one.'}</td></tr>`}</tbody></table></div>
    </div>
    ${isAdmin ? `<div class="card-box"><h2>Open a table</h2>
      <form id="new-table"><div class="form-grid">
        <label>Name<input name="name" value="Friday game" required></label>
        <label>Counts toward<select name="tournamentId"><option value="">Practice chips (not tracked)</option>${tournaments.map(t => `<option value="${t.id}">${esc(t.settings.name)}</option>`).join('')}</select></label>
        <label>Small blind<input name="smallBlind" type="number" min="1" value="1"></label>
        <label>Big blind<input name="bigBlind" type="number" min="2" value="2"></label>
        <label>Starting stack (practice)<input name="startingStack" type="number" min="1" value="200"></label>
        <label>Seconds to act<input name="actionSeconds" type="number" min="10" max="300" value="30"></label>
        <label>Seats<input name="maxSeats" type="number" min="2" max="9" value="8"></label>
        <label>Reveal seeds<select name="revealMode"><option value="session">When the session ends (recommended)</option><option value="hand">After every hand</option></select></label>
      </div>
      <p class="note">Tournament tables use each player's current tournament stack, and a buy-in gives the tournament's chips per buy-in. When you close the table it is saved as a session in the tracker. Revealing seeds lets anyone verify the shuffle, but it also shows every folded hand, which is why the default waits until the session is over.</p>
      <div class="row"><button class="btn">Open table</button><span class="err" id="new-err"></span></div></form></div>` : ''}`;
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => { location.hash = el.dataset.go; }));
  $('new-table')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await call('create_table', { ...f, smallBlind: +f.smallBlind, bigBlind: +f.bigBlind, startingStack: +f.startingStack, actionSeconds: +f.actionSeconds, maxSeats: +f.maxSeats });
      location.hash = '#table/' + r.tableId;
    } catch (err) { $('new-err').textContent = err.message; }
  });
}

// ---------- table ----------
async function tableView(tableId) {
  const info = await q(sb.from('game_tables').select('*').eq('id', tableId).maybeSingle());
  if (!info) throw new Error('No such table.');
  let S = null, version = -1, mine = { handId: null, cards: null }, busy = false, error = '', raiseTo = null, dead = false;
  let raiseOpen = false, preAction = false; // raise panel open; 'check or fold' queued for my next turn
  const flags = { seedFor: 0, startTry: 0, timeoutTry: 0, firstHandAsked: false };

  document.body.classList.add('in-table');
  view.innerHTML = `<div class="tv">
    <div class="tv-top">
      <a href="#lobby">‹ Tables</a>
      <div class="tv-title"><b>${esc(info.name)} · ${info.tournament_id ? 'tournament' : 'practice'}</b><span>NLH ~ ${info.config.smallBlind} / ${info.config.bigBlind}</span></div>
      <span id="seat-btns" class="row" style="gap:6px;flex-wrap:nowrap"></span>
      <span id="admin-btns"></span>
      <button class="ghost" id="tv-sound" title="Sound on / off">${Sound.muted ? '🔇' : '🔊'}</button>
      <button class="ghost" id="tv-info" title="Hand log, fairness and stacks">☰</button>
      <button class="ghost" id="tv-full" title="Full screen">⛶</button>
    </div>
    <div class="stage" id="felt"></div>
    <div class="err" id="t-err"></div>
    <div class="controls" id="controls"></div>
    <aside class="drawer hidden" id="drawer">
      <div class="row" style="justify-content:space-between"><b>Table info</b><button class="ghost" id="drawer-close">Close</button></div>
      <div class="row" style="margin-top:8px"><a href="#hands/${tableId}">Hand history</a><a href="#stats/${tableId}">Stats</a></div>
      <h2>This hand</h2><div class="log" id="log"></div>
      <h2>Fairness</h2><div id="fairbox" class="note"></div>
      <h2>Stacks this session</h2><div id="stack-chart"></div>
    </aside></div>`;
  if (!document.documentElement.requestFullscreen) $('tv-full').classList.add('hidden');

  const mySeat = () => S.seats.findIndex(s => s && s.profileId === me);
  const live = () => S.hand && S.hand.street !== 'done';
  const hp = pid => S.hand?.players.find(p => p.profileId === pid);

  function setState(st, v) {
    if (dead || v <= version) return;
    version = v; S = st;
    if (S.nextCommitment) remember(tableId, S.handNo + 1, { commitment: S.nextCommitment });
    if (S.hand?.commitment) { const k = seen(tableId)[S.hand.no]; if (!k?.commitment) remember(tableId, S.hand.no, { commitment: S.hand.commitment, late: true }); }
    if (S.hand && S.hand.id !== mine.handId) {
      mine = { handId: S.hand.id, cards: null }; raiseTo = null; raiseOpen = false; preAction = false;
      if (hp(me)) q(sb.from('game_hole_cards').select('cards').eq('hand_id', S.hand.id).eq('profile_id', me).maybeSingle())
        .then(r => { if (r && mine.handId === S.hand.id) { mine.cards = r.cards; render(); } }).catch(() => {});
      loadChart();
    }
    if (S.hand?.street === 'done') loadChart();
    render();
  }
  async function refresh() {
    const r = await q(sb.from('game_public').select('state,version').eq('table_id', tableId).maybeSingle());
    if (r) setState(r.state, r.version);
  }
  async function send(action, body = {}, quiet = false) {
    if (busy) return; busy = true; if (!quiet) error = '';
    try { const r = await call(action, { tableId, ...body }); if (r.state) setState(r.state, r.version); }
    catch (e) { if (!quiet) error = e.message; }
    finally { busy = false; render(); }
  }

  // ----- animation bookkeeping -----
  // The table is redrawn from scratch on every update. Each animated thing has a key and we remember
  // when it first appeared, so a redraw continues its animation where it was instead of restarting it.
  const SPEED = 2.3; // one knob for all animation timing: bigger is slower
  const born = new Map();
  let firstPaint = true, bornHand = null;
  function anim(key, name, dur, delay = 0, real = false) { // real = exact milliseconds, not scaled by SPEED
    if (!real) { dur *= SPEED; delay *= SPEED; }
    const now = performance.now();
    if (!born.has(key)) born.set(key, { t: firstPaint ? -1e9 : now, delay }); // things already on the table when you arrive don't animate
    const b = born.get(key), elapsed = now - b.t;
    if (elapsed > b.delay + dur) return '';
    return `animation:${name} ${Math.round(dur)}ms ${real ? 'ease-in-out' : 'cubic-bezier(.25,.8,.3,1)'} ${Math.round(b.delay - elapsed)}ms both;`;
  }
  // Sounds use the same idea: each has a key and plays once, the first time it is asked for.
  const heard = new Set();
  function sfx(key, name, delay = 0) { if (heard.has(key)) return; heard.add(key); if (!firstPaint) Sound.play(name, delay); }
  const pageTitle = document.title;
  const remaining = (key, dur) => { const b = born.get(key); return b ? Math.max(0, b.t + b.delay + dur * SPEED - performance.now()) / SPEED : 0; };

  // ----- chips -----
  // [value, body colour, edge-stripe colour]
  const DENOMS = [[1000, '#e3b23c', '#7a4b00'], [500, '#6d3fa8', '#e9dcff'], [100, '#1c1c1c', '#e04a3f'], [25, '#1f8a55', '#eafff3'], [10, '#27469c', '#ffe45c'], [5, '#c23a2e', '#ffe9e5'], [1, '#e9e9ee', '#2b4a8f']];
  // One stack of `count` chips drawn from the side, with striped edges and a patterned top chip.
  function stackSvg(color, stripe, count) {
    const w = 26, t = 4, ry = 4.6, rx = w / 2 - 1, h = count * t + ry * 2 + 1.5;
    let g = '';
    for (let i = 0; i < count; i++) {
      const top = h - ry - 1 - (i + 1) * t; // y of this chip's top rim centre
      g += `<path d="M1 ${top}v${t}a${rx} ${ry} 0 0 0 ${2 * rx} 0v-${t}z" fill="${color}" stroke="rgba(0,0,0,.5)" stroke-width=".5"/>`;
      for (const x0 of [3, 10, 17]) { // three edge inserts, staggered chip to chip like a real stack
        const x = x0 + (i % 2 ? 3 : 0), dy = ry * Math.sqrt(Math.max(0, 1 - ((x + 1.5 - w / 2) / rx) ** 2));
        g += `<rect x="${x}" y="${(top + dy + 0.4).toFixed(2)}" width="3" height="${t - 0.8}" fill="${stripe}"/>`;
      }
    }
    const cy = h - ry - 1 - count * t;
    g += `<ellipse cx="${w / 2}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" stroke="rgba(0,0,0,.5)" stroke-width=".5"/>
      <ellipse cx="${w / 2}" cy="${cy}" rx="${rx * 0.86}" ry="${ry * 0.86}" fill="none" stroke="${stripe}" stroke-width="1.6" stroke-dasharray="3.2 3.4"/>
      <ellipse cx="${w / 2}" cy="${cy}" rx="${rx * 0.56}" ry="${ry * 0.56}" fill="rgba(255,255,255,.16)" stroke="rgba(255,255,255,.5)" stroke-width=".5"/>`;
    return `<svg class="chipstack" viewBox="0 0 ${w} ${h.toFixed(1)}" style="aspect-ratio:${w}/${h.toFixed(1)}">${g}</svg>`;
  }
  // `full` breaks the amount into smaller chips so a big stack looks like a big stack.
  function chips(amount, maxCols = 5, maxHigh = 8, full = false) {
    let rest = Math.max(0, Math.floor(amount)); const cols = [];
    for (const [d, color, stripe] of DENOMS) { if (full && d > rest / 6 && d > 1) continue; const k = Math.floor(rest / d); if (k > 0) { cols.push(stackSvg(color, stripe, Math.min(k, maxHigh))); rest -= k * d; } }
    return `<span class="chips">${cols.slice(0, maxCols).join('')}</span>`;
  }
  // A card that can flip: back while `inner` holds it rotated, face when done.
  const flipCard = (c, outer, inner, cls = '') => `<span class="pc3d" style="${outer}"><span class="in" style="${inner}">${cardHtml(c, cls)}<span class="pc back"></span></span></span>`;
  // What a player is holding right now, e.g. "Pair", "Straight".
  const strength = (hole, board) => hole.length + board.length >= 5 ? bestHand([...hole, ...board]).name : hole[0][0] === hole[1][0] ? 'Pair' : 'High card';

  // ----- all-in runout pacing -----
  // The server deals the whole all-in board at once; the table then shows it street by street.
  const RUN_FIRST_MS = 1200, RUN_STREET_MS = 5200, RUN_END_MS = 3600;
  const RUN_FLOP_ANIM = 2100, RUN_CARD_ANIM = 1650; // how long until a dealt flop / single card is face up // RUN_STREET_MS matches the server's pause
  let runTimers = [], runScheduled = null;
  function runoutView(h) {
    const ro = h.runout, key = `runout:${h.id}`;
    if (!born.has(key)) born.set(key, { t: firstPaint ? -1e9 : performance.now(), delay: 0 });
    const el = performance.now() - born.get(key).t;
    const events = ro.runs.flatMap((r, run) => r.stages.slice(1).map(st => ({ run, len: st.len })));
    const count = el < RUN_FIRST_MS ? 0 : Math.min(events.length, 1 + Math.floor((el - RUN_FIRST_MS) / RUN_STREET_MS));
    const done = el >= RUN_FIRST_MS + (events.length - 1) * RUN_STREET_MS + RUN_END_MS;
    const lens = ro.runs.map((_, run) => events.slice(0, count).filter(e => e.run === run).at(-1)?.len ?? ro.from);
    const run = count ? events[count - 1].run : 0;
    // Odds and outs change only once the new card(s) have actually been turned over.
    const landed = events.filter((e, i) => el >= RUN_FIRST_MS + i * RUN_STREET_MS + (e.len === 3 ? RUN_FLOP_ANIM : RUN_CARD_ANIM));
    const seenRun = landed.length ? landed.at(-1).run : 0, seenLen = landed.filter(e => e.run === seenRun).at(-1)?.len ?? ro.from;
    const stage = ro.runs[seenRun].stages.find(st => st.len === seenLen);
    if (runScheduled !== h.id && !done) { // redraw at each reveal
      runScheduled = h.id; runTimers.forEach(clearTimeout);
      const times = [...events.flatMap((e, i) => [RUN_FIRST_MS + i * RUN_STREET_MS, RUN_FIRST_MS + i * RUN_STREET_MS + (e.len === 3 ? RUN_FLOP_ANIM : RUN_CARD_ANIM)]), RUN_FIRST_MS + (events.length - 1) * RUN_STREET_MS + RUN_END_MS];
      runTimers = times.filter(t => t > el).map(t => setTimeout(render, t - el + 40));
    }
    return { done, lens, run, stage, times: ro.times, started: ro.runs.map((_, r) => r === 0 || events.slice(0, count).some(e => e.run === r)) };
  }
  const ALLIN = `<svg class="allin" viewBox="0 0 60 54"><path d="M30 3 57 50H3z" fill="#141414" stroke="#e23b2e" stroke-width="4" stroke-linejoin="round"/><path d="M30 14c5 6 9 8 9 12a4.4 4.4 0 0 1-7.6 3c.3 2 1 3.4 2.2 4.6h-7.2c1.200-1.200 1.900-2.600 2.200-4.600A4.400 4.400 0 0 1 21 26c0-4 4-6 9-12z" fill="#e23b2e"/><text x="30" y="46" text-anchor="middle" font-size="9.500" font-weight="900" fill="#fff" font-family="Arial, sans-serif">ALL IN</text></svg>`;

  // ----- drawing -----
  function render() {
    if (!S || dead) return;
    const n = S.seats.length, seatIdx = mySeat(), rot = seatIdx >= 0 ? seatIdx : 0;
    const h = S.hand, isLive = live(), stage = $('felt'), hid = h?.id;
    if (hid !== bornHand) { born.clear(); bornHand = hid; }
    const portrait = stage.clientHeight > stage.clientWidth * 1.05;
    // Seats sit on a ring just outside the felt, so name plates never cover the board or the pot.
    // On a phone the side seats are pushed all the way to the screen edges.
    const RX = portrait ? 50 : 44, RY = portrait ? 41 : 40, CY = portrait ? 49 : 48;
    const at = (i, r = 1) => { const a = Math.PI / 2 + ((i - rot + n) % n) * 2 * Math.PI / n, x = 50 + Math.cos(a) * RX * r; return [portrait ? Math.max(15, Math.min(85, x)) : x, CY + Math.sin(a) * RY * r]; };
    const place = ([x, y]) => `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;`;
    const seatAt = ([x, y]) => `--x:${x.toFixed(1)}%;top:${y.toFixed(1)}%;`;
    const from = ([x, y], [fx, fy]) => `--dx:${(fx - x).toFixed(1)}cqw;--dy:${(fy - y).toFixed(1)}cqh;`; // offset to where it starts
    // On a phone the side seats reach into the middle, so the board goes in the widest gap between seat rows.
    let boardY = CY;
    if (portrait) {
      const rows = S.seats.map((_, i) => at(i)).filter(([x]) => Math.abs(x - 50) > 12).map(([, y]) => y);
      let best = -1;
      for (let y = CY - RY * 0.55; y <= CY + RY * 0.25; y += 1) { const gap = Math.min(...rows.map(r => Math.abs(r - y)), 99); if (gap > best) { best = gap; boardY = y; } }
    }
    const mid = [50, boardY];
    // Board geometry in "em" of the board's font size: card, gaps, and how far left of centre the deck sits.
    const CW = 2.5, CH = 3.5, GAP = 0.3, DGAP = 1.1, DECK_X = ((CW + DGAP + 5 * CW + 4 * GAP) / 2 - CW / 2).toFixed(2);
    const verb = a => ({ fold: 'fold', check: 'check', call: `call ${num(a.chips)}`, bet: `bet ${num(a.to)}`, raise: `raise ${num(a.to)}`, 'small blind': '', 'big blind': '' }[a.type]);
    const lastAct = h?.actions.at(-1), nP = h?.players.length || 0;
    const ro = h?.runout ? runoutView(h) : null;
    const revealing = !!ro && !ro.done;                 // all-in board still coming out
    const odds = revealing ? ro.stage.equity : null;    // win chances appear once once / twice is chosen and the hands are face up
    const boardNow = !h ? [] : ro ? h.runout.runs[ro.run].board.slice(0, ro.lens[ro.run]) : h.board;
    const winners = h?.results && !revealing ? new Map() : null;
    if (winners) for (const pot of h.results.pots) for (const w of pot.winners) winners.set(w, (winners.get(w) || 0) + Math.floor(pot.amount / pot.winners.length));

    // sounds for whatever just happened
    if (h) {
      sfx(`deal:${hid}`, 'card'); for (let c = 1; c < nP * 2; c++) sfx(`deal:${hid}:${c}`, 'card', c * 130 * SPEED);
      if (lastAct) sfx(`act:${hid}:${h.actions.length}`, lastAct.allIn ? 'allin' : { fold: 'fold', check: 'check' }[lastAct.type] || 'chips');
      if (winners?.size) sfx(`win:${hid}`, winners.get(me) > 0 ? 'win' : 'pot', 700);
    }
    const myTurn = !!myOptions() && !preAction;
    if (myTurn && !heard.has(`turn:${hid}:${h.actions.length}`)) { try { if (!firstPaint) navigator.vibrate?.([120, 60, 120]); } catch (e) {} }
    if (myTurn) sfx(`turn:${hid}:${h.actions.length}`, 'turn', 250);
    view.firstElementChild.classList.toggle('myturn', myTurn);
    document.title = myTurn ? '▶ YOUR TURN' : pageTitle;

    let html = `<div class="felt ${portrait ? 'portrait' : ''}"></div>`;
    S.seats.forEach((s, i) => {
      const xy = at(i);
      if (!s) {
        html += `<div class="seat empty" style="${seatAt(xy)}">${seatIdx < 0 && S.status === 'open' && me ? `<button data-sit="${i}">Sit here</button>` : ''}</div>`;
        return;
      }
      const p = prof(s.profileId), k = h ? h.players.findIndex(x => x.profileId === s.profileId) : -1, pl = k >= 0 ? h.players[k] : null;
      const isMe = s.profileId === me, turn = isLive && h.toAct === i, won = winners?.get(s.profileId) > 0 && pl.won > 0;
      let cards = '', tag = '';
      if (pl) {
        const fromMid = `--dx:calc(${(50 - xy[0]).toFixed(1)}cqw - ${DECK_X}*var(--bfs));--dy:${(boardY - xy[1]).toFixed(1)}cqh;`; // from the deck
        const deal = c => anim(`deal:${hid}:${i}:${c}`, 'deal', 450, (c * nP + k) * 130) + fromMid;
        const dealEnd = remaining(`deal:${hid}:${i}:1`, 450);
        const faces = (isMe ? mine.cards : null) || pl.hole; // pl.hole may hold just one card if they chose to show one
        if (pl.folded && !faces) {
          const m = anim(`muck:${hid}:${i}`, 'muck', 500);
          if (m) cards = [0, 1].map(() => `<span class="hc" style="${m}${fromMid}">${cardHtml(null)}</span>`).join('');
        } else if (faces) {
          const flip = anim(`face:${hid}:${i}`, 'flipin', 400, born.has(`face:${hid}:${i}`) ? 0 : dealEnd);
          cards = faces.map((c, j) => `<span class="hc">${flipCard(c, deal(j), flip, pl.folded && !pl.hole?.[j] ? 'dim' : '')}</span>`).join('');
          if (!pl.folded && faces.every(Boolean)) tag = winners ? [pl.handName, pl.handName2].filter(Boolean).join(' / ') || strength(faces, boardNow) : strength(faces, boardNow);
        } else cards = [0, 1].map(j => `<span class="hc" style="${deal(j)}">${cardHtml(null)}</span>`).join('');
      }
      const stack = pl ? pl.stack - (revealing ? pl.won : 0) : s.stack; // winnings arrive when the board is finished
      const eq = odds && pl && !pl.folded ? odds[s.profileId] : null;
      const myOuts = revealing && eq !== null && eq < 0.3 ? ro.stage.outs?.[s.profileId] : null;
      const allIn = pl && pl.allIn && !pl.folded && (isLive || revealing);
      const status = !pl ? (s.sittingOut ? 'away' : s.stack === 0 ? 'out of chips' : '') : pl.folded ? 'folded' : '';
      const say = lastAct && lastAct.seat === i && verb(lastAct) ? anim(`act:${hid}:${h.actions.length}`, 'bubble', 1400) : '';
      const badges = h && (isLive || h.street === 'done') ? [[h.button, 'd', 'D', 'Dealer'], [h.sb, 'sb', 'SB', 'Small blind'], [h.bb, 'bb', 'BB', 'Big blind']]
        .filter(([seat]) => seat === i).map(([, cls, label, title]) => `<span class="mk ${cls}" title="${title}" style="${anim(`mk:${hid}:${cls}`, 'pop', 300)}">${label}</span>`).join('') : '';
      html += `<div class="seat ${isMe ? 'me' : ''} ${xy[1] < CY - 4 ? 'top' : ''} ${turn ? 'turn' : ''} ${won ? 'winner' : ''} ${cards ? 'has-cards' : ''} ${(pl && pl.folded) || (!pl && isLive) || s.sittingOut ? 'out' : ''}" style="${seatAt(xy)}">
        ${say ? `<div class="bubble" style="${say}">${verb(lastAct)}${lastAct.allIn ? ' · all-in' : ''}</div>` : ''}
        <div class="hcards">${cards}${tag ? `<span class="hs">${esc(tag)}</span>` : ''}${eq !== null && eq !== undefined ? `<span class="eq ${eq >= 0.5 ? 'good' : 'bad'}" style="${anim(`eq:${hid}:${i}:${Math.round(eq * 100)}`, 'pop', 300)}">${Math.round(eq * 100)}%</span>` : ''}</div>
        ${myOuts?.length ? `<div class="outs"><b>${myOuts.length} out${myOuts.length > 1 ? 's' : ''}</b>${myOuts.slice(0, 14).map(c => cardHtml(c, 'tiny')).join('')}</div>` : ''}
        <div class="plate">
          <div class="front">${badges}${allIn ? `<span style="${anim(`allin:${hid}:${i}`, 'pop', 350)}">${ALLIN}</span>` : stack > 0 ? chips(stack, 4, 9, true) : ''}</div>
          <div class="who">${avatar(p, 22)}<div><div class="nm">${esc(p.name)}</div>
            <div class="stack">${allIn ? 'All In' : num(stack)}${won ? ` <span class="plus">+${num(pl.won)}</span>` : ''}${status ? ` <span class="st">${status}</span>` : ''}</div></div></div>
          ${turn ? '<div class="timer" data-timer></div>' : ''}
        </div></div>`;
      if (pl && pl.bet > 0 && isLive) {
        const b = portrait ? [50 + (xy[0] - 50) * 0.3, CY + (xy[1] - CY) * 0.6] : at(i, 0.55);
        html += `<div class="bet" style="${place(b)}${from(b, xy)}${anim(`bet:${hid}:${h.street}:${i}:${pl.bet}`, 'chipin', 380)}">${chips(pl.bet, 3, 5)}<b>${num(pl.bet)}</b></div>`;
      }
      if (won) { // the pot slides from the middle to the winner
        html += `<div class="winpile" style="${place(xy)}${from(xy, mid)}${anim(`win:${hid}:${i}`, 'winfly', 1300, 700) || 'opacity:0;'}">${chips(winners.get(s.profileId), 4, 6)}<b>+${num(pl.won)}</b></div>`;
      }
    });
    let msg = '';
    if (S.status === 'closed') msg = 'This table is closed.';
    else if (h?.awaiting) msg = 'All in! Once or twice? Hands are shown after everyone chooses.';
    else if (revealing) msg = ro.times === 2 ? `Running it twice · board ${ro.run + 1} of 2` : 'All in';
    else if (h && h.street === 'done') {
      const pots = h.results.pots.filter(p => p.contested || h.results.pots.length === 1);
      const line = (who, amount) => `${who.map(w => esc(prof(w).name)).join(' & ')} ${who.length > 1 ? 'split' : 'wins'} ${num(amount)}`;
      msg = pots.map(p => p.runs ? p.runs.map((r, i) => `Board ${i + 1}: ${line(r.winners, r.amount)}`).join(' · ') : line(p.winners, p.amount)).join(' · ');
    } else if (!isLive) msg = S.seats.filter(s => s && !s.sittingOut && s.stack > 0).length < 2 ? 'Waiting for players…' : S.handNo === 0 ? 'Ready when you are.' : 'Next hand starting…';
    // At showdown, light up the winning five cards and dim the rest.
    let winning = null;
    if (winners && h.results.endedBy === 'showdown' && !h.board2) {
      const top = h.players.filter(p => p.hole && p.won > 0 && winners.get(p.profileId) > 0);
      if (top.length) winning = new Set(top.flatMap(p => bestHand([...p.hole, ...h.board]).cards));
    }
    // The board: deck and burn pile on the left, then five fixed slots. Every card is dealt like at a real
    // table: burn one (deck -> burn pile), slide the card(s) face down to the board, turn over, and for the
    // flop spread the three out. Run it twice: cards that were already out sit in the middle, and each
    // remaining slot splits into a top card (first run) and a bottom card (second run).
    const T = { burn: 500, go: 600, gap: 200, move: 450, flipFlop: 1550, flipOne: 1150, flip: 500, spread: 2100 }; // real ms
    const twoRows = !!h?.runout && h.runout.times === 2, split = twoRows ? h.runout.from : 5;
    const rowCards = !h ? [[]] : ro ? h.runout.runs.map((r, ri) => r.board.slice(0, ro.started[ri] ? ro.lens[ri] : Math.min(ro.lens[ri], h.runout.from))) : [h.board];
    const burns = []; let burnt = 0;
    const cardAt = (ri, col, rowY) => {
      const c = rowCards[ri]?.[col]; if (!c) return '';
      const key = `board:${hid}:${ri}:${col}`, flop = col < 3, street = flop ? 0 : col - 2;
      sfx(key, 'card', T.go + (flop ? col * T.gap : 0));
      if (!flop || col === 0) { // one burn per street
        const bk = `burn:${hid}:${ri}:${street}`, fresh = !born.has(bk), ba = anim(bk, 'burn', T.burn, 0, true);
        if (ba) burns.push(`<span class="burncard" style="--by:${-(CH + GAP)}em;${ba}">${cardHtml(null)}</span>`); else burnt++;
        if (fresh && firstPaint) burnt = Math.max(burnt, 1);
      }
      const mv = `--dx:${-((flop ? 0 : col) * (CW + GAP) + CW + DGAP).toFixed(2)}em;--dy:${(-rowY).toFixed(2)}em;` + anim(`mv:${key}`, 'fromdeck', T.move, T.go + (flop ? col * T.gap : 0), true);
      const sp = flop && col ? `--sx:${(-col * (CW + GAP)).toFixed(2)}em;` + anim(`sp:${key}`, 'spread', T.move, T.spread, true) : '';
      const flip = anim(key, 'flipin', T.flip, flop ? T.flipFlop : T.flipOne, true);
      return `<span class="mv" style="${mv}"><span class="sp" style="${sp}">${flipCard(c, '', flip, winning && !winning.has(c) ? 'faded' : '')}</span></span>`;
    };
    let slots = '';
    for (let col = 0; col < 5; col++) {
      if (col < split) slots += `<div class="slot ${twoRows ? 'span' : ''}" style="grid-column:${col + 1}">${cardAt(0, col, 0)}</div>`;
      else for (const ri of [0, 1]) slots += `<div class="slot" style="grid-column:${col + 1};grid-row:${ri + 1}">${cardAt(ri, col, (ri ? 1 : -1) * (CH + GAP) / 2)}</div>`;
    }
    const board = `<div class="deckbox"><div class="slot discard">${burnt ? cardHtml(null) : ''}</div><div class="deck">${cardHtml(null)}</div>${burns.join('')}</div>
      <div class="slots ${twoRows ? 'two' : ''}">${slots}</div>`;
    const inMiddle = h && (isLive || revealing) ? h.pot - h.players.reduce((a, p) => a + (isLive ? p.bet : 0), 0) : 0;
    html += `<div class="center ${twoRows ? 'two' : ''} ${portrait ? 'portrait' : ''}" style="top:${boardY.toFixed(1)}%">
      ${h && (isLive || revealing) ? `<div class="pot" style="${anim(`pot:${hid}:${h.street}`, 'pulse', 350)}">${inMiddle > 0 ? chips(inMiddle, 4, 5) : ''}<span class="amt">${num(inMiddle)}</span>${inMiddle !== h.pot ? `<span class="total">total ${num(h.pot)}</span>` : ''}</div>` : ''}
      <div class="board">${board}</div><div class="msg">${msg}</div></div>`;
    stage.innerHTML = html;
    firstPaint = false;
    $('t-err').textContent = error;
    renderControls(seatIdx, isLive);
    renderLog(); renderFair();
    $('admin-btns').innerHTML = isAdmin && S.status === 'open' ? `<button class="ghost danger" data-close ${isLive ? 'disabled title="Wait for the hand to finish"' : ''}>End</button>` : '';
  }

  // What I can do right now, or null when it is not my turn.
  function myOptions() {
    const h = S.hand, seatIdx = mySeat(), pl = h && hp(me);
    if (!live() || seatIdx < 0 || h.toAct !== seatIdx || !pl) return null;
    const toCall = Math.min(h.currentBet - pl.bet, pl.stack), maxTo = pl.bet + pl.stack;
    const others = h.players.some(o => o.profileId !== me && !o.folded && !o.allIn);
    return { toCall, maxTo, minTo: Math.min(h.currentBet + h.minRaise, maxTo), canRaise: maxTo > h.currentBet && others, isBet: h.currentBet === 0, pot: h.pot, currentBet: h.currentBet };
  }

  // Controls, plus (once the hand is over) a card bottom right to show your hand to the table.
  function renderControls(seatIdx, isLive) {
    actionControls(seatIdx, isLive);
    const h = S.hand, pl = h && hp(me);
    if (S.status !== 'open' || !pl || !mine.cards || h.street !== 'done' || h.results.shown.includes(me) || (h.runout && !runoutView(h).done)) return;
    const up = j => !!pl.hole?.[j], label = c => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}`;
    $('controls').insertAdjacentHTML('afterbegin', `<div class="showbox">
      <button class="${up(0) && up(1) ? 'on' : ''}" data-show="0,1">${up(0) && up(1) ? 'CARDS SHOWN' : 'SHOW ALL CARDS'}</button>
      <div>${mine.cards.map((c, j) => `<button class="${up(j) ? 'on' : ''} ${'dh'.includes(c[1]) ? 'red' : ''}" data-show="${j}">${label(c)}</button>`).join('')}</div></div>`);
  }

  function actionControls(seatIdx, isLive) {
    const el = $('controls'), h = S.hand, seat = seatIdx >= 0 ? S.seats[seatIdx] : null, pl = h && hp(me);
    $('seat-btns').innerHTML = seat && S.status === 'open' ? (seat.sittingOut ? `<button class="ghost on" data-out="0">I'm back</button>` : `<button class="ghost" data-out="1">Away</button>`) + `<button class="ghost" data-act="leave">Leave</button>` : '';
    if (S.status === 'closed') { el.innerHTML = `<a href="#hands/${tableId}">Review and verify the hands from this session</a>`; return; }
    if (!me) { el.innerHTML = '<span class="muted">Your login is not linked to a player profile, so you can watch but not play.</span>'; return; }
    if (!seat) { el.innerHTML = '<span class="muted">Pick an empty seat to join.</span>'; return; }
    if (h?.runout && !runoutView(h).done) { el.innerHTML = '<span class="muted">All in. The board is being dealt…</span>'; return; }
    if (h?.awaiting) {
      const votes = h.awaiting.votes, mine = votes[me], inIt = pl && !pl.folded;
      const said = Object.entries(votes).map(([id, t]) => `${esc(prof(id).name)}: ${t === 2 ? 'twice' : 'once'}`).join(' · ');
      el.innerHTML = `<div class="turn-note">${inIt ? 'ALL IN · EVERYONE MUST AGREE TO RUN IT TWICE' : 'ALL IN'}</div>
        ${inIt ? `<div class="actions"><button class="act ${mine === 1 ? 'armed' : ''}" data-run="1">RUN IT ONCE</button><button class="act go ${mine === 2 ? 'armed' : ''}" data-run="2">RUN IT TWICE</button></div>` : ''}
        <span class="muted" style="align-self:flex-end">${said || 'Players are choosing…'}</span>`;
      return;
    }
    const o = myOptions();
    if (o) {
      if (preAction) { preAction = false; send('act', { type: o.toCall === 0 ? 'check' : 'fold' }); return; }
      const word = o.isBet ? 'BET' : 'RAISE';
      if (raiseOpen && o.canRaise) {
        if (raiseTo === null || raiseTo < o.minTo || raiseTo > o.maxTo) raiseTo = o.minTo;
        const presets = [[o.isBet ? 'MIN BET' : 'MIN RAISE', o.minTo], ['1/2 POT', o.currentBet + Math.round((o.pot + o.toCall) / 2)], ['3/4 POT', o.currentBet + Math.round((o.pot + o.toCall) * 0.75)], ['POT', o.currentBet + o.pot + o.toCall], ['ALL IN', o.maxTo]]
          .map(([l, v]) => [l, Math.max(o.minTo, Math.min(o.maxTo, v))]);
        const bb = S.config.bigBlind;
        el.innerHTML = `<div class="raise-ui">
          <div class="yourbet"><label for="raise-num">Your bet</label>
            <div class="betbox"><input type="number" id="raise-num" inputmode="numeric" min="${o.minTo}" max="${o.maxTo}" value="${raiseTo}"><span class="bbs" id="raise-bb">${+(raiseTo / bb).toFixed(1)}BB</span></div></div>
          <div class="sizing">
            <div class="presets">${presets.map(([l, v]) => `<button data-preset="${v}">${l}</button>`).join('')}</div>
            <div class="slide"><button data-step="-1" aria-label="Less">−</button><input type="range" id="raise-range" min="${o.minTo}" max="${o.maxTo}" step="1" value="${raiseTo}"><button data-step="1" aria-label="More">+</button></div>
          </div>
          <div class="confirm"><button class="back" data-back>BACK<kbd>ESC</kbd></button><button class="doraise" data-act="raise" id="raise-btn">${word}<kbd>↵</kbd></button></div>
        </div>`;
        return;
      }
      el.innerHTML = `<div class="turn-note">YOUR TURN</div><div class="actions">
        <button class="act go" data-act="call" ${o.toCall === 0 ? 'disabled' : ''}>CALL${o.toCall ? ' ' + num(o.toCall) : ''}<kbd>C</kbd></button>
        <button class="act go" data-raise-open ${o.canRaise ? '' : 'disabled'}>${word}<kbd>R</kbd></button>
        <button class="act go" data-act="check" ${o.toCall === 0 ? '' : 'disabled'}>CHECK<kbd>K</kbd></button>
        <button class="act stop" data-act="fold">FOLD<kbd>F</kbd></button></div>`;
      return;
    }
    if (seat.stack === 0 && !(isLive && pl && !pl.folded)) { el.innerHTML = `<div class="actions"><button class="act go" data-act="rebuy">REBUY ${num(S.config.startingStack)}</button></div>`; return; }
    if (!isLive && S.handNo === 0 && S.seats.filter(s => s && !s.sittingOut && s.stack > 0).length >= 2) { el.innerHTML = `<div class="actions"><button class="act go" data-act="start">DEAL FIRST HAND</button></div>`; return; }
    if (isLive && pl && !pl.folded && !pl.allIn) { // not my turn yet: queue a decision
      el.innerHTML = `<div class="actions"><button class="act ${preAction ? 'armed' : ''}" data-pre>CHECK OR FOLD</button>
        <button class="act go" disabled>${h.currentBet ? 'RAISE' : 'BET'}</button><button class="act go" disabled>CHECK</button><button class="act stop" disabled>FOLD</button></div>`;
      return;
    }
    el.innerHTML = `<span class="muted">${isLive ? 'Hand in progress…' : seat.sittingOut ? 'You are away. Press "I\'m back" to be dealt in.' : ''}</span>`;
  }

  function renderLog() {
    const h = S.hand;
    if (!h) { $('log').innerHTML = '<span class="muted">No hand yet.</span>'; return; }
    const verb = a => ({ 'small blind': `posts small blind ${a.chips}`, 'big blind': `posts big blind ${a.chips}`, fold: 'folds', check: 'checks', call: `calls ${num(a.chips)}`, bet: `bets ${num(a.to)}`, raise: `raises to ${num(a.to)}` }[a.type]);
    let street = '', out = `<div class="muted">Hand #${h.no}</div>`;
    for (const a of h.actions) {
      if (a.street !== street) { street = a.street; if (street !== 'preflop') out += `<div class="muted">— ${street} —</div>`; }
      out += `<div><b>${esc(prof(a.profileId).name)}</b> ${verb(a)}${a.allIn ? ' (all-in)' : ''}${a.auto ? ' <span class="muted">(timed out)</span>' : ''}</div>`;
    }
    if (h.results) for (const p of h.players.filter(p => p.hole)) out += `<div>${esc(prof(p.profileId).name)} shows ${cardsHtml(p.hole, 'small')} <span class="muted">${esc(p.handName || '')}</span></div>`;
    $('log').innerHTML = out; $('log').scrollTop = $('log').scrollHeight;
  }

  function renderFair() {
    const mineSeen = seen(tableId), h = S.hand, short = x => x ? `<code title="${x}">${x.slice(0, 16)}…</code>` : '–';
    const nextNo = S.handNo + 1;
    $('fairbox').innerHTML = `
      <div>Before each hand the server locks in its shuffle seed and shows its fingerprint here. Your browser then adds its own random seed. Neither side can steer the deck. <a href="#fair">How it works</a></div>
      ${h ? `<div style="margin-top:8px"><b>Hand #${h.no}</b> fingerprint: ${short(h.commitment)}</div>` : ''}
      ${S.nextCommitment ? `<div style="margin-top:4px"><b>Hand #${nextNo}</b> fingerprint: ${short(S.nextCommitment)}</div>
        <div>Seeds in: ${S.seedsIn.map(id => esc(prof(id).name)).join(', ') || 'none yet'}</div>
        <div>Your seed: ${mineSeen[nextNo]?.seed ? short(mineSeen[nextNo].seed) : '<span class="muted">not sent</span>'}</div>` : ''}
      <div style="margin-top:8px">${S.revealMode === 'hand' ? 'Seeds are revealed after every hand.' : 'Seeds are revealed when the session ends; then every hand can be re-checked.'} <a href="#hands/${tableId}">Verify hands</a></div>`;
  }

  // ----- stacks chart -----
  let chartBusy = false;
  async function loadChart() {
    if (chartBusy) return; chartBusy = true;
    try {
      const hands = await q(sb.from('game_hands').select('hand_no,record').eq('table_id', tableId).not('record', 'is', null).order('hand_no'));
      if (!dead && $('stack-chart')) $('stack-chart').innerHTML = stackChart(hands);
    } catch (e) {} finally { chartBusy = false; }
  }

  // ----- clicks -----
  const onClick = e => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.id === 'tv-info' || btn.id === 'drawer-close') { $('drawer').classList.toggle('hidden'); if (btn.id === 'tv-info') loadChart(); return; }
    if (btn.id === 'tv-sound') { btn.textContent = Sound.toggle() ? '🔇' : '🔊'; return; }
    if (btn.id === 'tv-full') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); return; }
    const d = btn.dataset;
    if (d.sit !== undefined) send('sit', { seat: +d.sit });
    else if (d.out !== undefined) send('sit_out', { out: d.out === '1' });
    else if (d.preset) { raiseTo = +d.preset; render(); }
    else if (d.raiseOpen !== undefined) { raiseOpen = true; raiseTo = null; render(); if (matchMedia('(pointer: fine)').matches) $('raise-num')?.select(); }
    else if (d.step) { const o = myOptions(); if (o) { raiseTo = Math.max(o.minTo, Math.min(o.maxTo, (raiseTo ?? o.minTo) + (+d.step) * S.config.bigBlind)); render(); } }
    else if (d.back !== undefined) { raiseOpen = false; render(); }
    else if (d.pre !== undefined) { preAction = !preAction; render(); }
    else if (d.run) send('runout', { times: +d.run });
    else if (d.show) { if (!btn.classList.contains('on')) send('show', { cards: d.show.split(',').map(Number) }); }
    else if (d.close !== undefined) { if (confirm('End the session? No more hands can be played at this table, all seeds are revealed, and a tournament table is saved to the tracker.')) send('close'); }
    else if (d.act === 'raise') { const o = myOptions(); raiseOpen = false; send('act', { type: 'raise', amount: o ? Math.max(o.minTo, Math.min(o.maxTo, raiseTo)) : raiseTo }); }
    else if (d.act === 'leave') { if (confirm('Leave the table? Your stack is kept if you come back this session.')) send('leave'); }
    else if (d.act === 'start' || d.act === 'rebuy') send(d.act);
    else if (d.act) send('act', { type: d.act });
  };
  const onInput = e => {
    if (e.target.id !== 'raise-range' && e.target.id !== 'raise-num') return;
    raiseTo = Math.floor(+e.target.value) || raiseTo;
    const other = $(e.target.id === 'raise-range' ? 'raise-num' : 'raise-range'); if (other) other.value = raiseTo;
    if ($('raise-bb')) $('raise-bb').textContent = `${+(raiseTo / S.config.bigBlind).toFixed(1)}BB`;
  };
  const onKey = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName), o = S && myOptions(), key = e.key.toLowerCase();
    if (!o) return;
    if (raiseOpen) {
      if (key === 'escape') { raiseOpen = false; render(); }
      else if (key === 'enter') { raiseOpen = false; send('act', { type: 'raise', amount: raiseTo }); }
      return;
    }
    if (typing) return;
    if (key === 'f') send('act', { type: 'fold' });
    else if (key === 'k' && o.toCall === 0) send('act', { type: 'check' });
    else if (key === 'c' && o.toCall > 0) send('act', { type: 'call' });
    else if (key === 'r' && o.canRaise) { raiseOpen = true; raiseTo = null; render(); }
  };
  document.addEventListener('keydown', onKey);
  view.addEventListener('click', onClick); view.addEventListener('input', onInput);

  // ----- housekeeping done by every seated browser -----
  const tick = setInterval(() => {
    if (!S || dead) return;
    const now = Date.now(), seatIdx = mySeat(), isLive = live();
    const t = view.querySelector('[data-timer]');
    if (t && S.deadline) t.style.transform = `scaleX(${Math.max(0, Math.min(1, (S.deadline - now) / (S.config.actionSeconds * 1000)))})`;
    if (S.deadline && isLive && S.hand.toAct === seatIdx && S.deadline - now < 8000 && S.deadline > now) sfx(`warn:${S.deadline}`, 'tick');
    if (seatIdx < 0 || busy || S.status !== 'open') return;
    const order = S.seats.map((s, i) => s && !s.sittingOut ? i : -1).filter(i => i >= 0).indexOf(seatIdx); // spreads out who calls first
    const lag = Math.max(0, order) * 900;
    if (isLive) {
      // Clock ran out: ask the server to act for the player (it checks the clock itself).
      if (S.deadline && now > S.deadline + 600 + lag && now - flags.timeoutTry > 3000) { flags.timeoutTry = now; send('timeout', {}, true); }
      return;
    }
    const seat = S.seats[seatIdx];
    if (seat.sittingOut || seat.stack === 0) return;
    // 1. Send this browser's random seed for the next hand, once its commitment is published.
    const nextNo = S.handNo + 1;
    if (S.nextCommitment && !S.seedsIn.includes(me) && flags.seedFor !== nextNo) {
      flags.seedFor = nextNo;
      const seed = F.randomSeed(16);
      remember(tableId, nextNo, { commitment: S.nextCommitment, seed });
      send('seed', { seed }, true);
      return;
    }
    // 2. Deal the next hand automatically (the first hand waits for someone to press the button).
    const ready = S.seats.filter(s => s && !s.sittingOut && s.stack > 0);
    if (S.handNo > 0 && ready.length >= 2 && S.nextHandAt) {
      const allSeeds = ready.every(s => S.seedsIn.includes(s.profileId));
      const due = S.nextHandAt + lag + (allSeeds ? 0 : 3000); // give slow browsers a moment to send their seed
      if (now > due && now - flags.startTry > 2500) { flags.startTry = now; send('start', {}, true); }
    }
  }, 300);

  const channel = sb.channel('table-' + tableId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_public', filter: `table_id=eq.${tableId}` }, p => setState(p.new.state, p.new.version))
    .subscribe();
  const poll = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 2500); // safety net if live updates drop
  const onResize = () => render();
  window.addEventListener('resize', onResize);
  cleanup = () => { dead = true; document.title = pageTitle; runTimers.forEach(clearTimeout); document.body.classList.remove('in-table'); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); clearInterval(tick); clearInterval(poll); sb.removeChannel(channel); view.removeEventListener('click', onClick); view.removeEventListener('input', onInput); };
  await refresh();
}

// ---------- charts ----------
function stackChart(hands) {
  if (!hands.length) return '<div class="muted">The chart fills in as hands are played.</div>';
  const series = {};
  hands.forEach(h => h.record.players.forEach(p => {
    const s = series[p.profileId] ||= [];
    if (!s.length) s.push({ x: h.hand_no - 1, y: p.startStack });
    s.push({ x: h.hand_no, y: p.endStack });
  }));
  const W = 860, H = 260, L = 50, R = 30, T = 14, B = 26;
  const maxX = hands.at(-1).hand_no, minX = Math.min(...Object.values(series).map(s => s[0].x));
  const maxY = Math.max(1, ...Object.values(series).flatMap(s => s.map(p => p.y)));
  const x = v => L + (v - minX) / Math.max(1, maxX - minX) * (W - L - R), y = v => T + (H - T - B) * (1 - v / maxY);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">`;
  for (let k = 0; k <= 4; k++) { const v = maxY * k / 4; svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${num(Math.round(v))}</text>`; }
  svg += `<text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">hand ${maxX}</text>`;
  for (const [id, pts] of Object.entries(series)) {
    const p = prof(id), last = pts.at(-1);
    svg += `<path d="${pts.map((pt, i) => (i ? 'L' : 'M') + x(pt.x) + ',' + y(pt.y)).join('')}" fill="none" stroke="${p.color}" stroke-width="2"/>
      <circle cx="${x(last.x)}" cy="${y(last.y)}" r="9" fill="${p.color}"><title>${esc(p.name)}: ${num(last.y)}</title></circle>
      <text x="${x(last.x)}" y="${y(last.y) + 3}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${esc(((p.first || '?')[0] + (p.last ? p.last[0] : '')).toUpperCase())}</text>`;
  }
  return svg + '</svg><div class="legend">' + Object.keys(series).map(id => `<span><i style="background:${prof(id).color}"></i>${esc(prof(id).name)}</span>`).join('') + '</div>';
}

// ---------- hand history ----------
async function myCardsFor(handIds) {
  if (!me || !handIds.length) return {};
  const rows = await q(sb.from('game_hole_cards').select('hand_id,cards').eq('profile_id', me).in('hand_id', handIds));
  return Object.fromEntries(rows.map(r => [r.hand_id, r.cards]));
}
async function handsView(tableId) {
  const [info, hands] = await Promise.all([
    q(sb.from('game_tables').select('*').eq('id', tableId).maybeSingle()),
    q(sb.from('game_hands').select('id,hand_no,record,server_seed,ended_at').eq('table_id', tableId).not('record', 'is', null).order('hand_no', { ascending: false }))
  ]);
  if (!info) throw new Error('No such table.');
  const cards = await myCardsFor(hands.map(h => h.id));
  const rows = hands.map(h => {
    const r = h.record, mine = r.players.find(p => p.profileId === me), pot = r.results.pots.reduce((a, p) => a + p.amount, 0);
    const winners = [...new Set(r.results.pots.flatMap(p => p.winners))];
    return `<tr class="click" data-go="#hand/${h.id}"><td>#${h.hand_no}</td><td>${cards[h.id] ? cardsHtml(cards[h.id], 'small') : '<span class="muted">–</span>'}</td>
      <td>${cardsHtml(r.board, 'small') || '<span class="muted">No flop</span>'}</td><td>${winners.map(w => esc(prof(w).name)).join(', ')}</td>
      <td class="num">${num(pot)}</td><td class="num ${mine?.net > 0 ? 'pos' : mine?.net < 0 ? 'neg' : ''}">${mine ? signed(mine.net) : '–'}</td>
      <td>${h.server_seed ? '<span class="pill ok">Can verify</span>' : '<span class="pill">Seed not revealed yet</span>'}</td></tr>`;
  });
  view.innerHTML = `<div class="card-box">
    <div class="row" style="justify-content:space-between"><h2>${esc(info.name)}: hand history</h2>
      <div class="row">${info.status === 'open' ? `<a href="#table/${tableId}">Back to the table</a>` : ''}<a href="#stats/${tableId}">Stats</a>
      ${hands.some(h => h.server_seed) ? '<button class="btn" id="verify-all">Verify all revealed hands</button>' : ''}</div></div>
    <div id="verify-all-out" class="note" style="margin:8px 0"></div>
    <div class="table-wrap"><table><thead><tr><th>Hand</th><th>Your cards</th><th>Board</th><th>Winner</th><th class="num">Pot</th><th class="num">Your result</th><th>Fairness</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="7" class="muted">No hands played yet.</td></tr>'}</tbody></table></div></div>`;
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => { location.hash = el.dataset.go; }));
  $('verify-all')?.addEventListener('click', async () => {
    const out = $('verify-all-out'); out.textContent = 'Checking…';
    const full = await q(sb.from('game_hands').select('*').eq('table_id', tableId).not('server_seed', 'is', null).order('hand_no'));
    const mineSeen = seen(tableId); let bad = [];
    for (const h of full) {
      const withMine = { ...h, record: { ...h.record, players: h.record.players.map(p => p.profileId === me && cards[h.id] ? { ...p, hole: cards[h.id] } : p) } };
      const checks = await F.verifyHand(withMine, mineSeen[h.hand_no]?.commitment);
      if (checks.some(c => !c.ok)) bad.push(h.hand_no);
    }
    out.innerHTML = bad.length ? `<b class="neg">Problem found in hand${bad.length > 1 ? 's' : ''} ${bad.join(', ')}.</b> Open the hand to see which check failed.`
      : `<b class="pos">All ${full.length} revealed hands check out.</b> Each seed matches its fingerprint and re-shuffling gives exactly the cards that were dealt.`;
  });
}

async function handView(handId) {
  const h = await q(sb.from('game_hands').select('*').eq('id', handId).maybeSingle());
  if (!h) throw new Error('No such hand.');
  const r = h.record, cards = await myCardsFor([handId]), mineSeen = seen(h.table_id)[h.hand_no];
  let all = null;
  if (h.deck) { const plan = F.dealPlan(r.dealOrder); all = Object.fromEntries(r.dealOrder.map(id => [id, plan.hole[id].map(i => h.deck[i])])); }
  const verb = a => ({ 'small blind': `posts small blind ${a.chips}`, 'big blind': `posts big blind ${a.chips}`, fold: 'folds', check: 'checks', call: `calls ${num(a.chips)}`, bet: `bets ${num(a.to)}`, raise: `raises to ${num(a.to)}` }[a.type]);
  let street = '', log = '';
  const boardAt = { flop: r.board.slice(0, 3), turn: r.board.slice(3, 4), river: r.board.slice(4, 5) };
  for (const a of r.actions) {
    if (a.street !== street) { street = a.street; log += `<h3>${street[0].toUpperCase() + street.slice(1)} ${street !== 'preflop' ? cardsHtml(boardAt[street], 'small') : ''}</h3>`; }
    log += `<div><b>${esc(prof(a.profileId).name)}</b> ${verb(a)}${a.allIn ? ' (all-in)' : ''}${a.auto ? ' <span class="muted">(timed out)</span>' : ''}</div>`;
  }
  const withMine = { ...h, record: { ...r, players: r.players.map(p => p.profileId === me && cards[handId] ? { ...p, hole: cards[handId] } : p) } };
  const checks = h.server_seed ? await F.verifyHand(withMine, mineSeen?.commitment) : null;
  const message = F.shuffleMessage({ tableId: h.table_id, handNo: h.hand_no, clientSeeds: h.client_seeds });
  view.innerHTML = `
    <div class="card-box"><div class="row" style="justify-content:space-between"><h2>Hand #${h.hand_no}</h2><a href="#hands/${h.table_id}">← All hands</a></div>
      <div style="margin-bottom:10px">${cardsHtml(r.board) || '<span class="muted">No flop</span>'}</div>
      ${r.board2 ? `<div style="margin-bottom:10px"><span class="note">Second board (run twice)</span><br>${cardsHtml(r.board2)}</div>` : ''}
      ${r.runout ? `<div class="note" style="margin-bottom:10px">All-in ${['before the flop', '', '', 'on the flop', 'on the turn'][r.runout.from]}, run ${r.runout.times === 2 ? 'twice' : 'once'}. Chance to win at that point: ${Object.entries(r.runout.runs[0].stages[0].equity).map(([id, e]) => `${esc(prof(id).name)} ${Math.round(e * 100)}%`).join(' · ')}</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Player</th><th>Cards</th><th>Hand</th><th class="num">Start</th><th class="num">Put in</th><th class="num">Won</th><th class="num">Result</th></tr></thead><tbody>
      ${r.players.map(p => {
        const shown = p.hole || (p.profileId === me ? cards[handId] : null);
        return `<tr><td>${who(p.profileId)}${r.button === p.seat ? ' <span class="pill">D</span>' : ''}</td>
          <td>${shown ? cardsHtml(shown, 'small') : all ? cardsHtml(all[p.profileId], 'small dim') + ' <span class="muted">(not shown)</span>' : '<span class="muted">not shown</span>'}</td>
          <td>${esc(p.handName || (p.folded ? 'Folded' : ''))}</td><td class="num">${num(p.startStack)}</td><td class="num">${num(p.put)}</td><td class="num">${num(p.won)}</td>
          <td class="num ${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${signed(p.net)}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${r.results.pots.length > 1 ? `<div class="note" style="margin-top:8px">Pots: ${r.results.pots.map((p, i) => `${i ? 'side' : 'main'} ${num(p.amount)} → ${p.winners.map(w => esc(prof(w).name)).join(' & ')}`).join(' · ')}</div>` : ''}
    </div>
    <div class="cols">
      <div class="card-box"><h2>Action</h2><div style="font-size:14px">${log}</div></div>
      <div class="card-box"><h2>Fairness check</h2>
        ${checks ? `<div class="note" style="margin-bottom:6px">Re-computed just now in your browser, not taken from the server's word.</div>` +
          checks.map(c => `<div class="check"><b class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</b><span>${esc(c.name.replace(/Hole cards of (\S+)/, (_, id) => `Hole cards of ${prof(id).name}`))}</span></div>`).join('') +
          (mineSeen?.commitment ? '' : '<div class="note" style="margin-top:6px">This device was not at the table for this hand, so it cannot confirm the fingerprint was published beforehand. A device that was there can.</div>')
          : `<div class="note">The server seed for this hand has not been revealed yet${mineSeen?.commitment ? ', but this device saved its fingerprint before the hand was dealt' : ''}. It is revealed when the session ends, and then this page re-checks everything.</div>`}
        <h3>The numbers</h3>
        <div class="note">Fingerprint (published before the hand)<br><code>${esc(h.commitment)}</code></div>
        ${mineSeen?.commitment ? `<div class="note" style="margin-top:6px">Fingerprint this device saw beforehand${mineSeen.late ? ' (joined mid-hand)' : ''}<br><code>${esc(mineSeen.commitment)}</code></div>` : ''}
        <div class="note" style="margin-top:6px">Server seed<br><code>${h.server_seed ? esc(h.server_seed) : 'not revealed yet'}</code></div>
        <div class="note" style="margin-top:6px">Player seeds<br>${Object.entries(h.client_seeds).map(([id, s]) => `${esc(prof(id).name)}: <code>${esc(s)}</code>`).join('<br>') || 'none'}</div>
        <div class="note" style="margin-top:6px">Shuffle input<br><code>${esc(message)}</code></div>
        ${h.deck ? `<div class="note" style="margin-top:6px">Full deck in dealt order<br><code>${h.deck.join(' ')}</code></div>` : ''}
        <div class="note" style="margin-top:8px"><a href="#fair">How to check this yourself</a></div>
      </div>
    </div>`;
}

// ---------- stats ----------
async function statsView(tableId) {
  const tables = await q(sb.from('game_tables').select('id,name,created_at').order('created_at', { ascending: false }));
  let query = sb.from('game_hands').select('table_id,hand_no,record').not('record', 'is', null).order('started_at');
  if (tableId) query = query.eq('table_id', tableId);
  const hands = await q(query);
  const st = {};
  for (const h of hands) for (const p of h.record.players) {
    const s = st[p.profileId] ||= { hands: 0, vpip: 0, pfr: 0, flop: 0, sd: 0, sdWon: 0, won: 0, net: 0, bb: 0, biggest: 0, allIns: 0, expected: 0, actual: 0 };
    const eq0 = h.record.runout?.runs[0].stages[0].equity[p.profileId];
    if (eq0 !== undefined) { // all-in with cards to come: compare the share of the pot they won with their chance at the time
      const shared = h.record.players.filter(x => h.record.runout.runs[0].stages[0].equity[x.profileId] !== undefined).reduce((a, x) => a + x.won, 0);
      s.allIns++; s.expected += eq0; s.actual += shared ? p.won / shared : 0;
    }
    const contested = h.record.results.pots.some(pot => pot.contested && pot.winners.includes(p.profileId)) || (h.record.results.endedBy === 'fold' && p.won > 0);
    s.hands++; s.vpip += p.vpip; s.pfr += p.pfr; s.flop += p.sawFlop; s.sd += p.showdown; s.sdWon += p.showdown && p.won > 0 && contested;
    s.won += contested; s.net += p.net; s.bb += p.net / h.record.blinds[1]; s.biggest = Math.max(s.biggest, p.net);
  }
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const rows = Object.entries(st).sort((a, b) => b[1].net - a[1].net).map(([id, s]) => `<tr><td>${who(id)}</td><td class="num">${s.hands}</td>
    <td class="num">${pct(s.won, s.hands)}</td><td class="num">${pct(s.vpip, s.hands)}</td><td class="num">${pct(s.pfr, s.hands)}</td><td class="num">${pct(s.flop, s.hands)}</td>
    <td class="num">${pct(s.sd, s.hands)}</td><td class="num">${pct(s.sdWon, s.sd)}</td>
    <td class="num">${s.allIns || '–'}</td><td class="num">${s.allIns ? pct(s.expected, s.allIns) : '–'}</td><td class="num">${s.allIns ? pct(s.actual, s.allIns) : '–'}</td>
    <td class="num ${s.actual - s.expected > 0.05 ? 'pos' : s.actual - s.expected < -0.05 ? 'neg' : ''}">${s.allIns ? (s.actual - s.expected > 0 ? '+' : '') + (s.actual - s.expected).toFixed(1) : '–'}</td><td class="num">${signed(s.biggest)}</td>
    <td class="num">${(s.bb / s.hands * 100).toFixed(0)}</td><td class="num ${s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : ''}"><b>${signed(s.net)}</b></td></tr>`);
  view.innerHTML = `<div class="card-box">
    <div class="row" style="justify-content:space-between"><h2>Player stats</h2>
      <select id="stats-table"><option value="">All tables</option>${tables.map(t => `<option value="${t.id}"${t.id === tableId ? ' selected' : ''}>${esc(t.name)} (${new Date(t.created_at).toLocaleDateString()})</option>`).join('')}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Hands</th><th class="num">Hands won</th><th class="num" title="Voluntarily put chips in before the flop">Played</th>
      <th class="num" title="Raised before the flop">Raised pre</th><th class="num">Saw flop</th><th class="num">Showdown</th><th class="num">Won at showdown</th><th class="num" title="All-ins with cards still to come">All-ins</th><th class="num" title="Average chance to win when the money went in">Expected</th><th class="num" title="Share of those pots actually won">Actual</th><th class="num" title="Pots won above or below what the odds predicted">Luck</th><th class="num">Biggest win</th><th class="num" title="Big blinds won per 100 hands">BB/100</th><th class="num">Net chips</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="15" class="muted">No hands played yet.</td></tr>'}</tbody></table></div>
    <p class="note">Played = hands where the player chose to put chips in before the flop. BB/100 = big blinds won per 100 hands, the usual way to compare results across different blind sizes. All-in columns count hands where everyone was all-in with cards still to come: Expected is the average chance to win when the money went in, Actual is the share of those pots really won, and Luck is the difference in pots (+1.0 = one whole pot more than the odds predicted).</p></div>
    ${tableId ? `<div class="card-box"><h2>Stacks over the session</h2>${stackChart(hands)}</div>` : ''}`;
  $('stats-table').addEventListener('change', e => { location.hash = '#stats' + (e.target.value ? '/' + e.target.value : ''); });
}

// ---------- fairness explainer ----------
function fairView() {
  view.innerHTML = `<div class="card-box" style="max-width:760px">
    <h2>Is the shuffle fair? How you can check</h2>
    <p>You should not have to trust anyone's word that the cards are random. Every hand leaves behind a proof you can re-check yourself.</p>
    <h3>What happens for every hand</h3>
    <ol>
      <li><b>The server locks in its seed.</b> Before the hand, the server picks a random 256-bit number (the server seed) and publishes its SHA-256 fingerprint. A fingerprint cannot be reversed, and the server cannot later swap the seed for another one with the same fingerprint. Your browser saves the fingerprint the moment it appears.</li>
      <li><b>Each player adds their own randomness.</b> After the fingerprint is out, every player's browser sends a random seed of its own. The server had already committed before seeing these.</li>
      <li><b>The deck is computed from all of it.</b> Server seed + every player's seed + table id + hand number go into a fixed, public formula (below) that produces the order of all 52 cards. Nothing else is used: no clock, no names, no stack sizes.</li>
      <li><b>The seed is revealed.</b> When the session ends (or after each hand, if the table is set that way), the server seed is published. Anyone can confirm it matches the fingerprint and re-run the shuffle to get exactly the cards that were dealt.</li>
    </ol>
    <h3>Why nobody can rig it</h3>
    <ul>
      <li><b>The server can't pick a good deck</b>, because it committed to its seed before knowing the players' seeds. Change any one player's seed and the whole deck changes.</li>
      <li><b>A player can't pick a good deck</b>, because they don't know the server seed until afterwards.</li>
      <li><b>Nobody can change cards mid-hand</b>, because the whole deck, including the cards still to come, is fixed by seeds that were locked in before the first card.</li>
      <li><b>The shuffle isn't lopsided.</b> It is a standard Fisher–Yates shuffle, and it throws away random numbers that would make one position slightly more likely than another. An automated test deals 20,000 decks and checks every card lands in every position equally often.</li>
    </ul>
    <h3>What this does not prove</h3>
    <p>The proof shows the deck was random and untouched. It cannot show that nobody peeked. Whoever administers the database could in principle read the deck of a hand in progress, the same way the host of a home game could peek at the deck. Players' browsers never receive anyone else's cards or the undealt deck. If the group ever wants to remove that last bit of trust, the next step is "mental poker", where the deck is encrypted by all players together.</p>
    <h3>The formula</h3>
<pre>fingerprint = SHA-256(server_seed)                       // published before the hand
input       = "table=&lt;id&gt;;hand=&lt;n&gt;;seeds=&lt;id&gt;=&lt;seed&gt;,…"  // player seeds sorted by player id
deck        = 2c 3c … Ac 2d … Ad 2h … Ah 2s … As          // always starts in this order
random(n):    take 4 bytes at a time from HMAC-SHA256(server_seed, input + ";block=0"), ";block=1", …
              as a number; if it is ≥ the largest multiple of n, skip it; otherwise use it mod n
for i = 51 down to 1:  j = random(i + 1);  swap deck[i], deck[j]
deal:         one card to each player starting left of the button, then a second card each,
              then burn, flop (3), burn, turn, burn, river</pre>
    <p class="note">Open any finished hand and its page shows all of these values and re-runs the checks in your browser. The code is in <code>supabase/functions/_shared/fair.js</code>; it is the same file the server uses to deal. <code>node scripts/verify-hand.mjs</code> checks a hand outside the app entirely.</p>
  </div>`;
}

// ---------- start ----------
(async () => {
  $('env-pill').textContent = CFG.env === 'local' ? 'local test' : '';
  $('env-pill').classList.toggle('hidden', CFG.env !== 'local');
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_e, s) => { session = s; });
  if (!session) { view.innerHTML = '<div class="card-box">Please <a href="index.html">sign in on the tracker</a> first, then come back.</div>'; return; }
  const access = await q(sb.rpc('my_access'));
  if (access.role === 'none') { view.innerHTML = '<div class="card-box">Your account is not linked to a player yet. Ask the organizer to add your email to your profile.</div>'; return; }
  me = access.profile_id; isAdmin = access.role === 'admin';
  profiles = Object.fromEntries((await q(sb.from('poker_profiles').select('id,first,last,display,avatar'))).map(p => [p.id, p]));
  $('whoami').innerHTML = `${me ? who(me) : esc(session.user.email)}${isAdmin ? ' <span class="pill ok">Admin</span>' : ''}`;
  route();
})();
