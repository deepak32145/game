import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../ui.jsx';
import { Card } from './Table.jsx';

// Plays a saved hand back step by step: the table as it looked after every action,
// with the whole hand laid out street by street underneath.

const COLUMNS = [
  ['blinds', 'Blinds'],
  ['preflop', 'Pre-Flop'],
  ['flop', 'Flop'],
  ['turn', 'Turn'],
  ['river', 'River'],
  ['result', 'Result'],
];
const BOARD_AT = { preflop: 0, flop: 3, turn: 4, river: 5 };
const STREET_NAME = { flop: 'Flop', turn: 'Turn', river: 'River' };
const SPEEDS = [1, 2, 4];
const STEP_MS = 1300;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

// Seat names by position, counted from the player on the button's left.
const POSITION_NAMES = {
  2: ['BB', 'SB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'UTG', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'],
};
function positionsOf(hand) {
  const names = POSITION_NAMES[hand.players.length] || [];
  return Object.fromEntries(hand.players.map((p, i) => [p.seat, names[i] || '']));
}

// What a step says, e.g. "Raise 230,000" or "All-in 1,200".
function verb(a) {
  const allIn = a.stack === 0 && ['call', 'bet', 'raise'].includes(a.t);
  switch (a.t) {
    case 'sb': return `SB ${fmt(a.a)}`;
    case 'bb': return `BB ${fmt(a.a)}`;
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return `${allIn ? 'All-in' : 'Call'} ${fmt(a.a)}`;
    case 'bet': return `${allIn ? 'All-in' : 'Bet'} ${fmt(a.a)}`;
    case 'raise': return `${allIn ? 'All-in' : 'Raise to'} ${fmt(a.a)}`;
    case 'return': return `${fmt(a.a)} back`;
    case 'win': return `Wins ${fmt(a.a)}`;
    case 'show': return 'Shows';
    default: return a.t;
  }
}
const tone = (a) => (a.t === 'fold' ? 'fold' : a.t === 'check' || a.t === 'call' ? (a.stack === 0 && a.t === 'call' ? 'allin' : 'call') : a.t === 'bet' || a.t === 'raise' ? (a.stack === 0 ? 'allin' : 'raise') : a.t === 'win' ? 'win' : 'quiet');

// Every picture of the table, in order: the deal, then one per action, with the board dealt between streets.
function buildFrames(hand, meId) {
  const seats = {};
  for (const p of hand.players) seats[p.seat] = { stack: p.start, bet: 0, folded: false, act: null, won: 0, open: p.uid === meId };
  const frames = [];
  let street = 'preflop';
  let board = 0;
  let pot = 0;
  let lastStep = -1;
  const snap = (label, step = -1) => {
    if (step >= 0) lastStep = step;
    frames.push({ street, board, pot, label, step, lastStep, seats: structuredClone(seats) });
  };
  const collect = () => {
    for (const s of Object.values(seats)) {
      s.bet = 0;
      if (s.act && !s.folded && s.stack > 0) s.act = null; // keep FOLD and ALL-IN on show
    }
  };
  const dealTo = (target) => {
    for (const name of ['flop', 'turn', 'river']) {
      if (BOARD_AT[name] > board && BOARD_AT[name] <= target && BOARD_AT[name] <= hand.board.length) {
        collect();
        const before = board;
        street = name;
        board = BOARD_AT[name];
        snap(`${STREET_NAME[name]}: ${hand.board.slice(before, board).join(' ')}`);
      }
    }
  };
  snap('Cards are dealt');
  hand.actions.forEach((a, i) => {
    if (a.st !== street) {
      if (a.st === 'result' && street !== 'result') {
        if (hand.showdown) {
          dealTo(5);
          collect();
          street = 'result';
          for (const p of hand.players) if (!seats[p.seat].folded && p.cards.some(Boolean)) seats[p.seat].open = true;
          snap('Showdown');
        } else {
          collect();
          street = 'result';
        }
      } else if (BOARD_AT[a.st] != null) {
        dealTo(BOARD_AT[a.st]);
      }
    }
    const s = seats[a.seat];
    if (!s) return;
    s.stack = a.stack;
    s.bet = a.bet;
    if (a.t === 'fold') s.folded = true;
    if (a.t === 'show') s.open = true;
    if (a.t === 'win') {
      s.won += a.a;
      for (const o of Object.values(seats)) o.bet = 0;
    }
    if (a.t !== 'return') s.act = a;
    pot = a.pot;
    snap(null, i);
  });
  return frames;
}

