import crypto from 'crypto';
import { Table } from './table.js';
import { User } from '../models.js';
import * as wallet from '../wallet.js';

// Runs every poker table: the permanent cash tables and the Sit & Go tournaments.
// It is the only place where chips cross between a wallet and a table.

export const CASH_STAKES = [[1, 2], [2, 4], [5, 10]];
export const MIN_BUYIN_BB = 40;
export const MAX_BUYIN_BB = 200;
const TABLES_PER_STAKE = 2;
const SIT_OUT_LIMIT_MS = 5 * 60 * 1000; // a sitting-out player keeps a cash seat this long
const OFFLINE_LIMIT_MS = 60 * 1000; // a disconnected cash player is stood up after this long

export const SNG_BUYINS = [100, 250, 500, 1000];
export const SNG_SIZES = [2, 6];
const SNG_STACK = 1500;
const SNG_LEVEL_MS = Number(process.env.POKER_LEVEL_MS) || 5 * 60 * 1000;
// Small steps, so there is time to play.
const SNG_LEVELS = [
  [10, 20], [15, 30], [20, 40], [25, 50], [30, 60], [40, 80], [50, 100], [60, 120],
  [75, 150], [100, 200], [125, 250], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000],
];
// Share of the prize pool by finishing place.
const SNG_PRIZES = { 2: [1], 6: [0.65, 0.35] };
const prizesFor = (buyIn, size) => SNG_PRIZES[size].map((share) => Math.floor(buyIn * size * share));

