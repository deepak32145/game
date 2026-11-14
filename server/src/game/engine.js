// Pure match rules: no sockets, no timers. `rng` is injectable for tests.
//
// Conventions (all batters are right-handed):
//   line   : -1 = leg side, 0 = middle stump, +1 = off side. Beyond +-1.15 is a wide.
//   length : 0 = yorker, 0.5 = good length, 1 = short.
//   offset : batter's swing time minus ideal contact time, in ms (negative = early).

export const RUNUP_MS = 1100;
export const VARIATIONS = ['stock', 'in', 'out', 'slow'];
export const DIRS = ['off', 'straight', 'leg'];
export const STYLES = ['defend', 'stroke', 'loft'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const QUALITY = ['perfect', 'good', 'ok', 'poor', 'miss'];

export function createInnings(battingUser, bowlingUser, battingTeam, bowlingTeam) {
  const batters = battingTeam.players.map((p) => ({
    name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, how: null, batted: false,
  }));
  batters[0].batted = batters[1].batted = true;
  return {
    battingUser,
    bowlingUser,
    runs: 0,
    wickets: 0,
    balls: 0,
    extras: 0,
    batters,
    striker: 0,
    nonStriker: 1,
    nextBatter: 2,
    bowlers: bowlingTeam.players.map((p) => ({
      name: p.name, kind: p.kind, balls: 0, runs: 0, wickets: 0,
    })),
    currentBowler: null,
    lastBowler: null,
    thisOver: [],
    ballPhase: 'select_bowler',
    done: false,
  };
}

// Turns the bowler's intended delivery into what actually comes out of the hand.
export function prepareDelivery(bowler, input, rng = Math.random) {
  const variation = VARIATIONS.includes(input.variation) ? input.variation : 'stock';
  const spread = (100 - bowler.bowl) / 100;
  const noise = () => rng() + rng() - 1;

  const line = clamp(Number(input.line) || 0, -1.3, 1.3) + noise() * spread * 0.45;
  const length = clamp(clamp(Number(input.length) || 0, 0, 1) + noise() * spread * 0.3, 0, 1);

  const spin = bowler.kind === 'spin';
  const moveDir = variation === 'in' ? -1 : variation === 'out' ? 1 : 0;
  const finalLine = line + moveDir * (spin ? 0.3 : 0.22) * (0.6 + bowler.bowl / 250);

  let flightMs = spin ? 1500 - bowler.bowl * 1.5 : 1080 - bowler.bowl * 2.2;
  let speedKph = spin ? 80 + rng() * 8 : 128 + bowler.bowl * 0.2 + rng() * 4;
  if (variation === 'slow') {
    flightMs += spin ? 300 : 420;
    speedKph -= spin ? 8 : 22;
  }

  return {
    variation,
    kind: bowler.kind,
    line,
    length,
    finalLine,
    flightMs: Math.round(flightMs),
    speedKph: Math.round(speedKph),
    wide: Math.abs(finalLine) > 1.15,
  };
}

function timingQuality(offset, scale) {
  const a = Math.abs(offset);
  if (a <= 45 * scale) return 0;
  if (a <= 100 * scale) return 1;
  if (a <= 170 * scale) return 2;
  if (a <= 260 * scale) return 3;
  return 4;
}

// [outcome, weight]. 'c' = caught.
const TABLES = {
  defend: {
    perfect: [[0, 85], [1, 15]],
    good: [[0, 88], [1, 12]],
    ok: [[0, 95], [1, 5]],
    poor: [[0, 80], ['c', 14], [1, 6]],
  },
  stroke: {
    perfect: [[4, 50], [2, 17], [1, 22], [3, 5], [0, 6]],
    good: [[1, 40], [2, 22], [4, 20], [0, 18]],
    ok: [[0, 48], [1, 38], [2, 9], ['c', 5]],
    poor: [[0, 50], ['c', 24], [1, 20], [4, 6]],
  },
  loft: {
    perfect: [[6, 62], [4, 26], [2, 12]],
    good: [[6, 24], [4, 34], [2, 16], [1, 10], ['c', 16]],
    ok: [['c', 38], [1, 24], [2, 14], [4, 12], [0, 12]],
    poor: [['c', 58], [0, 30], [1, 12]],
  },
};

function pick(table, rng) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of table) {
    r -= w;
    if (r < 0) return value;
  }
  return table[table.length - 1][0];
}

