import { TEAMS, TEAM_BY_ID } from './teams.js';
import {
  RUNUP_MS, createInnings, prepareDelivery, resolveBall, applyOutcome, describeBall,
} from './engine.js';

const TEAM_SELECT_MS = 60000;
const TOSS_MS = 20000;
const BOWLER_MS = 20000;
const DELIVERY_MS = 15000;
const SHOT_GRACE_MS = 2500;
const RESULT_MS = 3600;
const BREAK_MS = 7000;

// One live match between two users. Server-authoritative: clients send intents,
// the room validates them against the current phase and broadcasts the new state.
export class MatchRoom {
  constructor({ id, players, overs, emitTo, onFinish, rng = Math.random }) {
    this.id = id;
    this.players = players; // [{ id, name, picture }], challenger first
    this.overs = overs;
    this.emitTo = emitTo;
    this.onFinish = onFinish;
    this.rng = rng;

    this.phase = 'team_select';
    this.teams = { [players[0].id]: null, [players[1].id]: null };
    this.toss = { caller: players[1].id, stage: 'call', call: null, coin: null, winner: null, choice: null };
    this.innings = [];
    this.current = 0;
    this.target = null;
    this.result = null;
    this.commentary = [];
    this.disconnected = new Set();
    this.delivery = null;
    this.maxOversPerBowler = Math.max(1, Math.ceil(overs / 5));

    this.setTimer(TEAM_SELECT_MS, () => this.autoTeams());
  }

