import { bestHand, compareScores } from './handEval.js';

// What a good player sees at a glance, worked out for the bot so it can play more than ABC poker:
// how its made hand ranks against the board, its draws and outs, the board's texture, and its
// equity against the opponents still in. Only the bot's own cards and the board are used.

const RANKS = '23456789TJQKA';
const NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const rank = (c) => RANKS.indexOf(c[0]);
const FULL_DECK = [];
for (const r of RANKS) for (const s of 'shdc') FULL_DECK.push(r + s);

// Is there a five-in-a-row in this set of ranks (the ace also counts low)?
function hasStraight(ranks) {
  const set = new Set(ranks);
  if (set.has(12)) set.add(-1);
  for (let hi = 12; hi >= 3; hi--) {
    let ok = true;
    for (let k = 0; k < 5 && ok; k++) ok = set.has(hi - k);
    if (ok) return true;
  }
  return false;
}

// How the made hand sits against the board: "top pair, Ace kicker", "overpair", "set"...
function madeHand(hole, board) {
  const best = bestHand([...hole, ...board]);
  const cat = best.score[0];
  const b = board.map(rank).sort((x, y) => y - x);
  const h = hole.map(rank).sort((x, y) => y - x);
  const boardBest = board.length >= 5 ? bestHand(board) : null;
  if (boardBest && compareScores(best.score, boardBest.score) === 0) return `${best.name} (playing the board)`;
  if (cat === 1) {
    const pairRank = best.score[1];
    if (b.filter((r) => r === pairRank).length === 2) return `${best.name}, on the board only: really ${NAMES[h[0]]} high`;
    if (h[0] === h[1]) {
      if (pairRank > b[0]) return `overpair (${best.name})`;
      return `pocket pair below the top card (${best.name})`;
    }
    const kicker = h.find((r) => r !== pairRank);
    const uniq = [...new Set(b)];
    if (pairRank === uniq[0]) return `top pair, ${NAMES[kicker]} kicker`;
    if (pairRank === uniq[1]) return `second pair, ${NAMES[kicker]} kicker`;
    return `weak pair (${best.name})`;
  }
  if (cat === 2) {
    const usesBoth = h[0] !== h[1] && best.score.slice(1, 3).every((r) => h.includes(r));
    const boardPaired = new Set(b).size < b.length;
    if (usesBoth) return `two pair using both your cards (${best.name})`;
    if (boardPaired) return `${best.name}, one pair is on the board`;
    return best.name;
  }
  if (cat === 3) return h[0] === h[1] && h[0] === best.score[1] ? `set (${best.name})` : `trips (${best.name})`;
  return best.name;
}

function draws(hole, board) {
  if (board.length < 3 || board.length > 4) return [];
  const out = [];
  const all = [...hole, ...board];
  const made = bestHand(all).score[0];
  // Flush draws.
  if (made < 5) {
    for (const s of 'shdc') {
      const n = all.filter((c) => c[1] === s).length;
      const mine = hole.filter((c) => c[1] === s);
      if (!mine.length) continue;
      if (n === 4) {
        const missing = [...RANKS].reverse().find((r) => !all.includes(r + s));
        const nut = mine.some((c) => c[0] === missing) || mine.some((c) => c[0] === 'A');
        out.push(`${nut ? 'nut ' : ''}flush draw (9 outs)`);
      } else if (n === 3 && board.length === 3 && mine.length === 2) out.push('backdoor flush draw');
    }
  }
  // Straight draws: which ranks would complete a straight that uses one of my cards?
  if (made < 4) {
    const allRanks = all.map(rank);
    const boardRanks = board.map(rank);
    let fills = 0;
    for (let r = 0; r < 13; r++) {
      if (allRanks.includes(r)) continue;
      if (hasStraight([...allRanks, r]) && !hasStraight([...boardRanks, r])) fills++;
    }
    if (fills >= 2) out.push('open-ended straight draw (8 outs)');
    else if (fills === 1) out.push('gutshot straight draw (4 outs)');
  }
  // Two overcards with nothing made yet.
  if (made === 0 && hole.every((c) => rank(c) > Math.max(...board.map(rank)))) out.push('two overcards (6 outs)');
  return out;
}

function texture(board) {
  if (board.length < 3) return '';
  const suits = Math.max(...'shdc'.split('').map((s) => board.filter((c) => c[1] === s).length));
  const ranks = board.map(rank);
  const bits = [];
  bits.push(suits >= 3 ? `${suits === board.length ? 'monotone' : `${suits} of one suit`}: a flush is possible` : suits === 2 && board.length < 5 ? 'two-tone: flush draws possible' : 'no flush possible');
  if (new Set(ranks).size < ranks.length) bits.push('paired');
  // Three board cards inside any five-rank window make a straight possible.
  const set = new Set(ranks);
  if (set.has(12)) set.add(-1);
  let conn = false;
  for (let lo = -1; lo <= 8 && !conn; lo++) {
    let n = 0;
    for (let k = 0; k < 5; k++) if (set.has(lo + k)) n++;
    conn = n >= 3;
  }
  bits.push(conn ? 'connected: a straight is possible' : 'disconnected');
  const high = Math.max(...ranks);
  bits.push(high >= 10 ? `high (${NAMES[high]} high)` : `low (${NAMES[high]} high)`);
  return bits.join(', ');
}

