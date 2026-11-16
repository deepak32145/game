import { shuffledDeck, bestHand, compareScores, equityMulti } from './handEval.js';

// One No-Limit Texas Hold'em table for 2 to 6 players. It is used for both cash games and
// Sit & Go tournaments; whoever creates it supplies `hooks` for what differs between them.
//
// The table only moves chips between its own seats and the pot. Moving chips between a seat and a
// player's wallet is the caller's job (see manager.js), using the amounts this class reports.
// Server-authoritative: a player is only ever sent their own hole cards until a showdown.

const ACT_MS = 25000; // time to act
const AWAY_MS = 3000; // time given to a disconnected or timed-out player before auto-fold
const SHOWDOWN_MS = 6500;
const FOLD_MS = 4500; // pause after a fold, long enough for the winner to choose to show
const SHOWN_MS = 3000;
const START_MS = 2500; // pause before the first hand once two players are ready
const RUNOUT_STEP_MS = 500; // must match the client: gap between flop, turn and river of an all-in

export class Table {
  constructor({ id, name, kind, maxSeats = 6, blinds, hooks = {}, onChange }) {
    this.id = id;
    this.name = name;
    this.kind = kind; // 'cash' | 'sng'
    this.maxSeats = maxSeats;
    [this.sb, this.bb] = blinds;
    this.hooks = hooks;
    this.onChange = onChange;

    this.seats = Array(maxSeats).fill(null);
    this.button = -1;
    this.handNo = 0;
    this.phase = 'waiting'; // 'waiting' | 'hand' | 'between' | 'closed'
    this.players = []; // the players in the current hand, in order starting left of the button
    this.board = [];
    this.pot = 0;
    this.street = null;
    this.toAct = null;
    this.handResult = null;
    this.log = [];
    this.handLog = []; // everything said during the current hand, oldest first
    this.events = [];
    this.eventSeq = 0;
    this.watchers = 0;
  }