  // ---- plumbing -----------------------------------------------------------

  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      try { fn(); } catch (err) { console.error('match timer failed', err); }
    }, ms);
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.deadline = null;
  }

  other(uid) {
    return this.players.find((p) => p.id !== uid).id;
  }

  name(uid) {
    return this.players.find((p) => p.id === uid).name;
  }

  get inn() {
    return this.innings[this.current];
  }

  say(text) {
    this.commentary.unshift(text);
    this.commentary.length = Math.min(this.commentary.length, 8);
  }

  emitAll(event, payload) {
    for (const p of this.players) this.emitTo(p.id, event, payload);
  }

  broadcast() {
    this.emitAll('match:state', this.publicState());
  }

  publicState() {
    const waiting = ['in_flight', 'result'].includes(this.inn?.ballPhase) || this.phase === 'finished';
    return {
      game: 'cricket',
      id: this.id,
      overs: this.overs,
      phase: this.phase,
      players: this.players,
      teams: this.teams,
      toss: this.toss,
      innings: this.innings,
      current: this.current,
      target: this.target,
      result: this.result,
      commentary: this.commentary,
      disconnected: [...this.disconnected],
      maxOversPerBowler: this.maxOversPerBowler,
      eligibleBowlers: this.phase === 'innings' ? this.eligibleBowlers() : [],
      deadlineIn: this.deadline && !waiting ? Math.max(0, this.deadline - Date.now()) : null,
    };
  }

  setConnected(uid, connected) {
    if (connected) this.disconnected.delete(uid);
    else this.disconnected.add(uid);
    if (this.phase !== 'finished') this.broadcast();
  }

  // ---- team selection -----------------------------------------------------

  pickTeam(uid, teamId) {
    if (this.phase !== 'team_select' || !TEAM_BY_ID[teamId]) return;
    if (this.teams[this.other(uid)] === teamId) return;
    this.teams[uid] = teamId;
    if (Object.values(this.teams).every(Boolean)) this.startToss();
    else this.broadcast();
  }

  autoTeams() {
    for (const p of this.players) {
      if (this.teams[p.id]) continue;
      const taken = this.teams[this.other(p.id)];
      const free = TEAMS.filter((t) => t.id !== taken);
      this.teams[p.id] = free[Math.floor(this.rng() * free.length)].id;
    }
    this.startToss();
  }

  // ---- toss ---------------------------------------------------------------

  startToss() {
    this.phase = 'toss';
    this.setTimer(TOSS_MS, () => this.tossCall(this.toss.caller, 'heads'));
    this.broadcast();
  }

  tossCall(uid, call) {
    const t = this.toss;
    if (this.phase !== 'toss' || t.stage !== 'call' || uid !== t.caller) return;
    t.call = call === 'tails' ? 'tails' : 'heads';
    t.coin = this.rng() < 0.5 ? 'heads' : 'tails';
    t.winner = t.coin === t.call ? uid : this.other(uid);
    t.stage = 'choose';
    this.setTimer(TOSS_MS, () => this.tossChoice(t.winner, 'bat'));
    this.broadcast();
  }

  tossChoice(uid, choice) {
    const t = this.toss;
    if (this.phase !== 'toss' || t.stage !== 'choose' || uid !== t.winner) return;
    t.choice = choice === 'bowl' ? 'bowl' : 'bat';
    t.stage = 'done';
    this.say(`${this.name(uid)} won the toss and chose to ${t.choice} first.`);
    this.startInnings(t.choice === 'bat' ? uid : this.other(uid));
  }

  // ---- innings ------------------------------------------------------------

  team(uid) {
    return TEAM_BY_ID[this.teams[uid]];
  }

  startInnings(battingUser) {
    const bowlingUser = this.other(battingUser);
    this.innings.push(createInnings(battingUser, bowlingUser, this.team(battingUser), this.team(bowlingUser)));
    this.current = this.innings.length - 1;
    this.phase = 'innings';
    this.awaitBowler();
  }

  eligibleBowlers() {
    const inn = this.inn;
    if (!inn) return [];
    const canBowl = (b, i) => b.kind && i !== inn.lastBowler;
    const idx = inn.bowlers.map((_, i) => i);
    const fresh = idx.filter((i) => canBowl(inn.bowlers[i], i) && inn.bowlers[i].balls < this.maxOversPerBowler * 6);
    return fresh.length ? fresh : idx.filter((i) => canBowl(inn.bowlers[i], i));
  }

  awaitBowler() {
    const inn = this.inn;
    inn.ballPhase = 'select_bowler';
    this.setTimer(BOWLER_MS, () => this.selectBowler(inn.bowlingUser, this.eligibleBowlers()[0]));
    this.broadcast();
  }

  selectBowler(uid, idx) {
    const inn = this.inn;
    if (this.phase !== 'innings' || inn.ballPhase !== 'select_bowler' || uid !== inn.bowlingUser) return;
    if (!this.eligibleBowlers().includes(idx)) return;
    inn.currentBowler = idx;
    inn.thisOver = [];
    this.awaitDelivery();
  }

  awaitDelivery() {
    const inn = this.inn;
    inn.ballPhase = 'await_delivery';
    this.setTimer(DELIVERY_MS, () =>
      this.bowl(inn.bowlingUser, {
        variation: 'stock',
        line: -0.3 + this.rng() * 0.8,
        length: 0.3 + this.rng() * 0.3,
      })
    );
    this.broadcast();
  }

  bowl(uid, input) {
    const inn = this.inn;
    if (this.phase !== 'innings' || inn.ballPhase !== 'await_delivery' || uid !== inn.bowlingUser) return;
    const bowler = this.team(inn.bowlingUser).players[inn.currentBowler];
    this.delivery = prepareDelivery(bowler, input || {}, this.rng);
    inn.ballPhase = 'in_flight';
    this.setTimer(RUNUP_MS + this.delivery.flightMs + SHOT_GRACE_MS, () =>
      this.shot(inn.battingUser, { none: true })
    );
    this.emitAll('ball:start', { ...this.delivery, runupMs: RUNUP_MS });
    this.broadcast();
  }

  shot(uid, input) {
    const inn = this.inn;
    if (this.phase !== 'innings' || inn.ballPhase !== 'in_flight' || uid !== inn.battingUser) return;
    const batter = this.team(inn.battingUser).players[inn.striker];
    const bowler = this.team(inn.bowlingUser).players[inn.currentBowler];
    const res = resolveBall(this.delivery, input || { none: true }, batter, bowler, this.rng);
    const text = describeBall(res, batter.name, bowler.name);
    const { overComplete } = applyOutcome(inn, res, { overs: this.overs, target: this.target });

    inn.ballPhase = 'result';
    this.say(text);
    this.emitAll('ball:result', { ...res, text });
    this.setTimer(RESULT_MS, () => this.afterBall(overComplete));
    this.broadcast();
  }

  afterBall(overComplete) {
    const inn = this.inn;
    if (inn.done) {
      if (this.current === 0) {
        this.target = inn.runs + 1;
        this.phase = 'innings_break';
        this.say(`${this.name(inn.bowlingUser)} needs ${this.target} to win.`);
        this.setTimer(BREAK_MS, () => this.startInnings(inn.bowlingUser));
        this.broadcast();
      } else {
        this.finish();
      }
    } else if (overComplete) {
      this.awaitBowler();
    } else {
      this.awaitDelivery();
    }
  }

  // ---- ending -------------------------------------------------------------

  finish() {
    const [first, second] = this.innings;
    let winner = null;
    let text = 'Match tied!';
    if (second.runs > first.runs) {
      winner = second.battingUser;
      const left = second.batters.length - 1 - second.wickets;
      text = `${this.team(winner).name} win by ${left} wicket${left === 1 ? '' : 's'}`;
    } else if (first.runs > second.runs) {
      winner = first.battingUser;
      const by = first.runs - second.runs;
      text = `${this.team(winner).name} win by ${by} run${by === 1 ? '' : 's'}`;
    }
    this.end(winner, text);
  }

  forfeit(uid) {
    if (this.phase === 'finished') return;
    this.end(this.other(uid), `${this.name(uid)} forfeited. ${this.name(this.other(uid))} wins`);
  }

  // What gets saved to match history.
  record() {
    return {
      game: 'cricket',
      overs: this.overs,
      played: this.innings.length > 0,
      players: this.players.map((p) => {
        const inn = this.innings.find((i) => i.battingUser === p.id);
        return {
          user: p.id, name: p.name, team: this.teams[p.id],
          runs: inn?.runs ?? 0, wickets: inn?.wickets ?? 0, balls: inn?.balls ?? 0,
        };
      }),
    };
  }

  end(winner, text) {
    this.clearTimer();
    this.phase = 'finished';
    this.result = { winner, text };
    this.say(text);
    this.broadcast();
    this.onFinish(this);
  }
}
