import { BotSettings, BotDecision, PlayerNote, NOTE_COUNTS } from '../models.js';
import crypto from 'crypto';
import { systemPrompt, MODELS } from './botBrain.js';
import { readHand } from './botRead.js';
import { decide as decideLocally, STYLES, profile } from './botEngine.js';
import { shownClass } from './botRange.js';
import { createMood, afterHand, tellFor, moodNow } from './botMood.js';
import { reactTo, chatEvent, TALK_LEVELS } from './botTalk.js';

// engine: free rule-based play on the server · hybrid: engine, with Claude for big pots · claude: Claude every turn
const MODES = ['engine', 'hybrid', 'claude'];

// Seats played by the AI bot. When an admin sits down or registers "as Bot", their seat is marked
// here and the bot plays it: whenever it is that seat's turn, the bot describes the table to Claude
// (only what that seat may see), keeps notes on the session, checks the answer is a legal move and
// plays it at a human pace. If Claude is slow, errors or the daily budget is used up, it plays the
// safe move (check, or fold) so the game never waits.

const THINK_MIN_MS = 1200; // never answer faster than a human would
const THINK_SPREAD_MS = 1800; // ... plus up to this much more, at random
const DECIDE_TIMEOUT_MS = 11000; // players have 25 seconds; give up on Claude well before that
const BIG_DECIDE_TIMEOUT_MS = 16000; // a big pot gets a little longer to think, still inside the clock
const RECENT_HANDS = 8; // how many of this session's hands the bot is reminded of

export const DEFAULT_PLAYBOOK = `- Loose-aggressive style: play plenty of hands in position and put pressure on with bets and raises.
- Fire a second barrel on good turn cards when you have equity; give up on bad ones.
- Mix it up: sometimes check-raise the flop, sometimes overbet the river, sometimes just call with a monster.
- Against players who call a lot, value bet thinner and bluff less.`;

// The playbook first shipped; a seat still using it gets the newer default above.
const FIRST_PLAYBOOK = `- Play tighter from early position and wider on the button.
- Open-raise to about 2.5 big blinds; 3-bet strong hands and some suited aces as bluffs.
- Bet for value when ahead; don't slow-play wet boards.
- Against players who call a lot, bluff less and value bet thinner.
- Against tight players, steal their blinds and fold to their big bets more often.`;

const POSITION_NAMES = {
  2: ['BB', 'BTN/SB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'UTG', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'],
};
const BOARD_AT = { flop: 3, turn: 4, river: 5 };
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (lo, hi) => lo + Math.random() * (hi - lo);

// How long a person would take here, so the seat looks like its owner playing: easy checks and
// folds go quickly, a big bet or the river takes longer, and now and then they stop to think.
// Kept well inside the 25 s turn clock.
function humanThinkMs(view, move, p) {
  const big = view.toCall > 0 && (view.toCall >= p.stack || view.toCall >= (view.pot || 0) * 0.5);
  let ms;
  if (move.type === 'check') ms = between(THINK_MIN_MS * 0.7, THINK_MIN_MS + THINK_SPREAD_MS * 0.6);
  else if (move.type === 'fold') ms = big ? between(2500, 6000) : between(THINK_MIN_MS * 0.8, THINK_MIN_MS + THINK_SPREAD_MS);
  else if (big) ms = between(3000, 8000);
  else ms = between(THINK_MIN_MS, THINK_MIN_MS + THINK_SPREAD_MS * 1.5);
  if (view.street === 'river') ms *= 1.3;
  if (Math.random() < 0.08) ms += between(2000, 5000); // a long think now and then
  return Math.min(ms, 14000);
}
const keyOf = (tableId, uid) => `${tableId}|${uid}`;

// Ready-made bet sizes, so the bot varies them sensibly instead of always picking the same one.
function sizeMenu(view, p, bb, street) {
  const facing = (p.bet || 0) + (view.toCall || 0); // the bet to match on this street
  const clamp = (n) => Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, Math.round(n)));
  const items = [];
  if (street === 'preflop' && facing <= bb) {
    for (const x of [2.2, 2.5, 3]) items.push([`open ${x}bb`, x * bb]);
  } else if (facing === 0) {
    for (const [label, f] of [['1/3 pot', 1 / 3], ['1/2 pot', 0.5], ['3/4 pot', 0.75], ['pot', 1], ['overbet 1.5x pot', 1.5]]) items.push([label, view.pot * f]);
  } else {
    items.push(['2.5x', facing * 2.5], ['3x', facing * 3], [street === 'preflop' ? '4x (out of position)' : 'pot-size raise', street === 'preflop' ? facing * 4 : facing + view.pot + view.toCall]);
  }
  const seen = new Set();
  const out = [];
  for (const [label, n] of items) {
    const v = clamp(n);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(`${label} = ${fmt(v)}${v === view.maxRaiseTo ? ' (all-in)' : ''}`);
  }
  if (!seen.has(view.maxRaiseTo)) out.push(`all-in = ${fmt(view.maxRaiseTo)}`);
  return out;
}

