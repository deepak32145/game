import { BotSettings, BotDecision } from '../models.js';
import crypto from 'crypto';
import { systemPrompt } from './botBrain.js';
import { readHand } from './botRead.js';

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

export function createBots({ brain, notify }) {
  const seats = new Set(); // tableId|uid of every seat the bot plays
  const busy = new Map(); // tableId -> the turn being decided, so each turn is decided once
  const sessions = new Map(); // tableId|uid -> what the bot remembers of this session
  let settings = { playbook: DEFAULT_PLAYBOOK, dailyBudgetUsd: 3 };
  const spend = { day: today(), usd: 0, decisions: 0, ms: 0, fallbacks: 0 };

  // Load the saved playbook and today's spend so far.
  (async () => {
    try {
      const saved = await BotSettings.findOne({ key: 'main' }).lean();
      if (saved) settings = { playbook: !saved.playbook || saved.playbook.trim() === FIRST_PLAYBOOK ? DEFAULT_PLAYBOOK : saved.playbook, dailyBudgetUsd: saved.dailyBudgetUsd ?? 3 };
      const start = new Date(`${today()}T00:00:00Z`);
      const [row] = await BotDecision.aggregate([
        { $match: { at: { $gte: start } } },
        { $group: { _id: null, usd: { $sum: '$costUsd' }, n: { $sum: 1 }, ms: { $sum: '$ms' }, fb: { $sum: { $cond: [{ $ifNull: ['$fallback', false] }, 1, 0] } } } },
      ]);
      if (row) Object.assign(spend, { usd: row.usd || 0, decisions: row.n || 0, ms: row.ms || 0, fallbacks: row.fb || 0 });
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
      if (!sessions.has(key)) sessions.set(key, { startedAt: Date.now(), hands: 0, net: 0, recent: [], opp: new Map() });
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

  function rememberHand(hand) {
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
      // How each opponent has played this session.
      for (const p of hand.players) {
        if (p.uid === uid) continue;
        const o = s.opp.get(p.uid) || { name: p.name, hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, folds: 0, shown: [] };
        o.name = p.name;
        o.hands += 1;
        const mine = hand.actions.filter((a) => a.seat === p.seat);
        if (mine.some((a) => a.st === 'preflop' && ['call', 'bet', 'raise'].includes(a.t))) o.vpip += 1;
        if (mine.some((a) => a.st === 'preflop' && ['bet', 'raise'].includes(a.t))) o.pfr += 1;
        for (const a of mine) {
          if (a.st === 'preflop' || a.st === 'result') continue;
          if (a.t === 'bet' || a.t === 'raise') o.bets += 1;
          else if (a.t === 'call') o.calls += 1;
          else if (a.t === 'fold') o.folds += 1;
        }
        // Cards turned over at the table are public; anything else stays hidden.
        if (p.revealed?.length === 2 && p.revealed.every(Boolean)) {
          o.shown.push(`${p.revealed.join(' ')}${p.hand ? ` (${p.hand})` : ''}`);
          if (o.shown.length > 3) o.shown.shift();
        }
        s.opp.set(p.uid, o);
      }
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
      const o = s?.opp.get(q.uid);
      const state = q.folded ? 'folded' : q.allIn ? 'all-in' : 'in hand';
      let line = `- ${q.uid === p.uid ? 'YOU' : q.name} (${posOf(q.seat)}${q.seat === table.button ? ', dealer' : ''}): stack ${fmt(q.stack)} (${bbs(q.stack)}), bet ${fmt(q.bet)} this street, ${state}`;
      if (o && o.hands >= 3) {
        const pct = (n) => `${Math.round((n / o.hands) * 100)}%`;
        const aggr = o.calls ? (o.bets / o.calls).toFixed(1) : o.bets ? 'high' : '0';
        line += ` | this session ${o.hands} hands: plays ${pct(o.vpip)} of hands, raises pre-flop ${pct(o.pfr)}, aggression ${aggr}`;
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
    rollDay();
    let decision = null;
    let fallback = '';
    if (!brain.ready()) fallback = 'no API key on the server';
    else if (spend.usd >= settings.dailyBudgetUsd) fallback = `daily budget of $${settings.dailyBudgetUsd} reached`;
    else {
      try {
        const effort = effortFor(view, p, table.bb, table.street);
        decision = await brain.decide({ system: systemPrompt(settings.playbook), prompt: describe(table, p, view), effort, timeoutMs: effort === 'low' ? DECIDE_TIMEOUT_MS : BIG_DECIDE_TIMEOUT_MS });
      } catch (err) {
        fallback = err.message?.slice(0, 120) || 'Claude did not answer';
      }
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
    const said = `${move.type === 'raise' ? `raise to ${fmt(move.amount)}` : move.type}${decision?.reason ? ` · ${decision.reason}` : ''}${fallback ? ` · safe move (${fallback})` : ''}`;
    notify(p.uid, { tableId: table.id, text: said });
    BotDecision.create({
      uid: p.uid,
      tableId: table.id,
      tableName: table.name,
      handNo: table.handNo,
      street: view.street,
      cards: p.cards,
      board: [...view.board],
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
      ready: brain.ready(),
      model: brain.model,
      playbook: settings.playbook,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      today: { spentUsd: Math.round(spend.usd * 10000) / 10000, decisions: spend.decisions, avgMs: spend.decisions ? Math.round(spend.ms / Math.max(1, spend.decisions - spend.fallbacks)) : 0, fallbacks: spend.fallbacks },
      seats: seats.size,
    };
  }

  async function saveSettings({ playbook, dailyBudgetUsd }) {
    if (typeof playbook === 'string') settings.playbook = playbook.slice(0, 6000);
    if (dailyBudgetUsd != null) {
      const v = Number(dailyBudgetUsd);
      if (Number.isFinite(v) && v >= 0 && v <= 100) settings.dailyBudgetUsd = Math.round(v * 100) / 100;
    }
    await BotSettings.updateOne({ key: 'main' }, { $set: settings }, { upsert: true });
    return status();
  }

  return { setBot, forget, rememberHand, onTableChange, status, saveSettings, isBot: (tableId, uid) => seats.has(keyOf(tableId, uid)), describe, legalize };
}
