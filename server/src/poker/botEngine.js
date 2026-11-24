import { equityVsRandom, equityVsBettor, features } from './botRead.js';

// The bot's free brain: a rule-based poker player that runs on the server, with no API calls.
// It reads the same things Claude is given (its cards and the board, draws, equity, position,
// pot odds, each opponent's style this session) and decides with poker rules of thumb, mixing
// its lines with a random roll so it is not predictable.
//
// decide(sit) takes a situation built by bots.js and returns { action, amount, reason }.

const RANKS = '23456789TJQKA';
const rank = (c) => RANKS.indexOf(c[0]);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pct = (x) => `${Math.round(x * 100)}%`;

// How bold each style is: shifts the pre-flop thresholds and scales bluffing.
export const STYLES = {
  tight: { shift: 1, bluff: 0.6, label: 'Tight' },
  balanced: { shift: 0, bluff: 1, label: 'Balanced' },
  aggressive: { shift: -1, bluff: 1.35, label: 'Aggressive' },
};

// Bill Chen's quick score for two hole cards: about -1 (7-2) to 20 (A-A).
export function chen(hole) {
  const [a, b] = hole.map(rank).sort((x, y) => y - x);
  const pts = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  if (a === b) return Math.max(5, pts(a) * 2);
  let s = pts(a);
  if (hole[0][1] === hole[1][1]) s += 2;
  const gap = a - b - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && a < 10) s += 1;
  // Chen undervalues weak aces and kings in short-handed games; nudge them up.
  if (a === 12) s += 2;
  else if (a === 11) s += 1;
  return Math.ceil(s);
}

// What kind of player an opponent has been this session (needs a few hands to tell).
export function profile(o) {
  if (!o || o.hands < 5) return 'unknown';
  const vpip = o.vpip / o.hands;
  const pfr = o.pfr / o.hands;
  const aggr = o.calls ? o.bets / o.calls : o.bets ? 3 : 0;
  if (aggr >= 2.5 || pfr >= 0.35) return 'maniac';
  if (vpip >= 0.45 && aggr < 1.2) return 'station';
  if (vpip <= 0.2) return 'nit';
  return 'regular';
}

const bet = (amount, reason) => ({ action: 'raise', amount: Math.round(amount), reason });
const call = (reason) => ({ action: 'call', amount: 0, reason });
const check = (reason) => ({ action: 'check', amount: 0, reason });
const fold = (reason) => ({ action: 'fold', amount: 0, reason });

export function decide(sit) {
  const style = STYLES[sit.style] || STYLES.aggressive;
  return sit.street === 'preflop' ? preflop(sit, style) : postflop(sit, style);
}

// A raise that commits most of the stack should just be all-in.
function sized(sit, to) {
  const total = Math.round(to);
  if (total >= sit.maxRaiseTo * 0.45) return sit.maxRaiseTo;
  return clamp(total, sit.minRaiseTo, sit.maxRaiseTo);
}

// ---------------- before the flop ----------------