// Seats around an oval, your own at the bottom.
function seatSpot(pos, max) {
  const angle = Math.PI / 2 + (pos * 2 * Math.PI) / max;
  return {
    seat: { left: `${50 + 43 * Math.cos(angle)}%`, top: `${50 + 40 * Math.sin(angle)}%` },
    bet: { left: `${50 + 25 * Math.cos(angle)}%`, top: `${50 + 23 * Math.sin(angle)}%` },
  };
}

export default function Replayer({ hands, index, me, onIndex, onClose }) {
  const hand = hands[index];
  const frames = useMemo(() => (hand.actions?.length ? buildFrames(hand, me.id) : []), [hand, me.id]);
  const positions = useMemo(() => positionsOf(hand), [hand]);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = frames.length - 1;

  useEffect(() => {
    setAt(0);
    setPlaying(frames.length > 0);
  }, [hand.id]);

  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setAt((n) => Math.min(last, n + 1)), STEP_MS / speed);
    return () => clearTimeout(t);
  }, [playing, at, speed, last]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') { setPlaying(false); setAt((n) => Math.min(last, n + 1)); }
      else if (e.key === 'ArrowLeft') { setPlaying(false); setAt((n) => Math.max(0, n - 1)); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last]);

  const frame = frames[at];
  const mine = hand.players.find((p) => p.uid === me.id);
  const mySeat = mine ? mine.seat : 0;
  const max = Math.max(hand.maxSeats || 6, ...hand.players.map((p) => p.seat + 1));
  const nameOf = Object.fromEntries(hand.players.map((p) => [p.seat, p.name]));
  const userOf = Object.fromEntries(hand.players.map((p) => [p.seat, p]));
  const playPause = () => {
    if (at >= last) setAt(0);
    setPlaying(!playing || at >= last);
  };
  const jump = (n) => {
    setPlaying(false);
    setAt(Math.max(0, Math.min(last, n)));
  };

  // Column headers show the pot as each street began.
  const potAt = {};
  for (const f of frames) if (f.step === -1 && f.street !== 'preflop' && potAt[f.street] == null) potAt[f.street] = f.pot;
  const bbStep = hand.actions?.findIndex((a) => a.t === 'bb');
  if (bbStep >= 0) potAt.preflop = hand.actions[bbStep].pot;
  potAt.result = hand.pot;

  const caption = !frame
    ? ''
    : frame.step >= 0
      ? `${nameOf[hand.actions[frame.step].seat]}${positions[hand.actions[frame.step].seat] ? ` (${positions[hand.actions[frame.step].seat]})` : ''}: ${verb(hand.actions[frame.step])}`
      : frame.label;

  return (
    <div className="rp-backdrop" onClick={onClose}>
      <div className="rp" role="dialog" aria-label="Hand replayer" onClick={(e) => e.stopPropagation()}>
        <header className="rp-head">
          <div className="rp-title">
            <b>{hand.tableName}</b>
            <span>
              hand #{hand.handNo} · {hand.blinds[0]}/{hand.blinds[1]} ·{' '}
              {new Date(hand.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="rp-nav">
            <button className="btn ghost" disabled={index >= hands.length - 1} onClick={() => onIndex(index + 1)} title="Previous hand">‹ Prev</button>
            <span className="muted small">{hands.length - index} / {hands.length}</span>
            <button className="btn ghost" disabled={index <= 0} onClick={() => onIndex(index - 1)} title="Next hand">Next ›</button>
            <button className="btn ghost rp-x" onClick={onClose} aria-label="Close replayer">✕</button>
          </div>
        </header>

        {!frame ? (
          <div className="rp-old">
            <p className="muted small">This hand was saved before the replayer existed, so only its summary is available.</p>
            <ol className="hh-log">{hand.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
          </div>
        ) : (
          <>
            <div className="rp-stage">
              <div className="rp-felt">
                <div className="rp-mid">
                  <div className="rp-board">
                    {[0, 1, 2, 3, 4].map((i) =>
                      i < frame.board ? <Card key={`${hand.id}-${i}`} card={hand.board[i]} mark="flip" /> : <div key={i} className="pk-card slot" />
                    )}
                  </div>
                  <div className="rp-pot">Pot <b>{fmt(frame.pot)}</b></div>
                </div>

                {hand.players.map((p) => {
                  const s = frame.seats[p.seat];
                  const spot = seatSpot((p.seat - mySeat + max) % max, max);
                  const acting = frame.step >= 0 && hand.actions[frame.step].seat === p.seat;
                  const cards = s.folded ? null : s.open && p.cards.length ? p.cards : [null, null];
                  return (
                    <div key={p.seat}>
                      <div className={`rp-seat ${p.uid === me.id ? 'me' : ''} ${s.folded ? 'out' : ''} ${acting ? 'acting' : ''} ${s.won ? 'won' : ''}`} style={spot.seat}>
                        <div className="rp-cards">
                          {cards && cards.map((c, i) => <Card key={`${i}${c ? 'f' : 'b'}`} card={c} mark={c && p.uid !== me.id ? 'flip' : ''} />)}
                        </div>
                        <div className="rp-plate">
                          <Avatar user={p} size={30} />
                          <div>
                            <div className="rp-name">{p.name}</div>
                            <div className="rp-stack">{fmt(s.stack)}</div>
                          </div>
                          {hand.button === p.seat && <span className="rp-dealer">D</span>}
                          {positions[p.seat] && <span className="rp-pos">{positions[p.seat]}</span>}
                        </div>
                        {s.won > 0 ? (
                          <span className="rp-act win">WIN +{fmt(s.won)}</span>
                        ) : (
                          s.act && s.act.t !== 'show' && <span key={`${frame.lastStep}`} className={`rp-act ${tone(s.act)}`}>{verb(s.act)}</span>
                        )}
                        {s.open && frame.street === 'result' && p.hand && !s.folded && <span className="rp-hand">{p.hand}</span>}
                      </div>
                      {s.bet > 0 && <div className="rp-bet" style={spot.bet}>{fmt(s.bet)}</div>}
                    </div>
                  );
                })}
              </div>
              <div className="rp-caption" aria-live="polite">{caption}</div>
            </div>

            <div className="rp-controls">
              <button className="btn ghost" onClick={() => jump(0)} title="Start" aria-label="Back to the start">⏮</button>
              <button className="btn ghost" onClick={() => jump(at - 1)} disabled={at === 0} title="Step back" aria-label="Step back">◀</button>
              <button className="btn primary rp-play" onClick={playPause} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
              <button className="btn ghost" onClick={() => jump(at + 1)} disabled={at === last} title="Step forward" aria-label="Step forward">▶</button>
              <button className="btn ghost" onClick={() => jump(last)} title="End" aria-label="Jump to the end">⏭</button>
              <input type="range" min={0} max={last} value={at} onChange={(e) => jump(Number(e.target.value))} aria-label="Position in the hand" />
              <button className="btn ghost rp-speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} title="Playback speed">{speed}×</button>
            </div>

            <div className="rp-grid">
              {COLUMNS.map(([key, title]) => {
                const steps = hand.actions
                  .map((a, i) => ({ a, i }))
                  .filter(({ a }) => (a.t === 'sb' || a.t === 'bb' ? 'blinds' : a.st) === key);
                const cardsHere = key === 'flop' ? hand.board.slice(0, 3) : key === 'turn' ? hand.board.slice(3, 4) : key === 'river' ? hand.board.slice(4, 5) : [];
                const reached = key === 'blinds' || key === 'preflop' || frames.slice(0, at + 1).some((f) => f.street === key);
                return (
                  <div key={key} className={`rp-col ${reached ? '' : 'later'}`}>
                    <div className="rp-col-head">
                      <b>{title}</b>
                      {potAt[key] != null && key !== 'blinds' && <span>{fmt(potAt[key])}</span>}
                    </div>
                    {cardsHere.length > 0 && <div className="rp-col-cards">{cardsHere.map((c) => <Card key={c} card={reached ? c : null} />)}</div>}
                    {steps.map(({ a, i }) => (
                      <button
                        key={i}
                        className={`rp-step ${i === frame.lastStep ? 'now' : ''} ${i > frame.lastStep ? 'later' : ''}`}
                        onClick={() => jump(frames.findIndex((f) => f.step === i))}
                      >
                        <Avatar user={userOf[a.seat]} size={22} />
                        <span className="rp-step-who">
                          <span>{nameOf[a.seat]}</span>
                          <small>{positions[a.seat]}</small>
                        </span>
                        <span className={`rp-pill ${tone(a)}`}>{verb(a)}</span>
                      </button>
                    ))}
                    {steps.length === 0 && <span className="rp-none">—</span>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
