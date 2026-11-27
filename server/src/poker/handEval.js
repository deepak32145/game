import crypto from 'crypto';

// Cards are two-character strings: rank then suit, e.g. "As", "Td", "7h".
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const RANK_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const plural = (v) => (RANK_NAMES[v] === 'Six' ? 'Sixes' : `${RANK_NAMES[v]}s`);

export function shuffledDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Score for exactly five cards: [category, ...tiebreakers], compared left to right.
function score5(cards) {
  const vals = cards.map((c) => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const kickers = groups.map((g) => g[0]);

  let straightHigh = -1;
  if (groups.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals.join() === '12,3,2,1,0') straightHigh = 3; // A-2-3-4-5
  }

  if (straightHigh >= 0 && flush) return [8, straightHigh];
  if (shape === '41') return [7, ...kickers];
  if (shape === '32') return [6, ...kickers];
  if (flush) return [5, ...vals];
  if (straightHigh >= 0) return [4, straightHigh];
  if (shape === '311') return [3, ...kickers];
  if (shape === '221') return [2, ...kickers];
  if (shape === '2111') return [1, ...kickers];
  return [0, ...vals];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function describe(s) {
  switch (s[0]) {
    case 8: return s[1] === 12 ? 'Royal flush' : `Straight flush, ${RANK_NAMES[s[1]]} high`;
    case 7: return `Four ${plural(s[1])}`;
    case 6: return `Full house, ${plural(s[1])} full of ${plural(s[2])}`;
    case 5: return `Flush, ${RANK_NAMES[s[1]]} high`;
    case 4: return `Straight, ${RANK_NAMES[s[1]]} high`;
    case 3: return `Three ${plural(s[1])}`;
    case 2: return `Two pair, ${plural(s[1])} and ${plural(s[2])}`;
    case 1: return `Pair of ${plural(s[1])}`;
    default: return `${RANK_NAMES[s[1]]} high`;
  }
}

// Best five-card hand from any number of cards (seven in Hold'em).
export function bestHand(cards) {
  let best = null;
  let bestCards = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(five);
            if (!best || compareScores(s, best) > 0) {
              best = s;
              bestCards = five;
            }
          }
  return { score: best, name: describe(best), cards: bestCards };
}

const FULL_DECK = [];
for (const r of RANKS) for (const s of SUITS) FULL_DECK.push(r + s);

// Each player's chance of winning from here, as whole percentages that add up to 100 (ties count half each).
// With the flop or turn already out every remaining card is tried; before the flop it is estimated by sampling.
export function equity(holeA, holeB, board, samples = 2500) {
  const dead = new Set([...holeA, ...holeB, ...board]);
  const rest = FULL_DECK.filter((c) => !dead.has(c));
  const need = 5 - board.length;
  let a = 0;
  let n = 0;
  const run = (extra) => {
    const full = [...board, ...extra];
    const cmp = compareScores(bestHand([...holeA, ...full]).score, bestHand([...holeB, ...full]).score);
    a += cmp > 0 ? 1 : cmp === 0 ? 0.5 : 0;
    n += 1;
  };
  if (need <= 0) run([]);
  else if (need === 1) for (const c of rest) run([c]);
  else if (need === 2) {
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) run([rest[i], rest[j]]);
  } else {
    for (let s = 0; s < samples; s++) {
      const pool = rest.slice();
      const extra = [];
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(Math.random() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
        extra.push(pool[k]);
      }
      run(extra);
    }
  }
  const pctA = Math.round((a / n) * 100);
  return [pctA, 100 - pctA];
}

// The same idea for any number of players: each one's chance of winning, as whole percentages
// adding up to 100. `holes` is a list of two-card hands.
export function equityMulti(holes, board, samples = holes.length > 2 ? 700 : 1500) {
  const dead = new Set([...holes.flat(), ...board]);
  const rest = FULL_DECK.filter((c) => !dead.has(c));
  const need = 5 - board.length;
  const share = holes.map(() => 0);
  let n = 0;
  const run = (extra) => {
    const full = [...board, ...extra];
    const scores = holes.map((h) => bestHand([...h, ...full]).score);
    let best = scores[0];
    for (const s of scores) if (compareScores(s, best) > 0) best = s;
    const winners = scores.map((s) => compareScores(s, best) === 0);
    const count = winners.filter(Boolean).length;
    winners.forEach((w, i) => {
      if (w) share[i] += 1 / count;
    });
    n += 1;
  };
  if (need <= 0) run([]);
  else if (need === 1) for (const c of rest) run([c]);
  else if (need === 2) {
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) run([rest[i], rest[j]]);
  } else {
    for (let s = 0; s < samples; s++) {
      const pool = rest.slice();
      const extra = [];
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(Math.random() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
        extra.push(pool[k]);
      }
      run(extra);
    }
  }
  // Round so the figures add up to exactly 100.
  const pct = share.map((v) => Math.floor((v / n) * 100));
  let left = 100 - pct.reduce((a, b) => a + b, 0);
  const order = share.map((v, i) => [(v / n) * 100 - pct[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) pct[order[k % order.length][1]] += 1;
  return pct;
}
