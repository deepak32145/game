import { bestHand, compareScores } from './handEval.js';

// Reading one opponent's range through the hand, the way a thinking player does.
//
// Start from every two-card hand they could hold (none of our cards or the board's), weight each by
// how likely they were to play it the way they did before the flop, then street by street multiply
// in how likely they were to check, bet, call or raise with it on that board. What is left is what
// they are likely to hold now. Each hand is judged against all hands on that board (top 6% =
// monster, and so on), so a counterfeited two pair or a board pair is understood automatically.
//
// Only public information is used: our own cards, the board, and the actions everyone saw.

const RANKS = '23456789TJQKA';
const rankOf = (c) => RANKS.indexOf(c[0]);
const DECK = [];
for (const r of RANKS) for (const s of 'shdc') DECK.push(r + s);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Chen score, as in the engine (kept here so this file stands alone).
function chen(hole) {
  const [a, b] = hole.map(rankOf).sort((x, y) => y - x);
  const pts = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  if (a === b) return Math.max(5, pts(a) * 2);
  let s = pts(a);
  if (hole[0][1] === hole[1][1]) s += 2;
  const gap = a - b - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && a < 10) s += 1;
  if (a === 12) s += 2;
  else if (a === 11) s += 1;
  return Math.ceil(s);
}
// Share of hands at or above each Chen score, to turn "top 25%" into a score.
const SCORE_SHARE = [[16, 0.01], [14, 0.02], [12, 0.04], [11, 0.05], [10, 0.07], [9, 0.11], [8, 0.15], [7, 0.27], [6, 0.35], [5, 0.44], [4, 0.58], [3, 0.67], [2, 0.79], [1, 0.88], [0, 0.96], [-1, 1]];
const scoreFor = (width) => { for (const [s, share] of SCORE_SHARE) if (share >= width) return s; return -1; };

// ---- how a hand sits on a board ----

const CLASSES = ['monster', 'strong', 'medium', 'draw', 'weak', 'air'];

// Rank masks: rank r is bit (r + 1), and an ace is also bit 0 (low). Five bits in a row = a straight.
function straightIn(m) {
  for (let hi = 13; hi >= 4; hi--) if (((m >> (hi - 4)) & 0b11111) === 0b11111) return true;
  return false;
}
const rankMask = (cards) => { let m = 0; for (const c of cards) { const r = rankOf(c); m |= 1 << (r + 1); if (r === 12) m |= 1; } return m; };

// A strong draw: a flush draw or an open-ended straight draw that uses a hole card.
function strongDraw(hole, board) {
  if (board.length >= 5) return false;
  for (const s of new Set(hole.map((c) => c[1]))) {
    const onBoard = board.filter((c) => c[1] === s).length;
    const mine = hole.filter((c) => c[1] === s).length;
    if (onBoard + mine === 4 && onBoard < 4) return true;
  }
  const all = rankMask([...hole, ...board]);
  const bm = rankMask(board);
  if (straightIn(all)) return false;
  let fills = 0;
  for (let r = 0; r < 13; r++) {
    const bit = 1 << (r + 1) | (r === 12 ? 1 : 0);
    if (all & (1 << (r + 1))) continue;
    if (straightIn(all | bit) && !straightIn(bm | bit)) fills++;
  }
  return fills >= 2;
}

// Classify every possible holding on this board by how it ranks against all of them.
function classify(combos, board) {
  const scored = combos.map((c, i) => ({ i, s: bestHand([...c, ...board]).score }));
  scored.sort((a, b) => compareScores(b.s, a.s));
  const out = new Array(combos.length);
  const n = scored.length;
  let first = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0 && compareScores(scored[k].s, scored[k - 1].s) !== 0) first = k;
    const pct = first / n; // share of hands that beat it (0 = the nuts)
    const c = combos[scored[k].i];
    let cls;
    if (pct < 0.06) cls = 'monster';
    else if (pct < 0.2) cls = 'strong';
    else if (pct < 0.45) cls = 'medium';
    else if (strongDraw(c, board)) cls = 'draw';
    else if (pct < 0.7) cls = 'weak';
    else cls = 'air';
    out[scored[k].i] = { cls, score: scored[k].s, pct };
  }
  return out;
}

// ---- how likely each kind of hand is to take each action ----

// What we have seen this player do after the flop (needs a few samples to count):
// foldToBet = how often they fold when bet into, stab = how often they bet when checked to.
export function tendencies(o) {
  if (!o) return {};
  return {
    foldToBet: o.facedBet >= 4 ? o.foldedToBet / o.facedBet : null,
    stab: o.checkedTo >= 4 ? o.stabbed / o.checkedTo : null,
    // From showdowns: of their river bets and raises we saw the cards for, how many were bluffs.
    riverBluff: o.riverBetShown >= 3 ? o.riverBluffShown / o.riverBetShown : null,
    // How often they call a bet on the river.
    riverCall: o.riverFaced >= 3 ? o.riverCalls / o.riverFaced : null,
  };
}