// Chance of winning against `opponents` players holding random cards, from 0 to 100.
// Kept to a few hundred samples (about ±3%) so a read takes tens of milliseconds, not more.
export function equityVsRandom(hole, board, opponents, samples = opponents >= 3 ? 200 : 350) {
  if (opponents < 1) return 100;
  const dead = new Set([...hole, ...board]);
  const rest = FULL_DECK.filter((c) => !dead.has(c));
  const need = 5 - board.length;
  let won = 0;
  for (let s = 0; s < samples; s++) {
    const deal = need + opponents * 2;
    const pool = rest.slice();
    for (let k = 0; k < deal; k++) {
      const j = k + Math.floor(Math.random() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    const full = [...board, ...pool.slice(0, need)];
    const mine = bestHand([...hole, ...full]).score;
    let share = 1;
    let ties = 1;
    for (let o = 0; o < opponents; o++) {
      const theirs = bestHand([pool[need + o * 2], pool[need + o * 2 + 1], ...full]).score;
      const cmp = compareScores(mine, theirs);
      if (cmp < 0) { share = 0; break; }
      if (cmp === 0) ties++;
    }
    won += share / ties;
  }
  return Math.round((won / samples) * 100);
}

// Would a player bet with these two cards on this board? A real pair or better (not just the
// board's), or a flush draw; anything else only as a bluff, at the given rate.
function wouldBet(cards, board, bluffRate, minCat) {
  const cat = bestHand([...cards, ...board]).score[0];
  const boardCat = board.length >= 5 ? bestHand(board).score[0] : board.length >= 2 && new Set(board.map((c) => c[0])).size < board.length ? 1 : 0;
  if (cat >= minCat && cat > boardCat) return true;
  if (minCat <= 1 && board.length < 5) {
    for (const s of 'shdc') {
      const onBoard = board.filter((c) => c[1] === s).length;
      if (onBoard < 4 && onBoard + cards.filter((c) => c[1] === s).length >= 4) return true;
    }
  }
  return Math.random() < bluffRate;
}

// Chance of winning when one opponent has bet: their cards are drawn only from hands they would
// plausibly bet (see wouldBet); the other opponents still in hold random cards. 0 to 100.
export function equityVsBettor(hole, board, opponents, { bluffRate = 0.3, minCat = 1 } = {}, samples = opponents >= 3 ? 200 : 300) {
  const dead = new Set([...hole, ...board]);
  const rest = FULL_DECK.filter((c) => !dead.has(c));
  const need = 5 - board.length;
  let won = 0;
  let n = 0;
  for (let tries = 0; n < samples && tries < samples * 12; tries++) {
    const deal = need + opponents * 2;
    const pool = rest.slice();
    for (let k = 0; k < deal; k++) {
      const j = k + Math.floor(Math.random() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    const bettor = [pool[need], pool[need + 1]];
    if (!wouldBet(bettor, board, bluffRate, minCat)) continue;
    n++;
    const full = [...board, ...pool.slice(0, need)];
    const mine = bestHand([...hole, ...full]).score;
    let share = 1;
    let ties = 1;
    for (let o = 0; o < opponents; o++) {
      const theirs = bestHand([pool[need + o * 2], pool[need + o * 2 + 1], ...full]).score;
      const cmp = compareScores(mine, theirs);
      if (cmp < 0) { share = 0; break; }
      if (cmp === 0) ties++;
    }
    won += share / ties;
  }
  return n ? Math.round((won / n) * 100) : equityVsRandom(hole, board, opponents);
}

// The same reads as flags, for the free decision engine.
export function features(hole, board) {
  const d = draws(hole, board);
  const suits = board.length ? Math.max(...'shdc'.split('').map((s) => board.filter((c) => c[1] === s).length)) : 0;
  const tex = board.length >= 3 ? texture(board) : '';
  return {
    made: board.length >= 3 ? madeHand(hole, board) : '',
    draws: d,
    flushDraw: d.some((x) => x.includes('flush draw (9')),
    nutFlushDraw: d.some((x) => x.startsWith('nut flush draw')),
    oesd: d.some((x) => x.startsWith('open-ended')),
    gutshot: d.some((x) => x.startsWith('gutshot')),
    overcards: d.some((x) => x.startsWith('two overcards')),
    backdoor: d.some((x) => x.startsWith('backdoor')),
    // Wet: flush or straight draws are likely on this board.
    wet: (suits >= 2 && board.length < 5) || suits >= 3 || tex.includes('connected:'),
    paired: tex.includes('paired'),
  };
}

// The lines the bot reads about its own hand.
export function readHand(hole, board, opponents) {
  const lines = [];
  if (board.length >= 3) {
    const d = draws(hole, board);
    lines.push(`YOUR HAND: ${madeHand(hole, board)}${d.length ? `; draws: ${d.join(', ')}` : ''}.`);
    lines.push(`BOARD TEXTURE: ${texture(board)}.`);
  }
  if (opponents > 0) lines.push(`EQUITY: about ${equityVsRandom(hole, board, opponents)}% against ${opponents} opponent${opponents > 1 ? 's' : ''} with random cards (real ranges are stronger when they have bet or raised).`);
  return lines;
}
