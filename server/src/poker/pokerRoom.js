import crypto from 'crypto';
import { shuffledDeck, bestHand, compareScores, equity } from './handEval.js';

// Blinds rise one level every LEVEL_MS, taking effect at the start of the next hand.
// The steps are small (about a quarter to a third each) so there is time to play: with 2,000 chips
// on the table the average stack is still 20 big blinds after half an hour, and 10 after 45 minutes.
export const BLIND_LEVELS = [
  [5, 10], [5, 15], [10, 20], [10, 25], [15, 30], [20, 40], [25, 50], [30, 60],
  [40, 80], [50, 100], [60, 120], [75, 150], [100, 200], [125, 250], [150, 300], [200, 400],
];
export const LEVEL_MS = Number(process.env.POKER_LEVEL_MS) || 5 * 60 * 1000; // five minutes per level
export const START_CHIPS = 1000;

const ACT_MS = 30000;
const SHOWDOWN_MS = 7000;
const RUNOUT_STEP_MS = 500; // must match the client: pause between the flop, turn and river of an all-in
const FOLD_MS = 3000;

// Heads-up No-Limit Texas Hold'em between two users, played hand after hand until one has no chips.
// The dealer button posts the small blind and acts first before the flop; the other player acts first after it.
// Server-authoritative: each player is only ever sent their own hole cards until a showdown.
export class PokerRoom {
  constructor({ id, players, emitTo, onFinish }) {
    this.id = id;
    this.game = 'poker';
    this.players = players; // [{ id, name, picture }]
    this.emitTo = emitTo;
    this.onFinish = onFinish;

    this.phase = 'playing';
    this.result = null;
    this.disconnected = new Set();
    this.stacks = { [players[0].id]: START_CHIPS, [players[1].id]: START_CHIPS };
    this.button = players[crypto.randomInt(2)].id;
    this.handNo = 0;
    this.startedAt = Date.now();
    this.level = 0;
    [this.sb, this.bb] = BLIND_LEVELS[0];
    this.log = [];
    this.events = []; // recent happenings, so clients can play a sound for each
    this.eventSeq = 0;
    this.startHand();
  }