// size = the bet as a share of the pot before it. style = the player's profile this session.
// tend = their observed tendencies (see above), which override the defaults once known.
function likelihood(cls, action, size, style, tend = {}, street = '') {
  const big = clamp(size, 0, 2);
  const st = style || 'regular';
  const river = street === 'river';
  if (action === 'check') return clamp(1 - likelihood(cls, 'bet', size, style, tend, street), 0.02, 0.98);
  // Big bets are polarized: the nuts or a bluff. Middling hands bet small, and almost never overbet
  // or jam; good-but-not-great hands overbet less too.
  if ((action === 'bet' || action === 'raise') && size > 0.75) {
    const base = likelihood(cls, action, 0.5, style, tend, street);
    // Tight, passive players are even more extreme: a big bet from them is almost always the nuts.
    const tight = st === 'nit' ? 3 : 1;
    if (cls === 'medium' || cls === 'weak') return base / (1 + (size - 0.5) * 3 * tight);
    if (cls === 'strong') return base / (1 + Math.max(0, size - 1) * 2 * tight);
    return base;
  }
  // River bets and raises: once we have seen their river cards a few times, bluffs follow what they
  // actually showed. Tight players bluff the river less than they bluff earlier streets.
  if (river && (action === 'bet' || action === 'raise') && (cls === 'air' || cls === 'weak' || cls === 'draw')) {
    const shown = tend.riverBluff;
    const scale = action === 'raise' ? 0.5 : 1;
    if (shown != null) return clamp((cls === 'air' ? shown * 0.6 : shown * 0.3) * scale, 0.005, 0.8);
    if (st === 'nit') return (cls === 'air' ? 0.04 : 0.03) * scale;
  }
  if (action === 'bet') {
    const air = st === 'maniac' ? 0.45 : st === 'nit' ? 0.08 : st === 'station' ? 0.08 : 0.25;
    const base = { monster: 0.65, strong: 0.55, medium: st === 'station' ? 0.2 : 0.3, draw: 0.5, weak: 0.15, air }[cls];
    if (tend.stab == null) return base;
    // Once we know how often they bet when checked to, their weak hands and bluffs follow that.
    return { air: clamp(tend.stab * 0.8, 0.02, 0.85), weak: clamp(tend.stab * 0.5, 0.02, 0.6), medium: clamp(0.15 + tend.stab * 0.4, 0.05, 0.7) }[cls] ?? base;
  }
  if (action === 'call') {
    const loose = st === 'station' ? 1.5 : st === 'nit' ? 0.6 : 1;
    // Up to the pot, bigger bets fold out more; beyond the pot (overbets, shoves) calls fall off fast.
    const over = size > 1 ? 1 / (1 + (size - 1) * 0.9) : 1;
    const shrink = (base, per) => clamp(base * loose * (1 - per * Math.min(big, 1)) * over, 0.01, 0.98);
    // Bigger bets fold out more of the middle: medium hands call a small bet often, a big one less.
    const p = { monster: 0.55, strong: shrink(0.9, 0.1), medium: shrink(0.62, 0.4), draw: shrink(0.75, 0.3), weak: shrink(0.25, 0.6), air: shrink(0.05, 0.6) }[cls];
    if (cls === 'monster') return p;
    // What we have actually seen them do scales how often each kind of hand folds, against a typical
    // 50%: a player who called eleven river bets of twelve folds about a sixth as often, even with air;
    // one who folds three times in four folds half again as often. On the river, river calls count.
    const seenFold = river && tend.riverCall != null ? 1 - tend.riverCall : tend.foldToBet;
    if (seenFold == null) return p;
    const scale = clamp(seenFold / 0.5, 0.1, 2.5);
    return clamp(1 - (1 - p) * scale, 0.01, 0.99);
  }
  if (action === 'raise') {
    const air = st === 'maniac' ? 0.15 : st === 'nit' ? 0.01 : 0.05;
    return { monster: 0.45, strong: 0.15, medium: 0.03, draw: 0.2, weak: 0.01, air }[cls];
  }
  return 1;
}

// ---- before the flop ----

