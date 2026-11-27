import { shownClass } from './botRange.js';

// The bot's feel for the game: the moods and reads a human player carries from hand to hand.
// Nothing here is hidden information: it comes from results, actions everyone saw, cards turned
// face up, and how long people took to act.
//
//   confidence  on a heater after winning pots (bolder), or shaken after losing them
//   tilt        after losing a big pot: looser and more aggressive for a while, then it cools off
//   restless    after folding hand after hand: itching to play, steals more
//   caught      recently shown down a bluff: people will call it, so bluff less, value-bet more
//   tight image folded a lot lately: its bets look strong, so bluffs work better
//   per player: their tilt (just lost big), a grudge (bluffed us and showed it, or keeps
//   pushing us off pots), and how fast they usually act (for timing tells)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function createMood() {
  return { confidence: 0, tilt: 0, restless: 0, caught: 0, folds: [], players: new Map(), handsSeen: 0 };
}

const playerOf = (m, uid) => {
  if (!m.players.has(uid)) m.players.set(uid, { tilt: 0, grudge: 0, pushed: 0, speed: null, actions: 0 });
  return m.players.get(uid);
};

// After each finished hand: update the moods from what happened. Returns the events worth
// reacting to at the table (a big win, a bad beat, a bluff shown...), for the table talk.
export function afterHand(m, hand, myUid, bb) {
  const me = hand.players.find((p) => p.uid === myUid);
  if (!me) return [];
  m.handsSeen += 1;
  const events = [];
  const netBb = me.net / bb;
  const potBb = (hand.pot || 0) / bb;

  // Everything fades a little each hand.
  m.tilt *= 0.82;
  m.caught *= 0.85;
  m.confidence *= 0.9;
  for (const p of m.players.values()) { p.tilt *= 0.75; p.grudge *= 0.96; p.pushed *= 0.9; }

  // My results.
  m.confidence = clamp(m.confidence + clamp(netBb / 40, -0.35, 0.35), -1, 1);
  if (netBb <= -25) { m.tilt = clamp(m.tilt + 0.6, 0, 1); events.push({ kind: 'bigLoss', netBb }); }
  else if (netBb >= 25) events.push({ kind: 'bigWin', netBb });
  else if (netBb >= 8) events.push({ kind: 'win', netBb });

  // Did I play this hand at all?
  const mine = hand.actions.filter((a) => a.seat === me.seat && a.st === 'preflop');
  const played = mine.some((a) => ['call', 'raise', 'bet'].includes(a.t));
  m.folds.push(!played);
  if (m.folds.length > 12) m.folds.shift();
  m.restless = played ? Math.max(0, m.restless - 0.4) : clamp(m.restless + 0.12, 0, 1);
  if (m.restless >= 0.7 && !played) events.push({ kind: 'cardDead' });

  // Caught bluffing: I showed down a weak hand after betting the river.
  const riverAggro = hand.actions.some((a) => a.seat === me.seat && a.st === 'river' && (a.t === 'bet' || a.t === 'raise'));
  // (Only if the table saw my cards.)
  if (riverAggro && me.revealed?.length === 2 && me.revealed.every(Boolean) && hand.board?.length === 5) {
    const cls = shownClass(me.revealed, hand.board);
    if (cls === 'air' || cls === 'weak') { m.caught = 1; events.push({ kind: 'caughtBluffing' }); }
  }

  // The others: their results, what they showed, how they treated me.
  const iFolded = hand.actions.some((a) => a.seat === me.seat && a.t === 'fold');
  for (const p of hand.players) {
    if (p.uid === myUid) continue;
    const o = playerOf(m, p.uid);
    if (p.net / bb <= -25) o.tilt = clamp(o.tilt + 0.7, 0, 1);
    // They won a pot I folded in after their bet: they pushed me off it.
    const theyBet = hand.actions.some((a) => a.seat === p.seat && a.st !== 'preflop' && (a.t === 'bet' || a.t === 'raise'));
    if (iFolded && p.won > 0 && theyBet) o.pushed = clamp(o.pushed + 0.25, 0, 1);
    // They showed a bluff that took my chips: that one stings.
    if (p.revealed?.length === 2 && p.revealed.every(Boolean) && hand.board?.length === 5) {
      const cls = shownClass(p.revealed, hand.board);
      if ((cls === 'air' || cls === 'weak') && theyBet) {
        events.push({ kind: 'theyBluffed', uid: p.uid, seat: p.seat, name: p.name, againstMe: me.net < 0 });
        if (me.net < 0) o.grudge = clamp(o.grudge + 0.6, 0, 1);
      }
    }
    // A bad beat: they won a big pot from me at showdown.
    if (hand.showdown && p.won > 0 && netBb <= -20) events.push({ kind: 'badBeat', uid: p.uid, seat: p.seat, name: p.name });
    if (netBb >= 20 && p.net < 0 && hand.showdown) events.push({ kind: 'crushed', uid: p.uid, seat: p.seat, name: p.name });
  }

  // How fast each player usually acts (for timing tells): a running average of their thinking time.
  let prevAt = null;
  for (const a of hand.actions) {
    if (a.st === 'result' || a.t === 'sb' || a.t === 'bb' || a.t === 'return') { prevAt = a.at ?? prevAt; continue; }
    const pl = hand.players.find((p) => p.seat === a.seat);
    if (pl && pl.uid !== myUid && a.at && prevAt) {
      const took = a.at - prevAt;
      if (took > 0 && took < 30000) {
        const o = playerOf(m, pl.uid);
        o.speed = o.speed == null ? took : o.speed * 0.85 + took * 0.15;
        o.actions += 1;
      }
    }
    prevAt = a.at ?? prevAt;
  }
  return events;
}