function preflop(sit, style) {
  const { hole, bb, toCall, roll } = sit;
  const score = chen(hole);
  const suited = hole[0][1] === hole[1][1];
  const hi = Math.max(...hole.map(rank));
  const lo = Math.min(...hole.map(rank));
  const pair = hi === lo;
  const stackBb = sit.stack / bb;
  const facing = sit.myBet + toCall; // the bet to match
  const raises = sit.preRaises; // raises so far this hand (blinds don't count)
  const hu = sit.players === 2;
  const late = ['BTN', 'CO', 'BTN/SB'].includes(sit.pos);
  const raiser = profile(sit.lastRaiser);
  const s = style.shift;
  const name = `${hole.join(' ')} (score ${score})`;
  const looseTable = !hu && (sit.tableVpip ?? 0) >= 0.5; // most players here call too much: no point stealing
  // Hands that make good bluffs: they block big hands or play well when called.
  const bluffCandidate = suited ? hi === 12 || hi - lo <= 2 || hi >= 10 : hi === 12 && lo >= 6;

  // Short-stacked: shove or fold (wider heads-up, where any ace or king is strong).
  if (stackBb <= 15) {
    if (raises === 0) {
      const pushAt = (hu ? 1 : 5) + (stackBb / 15) * 5 - (late || sit.pos === 'SB' ? 1.5 : 0) + s;
      if (score >= pushAt) return bet(sit.maxRaiseTo, `short stack shove with ${name}`);
      return toCall === 0 ? check('short stack, free look') : fold(`short stack, ${name} too weak to shove`);
    }
    const callAt = (hu ? 6 : 9) + (raiser === 'maniac' || raiser === 'station' ? 0 : 1) + s;
    if (score >= callAt) return sit.canRaise ? bet(sit.maxRaiseTo, `short stack, all-in with ${name}`) : call(`short stack call with ${name}`);
    return fold(`short stack, ${name} not good enough against a raise`);
  }

  // Nobody has raised: open, isolate limpers, or check the big blind.
  if (raises === 0) {
    // Heads-up the button opens most hands; six-handed it depends on position.
    const openAt = (hu ? 2 : { UTG: 8, MP: 7, CO: 6, BTN: 4, SB: 6, BB: 7 }[sit.pos] ?? 7) + s + (sit.limpers ? 1 : 0) + (looseTable ? 2 : 0);
    if (score >= openAt || (late && !looseTable && bluffCandidate && roll <= 45 * style.bluff)) {
      const open = looseTable ? 3.5 : hu ? (roll <= 50 ? 2 : 2.5) : roll <= 33 ? 2.2 : roll <= 80 ? 2.5 : 3;
      return bet(sized(sit, (open + sit.limpers) * bb), sit.limpers ? `isolation raise with ${name}` : `open-raise from ${sit.pos} with ${name}`);
    }
    // In the big blind after a limp: raise good hands and some bluffs, check the rest.
    if (toCall === 0) {
      if (sit.canRaise && (score >= 9 + s || (bluffCandidate && roll <= 20 * style.bluff))) return bet(sized(sit, (3 + sit.limpers) * bb), `raise the limp with ${name}`);
      return check(`${name}: check the big blind`);
    }
    if (sit.pos === 'SB' && toCall <= bb / 2 && score >= 4 + s) return call(`complete the small blind with ${name}`);
    return fold(`${name} too weak to open from ${sit.pos}`);
  }

  const share = toCall / sit.stack; // how much of my stack the call is
  // Facing one raise.
  if (raises === 1) {
    const loose = raiser === 'maniac' || raiser === 'station' || hu;
    const valueAt = (hu ? 9 : loose ? 10 : raiser === 'nit' ? 12 : 11) + s;
    // Defend wider when the price is good: in the big blind, heads-up, or against a small raise.
    let callAt = (hu ? 4 : late || sit.pos === 'BB' ? 6 : 8) + (raiser === 'nit' ? 2 : raiser === 'maniac' ? -1 : 0) + s;
    if (facing <= 2.5 * bb) callAt -= 1;
    if (facing >= 4 * bb) callAt += 2;
    if (share >= 0.35) {
      return score >= valueAt - (hu ? 2 : 0) ? (sit.canRaise ? bet(sit.maxRaiseTo, `all-in with ${name}`) : call(`call the big raise with ${name}`)) : fold(`${name} not strong enough for a big raise`);
    }
    const threeBet = sized(sit, facing * (sit.inPosition ? 3 : hu ? 3.5 : 4));
    if (score >= valueAt && sit.canRaise) return bet(threeBet, `3-bet for value with ${name}`);
    if (bluffCandidate && sit.canRaise && raiser !== 'station' && roll <= (hu ? 30 : 20) * style.bluff) return bet(threeBet, `3-bet bluff with ${name}`);
    if (score >= callAt || (pair && share <= 0.08)) return call(pair && score < callAt ? `set-mine with ${name}` : `defend with ${name}`);
    return fold(`${name} too weak against a raise`);
  }

  // Facing a 3-bet or more.
  const fourAt = (hu ? 10 : raiser === 'maniac' ? 12 : 13) + s;
  if (score >= fourAt) return sit.canRaise ? bet(sized(sit, facing * 2.3), `4-bet with ${name}`) : call(`call with ${name}`);
  if (sit.iRaised && bluffCandidate && hi >= 11 && sit.canRaise && roll <= (hu ? 14 : 8) * style.bluff) return bet(sized(sit, facing * 2.3), `4-bet bluff with ${name}`);
  if (score >= (hu ? 6 : 10) + s && share <= 0.25) return call(`call the re-raise with ${name}`);
  return fold(`${name} not strong enough against a re-raise`);
}

