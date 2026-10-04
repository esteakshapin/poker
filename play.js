// Online poker client. All rules and the shuffle live on the server (supabase/functions/game);
// this file only shows the table, sends your actions, and lets you verify hands in your own browser.
import * as F from './supabase/functions/_shared/fair.js';

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
  const flags = { seedFor: 0, startTry: 0, timeoutTry: 0, firstHandAsked: false };

  document.body.classList.add('in-table');
  view.innerHTML = `<div class="tv">
    <div class="tv-top">
      <a href="#lobby">‹ Tables</a>
      <div class="tv-title"><b>${esc(info.name)}</b><span>Blinds ${info.config.smallBlind}/${info.config.bigBlind} · ${info.tournament_id ? 'tournament table' : 'practice chips'}</span></div>
      <span id="admin-btns"></span>
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
      mine = { handId: S.hand.id, cards: null }; raiseTo = null;
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
  const born = new Map();
  let firstPaint = true, bornHand = null;
  function anim(key, name, dur, delay = 0) {
    const now = performance.now();
    if (!born.has(key)) born.set(key, { t: firstPaint ? -1e9 : now, delay }); // things already on the table when you arrive don't animate
    const b = born.get(key), elapsed = now - b.t;
    if (elapsed > b.delay + dur) return '';
    return `animation:${name} ${dur}ms cubic-bezier(.2,.8,.3,1) ${Math.round(b.delay - elapsed)}ms both;`;
  }
  const remaining = (key, dur) => { const b = born.get(key); return b ? Math.max(0, b.t + b.delay + dur - performance.now()) : 0; };

  const DENOMS = [[1000, '#e0b84a'], [500, '#7b4bb3'], [100, '#262626'], [25, '#2e8b57'], [5, '#c0392b'], [1, '#f1f1f1']];
  function chips(amount) {
    let rest = amount; const cols = [];
    for (const [d, color] of DENOMS) { const k = Math.floor(rest / d); if (k > 0) { cols.push(`<span class="chipcol">${`<i style="--c:${color}"></i>`.repeat(Math.min(k, 6))}</span>`); rest -= k * d; } }
    return `<span class="chips">${cols.slice(0, 4).join('')}</span>`;
  }
  // A card that can flip: back while `style` holds it rotated, face when done.
  const flipCard = (c, outer, inner, cls = '') => `<span class="pc3d" style="${outer}"><span class="in" style="${inner}">${cardHtml(c, cls)}<span class="pc back"></span></span></span>`;

  // ----- drawing -----
  function render() {
    if (!S || dead) return;
    const n = S.seats.length, seatIdx = mySeat(), rot = seatIdx >= 0 ? seatIdx : 0;
    const h = S.hand, isLive = live(), stage = $('felt'), hid = h?.id;
    if (hid !== bornHand) { born.clear(); bornHand = hid; }
    const portrait = stage.clientHeight > stage.clientWidth * 1.05;
    const RX = portrait ? 37 : 41, RY = portrait ? 39 : 35, CY = portrait ? 47 : 46;
    const at = (i, r = 1, da = 0) => { const a = Math.PI / 2 + ((i - rot + n) % n) * 2 * Math.PI / n + da; return [50 + Math.cos(a) * RX * r, CY + Math.sin(a) * RY * r]; };
    const place = ([x, y]) => `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;`;
    const from = ([x, y], [fx, fy]) => `--dx:${(fx - x).toFixed(1)}cqw;--dy:${(fy - y).toFixed(1)}cqh;`; // offset to where it starts
    const mid = [50, CY];
    const verb = a => ({ fold: 'Fold', check: 'Check', call: `Call ${num(a.chips)}`, bet: `Bet ${num(a.to)}`, raise: `Raise ${num(a.to)}`, 'small blind': '', 'big blind': '' }[a.type]);
    const lastAct = h?.actions.at(-1), nP = h?.players.length || 0;
    const winners = h?.results ? new Map() : null;
    if (winners) for (const pot of h.results.pots) for (const w of pot.winners) winners.set(w, (winners.get(w) || 0) + Math.floor(pot.amount / pot.winners.length));

    let html = `<div class="felt ${portrait ? 'portrait' : ''}"></div>`;
    S.seats.forEach((s, i) => {
      const xy = at(i);
      if (!s) {
        html += `<div class="seat empty" style="${place(xy)}">${seatIdx < 0 && S.status === 'open' && me ? `<button data-sit="${i}">Sit</button>` : '<span>·</span>'}</div>`;
        return;
      }
      const p = prof(s.profileId), k = h ? h.players.findIndex(x => x.profileId === s.profileId) : -1, pl = k >= 0 ? h.players[k] : null;
      const isMe = s.profileId === me, turn = isLive && h.toAct === i, won = winners?.get(s.profileId) > 0 && pl.won > 0;
      let cards = '';
      if (pl) {
        const fromMid = from(xy, mid);
        const deal = c => anim(`deal:${hid}:${i}:${c}`, 'deal', 420, (c * nP + k) * 110) + fromMid;
        const dealEnd = remaining(`deal:${hid}:${i}:1`, 420);
        const faces = pl.hole || (isMe ? mine.cards : null);
        if (pl.folded && !(isMe && faces)) {
          const m = anim(`muck:${hid}:${i}`, 'muck', 450);
          if (m) cards = [0, 1].map(() => `<span style="${m}${fromMid}">${cardHtml(null)}</span>`).join('');
        } else if (faces) {
          const flip = anim(`face:${hid}:${i}`, 'flipin', 380, born.has(`face:${hid}:${i}`) ? 0 : dealEnd);
          cards = faces.map((c, j) => flipCard(c, deal(j), flip, pl.folded ? 'dim' : '')).join('');
        } else cards = [0, 1].map(j => `<span style="${deal(j)}">${cardHtml(null)}</span>`).join('');
      }
      const status = !pl ? (s.sittingOut ? 'Sitting out' : s.stack === 0 ? 'Out of chips' : '')
        : pl.folded ? 'Folded' : pl.allIn ? 'All-in' : h.street === 'done' && pl.won > 0 ? `+${num(pl.won)}` : (pl.handName || '');
      const bubble = lastAct && lastAct.seat === i && verb(lastAct) ? anim(`act:${hid}:${h.actions.length}`, 'bubble', 1700) : '';
      html += `<div class="seat ${isMe ? 'me' : ''} ${turn ? 'turn' : ''} ${won ? 'winner' : ''} ${(pl && pl.folded) || (!pl && isLive) || s.sittingOut ? 'out' : ''}" style="${place(xy)}">
        <div class="cards">${cards}</div>
        ${bubble ? `<div class="bubble" style="${bubble}">${verb(lastAct)}${lastAct.allIn ? ' · all-in' : ''}</div>` : ''}
        <div class="plate"><span class="ava">${avatar(p, 30)}</span>
          <div class="nm">${esc(p.name)}</div>
          <div class="stack">${num(pl ? pl.stack : s.stack)}</div>
          <div class="status">${status}</div>
          ${turn ? '<div class="timer" data-timer></div>' : ''}
        </div></div>`;
      if (pl && pl.bet > 0 && isLive) {
        const b = at(i, 0.6);
        html += `<div class="bet" style="${place(b)}${from(b, xy)}${anim(`bet:${hid}:${h.street}:${i}:${pl.bet}`, 'chipin', 320)}">${chips(pl.bet)}<b>${num(pl.bet)}</b></div>`;
      }
      if (won) { // the pot slides from the middle to the winner
        html += `<div class="winpile" style="${place(xy)}${from(xy, mid)}${anim(`win:${hid}:${i}`, 'winfly', 1300, 600) || 'opacity:0;'}">${chips(winners.get(s.profileId))}<b>+${num(pl.won)}</b></div>`;
      }
    });
    // dealer and blind buttons
    if (h) {
      const mk = (cls, label, seat, da) => `<div class="mk ${cls}" style="${place(at(seat, 0.72, da))}${anim(`mk:${hid}:${cls}`, 'pop', 350)}" title="${label}">${cls === 'd' ? 'D' : cls.toUpperCase()}</div>`;
      html += mk("d", "Dealer", h.button, 0.28);
      if (S.seats[h.sb]) html += mk("sb", "Small blind", h.sb, -0.28);
      if (S.seats[h.bb]) html += mk("bb", "Big blind", h.bb, -0.28);
    }
    let msg = '';
    if (S.status === 'closed') msg = 'This table is closed.';
    else if (h && h.street === 'done') {
      const pots = h.results.pots.filter(p => p.contested || h.results.pots.length === 1);
      msg = pots.map(p => `${p.winners.map(w => esc(prof(w).name)).join(' & ')} ${p.winners.length > 1 ? 'split' : 'wins'} ${num(p.amount)}`).join(' · ');
    } else if (!isLive) msg = S.seats.filter(s => s && !s.sittingOut && s.stack > 0).length < 2 ? 'Waiting for players…' : S.handNo === 0 ? 'Ready when you are.' : 'Next hand starting…';
    let board = '';
    if (h) {
      const known = h.board.filter((_, i) => born.has(`board:${hid}:${i}`)).length;
      board = h.board.map((c, i) => flipCard(c, '', anim(`board:${hid}:${i}`, 'flipin', 420, Math.max(0, i - known) * 140))).join('');
    }
    const inMiddle = h && isLive ? h.pot - h.players.reduce((a, p) => a + p.bet, 0) : 0;
    html += `<div class="center" style="top:${CY}%"><div class="board">${board}</div>
      ${h && isLive ? `<div class="pot" style="${anim(`pot:${hid}:${h.street}`, 'pulse', 400)}">${inMiddle > 0 ? chips(inMiddle) : ''}<span>Pot ${num(h.pot)}</span></div>` : ''}
      <div class="msg">${msg}</div></div>`;
    stage.innerHTML = html;
    firstPaint = false;
    $('t-err').textContent = error;
    renderControls(seatIdx, isLive);
    renderLog(); renderFair();
    $('admin-btns').innerHTML = isAdmin && S.status === 'open' ? `<button class="ghost danger" data-close ${isLive ? 'disabled title="Wait for the hand to finish"' : ''}>End</button>` : '';
  }

  function renderControls(seatIdx, isLive) {
    const el = $('controls'), h = S.hand;
    if (S.status === 'closed') { el.innerHTML = `<a href="#hands/${tableId}">Review and verify the hands from this session</a>`; return; }
    if (!me) { el.innerHTML = '<span class="muted">Your login is not linked to a player profile, so you can watch but not play.</span>'; return; }
    if (seatIdx < 0) { el.innerHTML = '<span class="muted">Pick an empty seat to join.</span>'; return; }
    const seat = S.seats[seatIdx], pl = h && hp(me);
    const side = `<button class="ghost" data-act="leave">Leave</button>` + (seat.sittingOut
      ? `<button class="btn" data-out="0">I'm back</button>` : `<button class="ghost" data-out="1">Sit out</button>`);
    if (isLive && h.toAct === seatIdx && pl) {
      const toCall = Math.min(h.currentBet - pl.bet, pl.stack), maxTo = pl.bet + pl.stack;
      const others = h.players.some(o => o.profileId !== me && !o.folded && !o.allIn);
      const canRaise = maxTo > h.currentBet && others;
      const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
      if (raiseTo === null || raiseTo < minTo || raiseTo > maxTo) raiseTo = minTo;
      const presets = [['Min', minTo], ['½ pot', h.currentBet + Math.round((h.pot + toCall) / 2)], ['Pot', h.currentBet + h.pot + toCall], ['All-in', maxTo]]
        .map(([l, v]) => [l, Math.max(minTo, Math.min(maxTo, v))]);
      el.innerHTML = `${canRaise ? `<div class="raise-row">${presets.map(([l, v]) => `<button class="ghost" data-preset="${v}">${l}</button>`).join('')}
          <input type="range" id="raise-range" min="${minTo}" max="${maxTo}" value="${raiseTo}">
          <input type="number" id="raise-num" min="${minTo}" max="${maxTo}" value="${raiseTo}"></div>` : ''}
        <button class="fold" data-act="fold">Fold</button>
        ${toCall === 0 ? '<button class="btn" data-act="check">Check</button>' : `<button class="btn" data-act="call">Call ${num(toCall)}</button>`}
        ${canRaise ? `<button class="btn raise" data-act="raise" id="raise-btn">${h.currentBet === 0 ? 'Bet' : 'Raise to'} ${num(raiseTo)}</button>` : ''}`;
      return;
    }
    if (seat.stack === 0 && !(isLive && pl && !pl.folded)) { el.innerHTML = `<button class="btn" data-act="rebuy">Rebuy ${num(S.config.startingStack)} chips</button>${side}`; return; }
    if (!isLive && S.handNo === 0 && S.seats.filter(s => s && !s.sittingOut && s.stack > 0).length >= 2) { el.innerHTML = `<button class="btn" data-act="start">Deal the first hand</button>${side}`; return; }
    el.innerHTML = `<span class="muted">${isLive ? (pl && !pl.folded ? `Waiting for ${esc(prof(S.seats[h.toAct]?.profileId).name)}…` : 'Hand in progress…') : ''}</span>${side}`;
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
    if (btn.id === 'tv-full') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); return; }
    const d = btn.dataset;
    if (d.sit !== undefined) send('sit', { seat: +d.sit });
    else if (d.out !== undefined) send('sit_out', { out: d.out === '1' });
    else if (d.preset) { raiseTo = +d.preset; render(); }
    else if (d.close !== undefined) { if (confirm('End the session? No more hands can be played at this table, all seeds are revealed, and a tournament table is saved to the tracker.')) send('close'); }
    else if (d.act === 'raise') send('act', { type: 'raise', amount: raiseTo });
    else if (d.act === 'leave') { if (confirm('Leave the table? Your stack is kept if you come back this session.')) send('leave'); }
    else if (d.act === 'start' || d.act === 'rebuy') send(d.act);
    else if (d.act) send('act', { type: d.act });
  };
  const onInput = e => {
    if (e.target.id !== 'raise-range' && e.target.id !== 'raise-num') return;
    raiseTo = Math.floor(+e.target.value) || raiseTo;
    const other = $(e.target.id === 'raise-range' ? 'raise-num' : 'raise-range'); if (other) other.value = raiseTo;
    if ($('raise-btn')) $('raise-btn').textContent = `${S.hand.currentBet === 0 ? 'Bet' : 'Raise to'} ${num(raiseTo)}`;
  };
  view.addEventListener('click', onClick); view.addEventListener('input', onInput);

  // ----- housekeeping done by every seated browser -----
  const tick = setInterval(() => {
    if (!S || dead) return;
    const now = Date.now(), seatIdx = mySeat(), isLive = live();
    const t = view.querySelector('[data-timer]');
    if (t && S.deadline) t.style.transform = `scaleX(${Math.max(0, Math.min(1, (S.deadline - now) / (S.config.actionSeconds * 1000)))})`;
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
  cleanup = () => { dead = true; document.body.classList.remove('in-table'); window.removeEventListener('resize', onResize); clearInterval(tick); clearInterval(poll); sb.removeChannel(channel); view.removeEventListener('click', onClick); view.removeEventListener('input', onInput); };
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
    const s = st[p.profileId] ||= { hands: 0, vpip: 0, pfr: 0, flop: 0, sd: 0, sdWon: 0, won: 0, net: 0, bb: 0, biggest: 0 };
    const contested = h.record.results.pots.some(pot => pot.contested && pot.winners.includes(p.profileId)) || (h.record.results.endedBy === 'fold' && p.won > 0);
    s.hands++; s.vpip += p.vpip; s.pfr += p.pfr; s.flop += p.sawFlop; s.sd += p.showdown; s.sdWon += p.showdown && p.won > 0 && contested;
    s.won += contested; s.net += p.net; s.bb += p.net / h.record.blinds[1]; s.biggest = Math.max(s.biggest, p.net);
  }
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const rows = Object.entries(st).sort((a, b) => b[1].net - a[1].net).map(([id, s]) => `<tr><td>${who(id)}</td><td class="num">${s.hands}</td>
    <td class="num">${pct(s.won, s.hands)}</td><td class="num">${pct(s.vpip, s.hands)}</td><td class="num">${pct(s.pfr, s.hands)}</td><td class="num">${pct(s.flop, s.hands)}</td>
    <td class="num">${pct(s.sd, s.hands)}</td><td class="num">${pct(s.sdWon, s.sd)}</td><td class="num">${signed(s.biggest)}</td>
    <td class="num">${(s.bb / s.hands * 100).toFixed(0)}</td><td class="num ${s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : ''}"><b>${signed(s.net)}</b></td></tr>`);
  view.innerHTML = `<div class="card-box">
    <div class="row" style="justify-content:space-between"><h2>Player stats</h2>
      <select id="stats-table"><option value="">All tables</option>${tables.map(t => `<option value="${t.id}"${t.id === tableId ? ' selected' : ''}>${esc(t.name)} (${new Date(t.created_at).toLocaleDateString()})</option>`).join('')}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Hands</th><th class="num">Hands won</th><th class="num" title="Voluntarily put chips in before the flop">Played</th>
      <th class="num" title="Raised before the flop">Raised pre</th><th class="num">Saw flop</th><th class="num">Showdown</th><th class="num">Won at showdown</th><th class="num">Biggest win</th><th class="num" title="Big blinds won per 100 hands">BB/100</th><th class="num">Net chips</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="11" class="muted">No hands played yet.</td></tr>'}</tbody></table></div>
    <p class="note">Played = hands where the player chose to put chips in before the flop. BB/100 = big blinds won per 100 hands, the usual way to compare results across different blind sizes.</p></div>
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