// A timing tell on the villain's latest action this street, judged against how fast they usually are.
export function tellFor(m, actions, villainSeat, villainUid, street) {
  const o = m.players.get(villainUid);
  if (!o || o.speed == null || o.actions < 6) return null;
  let prevAt = null;
  let last = null;
  for (const a of actions) {
    if (a.st === street && a.seat === villainSeat && a.at && prevAt) last = { t: a.t, took: a.at - prevAt };
    if (a.at) prevAt = a.at;
  }
  if (!last) return null;
  const ratio = last.took / Math.max(500, o.speed);
  const kind = last.t === 'bet' || last.t === 'raise' ? 'bet' : last.t;
  if (ratio <= 0.45 && last.took < 2500) return { speed: 'snap', action: kind, took: last.took };
  if (ratio >= 2.2 && last.took > 4000) return { speed: 'tank', action: kind, took: last.took };
  return null;
}

// How the mood bends play right now, against this villain. Returns small nudges, and a short
// label for the decision log.
export function moodNow(m, villainUid, { myStack = 0, villainStack = 0, bb = 1 } = {}) {
  const o = villainUid ? m.players.get(villainUid) : null;
  const recentFolds = m.folds.filter(Boolean).length;
  const tightImage = m.folds.length >= 8 && recentFolds / m.folds.length >= 0.75 ? 1 : 0;
  const bully = villainStack > 0 && myStack >= villainStack * 2 && villainStack / bb < 40 ? 1 : 0;
  const short = myStack / bb < 15 ? 1 : 0;
  const bluffMul = clamp(1 + 0.25 * Math.max(0, m.confidence) + 0.3 * m.tilt + 0.25 * tightImage - 0.45 * m.caught + 0.2 * m.restless + 0.25 * bully - 0.15 * Math.max(0, -m.confidence), 0.4, 1.8);
  const callShift = clamp(0.035 * m.tilt + 0.05 * (o?.grudge || 0) + 0.03 * (o?.tilt || 0) - 0.02 * short, -0.03, 0.1);
  const openShift = (m.restless >= 0.6 ? -1 : 0) + (m.tilt >= 0.5 ? -1 : 0);
  const villainBluffMul = clamp(1 + 0.7 * (o?.tilt || 0) + 0.3 * (o?.grudge || 0), 0.5, 2.2);
  const fightBack = (o?.pushed || 0) >= 0.5;
  const tags = [];
  if (m.tilt >= 0.5) tags.push('😤 tilted after a big loss');
  else if (m.confidence >= 0.4) tags.push('😎 on a heater');
  else if (m.confidence <= -0.4) tags.push('😕 card dead and down');
  if (m.restless >= 0.6) tags.push('🥱 restless');
  if (m.caught >= 0.5) tags.push('🎭 caught bluffing, playing it straight');
  else if (tightImage) tags.push('🧊 tight image, bluffs will get respect');
  if (bully) tags.push('🦈 big stack, bullying');
  if (o?.tilt >= 0.5) tags.push('🌋 villain on tilt');
  if (o?.grudge >= 0.4) tags.push('🔥 grudge: he bluffed me');
  if (fightBack) tags.push('🥊 he keeps pushing me around');
  return { bluffMul, callShift, openShift, villainBluffMul, fightBack, label: tags.join(', ') };
}