export function createManager(io) {
  const tables = new Map(); // table id -> Table (cash tables and running tournaments)
  const sngs = new Map(); // tournament id -> tournament
  const where = new Map(); // user id -> { type: 'cash' | 'sng', id }: the one game a player is in
  const online = new Map(); // user id -> Set of socket ids
  const offlineTimers = new Map();

  const room = (uid) => `user:${uid}`;
  const watchRoom = (id) => `watch:${id}`;

  // ---- telling people what changed ----

  async function emitMe(uid) {
    const user = await User.findById(uid);
    if (user) io.to(room(uid)).emit('me', selfView(user));
  }

  function emitTable(table) {
    for (const p of table.seated) io.to(room(p.uid)).emit('table:state', table.publicState(p.uid));
    io.to(watchRoom(table.id)).emit('table:state', table.publicState(null));
    scheduleLobby();
  }

  let lobbyTimer = null;
  function scheduleLobby() {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      io.emit('lobby:state', lobbyState());
    }, 300);
  }

  function lobbyState() {
    const cash = [...tables.values()].filter((t) => t.kind === 'cash').map((t) => ({
      id: t.id,
      name: t.name,
      blinds: [t.sb, t.bb],
      minBuyIn: t.bb * MIN_BUYIN_BB,
      maxBuyIn: t.bb * MAX_BUYIN_BB,
      maxSeats: t.maxSeats,
      players: t.seated.map((p) => ({ name: p.name, stack: p.stack })),
      ids: t.seated.map((p) => p.uid),
      playing: t.phase === 'hand' || t.phase === 'between',
      pot: t.publicState(null).pot,
      watchers: t.watchers,
    }));
    const sng = [...sngs.values()].map((s) => ({
      id: s.id,
      buyIn: s.buyIn,
      size: s.size,
      status: s.status,
      prizes: prizesFor(s.buyIn, s.size),
      registered: s.players.map((p) => p.name),
      ids: s.players.map((p) => p.uid),
      left: s.table ? s.table.seated.length : null,
      blinds: s.table ? [s.table.sb, s.table.bb] : SNG_LEVELS[0],
      tableId: s.table?.id || null,
    }));
    return { cash, sng, online: online.size, stack: SNG_STACK, levelMinutes: Math.round(SNG_LEVEL_MS / 60000) };
  }

  const fail = (error) => ({ ok: false, error });
  const playerInfo = (user) => ({ uid: user._id.toString(), name: user.name, picture: user.picture || '' });

  function watch(socket, tableId) {
    unwatch(socket);
    const table = tables.get(tableId);
    if (!table) return fail('That table is no longer running');
    const uid = socket.data.uid;
    // A seated player follows their own table only.
    const at = where.get(uid);
    if (at && at.id !== tableId && tables.get(at.id)?.seatOf(uid)) return fail('Leave your table before opening another one');
    socket.data.watching = tableId;
    if (table.seatOf(uid)) {
      socket.emit('table:state', table.publicState(uid));
    } else {
      socket.join(watchRoom(tableId));
      table.watchers += 1;
      socket.emit('table:state', table.publicState(null));
      scheduleLobby();
    }
    return { ok: true };
  }

  function unwatch(socket) {
    const id = socket.data.watching;
    if (!id) return;
    socket.data.watching = null;
    if (socket.rooms.has(watchRoom(id))) {
      socket.leave(watchRoom(id));
      const table = tables.get(id);
      if (table) table.watchers = Math.max(0, table.watchers - 1);
      scheduleLobby();
    }
  }

  // A seated player gets their own private view of their table, and stops spectating any other.
  function stopWatchingAsPlayer(uid, tableId) {
    for (const sid of online.get(uid) || []) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      unwatch(s);
      s.data.watching = tableId;
    }
  }

  // Someone who has just left a seat carries on watching the table.
  function keepWatching(uid, tableId) {
    const table = tables.get(tableId);
    for (const sid of online.get(uid) || []) {
      const s = io.sockets.sockets.get(sid);
      if (!s || s.data.watching !== tableId || !table) continue;
      if (!s.rooms.has(watchRoom(tableId))) {
        s.join(watchRoom(tableId));
        table.watchers += 1;
      }
      s.emit('table:state', table.publicState(null));
    }
  }

  // ---- cash games ----

  function makeCashTable(sb, bb, letter) {
    const id = `cash-${sb}-${bb}-${letter.toLowerCase()}`;
    const table = new Table({
      id,
      name: `${sb}/${bb} Table ${letter}`,
      kind: 'cash',
      blinds: [sb, bb],
      onChange: emitTable,
      hooks: {
        info: () => ({ minBuyIn: bb * MIN_BUYIN_BB, maxBuyIn: bb * MAX_BUYIN_BB }),
        onHandEnd: (t) => {
          for (const p of [...t.seated]) {
            if (p.stack === 0 && p.pendingTopUp === 0) {
              // Out of chips: the seat is freed and they can buy in again.
              standUp(p.uid, 'You are out of chips. Take a seat again to buy back in.');
            } else if (p.sittingOut && Date.now() - p.sitOutSince > SIT_OUT_LIMIT_MS) {
              standUp(p.uid, 'You were sitting out too long, so your seat was released.');
            } else {
              wallet.saveTableStack(p.uid, t.id, p.stack + p.pendingTopUp).catch(() => {});
            }
          }
        },
      },
    });
    tables.set(id, table);
  }
  for (const [sb, bb] of CASH_STAKES) {
    for (let i = 0; i < TABLES_PER_STAKE; i++) makeCashTable(sb, bb, 'ABCDEFGH'[i]);
  }

  async function cashSit(uid, { tableId, seat, amount }) {
    const table = tables.get(tableId);
    if (!table || table.kind !== 'cash') return fail('Table not found');
    if (where.has(uid)) return fail('You are already in a game. Leave it first.');
    amount = Math.floor(Number(amount));
    seat = Math.floor(Number(seat));
    const min = table.bb * MIN_BUYIN_BB;
    const max = table.bb * MAX_BUYIN_BB;
    if (!(amount >= min && amount <= max)) return fail(`Buy-in must be between ${min} and ${max}`);
    if (!(seat >= 0 && seat < table.maxSeats) || table.seats[seat]) return fail('That seat is taken');
    where.set(uid, { type: 'cash', id: tableId }); // claim first, so two quick clicks cannot buy in twice
    const user = await wallet.toTable(uid, tableId, amount, 'cash_buyin');
    if (!user) {
      where.delete(uid);
      return fail('Not enough balance in your wallet');
    }
    if (!table.addPlayer(playerInfo(user), seat, amount)) {
      // Someone took the seat in the meantime: give the money straight back.
      await wallet.fromTable(uid, tableId, amount, 'cash_cashout');
      where.delete(uid);
      emitMe(uid);
      return fail('That seat was just taken');
    }
    stopWatchingAsPlayer(uid, tableId);
    io.to(room(uid)).emit('table:state', table.publicState(uid));
    emitMe(uid);
    return { ok: true };
  }

  // Take a cash player off their table and pay their chips back into the wallet.
  async function standUp(uid, message) {
    const at = where.get(uid);
    if (!at || at.type !== 'cash') return fail('You are not seated');
    const table = tables.get(at.id);
    where.delete(uid);
    const stack = table ? table.removePlayer(uid) : 0;
    await wallet.fromTable(uid, at.id, stack, 'cash_cashout');
    if (message) io.to(room(uid)).emit('notice', message);
    keepWatching(uid, at.id);
    emitMe(uid);
    scheduleLobby();
    return { ok: true, cashedOut: stack };
  }

  async function cashTopUp(uid, { amount }) {
    const at = where.get(uid);
    const table = at?.type === 'cash' ? tables.get(at.id) : null;
    const p = table?.seatOf(uid);
    if (!p) return fail('You are not seated at a cash table');
    amount = Math.floor(Number(amount));
    const space = table.bb * MAX_BUYIN_BB - (p.stack + p.pendingTopUp);
    if (!(amount > 0)) return fail('Enter an amount');
    if (amount > space) return fail(space > 0 ? `You can add at most ${space} more` : 'You already have the maximum for this table');
    const user = await wallet.toTable(uid, table.id, amount, 'cash_buyin');
    if (!user) return fail('Not enough balance in your wallet');
    table.topUp(uid, amount);
    emitMe(uid);
    return { ok: true };
  }

  // ---- Sit & Go tournaments ----

  function openSng(buyIn, size) {
    const id = `sng-${crypto.randomBytes(4).toString('hex')}`;
    sngs.set(id, { id, buyIn, size, status: 'registering', players: [], table: null, results: [] });
  }
  // There is always exactly one tournament open for registration in each size and buy-in.
  function ensureOpenSngs() {
    for (const size of SNG_SIZES) {
      for (const buyIn of SNG_BUYINS) {
        const open = [...sngs.values()].some((s) => s.status === 'registering' && s.size === size && s.buyIn === buyIn);
        if (!open) openSng(buyIn, size);
      }
    }
  }
  ensureOpenSngs();

  async function sngRegister(uid, { id }) {
    const s = sngs.get(id);
    if (!s || s.status !== 'registering') return fail('That tournament is no longer open');
    if (where.has(uid)) return fail('You are already in a game. Leave it first.');
    where.set(uid, { type: 'sng', id });
    const user = await wallet.toTable(uid, id, s.buyIn, 'sng_buyin');
    if (!user) {
      where.delete(uid);
      return fail('Not enough balance in your wallet');
    }
    if (s.status !== 'registering' || s.players.length >= s.size) {
      await wallet.fromTable(uid, id, s.buyIn, 'sng_refund');
      where.delete(uid);
      emitMe(uid);
      return fail('That tournament just filled up');
    }
    s.players.push(playerInfo(user));
    emitMe(uid);
    if (s.players.length === s.size) startSng(s);
    scheduleLobby();
    return { ok: true };
  }

  async function sngUnregister(uid) {
    const at = where.get(uid);
    const s = at?.type === 'sng' ? sngs.get(at.id) : null;
    if (!s || s.status !== 'registering') return fail('The tournament has already started');
    s.players = s.players.filter((p) => p.uid !== uid);
    where.delete(uid);
    await wallet.fromTable(uid, s.id, s.buyIn, 'sng_refund');
    emitMe(uid);
    scheduleLobby();
    return { ok: true };
  }

  function startSng(s) {
    s.status = 'running';
    s.startedAt = Date.now();
    s.level = 0;
    const prizes = prizesFor(s.buyIn, s.size);
    const levelAt = () => Math.min(Math.floor((Date.now() - s.startedAt) / SNG_LEVEL_MS), SNG_LEVELS.length - 1);
    const table = new Table({
      id: s.id,
      name: `${s.buyIn} Sit & Go · ${s.size === 2 ? 'Heads-up' : '6-Max'}`,
      kind: 'sng',
      maxSeats: s.size,
      blinds: SNG_LEVELS[0],
      onChange: emitTable,
      hooks: {
        beforeHand: (t) => {
          const level = levelAt();
          if (level !== s.level) {
            s.level = level;
            [t.sb, t.bb] = SNG_LEVELS[level];
            t.note('blinds');
            t.say(`Blinds go up to ${t.sb}/${t.bb}.`);
          }
        },
        info: () => ({
          buyIn: s.buyIn,
          prizes,
          level: s.level + 1,
          nextBlinds: SNG_LEVELS[s.level + 1] || null,
          nextLevelIn: SNG_LEVELS[s.level + 1] ? Math.max(0, s.startedAt + (s.level + 1) * SNG_LEVEL_MS - Date.now()) : null,
          results: s.results,
          finished: s.status === 'finished',
        }),
        onHandEnd: (t) => {
          // Knock out everyone with no chips; whoever started the hand with more finishes higher.
          const out = t.seated.filter((p) => p.stack === 0).sort((a, b) => a.handStartStack - b.handStartStack);
          for (const p of out) {
            const place = t.seated.length;
            t.removePlayer(p.uid);
            finishPlayer(s, p, place, prizes[place - 1] || 0);
          }
          if (t.seated.length === 1) {
            const winner = t.seated[0];
            finishPlayer(s, winner, 1, prizes[0], true);
            s.status = 'finished';
            t.say(`${winner.name} wins the tournament and ${prizes[0]}.`);
            t.close();
            emitTable(t);
            // Leave the result on screen for a while, then clear the table away.
            setTimeout(() => {
              tables.delete(t.id);
              sngs.delete(s.id);
              io.to(room(winner.uid)).emit('table:state', null);
              io.to(watchRoom(t.id)).emit('table:state', null);
              io.in(watchRoom(t.id)).socketsLeave(watchRoom(t.id));
              for (const sid of online.get(winner.uid) || []) {
                const sock = io.sockets.sockets.get(sid);
                if (sock && sock.data.watching === t.id) sock.data.watching = null;
              }
              scheduleLobby();
            }, 20000);
          }
        },
      },
    });
    s.table = table;
    tables.set(s.id, table);
    // Seats are drawn at random.
    const order = [...s.players].sort(() => crypto.randomInt(3) - 1);
    order.forEach((p, i) => table.addPlayer(p, i, SNG_STACK));
    for (const p of s.players) {
      stopWatchingAsPlayer(p.uid, s.id);
      io.to(room(p.uid)).emit('table:state', table.publicState(p.uid));
      io.to(room(p.uid)).emit('notice', 'Your Sit & Go has started. Good luck!');
    }
    ensureOpenSngs();
  }

  function finishPlayer(s, p, place, prize, stays = false) {
    s.results.push({ uid: p.uid, name: p.name, place, prize });
    where.delete(p.uid);
    wallet
      .fromTable(p.uid, s.id, prize, 'sng_prize')
      .then(() => emitMe(p.uid))
      .catch((err) => console.error('could not settle tournament result', err));
    const msg = prize > 0 ? `You finished ${ordinal(place)} and won ${prize}!` : `You finished ${ordinal(place)}.`;
    io.to(room(p.uid)).emit('notice', msg);
    if (!stays) keepWatching(p.uid, s.id);
  }

  // ---- connections ----

  function connected(socket, user) {
    const uid = user._id.toString();
    socket.data.uid = uid;
    socket.join(room(uid));
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(socket.id);
    clearTimeout(offlineTimers.get(uid));
    offlineTimers.delete(uid);

    const at = where.get(uid);
    const table = at ? tables.get(at.id) : null;
    if (table?.seatOf(uid)) {
      table.setConnected(uid, true);
      socket.data.watching = table.id;
      socket.emit('table:state', table.publicState(uid));
    } else {
      socket.emit('table:state', null);
    }
    socket.emit('lobby:state', lobbyState());
    socket.emit('me', selfView(user));
    scheduleLobby();
  }

  function disconnected(socket) {
    const uid = socket.data.uid;
    unwatch(socket);
    const set = online.get(uid);
    if (!set) return;
    set.delete(socket.id);
    if (set.size > 0) return;
    online.delete(uid);
    const at = where.get(uid);
    const table = at ? tables.get(at.id) : null;
    if (table?.seatOf(uid)) {
      table.setConnected(uid, false);
      // A cash player who stays away gets their chips back and frees the seat.
      // A tournament player stays in and is folded until they return.
      if (at.type === 'cash') {
        offlineTimers.set(uid, setTimeout(() => {
          offlineTimers.delete(uid);
          if (!online.has(uid)) standUp(uid).catch(() => {});
        }, OFFLINE_LIMIT_MS));
      }
    }
    scheduleLobby();
  }

  // Remove a player from everything (used when they are banned).
  async function kick(uid) {
    const at = where.get(uid);
    if (at?.type === 'cash') await standUp(uid);
    else if (at?.type === 'sng') {
      const s = sngs.get(at.id);
      if (s?.status === 'registering') await sngUnregister(uid);
      else s?.table?.setConnected(uid, false); // already playing: they are folded from now on
    }
    io.to(room(uid)).emit('banned');
    io.in(room(uid)).disconnectSockets(true);
  }

  // Sitting-out seats are also released between hands at quiet tables.
  setInterval(() => {
    for (const t of tables.values()) {
      if (t.kind !== 'cash' || t.phase !== 'waiting') continue;
      for (const p of [...t.seated]) {
        if (p.sittingOut && Date.now() - p.sitOutSince > SIT_OUT_LIMIT_MS) standUp(p.uid, 'You were sitting out too long, so your seat was released.').catch(() => {});
      }
    }
  }, 30000).unref();

  const tableOf = (uid) => {
    const at = where.get(uid);
    const t = at ? tables.get(at.id) : null;
    return t?.seatOf(uid) ? t : null;
  };

  return {
    connected, disconnected, watch, unwatch, lobbyState, emitMe, kick,
    cashSit, cashTopUp, standUp, sngRegister, sngUnregister,
    act: (uid, action) => tableOf(uid)?.act(uid, action),
    show: (uid, which) => tableOf(uid)?.show(uid, which),
    sitOut: (uid, on) => tableOf(uid)?.setSittingOut(uid, !!on),
    summary: () => ({
      online: online.size,
      seated: [...tables.values()].reduce((n, t) => n + t.seated.length, 0),
      chipsOnTables: [...tables.values()].filter((t) => t.kind === 'cash').reduce((n, t) => n + t.seated.reduce((s, p) => s + p.stack + p.pendingTopUp, 0) + t.publicState(null).pot, 0),
    }),
  };
}

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

// What a player is told about their own account.
export function selfView(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    picture: user.picture || '',
    balance: user.balance,
    inPlay: wallet.inPlay(user),
    isAdmin: isAdmin(user),
  };
}

// Admins are named by email in the server's private settings (ADMIN_EMAILS), never in the code.
// Only an account whose email was proved (a login code or Google) can be one.
export function isAdmin(user) {
  const emails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!user.email && !user.googleId.startsWith('dev:') && emails.includes(user.email.toLowerCase());
}