  // ---- plumbing -----------------------------------------------------------

  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      try { fn(); } catch (err) { console.error('poker timer failed', err); }
    }, ms);
  }

  other(uid) {
    return this.players.find((p) => p.id !== uid).id;
  }

  name(uid) {
    return this.players.find((p) => p.id === uid).name;
  }

  note(type, uid = null) {
    this.events.push({ seq: ++this.eventSeq, type, uid });
    if (this.events.length > 8) this.events.shift();
  }

  say(text) {
    this.log.unshift(text);
    this.log.length = Math.min(this.log.length, 12);
  }

  broadcast() {
    for (const p of this.players) this.emitTo(p.id, 'match:state', this.publicState(p.id));
  }

  setConnected(uid, connected) {
    if (connected) this.disconnected.delete(uid);
    else this.disconnected.add(uid);
    if (this.phase !== 'finished') this.broadcast();
  }

  publicState(uid) {
    const opp = this.other(uid);
    const acting = this.phase === 'playing' && !this.handResult && this.toAct;
    const myMax = this.bets[uid] + this.stacks[uid];
    const cap = Math.min(myMax, this.bets[opp] + this.stacks[opp]); // no point betting more than can be called
    return {
      game: 'poker',
      id: this.id,
      phase: this.phase,
      players: this.players,
      blinds: [this.sb, this.bb],
      level: this.level + 1,
      nextBlinds: BLIND_LEVELS[this.level + 1] || null,
      nextLevelIn: BLIND_LEVELS[this.level + 1] ? Math.max(0, this.startedAt + (this.level + 1) * LEVEL_MS - Date.now()) : null,
      // What this player holds right now, from the flop onwards (their own hand only).
      myHand: this.board.length >= 3 ? bestHand([...this.hole[uid], ...this.board]).name : null,
      startChips: START_CHIPS,
      stacks: this.stacks,
      button: this.button,
      handNo: this.handNo,
      street: this.street,
      board: this.board,
      pot: this.pot + this.bets[uid] + this.bets[opp],
      bets: this.bets,
      toAct: acting || null,
      toCall: Math.min(Math.max(0, this.bets[opp] - this.bets[uid]), this.stacks[uid]),
      minRaiseTo: Math.min(this.currentBet + Math.max(this.bb, this.lastRaise), cap),
      maxRaiseTo: cap,
      canRaise: cap > this.currentBet && this.stacks[opp] > 0,
      myCards: this.hole[uid],
      oppCards: this.handResult?.showdown ? this.hole[opp] : null,
      handResult: this.handResult,
      log: this.log,
      events: this.events,
      acts: this.acts,
      result: this.result,
      disconnected: [...this.disconnected],
      deadlineIn: acting ? Math.max(0, this.deadline - Date.now()) : null,
    };
  }

  // ---- a hand ---------------------------------------------------------------

  pay(uid, amount) {
    const paid = Math.min(amount, this.stacks[uid]);
    this.stacks[uid] -= paid;
    this.bets[uid] += paid;
    return paid;
  }

  startHand() {
    this.handNo += 1;
    if (this.handNo > 1) this.button = this.other(this.button);
    const level = Math.min(Math.floor((Date.now() - this.startedAt) / LEVEL_MS), BLIND_LEVELS.length - 1);
    if (level !== this.level) {
      this.level = level;
      [this.sb, this.bb] = BLIND_LEVELS[level];
      this.note('blinds');
      this.say(`Blinds go up to ${this.sb}/${this.bb}.`);
    }
    const [sb, bb] = [this.button, this.other(this.button)];
    this.deck = shuffledDeck();
    this.hole = { [sb]: [this.deck.pop(), this.deck.pop()], [bb]: [this.deck.pop(), this.deck.pop()] };
    this.board = [];
    this.pot = 0;
    this.bets = { [sb]: 0, [bb]: 0 };
    this.street = 'preflop';
    this.handResult = null;
    this.pay(sb, this.sb);
    this.pay(bb, this.bb);
    this.currentBet = Math.max(this.bets[sb], this.bets[bb]);
    this.lastRaise = this.bb;
    this.acted = new Set();
    this.acts = {};
    this.note('newhand');
    this.say(`Hand ${this.handNo}: ${this.name(sb)} posts ${this.bets[sb]}, ${this.name(bb)} posts ${this.bets[bb]}.`);
    this.turnTo(sb);
  }

  // Does this player still owe a decision in the current betting round?
  needsToAct(uid) {
    const opp = this.other(uid);
    if (this.stacks[uid] === 0) return false;
    if (this.bets[uid] < this.bets[opp]) return true;
    return !this.acted.has(uid) && this.stacks[opp] > 0;
  }

  // Give the action to `first` if they owe one, otherwise to the other player, otherwise close the round.
  turnTo(first) {
    const next = [first, this.other(first)].find((u) => this.needsToAct(u));
    if (!next) {
      this.endRound();
      return;
    }
    this.toAct = next;
    this.setTimer(ACT_MS, () => {
      const owes = this.bets[this.other(next)] > this.bets[next];
      this.act(next, { type: owes ? 'fold' : 'check' });
    });
    this.broadcast();
  }

  act(uid, action) {
    if (this.phase !== 'playing' || this.handResult || uid !== this.toAct) return;
    const opp = this.other(uid);
    const who = this.name(uid);
    const toCall = Math.max(0, this.bets[opp] - this.bets[uid]);
    let type = action?.type;

    if (type === 'raise') {
      const cap = Math.min(this.bets[uid] + this.stacks[uid], this.bets[opp] + this.stacks[opp]);
      const to = Math.min(Math.floor(Number(action.amount)), cap);
      const minTo = this.currentBet + Math.max(this.bb, this.lastRaise);
      if (!Number.isFinite(to)) return;
      if (to <= this.currentBet) type = 'call'; // cannot actually raise: treat as a call
      else if (to < minTo && to !== cap) return; // below the minimum raise and not all-in
      else {
        const opened = this.currentBet === 0;
        this.pay(uid, to - this.bets[uid]);
        if (to - this.currentBet >= this.lastRaise) this.lastRaise = to - this.currentBet;
        this.currentBet = to;
        this.acted = new Set([uid]);
        const allIn = this.stacks[uid] === 0 ? ' and is all-in' : '';
        this.note(allIn ? 'allin' : opened ? 'bet' : 'raise', uid);
        this.acts[uid] = { type: allIn ? 'allin' : opened ? 'bet' : 'raise', amount: to };
        this.say(`${who} ${opened ? 'bets' : 'raises to'} ${to}${allIn}.`);
        this.turnTo(opp);
        return;
      }
    }

    if (type === 'fold') {
      if (toCall === 0) type = 'check'; // never fold when checking is free
      else {
        const won = this.pot + this.bets[uid] + this.bets[opp];
        this.stacks[opp] += won;
        this.bets = { [uid]: 0, [opp]: 0 };
        this.pot = 0;
        this.note('fold', uid);
        this.acts[uid] = { type: 'fold' };
        this.say(`${who} folds. ${this.name(opp)} wins ${won}.`);
        this.handResult = { winners: [opp], showdown: false, folded: uid, won, text: `${this.name(opp)} wins ${won}` };
        this.finishHand(FOLD_MS);
        return;
      }
    }

    if (type === 'call' && toCall > 0) {
      const paid = this.pay(uid, toCall);
      this.note(this.stacks[uid] === 0 ? 'allin' : 'call', uid);
      this.acts[uid] = { type: this.stacks[uid] === 0 ? 'allin' : 'call', amount: this.bets[uid] };
      this.say(`${who} calls ${paid}${this.stacks[uid] === 0 ? ' and is all-in' : ''}.`);
    } else if (type === 'check' || type === 'call') {
      if (toCall > 0) return; // cannot check facing a bet
      this.note('check', uid);
      this.acts[uid] = { type: 'check' };
      this.say(`${who} checks.`);
    } else {
      return;
    }
    this.acted.add(uid);
    this.turnTo(opp);
  }

  endRound() {
    const [a, b] = this.players.map((p) => p.id);
    // Hand back the part of a bet that could not be matched.
    const diff = this.bets[a] - this.bets[b];
    if (diff !== 0) {
      const big = diff > 0 ? a : b;
      this.stacks[big] += Math.abs(diff);
      this.bets[big] -= Math.abs(diff);
    }
    this.pot += this.bets[a] + this.bets[b];
    this.bets = { [a]: 0, [b]: 0 };
    this.currentBet = 0;
    this.lastRaise = this.bb;
    this.acted = new Set();

    const allIn = this.stacks[a] === 0 || this.stacks[b] === 0;
    if (this.street === 'river' || allIn) {
      // All-in before the river: deal the rest of the board. Clients reveal it card by card,
      // showing each player's chance of winning at every stage.
      let runout = null;
      if (this.board.length < 5) {
        const from = this.board.length;
        while (this.board.length < 5) this.board.push(this.deck.pop());
        const odds = {};
        for (const count of [0, 3, 4].filter((c) => c >= from)) {
          const [pa, pb] = equity(this.hole[a], this.hole[b], this.board.slice(0, count));
          odds[count] = { [a]: pa, [b]: pb };
        }
        runout = { from, odds, stacks: { ...this.stacks }, pot: this.pot };
      }
      this.street = 'river';
      this.showdown(runout);
      return;
    }
    if (this.street === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.street = 'flop';
    } else {
      this.board.push(this.deck.pop());
      this.street = this.street === 'flop' ? 'turn' : 'river';
    }
    this.note(this.street);
    this.acts = {}; // a new betting round
    this.say(`${this.street[0].toUpperCase()}${this.street.slice(1)}: ${this.board.join(' ')}`);
    this.turnTo(this.other(this.button));
  }

  showdown(runout = null) {
    const [a, b] = this.players.map((p) => p.id);
    const hands = {
      [a]: bestHand([...this.hole[a], ...this.board]),
      [b]: bestHand([...this.hole[b], ...this.board]),
    };
    const cmp = compareScores(hands[a].score, hands[b].score);
    const pot = this.pot;
    this.pot = 0;
    let winners;
    let text;
    if (cmp === 0) {
      winners = [a, b];
      const half = Math.floor(pot / 2);
      this.stacks[a] += half;
      this.stacks[b] += half;
      this.stacks[this.other(this.button)] += pot - half * 2; // odd chip to the player out of position
      text = `Split pot: both have ${hands[a].name}`;
    } else {
      const w = cmp > 0 ? a : b;
      winners = [w];
      this.stacks[w] += pot;
      text = `${this.name(w)} wins ${pot} with ${hands[w].name}`;
    }
    this.note('showdown');
    this.say(`Showdown. ${text}.`);
    this.handResult = {
      winners,
      showdown: true,
      text,
      hands: { [a]: hands[a].name, [b]: hands[b].name },
      best: { [a]: hands[a].cards, [b]: hands[b].cards }, // the five cards each hand is made of
      won: pot,
      runout,
    };
    // Leave time for the staged reveal before the next hand.
    const reveal = runout ? 900 + (runout.from < 3 ? 2 : 4 - runout.from) * RUNOUT_STEP_MS + 800 : 0;
    this.finishHand(SHOWDOWN_MS + reveal);
  }

  finishHand(ms) {
    this.toAct = null;
    this.setTimer(ms, () => {
      const broke = this.players.find((p) => this.stacks[p.id] === 0);
      if (broke) this.end(this.other(broke.id), `${this.name(this.other(broke.id))} wins all the chips`);
      else this.startHand();
    });
    this.broadcast();
  }

  // ---- ending ---------------------------------------------------------------

  forfeit(uid) {
    if (this.phase === 'finished') return;
    this.end(this.other(uid), `${this.name(uid)} left the table. ${this.name(this.other(uid))} wins`);
  }

  end(winner, text) {
    clearTimeout(this.timer);
    this.phase = 'finished';
    this.toAct = null;
    this.result = { winner, text };
    this.say(text);
    this.broadcast();
    this.onFinish(this);
  }

  // What gets saved to match history.
  record() {
    return {
      game: 'poker',
      overs: 0,
      played: true,
      players: this.players.map((p) => ({
        user: p.id, name: p.name, team: 'poker', runs: this.stacks[p.id], wickets: 0, balls: this.handNo,
      })),
    };
  }
}