  // ---- plumbing -----------------------------------------------------------

  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      try { fn(); } catch (err) { console.error(`table ${this.id} timer failed`, err); }
    }, ms);
  }

  note(type, uid = null) {
    this.events.push({ seq: ++this.eventSeq, type, uid });
    if (this.events.length > 10) this.events.shift();
  }

  say(text) {
    this.log.unshift(text);
    this.log.length = Math.min(this.log.length, 16);
    if (this.handLog.length < 80) this.handLog.push(text);
  }

  changed() {
    this.onChange(this);
  }

  seatOf(uid) {
    return this.seats.find((p) => p && p.uid === uid) || null;
  }

  get seated() {
    return this.seats.filter(Boolean);
  }

  // Who is dealt in next hand. In a tournament everyone with chips plays, even if away.
  eligible() {
    return this.seated.filter((p) => p.stack > 0 && (this.kind === 'sng' || !p.sittingOut));
  }

  live() {
    return this.players.filter((p) => !p.folded);
  }

  // ---- seats ----------------------------------------------------------------

  addPlayer({ uid, name, picture }, seat, stack) {
    if (this.phase === 'closed' || seat < 0 || seat >= this.maxSeats || this.seats[seat] || this.seatOf(uid)) return false;
    this.seats[seat] = {
      seat, uid, name, picture: picture || '', stack,
      sittingOut: false, connected: true, away: false, pendingTopUp: 0, sitOutSince: 0,
      inHand: false, folded: false, allIn: false, bet: 0, committed: 0, cards: null,
      acted: false, canRaise: true, act: null, handStartStack: stack,
    };
    this.say(`${name} sits down with ${stack}.`);
    this.note('sit', uid);
    this.changed();
    this.maybeStart();
    return true;
  }

  // Takes a player off the table and returns the chips they leave with.
  // If they are in a hand they fold first; what they already put in the pot stays there.
  removePlayer(uid) {
    const p = this.seatOf(uid);
    if (!p) return 0;
    if (this.phase === 'hand' && p.inHand && !p.folded) this.forceFold(p);
    const stack = p.stack + p.pendingTopUp;
    p.stack = 0;
    p.pendingTopUp = 0;
    p.gone = true;
    this.seats[p.seat] = null;
    this.say(`${p.name} leaves the table.`);
    this.changed();
    return stack;
  }

  setConnected(uid, connected) {
    const p = this.seatOf(uid);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    // If it is their turn, don't make the table wait the full clock for someone who has gone.
    if (!connected && this.toAct === p) this.setTimer(AWAY_MS, () => this.timeout(p));
    this.changed();
  }

  // Cash games: sit out to skip hands without giving up the seat.
  setSittingOut(uid, on) {
    const p = this.seatOf(uid);
    if (!p) return;
    p.sittingOut = on;
    p.away = false;
    p.sitOutSince = on ? Date.now() : 0;
    this.changed();
    if (!on) this.maybeStart();
  }

  // Extra chips bought mid-game join the stack at the start of the next hand.
  topUp(uid, amount) {
    const p = this.seatOf(uid);
    if (!p) return false;
    if (p.inHand && this.phase === 'hand') p.pendingTopUp += amount;
    else p.stack += amount;
    this.changed();
    this.maybeStart();
    return true;
  }

  maybeStart() {
    if (this.phase !== 'waiting' || this.startTimer) return;
    if (this.eligible().length < 2) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      try { this.startHand(); } catch (err) { console.error(`table ${this.id} could not start a hand`, err); }
    }, START_MS);
  }

  close() {
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.phase = 'closed';
    this.toAct = null;
  }

  // ---- a hand ---------------------------------------------------------------

  pay(p, amount) {
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.bet += paid;
    p.committed += paid;
    if (p.stack === 0) p.allIn = true;
    return paid;
  }

  startHand() {
    if (this.phase === 'closed') return;
    this.handLog = [];
    for (const p of this.seated) {
      p.stack += p.pendingTopUp;
      p.pendingTopUp = 0;
      Object.assign(p, { inHand: false, folded: false, allIn: false, bet: 0, committed: 0, cards: null, acted: false, canRaise: true, act: null, shown: null });
    }
    this.hooks.beforeHand?.(this);
    this.board = [];
    this.pot = 0;
    this.street = null;
    this.toAct = null;
    this.handResult = null;
    this.players = [];

    const playing = this.eligible();
    if (playing.length < 2) {
      this.phase = 'waiting';
      this.changed();
      return;
    }

    this.phase = 'hand';
    this.handNo += 1;
    // The button moves to the next player who is in this hand.
    const after = (from) => {
      for (let i = 1; i <= this.maxSeats; i++) {
        const p = this.seats[(from + i) % this.maxSeats];
        if (p && playing.includes(p)) return p;
      }
      return null;
    };
    this.button = after(this.button).seat;
    // Order of play after the flop: starting with the first player left of the button.
    let p = after(this.button);
    while (this.players.length < playing.length) {
      this.players.push(p);
      p = after(p.seat);
    }
    const headsUp = this.players.length === 2;
    // Heads-up the button posts the small blind; otherwise it is the player to the button's left.
    const sb = headsUp ? this.players[1] : this.players[0];
    const bb = headsUp ? this.players[0] : this.players[1];
    this.sbSeat = sb.seat;
    this.bbSeat = bb.seat;

    this.deck = shuffledDeck();
    for (const q of this.players) {
      q.inHand = true;
      q.handStartStack = q.stack;
      q.cards = [this.deck.pop(), this.deck.pop()];
    }
    this.pay(sb, this.sb);
    this.pay(bb, this.bb);
    this.street = 'preflop';
    this.currentBet = this.bb;
    this.lastRaise = this.bb;
    this.note('newhand');
    this.say(`Hand ${this.handNo}: ${sb.name} posts ${sb.bet}, ${bb.name} posts ${bb.bet}.`);
    // Before the flop the first to act is the player after the big blind.
    this.turnTo(headsUp ? 1 : 2 % this.players.length);
  }

  canAct(p) {
    return !p.folded && !p.allIn;
  }

  // Does this player still owe a decision in the current betting round?
  needs(p) {
    if (!this.canAct(p)) return false;
    if (p.bet < this.currentBet) return true;
    if (p.acted) return false;
    // Nobody else can respond to a bet, so there is nothing to decide.
    return this.live().filter((q) => this.canAct(q)).length > 1;
  }

  // Give the action to the first player, from position `index`, who owes a decision; else close the round.
  turnTo(index) {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.players[(index + i) % n];
      if (this.needs(p)) {
        this.toAct = p;
        this.setTimer(p.connected && !p.away ? ACT_MS : AWAY_MS, () => this.timeout(p));
        this.changed();
        return;
      }
    }
    this.endRound();
  }

  timeout(p) {
    if (this.toAct !== p) return;
    p.away = true;
    if (this.kind === 'cash') {
      p.sittingOut = true;
      p.sitOutSince = Date.now();
    }
    this.act(p.uid, { type: p.bet < this.currentBet ? 'fold' : 'check' }, true);
  }

  // The most a raise can usefully be: no more than the biggest stack still able to call it.
  raiseCap(p) {
    const others = this.live().filter((q) => q !== p).map((q) => q.bet + q.stack);
    return Math.min(p.bet + p.stack, Math.max(0, ...others));
  }

  act(uid, action, forced = false) {
    const p = this.toAct;
    if (this.phase !== 'hand' || !p || p.uid !== uid) return;
    if (!forced) p.away = false; // they are back
    const owed = Math.max(0, this.currentBet - p.bet);
    let type = action?.type;

    if (type === 'raise') {
      const cap = this.raiseCap(p);
      const to = Math.min(Math.floor(Number(action.amount)), cap);
      const minTo = this.currentBet + this.lastRaise;
      if (!Number.isFinite(to)) return;
      if (to <= this.currentBet) type = 'call'; // cannot actually raise: treat as a call
      else if (!p.canRaise) return; // betting was not reopened to them
      else if (to < minTo && to !== cap) return; // below the minimum raise and not all-in
      else {
        const opened = this.currentBet === 0;
        const size = to - this.currentBet;
        this.pay(p, to - p.bet);
        if (size >= this.lastRaise) {
          // A full raise reopens the betting for everyone else.
          this.lastRaise = size;
          for (const q of this.players) {
            if (q !== p) {
              q.acted = false;
              q.canRaise = true;
            }
          }
        }
        this.currentBet = to;
        p.acted = true;
        p.canRaise = false;
        const kind = p.allIn ? 'allin' : opened ? 'bet' : 'raise';
        p.act = { type: kind, amount: to };
        this.note(kind, uid);
        this.say(`${p.name} ${opened ? 'bets' : 'raises to'} ${to}${p.allIn ? ' and is all-in' : ''}.`);
        this.turnTo(this.players.indexOf(p) + 1);
        return;
      }
    }

    if (type === 'fold') {
      if (owed === 0 && !forced) type = 'check'; // never fold when checking is free
      else {
        p.folded = true;
        p.act = { type: 'fold' };
        this.note('fold', uid);
        this.say(`${p.name} folds.`);
        if (this.live().length === 1) this.winByFold();
        else this.turnTo(this.players.indexOf(p) + 1);
        return;
      }
    }

    if (type === 'call' && owed > 0) {
      const paid = this.pay(p, owed);
      p.act = { type: p.allIn ? 'allin' : 'call', amount: p.bet };
      this.note(p.allIn ? 'allin' : 'call', uid);
      this.say(`${p.name} calls ${paid}${p.allIn ? ' and is all-in' : ''}.`);
    } else if (type === 'check' || type === 'call') {
      if (owed > 0) return; // cannot check facing a bet
      p.act = { type: 'check' };
      this.note('check', uid);
      this.say(`${p.name} checks.`);
    } else {
      return;
    }
    p.acted = true;
    p.canRaise = false;
    this.turnTo(this.players.indexOf(p) + 1);
  }

  // Fold a player who is leaving, whether or not it is their turn.
  forceFold(p) {
    if (this.toAct === p) {
      this.act(p.uid, { type: 'fold' }, true);
      return;
    }
    p.folded = true;
    p.act = { type: 'fold' };
    this.say(`${p.name} folds.`);
    if (this.live().length === 1) this.winByFold();
    else if (this.toAct) this.turnTo(this.players.indexOf(this.toAct)); // the round may now be complete
  }

  // Hand back the part of the biggest bet that nobody matched.
  refundUncalled() {
    const sorted = [...this.players].sort((a, b) => b.bet - a.bet);
    const [top, next] = sorted;
    const extra = top.bet - (next ? next.bet : 0);
    // A player who left the table mid-hand forfeits what they bet: it stays in the pot.
    if (extra > 0 && !top.folded) {
      top.bet -= extra;
      top.committed -= extra;
      top.stack += extra;
      top.allIn = false;
    }
  }

  collectBets() {
    for (const p of this.players) {
      this.pot += p.bet;
      p.bet = 0;
    }
  }

  endRound() {
    this.refundUncalled();
    this.collectBets();
    this.currentBet = 0;
    this.lastRaise = this.bb;
    this.toAct = null;
    for (const p of this.players) {
      p.acted = false;
      p.canRaise = true;
      if (!p.folded && !p.allIn) p.act = null; // keep FOLD and ALL-IN captions on show
    }

    const able = this.live().filter((p) => this.canAct(p));
    if (this.street === 'river' || able.length <= 1) {
      // Nobody left to bet against: deal the rest of the board. Clients reveal it card by card,
      // showing each player's chance of winning at every stage.
      let runout = null;
      if (this.board.length < 5) {
        const from = this.board.length;
        while (this.board.length < 5) this.board.push(this.deck.pop());
        const live = this.live();
        const odds = {};
        for (const count of [0, 3, 4].filter((c) => c >= from)) {
          const pct = equityMulti(live.map((p) => p.cards), this.board.slice(0, count));
          odds[count] = Object.fromEntries(live.map((p, i) => [p.uid, pct[i]]));
        }
        runout = { from, odds, stacks: Object.fromEntries(this.players.map((p) => [p.uid, p.stack])), pot: this.pot };
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
    this.say(`${this.street[0].toUpperCase()}${this.street.slice(1)}: ${this.board.join(' ')}`);
    this.turnTo(0);
  }

  winByFold() {
    this.refundUncalled();
    this.collectBets();
    const winner = this.live()[0];
    const won = this.pot;
    winner.stack += won;
    this.pot = 0;
    this.say(`${winner.name} wins ${won}.`);
    this.handResult = { showdown: false, winners: [winner.uid], won: { [winner.uid]: won }, text: `${winner.name} wins ${won}` };
    this.finishHand(FOLD_MS);
  }

  // Splits the money into a main pot and side pots: a player can only win, from each opponent,
  // as much as they put in themselves.
  buildPots() {
    const live = this.live();
    const levels = [...new Set(live.map((p) => p.committed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const amount = this.players.reduce((sum, p) => sum + Math.min(p.committed, level) - Math.min(p.committed, prev), 0);
      const eligible = live.filter((p) => p.committed >= level);
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length && last.eligible.every((p) => eligible.includes(p))) last.amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // Anything left over (a folded player who had put in more than everyone still in) joins the last pot.
    const counted = pots.reduce((sum, pot) => sum + pot.amount, 0);
    if (pots.length && this.pot > counted) pots[pots.length - 1].amount += this.pot - counted;
    return pots;
  }

  showdown(runout = null) {
    const live = this.live();
    const hands = new Map(live.map((p) => [p, bestHand([...p.cards, ...this.board])]));
    const won = {};
    const potResults = [];
    for (const pot of this.buildPots()) {
      let best = null;
      for (const p of pot.eligible) if (!best || compareScores(hands.get(p).score, best) > 0) best = hands.get(p).score;
      // Winners in order from the button's left, so an odd chip goes to the earliest position.
      const winners = this.players.filter((p) => pot.eligible.includes(p) && compareScores(hands.get(p).score, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const w of winners) {
        const amount = share + (odd-- > 0 ? 1 : 0);
        w.stack += amount;
        won[w.uid] = (won[w.uid] || 0) + amount;
      }
      potResults.push({ amount: pot.amount, winners: winners.map((w) => w.uid) });
    }
    this.pot = 0;

    const top = Object.entries(won).sort((a, b) => b[1] - a[1]);
    const nameOf = (uid) => this.players.find((p) => p.uid === uid).name;
    const main = live.find((p) => p.uid === top[0][0]);
    const text = top.length === 1
      ? `${main.name} wins ${top[0][1]} with ${hands.get(main).name}`
      : top.map(([uid, amount]) => `${nameOf(uid)} wins ${amount}`).join(', ');
    this.note('showdown');
    this.say(`Showdown. ${top.map(([uid, amount]) => `${nameOf(uid)} wins ${amount} (${hands.get(live.find((p) => p.uid === uid)).name})`).join('; ')}.`);
    this.handResult = {
      showdown: true,
      winners: top.map(([uid]) => uid),
      won,
      pots: potResults,
      text,
      hands: Object.fromEntries(live.map((p) => [p.uid, hands.get(p).name])),
      best: Object.fromEntries(live.map((p) => [p.uid, hands.get(p).cards])),
      runout,
    };
    // Leave time for the staged reveal before the next hand.
    const reveal = runout ? 900 + (runout.from < 3 ? 2 : 4 - runout.from) * RUNOUT_STEP_MS + 800 : 0;
    this.finishHand(SHOWDOWN_MS + reveal);
  }

  // After winning without a showdown, the winner may turn over one card or both.
  show(uid, which) {
    const hr = this.handResult;
    if (this.phase !== 'between' || !hr || hr.showdown || hr.winners[0] !== uid) return;
    if (!['first', 'second', 'both'].includes(which)) return;
    const p = this.players.find((q) => q.uid === uid);
    const cards = hr.shown ? [...hr.shown.cards] : [null, null];
    if (which !== 'second') cards[0] = p.cards[0];
    if (which !== 'first') cards[1] = p.cards[1];
    hr.shown = { uid, cards };
    this.note('show', uid);
    this.say(`${p.name} shows ${cards.filter(Boolean).join(' ')}.`);
    this.setTimer(SHOWN_MS, this.afterHand);
    this.changed();
  }

  finishHand(ms) {
    this.toAct = null;
    this.phase = 'between';
    this.afterHand = () => {
      this.record();
      this.hooks.onHandEnd?.(this);
      if (this.phase !== 'closed') this.startHand();
    };
    this.setTimer(ms, this.afterHand);
    this.changed();
  }

  // Hand the finished hand to whoever keeps the history (once per hand).
  record() {
    const hr = this.handResult;
    if (!hr || !this.hooks.record || this.recordedHand === this.handNo) return;
    this.recordedHand = this.handNo;
    try {
      this.hooks.record({
        tableId: this.id,
        tableName: this.name,
        kind: this.kind,
        handNo: this.handNo,
        blinds: [this.sb, this.bb],
        button: this.button,
        board: [...this.board],
        pot: Object.values(hr.won).reduce((a, b) => a + b, 0),
        showdown: hr.showdown,
        players: this.players.map((p) => ({
          uid: p.uid,
          name: p.name,
          seat: p.seat,
          cards: p.cards,
          revealed: hr.showdown && !p.folded ? p.cards : hr.shown?.uid === p.uid ? hr.shown.cards.map((c) => c || '') : [],
          start: p.handStartStack,
          won: hr.won[p.uid] || 0,
          net: (hr.won[p.uid] || 0) - p.committed,
          folded: p.folded,
          hand: hr.hands?.[p.uid] || '',
        })),
        uids: this.players.map((p) => p.uid),
        log: [...this.handLog],
        at: new Date(),
      });
    } catch (err) {
      console.error(`table ${this.id} could not record a hand`, err);
    }
  }

  // ---- what each person is allowed to see ------------------------------------

  publicState(viewer) {
    const me = viewer ? this.seatOf(viewer) : null;
    const hr = this.handResult;
    const inHand = (p) => this.players.includes(p) && p.inHand;
    const cardsFor = (p) => {
      if (!inHand(p) || !p.cards) return null;
      if (p === me) return p.cards;
      if (hr?.showdown && !p.folded) return p.cards;
      if (hr?.shown?.uid === p.uid) return hr.shown.cards;
      return null;
    };
    const myTurn = me && this.toAct === me;
    const cap = me && inHand(me) && this.phase === 'hand' ? this.raiseCap(me) : 0;
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      maxSeats: this.maxSeats,
      blinds: [this.sb, this.bb],
      phase: this.phase,
      handNo: this.handNo,
      street: this.street,
      board: this.board,
      pot: this.pot + this.players.reduce((sum, p) => sum + p.bet, 0),
      button: this.button,
      sbSeat: this.phase === 'hand' ? this.sbSeat : null,
      bbSeat: this.phase === 'hand' ? this.bbSeat : null,
      seats: this.seats.map((p) => p && {
        seat: p.seat,
        uid: p.uid,
        name: p.name,
        picture: p.picture,
        stack: p.stack,
        bet: inHand(p) ? p.bet : 0,
        inHand: inHand(p),
        folded: inHand(p) && p.folded,
        allIn: inHand(p) && p.allIn && !p.folded,
        sittingOut: p.sittingOut,
        away: p.away || !p.connected,
        act: inHand(p) ? p.act : null,
        cards: cardsFor(p),
        hasCards: inHand(p) && !p.folded,
      }),
      toAct: this.toAct ? this.toAct.seat : null,
      deadlineIn: this.toAct ? Math.max(0, this.deadline - Date.now()) : null,
      mySeat: me ? me.seat : null,
      toCall: myTurn ? Math.min(Math.max(0, this.currentBet - me.bet), me.stack) : 0,
      minRaiseTo: myTurn ? Math.min(this.currentBet + this.lastRaise, cap) : 0,
      maxRaiseTo: myTurn ? cap : 0,
      canRaise: !!myTurn && me.canRaise && cap > this.currentBet,
      currentBet: this.phase === 'hand' ? this.currentBet : 0,
      // What this player holds right now, from the flop onwards (their own hand only).
      myHand: me && inHand(me) && !me.folded && this.board.length >= 3 ? bestHand([...me.cards, ...this.board]).name : null,
      handResult: hr,
      log: this.log,
      events: this.events,
      watchers: this.watchers,
      info: this.hooks.info?.(this) || null,
    };
  }
}