function preflopWeight(combo, acts, info) {
  const s = chen(combo);
  const { hu, stats } = info;
  const vpip = stats && stats.hands >= 6 ? stats.vpip / stats.hands : hu ? 0.8 : 0.3;
  const pfr = stats && stats.hands >= 6 ? stats.pfr / stats.hands : hu ? 0.55 : 0.18;
  const playAt = scoreFor(clamp(vpip, 0.05, 1));
  const raiseAt = scoreFor(clamp(pfr, 0.03, 1));
  const threeAt = scoreFor(clamp(pfr * 0.35, 0.02, 0.4));
  let w = 1;
  for (const a of acts) {
    if (a.kind === 'raise') w *= a.reraise ? sigmoid((s - threeAt) * 1.2) + 0.04 : sigmoid((s - raiseAt) * 1.2) + 0.02;
    else if (a.kind === 'call') w *= sigmoid((s - playAt) * 1.2) * (1 - 0.6 * sigmoid((s - (a.facingRaise ? threeAt : raiseAt)) * 1.2));
    else if (a.kind === 'check') w *= 1 - 0.5 * sigmoid((s - raiseAt) * 1.2); // checked the big blind: strong hands usually raise
  }
  return w;
}

// ---- the whole read ----

// sit needs: hole, board, actions (the hand so far), villainSeat, mySeat, stats (their session
// notes, or null), profile ('maniac' | 'nit' | 'station' | 'regular' | 'unknown'), hu.
export function readRange(sit) {
  sit = { ...sit, street: sit.street || (sit.board.length >= 5 ? 'river' : sit.board.length === 4 ? 'turn' : sit.board.length === 3 ? 'flop' : 'preflop') };
  const dead = new Set([...sit.hole, ...sit.board]);
  const live = DECK.filter((c) => !dead.has(c));
  const combos = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) combos.push([live[i], live[j]]);
  const style = sit.profile === 'unknown' ? 'regular' : sit.profile;
  const tend = sit.tend || {};

  // Walk the hand: who bet how much on each street, and what the villain did.
  const pre = [];
  const streets = { flop: [], turn: [], river: [] };
  let street = 'preflop';
  let streetBet = {};
  let top = 0;
  let raised = false;
  for (const a of sit.actions) {
    if (a.st === 'result') continue;
    if (a.st !== street) { street = a.st; streetBet = {}; top = 0; }
    const mine = streetBet[a.seat] || 0;
    const potBefore = a.pot - ((a.bet || 0) - mine);
    if (a.t === 'sb' || a.t === 'bb') { streetBet[a.seat] = a.a; top = Math.max(top, a.a); continue; }
    if (a.seat === sit.villainSeat) {
      const facing = top - mine;
      if (street === 'preflop') {
        if (a.t === 'raise' || a.t === 'bet') pre.push({ kind: 'raise', reraise: raised });
        else if (a.t === 'call') pre.push({ kind: 'call', facingRaise: raised });
        else if (a.t === 'check') pre.push({ kind: 'check' });
      } else if (streets[street]) {
        if (a.t === 'check') streets[street].push({ action: 'check', size: 0 });
        else if (a.t === 'call') streets[street].push({ action: 'call', size: facing / Math.max(1, potBefore) });
        else if (a.t === 'bet' || a.t === 'raise') streets[street].push({ action: facing > 0 ? 'raise' : 'bet', size: (a.a - mine) / Math.max(1, potBefore) });
      }
    }
    if (a.t === 'bet' || a.t === 'raise') { top = Math.max(top, a.a); if (street === 'preflop') raised = true; }
    streetBet[a.seat] = a.bet != null ? a.bet : mine;
  }

  const info = { hu: sit.hu, stats: sit.stats };
  const w = combos.map((c) => preflopWeight(c, pre, info));
  const BOARD_AT = { flop: 3, turn: 4, river: 5 };
  let last = null;
  for (const st of ['flop', 'turn', 'river']) {
    const n = BOARD_AT[st];
    if (sit.board.length < n) break;
    const board = sit.board.slice(0, n);
    const cls = classify(combos, board);
    last = cls;
    for (let ai = 0; ai < streets[st].length; ai++) {
      const act = streets[st][ai];
      for (let i = 0; i < combos.length; i++) if (w[i] > 0) w[i] *= likelihood(cls[i].cls, act.action, act.size, style, tend, st);
      const bluffy = (i) => ['air', 'weak', 'draw'].includes(cls[i].cls);
      // Their mood: a tilting player (or one with a grudge) bets and raises with more junk.
      if ((act.action === 'bet' || act.action === 'raise') && tend.bluffMul && tend.bluffMul !== 1) {
        for (let i = 0; i < combos.length; i++) if (bluffy(i)) w[i] *= tend.bluffMul;
      }
      // A timing tell on their latest action, this street (how fast they acted, against their usual pace).
      const isLast = st === sit.street && ai === streets[st].length - 1;
      if (isLast && tend.tell && tend.tell.action === (act.action === 'raise' ? 'bet' : act.action)) {
        const k = tend.tell.speed === 'snap' ? 'snap' : 'tank';
        for (let i = 0; i < combos.length; i++) {
          const c = cls[i].cls;
          const big = c === 'monster' || c === 'strong';
          if (act.action === 'check') w[i] *= k === 'snap' ? (big ? 0.6 : 1.1) : c === 'medium' ? 1.2 : 1; // a snap-check is usually weak
          else if (act.action === 'call') w[i] *= k === 'tank' ? (c === 'medium' || c === 'draw' ? 1.3 : c === 'monster' ? 0.7 : 1) : 1; // a tank-call is a tough medium hand
          else if (act.action === 'bet' || act.action === 'raise') w[i] *= k === 'tank' ? (c === 'monster' || c === 'air' ? 1.3 : c === 'medium' ? 0.7 : 1) : big ? 1.15 : bluffy(i) ? 0.8 : 1; // tank-bet = polarized, snap-bet = strong
        }
      }
      // On the river, when we have seen how often their river bets are bluffs, make the range say so:
      // set the share of bluffs among their betting hands to what they have actually shown.
      if (st === 'river' && (act.action === 'bet' || act.action === 'raise') && tend.riverBluff != null) {
        const isBluff = (i) => ['air', 'weak', 'draw'].includes(cls[i].cls);
        let bluffW = 0;
        let valueW = 0;
        for (let i = 0; i < combos.length; i++) if (isBluff(i)) bluffW += w[i]; else valueW += w[i];
        const r = clamp(tend.riverBluff, 0.02, 0.9);
        if (bluffW > 0 && valueW > 0) {
          const k = clamp((r / (1 - r)) * (valueW / bluffW), 0.02, 50);
          for (let i = 0; i < combos.length; i++) if (isBluff(i)) w[i] *= k;
        }
      }
    }
  }
  if (!last && sit.board.length >= 3) last = classify(combos, sit.board);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const range = combos.map((c, i) => ({ c, w: w[i] / total, cls: last ? last[i].cls : null, score: last ? last[i].score : null }));
  return { range, style, tend };
}