// shot: { none: true } or { dir, style, offset }
export function resolveBall(delivery, shot, batter, bowler, rng = Math.random) {
  const base = { runs: 0, legal: true, wicket: null, contact: false, quality: 'miss', shot: null, offset: null };
  let q = 4;

  if (!shot.none) {
    const dir = DIRS.includes(shot.dir) ? shot.dir : 'straight';
    const style = STYLES.includes(shot.style) ? shot.style : 'stroke';
    const offset = clamp(Number(shot.offset) || 0, -3000, 3000);
    base.shot = { dir, style };
    base.offset = Math.round(offset);

    let scale = clamp(1 + (batter.bat - bowler.bowl) / 150, 0.6, 1.4);
    if (delivery.variation === 'in' || delivery.variation === 'out') scale *= 0.9;
    if (delivery.length < 0.12) scale *= 0.8;
    q = timingQuality(offset, scale);

    if (q < 4 && style !== 'defend') {
      // Playing against the line, or the wrong shot for the length, costs quality.
      const ideal = delivery.finalLine > 0.35 ? 'off' : delivery.finalLine < -0.35 ? 'leg' : 'straight';
      if (ideal !== 'straight' && dir !== ideal) q += dir === 'straight' ? 1 : 2;
      if (style === 'loft' && delivery.length < 0.12) q += 1;
      if (dir === 'straight' && delivery.length > 0.75) q += 1;
      if (Math.abs(delivery.finalLine) > 0.9) q += 1;
      q = Math.min(q, 4);
    }
  }

  if (q === 4) {
    const onStumps = Math.abs(delivery.finalLine) < 0.2 && delivery.length < 0.8;
    if (onStumps) {
      const lbw = delivery.length < 0.5 && rng() < 0.25;
      return { ...base, wicket: lbw ? 'lbw' : 'bowled' };
    }
    if (delivery.wide) return { ...base, legal: false };
    return base;
  }

  const quality = QUALITY[q];
  const outcome = pick(TABLES[base.shot.style][quality], rng);
  const res = { ...base, contact: true, quality };
  if (outcome === 'c') res.wicket = 'caught';
  else res.runs = outcome;
  return res;
}

export function describeBall(res, batterName, bowlerName) {
  if (!res.legal) return `Wide from ${bowlerName}.`;
  if (res.wicket === 'bowled') return `BOWLED! ${bowlerName} knocks over ${batterName}'s stumps.`;
  if (res.wicket === 'lbw') return `LBW! ${batterName} is trapped in front by ${bowlerName}.`;
  if (res.wicket === 'caught') return `CAUGHT! ${batterName} holes out off ${bowlerName}.`;
  if (res.runs === 6) return `SIX! ${batterName} launches ${bowlerName} into the stands.`;
  if (res.runs === 4) return `FOUR! ${batterName} finds the boundary.`;
  if (res.runs === 0) return res.contact ? `No run. ${batterName} finds the fielder.` : `Beaten! ${bowlerName} goes past the bat.`;
  return `${batterName} takes ${res.runs} run${res.runs > 1 ? 's' : ''}.`;
}

// Mutates the innings. Returns { overComplete }.
export function applyOutcome(inn, res, { overs, target }) {
  const bat = inn.batters[inn.striker];
  const bowl = inn.bowlers[inn.currentBowler];

  if (!res.legal) {
    inn.runs += 1;
    inn.extras += 1;
    bowl.runs += 1;
    inn.thisOver.push('Wd');
  } else {
    inn.balls += 1;
    bat.balls += 1;
    bowl.balls += 1;
    if (res.wicket) {
      bat.out = true;
      bat.how = `${res.wicket} b ${bowl.name}`;
      inn.wickets += 1;
      bowl.wickets += 1;
      inn.thisOver.push('W');
      if (inn.nextBatter < inn.batters.length) {
        inn.striker = inn.nextBatter++;
        inn.batters[inn.striker].batted = true;
      } else {
        inn.striker = null;
      }
    } else {
      bat.runs += res.runs;
      inn.runs += res.runs;
      bowl.runs += res.runs;
      if (res.runs === 4) bat.fours += 1;
      if (res.runs === 6) bat.sixes += 1;
      inn.thisOver.push(String(res.runs));
      if (res.runs % 2 === 1) [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    }
  }

  inn.done =
    inn.wickets >= inn.batters.length - 1 ||
    inn.balls >= overs * 6 ||
    (target != null && inn.runs >= target);

  const overComplete = res.legal && inn.balls % 6 === 0;
  if (overComplete && !inn.done) {
    [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    inn.lastBowler = inn.currentBowler;
    inn.currentBowler = null;
  }
  return { overComplete };
}