// ---------------- after the flop ----------------

function postflop(sit, style) {
  const { hole, board, pot, toCall, roll, street } = sit;
  const f = features(hole, board);
  const opps = Math.max(1, sit.opponents);
  const hu = opps === 1;
  const eq = equityVsRandom(hole, board, opps) / 100;
  const fair = 1 / (opps + 1);
  const strength = clamp((eq - fair) / (1 - fair), 0, 1); // 0 = average hand, 1 = the nuts
  const strongDraw = (f.flushDraw || f.oesd) && street !== 'river';
  const someEquity = (f.gutshot || f.overcards || f.backdoor) && street !== 'river';
  const main = profile(sit.aggressor || sit.mainOpponent);
  const bluff = (style.bluff * (main === 'station' ? 0.3 : main === 'nit' ? 1.4 : 1)) / opps;
  const what = `${f.made}${f.draws.length ? ` + ${f.draws[0]}` : ''}`;
  const potBet = (x) => sized(sit, sit.myBet + pot * x);

  // ---- nobody has bet: check or bet ----
  if (toCall === 0) {
    if (!sit.canRaise) return check('nothing to bet');
    const valueAt = (main === 'station' ? 0.3 : hu ? 0.32 : 0.4) + (opps - 1) * 0.02;
    if (strength >= 0.9) {
      // Out of position, check some monsters to check-raise; in position, slow-play some on dry boards.
      if (!sit.inPosition && street !== 'river' && roll <= 30 * style.bluff) return check(`check to check-raise with ${what}`);
      if (!f.wet && street !== 'river' && roll <= 20 * style.bluff) return check(`slow-play ${what}`);
      if (street === 'river' && roll <= 30) return bet(potBet(1.25), `overbet the river with ${what}`);
      return bet(potBet(f.wet ? 0.75 : 0.55), `value bet ${what} (${pct(eq)})`);
    }
    if (strength >= valueAt) {
      if (!sit.inPosition && (strength >= 0.6 || strongDraw) && street !== 'river' && roll <= 20 * style.bluff) return check(`check to check-raise with ${what}`);
      return bet(potBet(main === 'station' || (sit.tableVpip ?? 0) >= 0.5 ? 0.8 : street === 'flop' && !f.wet ? 0.4 : 0.66), `value bet ${what} (${pct(eq)})`);
    }
    // Draws: bet them as semi-bluffs, or check planning to check-raise.
    if (strongDraw) {
      if (!sit.inPosition && roll <= 30 * style.bluff) return check(`check to check-raise ${f.draws[0]}`);
      if (roll <= 65 * bluff * opps ** 0.5) return bet(potBet(0.6), `semi-bluff ${f.draws[0]}`);
    }
    // We called a bet in position last street and they've checked now: they gave up, take it.
    if (sit.floated && sit.inPosition && roll <= (street === 'river' ? 55 : 75) * Math.min(1.3, bluff * opps)) {
      return bet(potBet(street === 'river' ? 0.66 : 0.5), 'they gave up after my float: take the pot');
    }
    if (sit.hadInitiative) {
      const freq = street === 'flop' ? (f.wet ? 40 : hu ? 58 : 55) : street === 'turn' ? (someEquity ? 60 : 40) : strength < 0.15 ? (hu ? 35 : 28) : 0;
      if (roll <= freq * bluff) {
        const size = street === 'flop' ? (f.wet ? 0.66 : 0.33) : street === 'turn' ? 0.66 : 0.75;
        return bet(potBet(size), street === 'flop' ? `c-bet ${f.wet ? 'wet' : 'dry'} board` : street === 'turn' ? 'second barrel' : 'river bluff');
      }
    } else if (sit.checkedToMe && sit.inPosition && opps <= 2 && roll <= (street === 'river' ? 25 : 45) * bluff) {
      return bet(potBet(0.5), 'stab when checked to');
    } else if (!sit.inPosition && hu && (someEquity || strength >= 0.25) && roll <= 12 * style.bluff) {
      return bet(potBet(0.4), `lead out with ${what}`);
    }
    return check(`check ${what} (${pct(eq)})`);
  }

  // ---- facing a bet ----
  const potBefore = pot - toCall > 0 ? pot - toCall : pot;
  const betRatio = clamp(toCall / Math.max(1, potBefore), 0, 1.5);
  // Their betting range is stronger than random cards: weigh my hand against the hands this player
  // would bet here (pairs, draws, and bluffs as often as their style suggests). Heads-up people bet wider.
  let bluffRate = { maniac: 0.55, nit: 0.12, station: 0.08 }[main] ?? (hu ? 0.42 : 0.3);
  if (betRatio > 1) bluffRate *= 0.8;
  if (street === 'river') bluffRate *= 0.8;
  const reraised = sit.streetRaises >= 2;
  if (reraised) bluffRate *= 0.35;
  const adj = equityVsBettor(hole, board, opps, { bluffRate, minCat: reraised ? 2 : 1 }) / 100;
  let need = toCall / (pot + toCall);
  if ((strongDraw || someEquity) && sit.stack > toCall * 4) need -= strongDraw ? 0.06 : 0.03; // implied odds
  const checkedFirst = sit.iCheckedThisStreet; // they bet into my check: a check-raise spot
  const raiseTo = sized(sit, (sit.myBet + toCall) * (checkedFirst ? 3 : 2.8));

  // Big hands raise (sometimes just call to trap, mostly on the flop).
  if (sit.canRaise && (adj >= 0.7 || strength >= 0.92)) {
    if (street === 'flop' && !checkedFirst && roll <= 20) return call(`slow-play ${what}, just call`);
    return bet(raiseTo, `${checkedFirst ? 'check-raise' : 'raise'} for value with ${what} (${pct(adj)} vs their range)`);
  }
  // Draws: raise as a semi-bluff (more after checking), else call if the price is right.
  if (sit.canRaise && strongDraw && !reraised && roll <= (checkedFirst ? 40 : 25) * bluff * opps) {
    return bet(raiseTo, `${checkedFirst ? 'check-raise' : 'raise'} semi-bluff with ${f.draws[0]}`);
  }
  // Now and then raise a weaker hand with some equity as a bluff, heads-up against a player who can fold.
  if (sit.canRaise && hu && !reraised && street !== 'river' && someEquity && main !== 'station' && roll <= 8 * style.bluff) {
    return bet(raiseTo, `${checkedFirst ? 'check-raise' : 'raise'} bluff with ${what}`);
  }
  if (adj >= need) return call(`call with ${what}: ${pct(adj)} vs their range, ${pct(need)} needed`);
  // Float: in position heads-up against a modest bet, call with some equity planning to take it away later.
  if (hu && sit.inPosition && street !== 'river' && betRatio <= 0.75 && (someEquity || strength >= 0.2) && main !== 'nit' && roll <= 45 * style.bluff) {
    return call(`float with ${what}, take it away later`);
  }
  return fold(`fold ${what}: ${pct(adj)} vs their range, ${pct(need)} needed`);
}