// What the range is made of, for the log: "strong 34%, medium 28%, ...".
export function describeRange(range) {
  const by = {};
  for (const r of range) if (r.cls) by[r.cls] = (by[r.cls] || 0) + r.w;
  return CLASSES.filter((k) => by[k] >= 0.03).map((k) => `${k} ${Math.round(by[k] * 100)}%`).join(', ');
}

// My chance against each holding in their range: exact on the river, sampled runouts before it.
// Returns a sample of { cls, eq, w } entries for the expected-value maths.
export function equityAgainst(hole, board, range, samples = 260, runouts = 5) {
  if (board.length === 5) {
    const mine = bestHand([...hole, ...board]).score;
    return range.filter((r) => r.w > 0).map((r) => {
      const cmp = compareScores(mine, r.score || bestHand([...r.c, ...board]).score);
      return { cls: r.cls, eq: cmp > 0 ? 1 : cmp === 0 ? 0.5 : 0, w: r.w };
    });
  }
  // Draw holdings in proportion to their weight, then run out the board a few times each.
  const cum = [];
  let acc = 0;
  for (const r of range) { acc += r.w; cum.push(acc); }
  const pick = () => { const x = Math.random() * acc; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return range[lo]; };
  const out = [];
  const need = 5 - board.length;
  for (let k = 0; k < samples; k++) {
    const r = pick();
    const dead = new Set([...hole, ...board, ...r.c]);
    const rest = DECK.filter((c) => !dead.has(c));
    let eq = 0;
    for (let t = 0; t < runouts; t++) {
      const extra = [];
      for (let q = 0; q < need; q++) { const j = q + Math.floor(Math.random() * (rest.length - q)); [rest[q], rest[j]] = [rest[j], rest[q]]; extra.push(rest[q]); }
      const full = [...board, ...extra];
      const cmp = compareScores(bestHand([...hole, ...full]).score, bestHand([...r.c, ...full]).score);
      eq += cmp > 0 ? 1 : cmp === 0 ? 0.5 : 0;
    }
    out.push({ cls: r.cls, eq: eq / runouts, w: 1 / samples });
  }
  return out;
}

// How a hand shown down ranked on that board (monster ... air), judged against every possible hand.
export function shownClass(hole, board) {
  const dead = new Set(board);
  const live = DECK.filter((c) => !dead.has(c));
  const combos = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) combos.push([live[i], live[j]]);
  const idx = combos.findIndex((c) => (c[0] === hole[0] && c[1] === hole[1]) || (c[0] === hole[1] && c[1] === hole[0]));
  if (idx < 0) return null;
  return classify(combos, board)[idx].cls;
}

export { likelihood, CLASSES };