// Bigger decisions get a little more thinking; everyday spots stay cheap and quick.
function effortFor(view, p, bb, street) {
  const big = view.pot >= 25 * bb || (view.toCall || 0) >= 12 * bb || (view.toCall > 0 && view.toCall >= p.stack * 0.4) || (street === 'river' && view.toCall > 0);
  return big ? 'medium' : 'low';
}

// express: how the bot shows feelings at the table, as its owner: { chat, react, throwAt }.
export function createBots({ brain, notify, express = null }) {
  const seats = new Set(); // tableId|uid of every seat the bot plays
  const bots = { has: (uid) => [...seats].some((k) => k.endsWith('|' + uid)) };
  const busy = new Map(); // tableId -> the turn being decided, so each turn is decided once
  const sessions = new Map(); // tableId|uid -> what the bot remembers of this session
  const notes = new Map(); // player uid -> everything the bot has learned about them, across games (saved)
  let settings = { playbook: DEFAULT_PLAYBOOK, dailyBudgetUsd: 3, mode: 'engine', style: 'aggressive', model: 'haiku', talk: 'normal' };
  const spend = { day: today(), usd: 0, decisions: 0, ms: 0, fallbacks: 0 };

  // Load the saved playbook and today's spend so far.
  (async () => {
    try {
      const saved = await BotSettings.findOne({ key: 'main' }).lean();
      if (saved) {
        settings = {
          playbook: !saved.playbook || saved.playbook.trim() === FIRST_PLAYBOOK ? DEFAULT_PLAYBOOK : saved.playbook,
          dailyBudgetUsd: saved.dailyBudgetUsd ?? 3,
          mode: MODES.includes(saved.mode) ? saved.mode : 'engine',
          style: STYLES[saved.style] ? saved.style : 'aggressive',
          model: MODELS[saved.model] ? saved.model : 'haiku',
          talk: saved.talk in TALK_LEVELS ? saved.talk : 'normal',
        };
      }
      const start = new Date(`${today()}T00:00:00Z`);
      const [row] = await BotDecision.aggregate([
        { $match: { at: { $gte: start } } },
        { $group: { _id: null, usd: { $sum: '$costUsd' }, n: { $sum: 1 }, ms: { $sum: '$ms' }, fb: { $sum: { $cond: [{ $ifNull: ['$fallback', false] }, 1, 0] } } } },
      ]);
      if (row) Object.assign(spend, { usd: row.usd || 0, decisions: row.n || 0, ms: row.ms || 0, fallbacks: row.fb || 0 });
      for (const n of await PlayerNote.find({}).lean()) notes.set(n.uid, n);
    } catch (err) {
      console.error('bot: could not load settings', err.message);
    }
  })();

  const rollDay = () => {
    if (spend.day !== today()) Object.assign(spend, { day: today(), usd: 0, decisions: 0, ms: 0, fallbacks: 0 });
  };

  // ---- which seats the bot plays ----

  function setBot(table, uid, on) {
    const seat = table?.seatOf(uid);
    if (!seat) return false;
    const key = keyOf(table.id, uid);
    if (on) {
      seats.add(key);
      seat.bot = true;
      if (!sessions.has(key)) sessions.set(key, { startedAt: Date.now(), hands: 0, net: 0, recent: [], opp: new Map(), mood: createMood(), said: { chatHand: -9, chatAt: 0, throwHand: -9, reactHand: -9 } });
    } else {
      seats.delete(key);
      seat.bot = false;
    }
    table.changed();
    return true;
  }

  // The seat is gone (stood up, knocked out): forget it.
  function forget(tableId, uid) {
    const key = keyOf(tableId, uid);
    seats.delete(key);
    sessions.delete(key);
  }

  // ---- session memory: what happened in each finished hand, kept per bot seat ----

  // What one finished hand tells us about one player: counts to add, and anything they showed.
  function handNotes(hand, p) {
    const d = Object.fromEntries(NOTE_COUNTS.map((k) => [k, 0]));
    d.hands = 1;
    const mine = hand.actions.filter((a) => a.seat === p.seat);
    if (mine.some((a) => a.st === 'preflop' && ['call', 'bet', 'raise'].includes(a.t))) d.vpip = 1;
    if (mine.some((a) => a.st === 'preflop' && ['bet', 'raise'].includes(a.t))) d.pfr = 1;
    for (const a of mine) {
      if (a.st === 'preflop' || a.st === 'result') continue;
      if (a.t === 'bet' || a.t === 'raise') d.bets += 1;
      else if (a.t === 'call') d.calls += 1;
      else if (a.t === 'fold') d.folds += 1;
    }
    // After the flop: do they fold when bet into, bet when checked to, call on the river?
    let street = '';
    let betPending = false;
    let checkedBefore = false;
    let riverAggro = false;
    for (const a of hand.actions) {
      if (a.st === 'preflop' || a.st === 'result') continue;
      if (a.st !== street) { street = a.st; betPending = false; checkedBefore = false; }
      if (a.seat === p.seat) {
        if (betPending) {
          d.facedBet += 1;
          if (a.t === 'fold') d.foldedToBet += 1;
          if (street === 'river') { d.riverFaced += 1; if (a.t === 'call') d.riverCalls += 1; }
        } else if (checkedBefore) {
          d.checkedTo += 1;
          if (a.t === 'bet' || a.t === 'raise') d.stabbed += 1;
        }
        if (street === 'river' && (a.t === 'bet' || a.t === 'raise')) riverAggro = true;
      }
      if (a.t === 'bet' || a.t === 'raise') betPending = true;
      else if (a.t === 'check') checkedBefore = true;
    }
    if (riverAggro) d.riverBets = 1;
    // Cards turned over at the table are public; anything else stays hidden.
    let shown = null;
    if (p.revealed?.length === 2 && p.revealed.every(Boolean)) {
      shown = `${p.revealed.join(' ')}${p.hand ? ` (${p.hand})` : ''}`;
      d.showdowns = 1;
      // A river bet or raise we got to see: was it a real hand, or a bluff?
      if (riverAggro && hand.board.length === 5) {
        const cls = shownClass(p.revealed, hand.board);
        d.riverBetShown = 1;
        if (cls === 'weak' || cls === 'air' || cls === 'draw') d.riverBluffShown = 1;
      }
    }
    return { d, shown };
  }

  function addNotes(o, d, shown) {
    for (const k of NOTE_COUNTS) o[k] = (o[k] || 0) + (d[k] || 0);
    o.shown = o.shown || [];
    if (shown) {
      o.shown.push(shown);
      if (o.shown.length > 5) o.shown.shift();
    }
  }

  // The long-term notes on a player, updated and saved after each hand the bot sees them play.
  function saveNotes(p, d, shown, newSession) {
    const n = notes.get(p.uid) || { uid: p.uid, shown: [] };
    n.name = p.name;
    n.lastSeen = new Date();
    if (newSession) d = { ...d, sessions: 1 };
    addNotes(n, d, shown);
    notes.set(p.uid, n);
    const inc = Object.fromEntries(NOTE_COUNTS.filter((k) => d[k]).map((k) => [k, d[k]]));
    const update = { $inc: inc, $set: { name: p.name, lastSeen: n.lastSeen } };
    if (shown) update.$push = { shown: { $each: [shown], $slice: -5 } };
    PlayerNote.updateOne({ uid: p.uid }, update, { upsert: true }).catch((err) => console.error('bot: could not save notes', err.message));
  }

  // What the bot knows about a player right now: this session's notes, plus what it learned in
  // earlier games. Older games count as a baseline (worth up to 80 hands); today's play weighs more.
  const PRIOR_HANDS = 80;
  function notesFor(s, uid) {
    const now = s?.opp.get(uid);
    const all = notes.get(uid);
    if (!all) return now || null;
    const prior = Object.fromEntries(NOTE_COUNTS.map((k) => [k, Math.max(0, (all[k] || 0) - (now?.[k] || 0))]));
    const k = prior.hands > 0 ? Math.min(1, PRIOR_HANDS / prior.hands) : 0;
    const out = { name: all.name };
    for (const key of NOTE_COUNTS) out[key] = (now?.[key] || 0) + prior[key] * k;
    out.shown = [...(all.shown || [])].slice(-3);
    out.sessions = all.sessions || 0;
    out.lifetimeHands = all.hands || 0;
    return out;
  }

  function rememberHand(hand) {
    const savedFor = new Set(); // long-term notes are taken once per hand, however many bot seats saw it
    for (const key of seats) {
      const [tableId, uid] = key.split('|');
      if (tableId !== hand.tableId || !hand.uids.includes(uid)) continue;
      const s = sessions.get(key);
      if (!s) continue;
      const me = hand.players.find((p) => p.uid === uid);
      s.hands += 1;
      s.net += me.net;
      s.recent.push(summarise(hand, uid));
      if (s.recent.length > RECENT_HANDS) s.recent.shift();
      for (const p of hand.players) {
        if (p.uid === uid || bots.has(p.uid)) continue;
        const { d, shown } = handNotes(hand, p);
        const fresh = !s.opp.has(p.uid);
        const o = s.opp.get(p.uid) || { name: p.name, shown: [] };
        o.name = p.name;
        addNotes(o, d, shown);
        s.opp.set(p.uid, o);
        if (!savedFor.has(p.uid)) {
          savedFor.add(p.uid);
          saveNotes(p, d, shown, fresh);
        }
      }
      // How the hand made the bot feel, and whether to show it.
      const events = afterHand(s.mood, hand, uid, hand.blinds?.[1] || 1);
      // A big win: the throw goes at whoever lost the most.
      const loser = [...hand.players].filter((p) => p.uid !== uid).sort((a, b) => a.net - b.net)[0];
      for (const ev of events) if (ev.kind === 'bigWin' && loser) Object.assign(ev, { seat: loser.seat, name: loser.name });
      expressFor(tableId, uid, s, events);
    }
  }

  // ---- showing feelings at the table: chat, emoji, throwables (never spammy) ----

  const later = (ms, fn) => setTimeout(() => { try { fn(); } catch (err) { console.error('bot: could not express', err.message); } }, ms);
  // The most telling events first; at most a chat, a reaction and a throw per hand, spaced like a person.
  const EVENT_ORDER = ['badBeat', 'theyBluffed', 'bigWin', 'bigLoss', 'crushed', 'caughtBluffing', 'win', 'cardDead', 'thrown', 'gg', 'nh', 'hello'];
  function expressFor(tableId, uid, s, events, { immediate = false } = {}) {
    if (!express || settings.talk === 'off' || !events.length) return;
    const sorted = [...events].sort((a, b) => EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind));
    let delay = immediate ? 900 + Math.random() * 1500 : 1500 + Math.random() * 2500;
    const done = new Set();
    for (const ev of sorted) {
      for (const act of reactTo(ev, settings.talk)) {
        if (done.has(act.type)) continue;
        const now = Date.now();
        // Keep it human: chat at most every few hands and 20 seconds, a throw every couple of hands.
        if (act.type === 'chat' && !immediate && (s.hands - s.said.chatHand < 3 || now - s.said.chatAt < 20000)) continue;
        if (act.type === 'chat' && immediate && now - s.said.chatAt < 8000) continue;
        if (act.type === 'throw' && s.hands - s.said.throwHand < 2 && !immediate) continue;
        if (act.type === 'react' && s.said.reactHand === s.hands) continue;
        done.add(act.type);
        if (act.type === 'chat') { s.said.chatHand = s.hands; s.said.chatAt = now; later(delay, () => express.chat(uid, tableId, act.text)); }
        if (act.type === 'react') { s.said.reactHand = s.hands; later(delay, () => express.react(uid, tableId, act.emote)); }
        if (act.type === 'throw') { s.said.throwHand = s.hands; later(delay, () => express.throwAt(uid, tableId, act.to, act.item)); }
        delay += 1200 + Math.random() * 1500;
      }
    }
  }

  // Someone threw something at a bot's seat: sometimes it throws back, or says something.
  function onThrown(tableId, fromUid, fromSeat, toUid, item) {
    const key = keyOf(tableId, toUid);
    if (!seats.has(key) || fromUid === toUid) return;
    const s = sessions.get(key);
    if (s) expressFor(tableId, toUid, s, [{ kind: 'thrown', seat: fromSeat, item }], { immediate: true });
  }

  // Someone said something at a table with a bot seat: answer greetings, "gg", "nh" now and then.
  function onChat(tableId, fromUid, text) {
    const kind = chatEvent(text);
    if (!kind) return;
    for (const key of seats) {
      const [tid, uid] = key.split('|');
      if (tid !== tableId || uid === fromUid) continue;
      const s = sessions.get(key);
      if (s) expressFor(tableId, uid, s, [{ kind }], { immediate: true });
    }
  }

  // One finished hand in one line, from the bot's point of view.
  function summarise(hand, uid) {
    const names = Object.fromEntries(hand.players.map((p) => [p.seat, p.uid === uid ? 'you' : p.name]));
    const me = hand.players.find((p) => p.uid === uid);
    const parts = [];
    let street = 'preflop';
    let line = [];
    const flush = () => line.length && parts.push(`${street === 'preflop' ? 'pre' : street}${street !== 'preflop' ? ` [${hand.board.slice(0, BOARD_AT[street]).join(' ')}]` : ''}: ${line.join(', ')}`);
    for (const a of hand.actions) {
      if (a.st === 'result') continue;
      if (a.st !== street) {
        flush();
        street = a.st;
        line = [];
      }
      if (a.t === 'sb' || a.t === 'bb' || a.t === 'return') continue;
      line.push(`${names[a.seat]} ${a.t === 'raise' ? `raise ${a.a}` : a.t === 'bet' ? `bet ${a.a}` : a.t === 'call' ? `call ${a.a}` : a.t}`);
    }
    flush();
    const shown = hand.players.filter((p) => p.uid !== uid && p.revealed?.length === 2 && p.revealed.every(Boolean)).map((p) => `${p.name} showed ${p.revealed.join(' ')}`);
    const won = hand.players.filter((p) => p.won > 0).map((p) => `${names[p.seat]} won ${p.won}`);
    return `#${hand.handNo} you held ${me.cards.join(' ')}: ${parts.join('; ')}${shown.length ? `; ${shown.join(', ')}` : ''}; ${won.join(', ')} (you ${me.net >= 0 ? '+' : ''}${me.net}).`;
  }

  // ---- describing the table for one decision ----

  function describe(table, p, view) {
    const bb = table.bb;
    const order = table.players; // in order from the button's left
    const names = POSITION_NAMES[order.length] || [];
    const posOf = (seat) => names[order.findIndex((q) => q.seat === seat)] || '';
    const s = sessions.get(keyOf(table.id, p.uid));
    const info = view.info || {};
    const bbs = (n) => `${(Math.round((n / bb) * 10) / 10).toLocaleString('en-IN')}bb`;
    const lines = [];

    if (table.kind === 'sng') {
      lines.push(`GAME: Sit & Go tournament "${table.name}", level ${info.level || 1}, blinds ${table.sb}/${bb}${info.nextBlinds ? ` (next ${info.nextBlinds.join('/')})` : ''}. Players left ${table.seated.length}. Prizes: ${(info.prizes || []).map((x, i) => `${i + 1}st ${fmt(x)}`).join(', ')}.`);
    } else {
      lines.push(`GAME: Cash game "${table.name}", blinds ${table.sb}/${bb}.`);
    }
    lines.push(`YOU: ${p.name}, ${posOf(p.seat)}, stack ${fmt(p.stack)} (${bbs(p.stack)}). Your cards: ${p.cards.join(' ')}.`);
    lines.push(`STREET: ${table.street}. BOARD: ${table.board.length ? table.board.join(' ') : '(none yet)'}. POT: ${fmt(view.pot)} (${bbs(view.pot)}).`);
    const who0 = (seat) => (seat === p.seat ? 'You' : table.seats[seat]?.name || `Seat ${seat + 1}`);
    lines.push(...readHand(p.cards, table.board, order.filter((q) => q.uid !== p.uid && !q.folded).length));
    // Who took the betting lead before the flop: the last pre-flop raiser has the initiative.
    const lastRaise = [...table.actions].reverse().find((a) => a.st === 'preflop' && a.t === 'raise');
    if (table.street !== 'preflop') lines.push(`INITIATIVE: ${lastRaise ? `${who0(lastRaise.seat)} raised last before the flop` : 'nobody raised before the flop (limped pot)'}.`);

    lines.push('PLAYERS (order of action after the flop):');
    for (const q of order) {
      const o = notesFor(s, q.uid);
      const state = q.folded ? 'folded' : q.allIn ? 'all-in' : 'in hand';
      let line = `- ${q.uid === p.uid ? 'YOU' : q.name} (${posOf(q.seat)}${q.seat === table.button ? ', dealer' : ''}): stack ${fmt(q.stack)} (${bbs(q.stack)}), bet ${fmt(q.bet)} this street, ${state}`;
      if (o && o.hands >= 3) {
        const pct = (n) => `${Math.round((n / o.hands) * 100)}%`;
        const aggr = o.calls ? (o.bets / o.calls).toFixed(1) : o.bets ? 'high' : '0';
        line += ` | this session ${o.hands} hands: plays ${pct(o.vpip)} of hands, raises pre-flop ${pct(o.pfr)}, aggression ${aggr}`;
        if (o.facedBet >= 4) line += `, folds to a bet ${Math.round((o.foldedToBet / o.facedBet) * 100)}% (${o.facedBet} times)`;
        if (o.checkedTo >= 4) line += `, bets when checked to ${Math.round((o.stabbed / o.checkedTo) * 100)}% (${o.checkedTo} times)`;
        if (o.shown.length) line += `, showed ${o.shown.join('; ')}`;
      }
      lines.push(line);
    }

    // This hand so far, street by street.
    const who = (seat) => (seat === p.seat ? 'You' : table.seats[seat]?.name || order.find((q) => q.seat === seat)?.name || `Seat ${seat + 1}`);
    const so = [];
    let street = '';
    for (const a of table.actions) {
      if (a.st !== street) {
        street = a.st;
        so.push(`${street === 'preflop' ? 'Pre-flop' : `${street[0].toUpperCase()}${street.slice(1)} [${table.board.slice(0, BOARD_AT[street]).join(' ')}]`}:`);
      }
      const what = a.t === 'sb' ? `posts SB ${a.a}` : a.t === 'bb' ? `posts BB ${a.a}` : a.t === 'raise' ? `raises to ${a.a}` : a.t === 'bet' ? `bets ${a.a}` : a.t === 'call' ? `calls ${a.a}` : a.t === 'return' ? `gets ${a.a} back` : `${a.t}s`;
      so.push(`  ${who(a.seat)}: ${what}${a.stack === 0 && ['call', 'bet', 'raise'].includes(a.t) ? ' (all-in)' : ''}`);
    }
    lines.push('THIS HAND SO FAR:', ...so);

    const opts = [];
    if (view.toCall > 0) {
      opts.push('fold');
      opts.push(`call ${fmt(view.toCall)}${view.toCall >= p.stack ? ' (all-in)' : ''}${view.pot ? ` (pot odds ${Math.round((view.toCall / (view.pot + view.toCall)) * 100)}%)` : ''}`);
    } else opts.push('check');
    if (view.canRaise) opts.push(`raise to between ${fmt(view.minRaiseTo)} and ${fmt(view.maxRaiseTo)} (all-in = ${fmt(view.maxRaiseTo)})`);
    lines.push(`YOUR OPTIONS: ${opts.join(' | ')}`);
    if (view.canRaise) lines.push(`SIZES (raise-to amounts): ${sizeMenu(view, p, bb, table.street).join(', ')}`);
    // A fresh random number each turn, so the bot can play mixed strategies instead of always the same line.
    lines.push(`ROLL: ${crypto.randomInt(1, 101)} (random 1-100, use it to mix your lines)`);

    if (s && s.hands > 0) {
      lines.push(`YOUR SESSION: ${s.hands} hands played here, net ${s.net >= 0 ? '+' : ''}${fmt(s.net)}. Recent hands:`);
      lines.push(...s.recent.map((r) => `  ${r}`));
    }
    return lines.join('\n');
  }

  // The situation for the free engine: the same facts Claude reads, as numbers and flags.
  function situation(table, p, view) {
    const order = table.players;
    const names = POSITION_NAMES[order.length] || [];
    const s = sessions.get(keyOf(table.id, p.uid));
    const statsOf = (seat) => notesFor(s, table.seats[seat]?.uid);
    const acts = table.actions;
    const aggressive = (a) => a.t === 'raise' || a.t === 'bet';
    const pre = acts.filter((a) => a.st === 'preflop');
    const preRaises = pre.filter(aggressive);
    const firstRaise = pre.findIndex(aggressive);
    const limpers = pre.filter((a, i) => a.t === 'call' && a.seat !== p.seat && (firstRaise < 0 || i < firstRaise)).length;
    const onStreet = acts.filter((a) => a.st === table.street);
    const streetBets = onStreet.filter(aggressive);
    const lastBet = streetBets[streetBets.length - 1];
    // Who led the previous street: the initiative carries over to this one.
    const prevStreet = { flop: 'preflop', turn: 'flop', river: 'turn' }[table.street];
    const prevBets = prevStreet ? acts.filter((a) => a.st === prevStreet && aggressive(a)) : [];
    const live = order.filter((q) => !q.folded);
    const others = live.filter((q) => q.uid !== p.uid);
    const pos = names[order.findIndex((q) => q.seat === p.seat)] || '';
    // How the bot feels right now, against the main opponent; and any timing tell they just gave.
    const mainOpp = others.length === 1 ? others[0] : others.find((q) => q.seat === [...acts].reverse().find((a) => a.seat !== p.seat && (a.t === 'bet' || a.t === 'raise'))?.seat) || others[0];
    const mood = s?.mood ? moodNow(s.mood, mainOpp?.uid, { myStack: p.stack, villainStack: mainOpp?.stack || 0, bb: table.bb }) : null;
    const tell = s?.mood && others.length === 1 ? tellFor(s.mood, acts, others[0].seat, others[0].uid, table.street) : null;
    // How loose the table plays: the average share of hands the others put money in (once known).
    const known = table.seated.map((q) => q.uid !== p.uid && notesFor(s, q.uid)).filter((o) => o && o.hands >= 5);
    const tableVpip = known.length ? known.reduce((sum, o) => sum + o.vpip / o.hands, 0) / known.length : null;
    return {
      tableVpip,
      style: settings.style,
      hole: p.cards,
      board: [...table.board],
      street: table.street,
      bb: table.bb,
      pot: view.pot,
      toCall: view.toCall || 0,
      stack: p.stack,
      myBet: p.bet || 0,
      canRaise: !!view.canRaise,
      minRaiseTo: view.minRaiseTo,
      maxRaiseTo: view.maxRaiseTo,
      pos,
      players: order.length,
      preRaises: preRaises.length,
      lastRaiser: preRaises.length ? statsOf(preRaises[preRaises.length - 1].seat) : null,
      limpers,
      // The bet the last raiser raised over (the previous raise, or the big blind), to judge its size.
      raiseBefore: preRaises.length >= 2 ? preRaises[preRaises.length - 2].a : table.bb,
      iRaised: preRaises.some((a) => a.seat === p.seat),
      inPosition: table.street === 'preflop' ? ['BTN', 'CO', 'BTN/SB'].includes(pos) : live[live.length - 1]?.uid === p.uid,
      opponents: others.length,
      streetRaises: streetBets.length,
      aggressor: lastBet && lastBet.seat !== p.seat ? statsOf(lastBet.seat) : null,
      mainOpponent: others.length ? statsOf(others[0].seat) : null,
      hadInitiative: prevBets.length > 0 && prevBets[prevBets.length - 1].seat === p.seat,
      checkedToMe: streetBets.length === 0,
      // Heads-up: who the villain is, their notes, and every action this hand, so their range can be read.
      villainSeat: others.length === 1 ? others[0].seat : null,
      villainStats: others.length === 1 ? statsOf(others[0].seat) || null : null,
      actions: acts.map((x) => ({ st: x.st, seat: x.seat, t: x.t, a: x.a, bet: x.bet, pot: x.pot })),
      iCheckedThisStreet: onStreet.some((a) => a.seat === p.seat && a.t === 'check'),
      // Last street (after the flop) they bet and I only called: a float, ready to take it away.
      floated: (() => {
        if (!prevStreet || prevStreet === 'preflop') return false;
        const prev = acts.filter((a) => a.st === prevStreet);
        const lastAgg = prev.filter(aggressive).pop();
        const mine = prev.filter((a) => a.seat === p.seat).pop();
        return !!lastAgg && lastAgg.seat !== p.seat && mine?.t === 'call';
      })(),
      roll: crypto.randomInt(1, 101),
      mood,
      tell,
    };
  }

  // Turn Claude's answer into a move the table accepts; anything odd becomes the safe move.
  function legalize(d, view) {
    const safe = view.toCall > 0 ? { type: 'fold' } : { type: 'check' };
    if (!d) return safe;
    if (d.action === 'fold') return safe;
    if (d.action === 'check') return view.toCall > 0 ? { type: 'fold' } : { type: 'check' };
    if (d.action === 'call') return view.toCall > 0 ? { type: 'call' } : { type: 'check' };
    if (d.action === 'raise') {
      if (!view.canRaise) return view.toCall > 0 ? { type: 'call' } : { type: 'check' };
      const to = Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, Math.floor(d.amount) || view.minRaiseTo));
      return { type: 'raise', amount: to };
    }
    return safe;
  }

  // ---- playing a turn ----

  // Called on every table change: if a bot seat is to act and nobody is deciding that turn yet, decide it.
  function onTableChange(table) {
    const p = table.toAct;
    if (table.phase !== 'hand' || !p?.bot) return;
    const turn = `${table.handNo}:${table.actions.length}:${p.seat}`;
    if (busy.get(table.id) === turn) return;
    busy.set(table.id, turn);
    play(table, p, turn).catch((err) => console.error('bot turn failed', err));
  }

  async function play(table, p, turn) {
    const started = Date.now();
    const view = table.publicState(p.uid);
    // The board and street as they were when deciding (the table moves on once the move is played).
    const boardNow = [...table.board];
    const streetNow = table.street;
    rollDay();
    let decision = null;
    let fallback = '';
    // Which brain plays this turn: the free engine, or Claude (always, or only for big pots).
    const effort = effortFor(view, p, table.bb, table.street);
    const wantClaude = settings.mode === 'claude' || (settings.mode === 'hybrid' && effort === 'medium');
    if (wantClaude) {
      if (!brain.ready()) fallback = 'no API key on the server';
      else if (spend.usd >= settings.dailyBudgetUsd) fallback = `daily budget of $${settings.dailyBudgetUsd} reached`;
      else {
        try {
          decision = await brain.decide({ system: systemPrompt(settings.playbook), prompt: describe(table, p, view), effort, model: settings.model, timeoutMs: effort === 'low' ? DECIDE_TIMEOUT_MS : BIG_DECIDE_TIMEOUT_MS });
        } catch (err) {
          fallback = err.message?.slice(0, 120) || 'Claude did not answer';
        }
      }
    }
    // The engine plays every turn Claude doesn't: by choice, or when Claude can't answer.
    if (!decision) {
      const t0 = Date.now();
      try {
        const sit = situation(table, p, view);
        decision = { ...decideLocally(sit), model: 'engine', costUsd: 0 };
        if (sit.mood?.label) decision.reason = `${sit.mood.label} · ${decision.reason}`;
      } catch (err) {
        console.error('bot engine failed', err);
        fallback = fallback || 'engine error';
      }
      if (decision) decision.ms = Date.now() - t0;
    }
    const move = legalize(decision, view);
    // Answer at a human pace for this spot: never instantly, and never at the same steady rhythm.
    const pause = humanThinkMs(view, move, p) - (Date.now() - started);
    if (pause > 0) await sleep(pause);
    // The turn may have moved on meanwhile (the admin took over, or the hand ended).
    const now = table.toAct;
    if (table.phase !== 'hand' || now !== p || !p.bot || `${table.handNo}:${table.actions.length}:${p.seat}` !== turn) return;
    table.act(p.uid, move);

    const costUsd = decision?.costUsd || 0;
    spend.usd += costUsd;
    spend.decisions += 1;
    spend.ms += decision?.ms || 0;
    if (fallback) spend.fallbacks += 1;
    const said = `${move.type === 'raise' ? `raise to ${fmt(move.amount)}` : move.type}${decision?.reason ? ` · ${decision.reason}` : ''}${fallback ? ` · ${decision ? 'engine played' : 'safe move'} (${fallback})` : ''}`;
    notify(p.uid, { tableId: table.id, text: said });
    BotDecision.create({
      uid: p.uid,
      tableId: table.id,
      tableName: table.name,
      handNo: table.handNo,
      street: streetNow,
      cards: p.cards,
      board: boardNow,
      pot: view.pot,
      toCall: view.toCall,
      action: move.type,
      amount: move.amount || 0,
      reason: decision?.reason || '',
      ms: decision?.ms || 0,
      fallback: fallback || undefined,
      model: decision?.model || brain.model,
      inputTokens: decision?.usage?.input_tokens || 0,
      outputTokens: decision?.usage?.output_tokens || 0,
      cacheReadTokens: decision?.usage?.cache_read_input_tokens || 0,
      costUsd,
    }).catch((err) => console.error('bot: could not log a decision', err.message));
  }

  // ---- admin ----

  function status() {
    rollDay();
    return {
      // The engine needs nothing, so the bot is ready unless it must use Claude and has no key.
      ready: settings.mode !== 'claude' || brain.ready(),
      claudeReady: brain.ready(),
      model: settings.mode === 'engine' ? 'Free engine' : settings.mode === 'hybrid' ? `Engine + ${MODELS[settings.model].label}` : MODELS[settings.model].label,
      mode: settings.mode,
      claudeModel: settings.model,
      talk: settings.talk,
      style: settings.style,
      playbook: settings.playbook,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      today: { spentUsd: Math.round(spend.usd * 10000) / 10000, decisions: spend.decisions, avgMs: spend.decisions ? Math.round(spend.ms / Math.max(1, spend.decisions - spend.fallbacks)) : 0, fallbacks: spend.fallbacks },
      seats: seats.size,
    };
  }

  async function saveSettings({ playbook, dailyBudgetUsd, mode, style, model, talk }) {
    if (talk in TALK_LEVELS) settings.talk = talk;
    if (MODELS[model]) settings.model = model;
    if (typeof playbook === 'string') settings.playbook = playbook.slice(0, 6000);
    if (MODES.includes(mode)) settings.mode = mode;
    if (STYLES[style]) settings.style = style;
    if (dailyBudgetUsd != null) {
      const v = Number(dailyBudgetUsd);
      if (Number.isFinite(v) && v >= 0 && v <= 100) settings.dailyBudgetUsd = Math.round(v * 100) / 100;
    }
    await BotSettings.updateOne({ key: 'main' }, { $set: settings }, { upsert: true });
    return status();
  }

  function playerNotes() {
    const pc = (a, b) => (b ? Math.round((a / b) * 100) : null);
    return [...notes.values()]
      .sort((a, b) => (b.lastSeen ? +new Date(b.lastSeen) : 0) - (a.lastSeen ? +new Date(a.lastSeen) : 0))
      .map((n) => ({
        uid: n.uid,
        name: n.name,
        hands: n.hands || 0,
        sessions: n.sessions || 0,
        vpip: pc(n.vpip, n.hands),
        pfr: pc(n.pfr, n.hands),
        aggression: n.calls ? Math.round(((n.bets || 0) / n.calls) * 10) / 10 : n.bets ? null : 0,
        foldToBet: n.facedBet >= 4 ? pc(n.foldedToBet, n.facedBet) : null,
        betsWhenCheckedTo: n.checkedTo >= 4 ? pc(n.stabbed, n.checkedTo) : null,
        riverCall: n.riverFaced >= 3 ? pc(n.riverCalls, n.riverFaced) : null,
        riverBluffs: n.riverBetShown ? `${n.riverBluffShown || 0} of ${n.riverBetShown}` : null,
        style: profile(n),
        shown: (n.shown || []).slice(-3),
        lastSeen: n.lastSeen,
      }));
  }

  async function forgetPlayer(uid) {
    notes.delete(uid);
    for (const s of sessions.values()) s.opp.delete(uid);
    await PlayerNote.deleteOne({ uid });
    return { ok: true };
  }

  return { onThrown, onChat, playerNotes, forgetPlayer, setBot, forget, rememberHand, onTableChange, status, saveSettings, isBot: (tableId, uid) => seats.has(keyOf(tableId, uid)), describe, legalize, situation };
}
