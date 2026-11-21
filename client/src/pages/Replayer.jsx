import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Avatar } from '../ui.jsx';
import { Card } from './Table.jsx';
import { FeltFx } from './TableFx.jsx';
import { useTableTheme, useTableFx } from '../tableTheme.js';
import { sfx, pokerSfx } from '../audio/sound.js';

// Plays a saved hand back on a table that looks like the real one (in the player's own theme):
// cards dealt and turned, bets sliding into the pot, the pot going to the winner, each player's
// chance of winning on every street, and the whole hand listed street by street underneath.

const STREETS = [
  ['blinds', 'Blinds'],
  ['preflop', 'Pre-flop'],
  ['flop', 'Flop'],
  ['turn', 'Turn'],
  ['river', 'River'],
  ['result', 'Result'],
];
const STREET_NAME = Object.fromEntries(STREETS);
const BOARD_AT = { preflop: 0, flop: 3, turn: 4, river: 5 };
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SPEEDS = [0.5, 1, 2, 4];
const STEP_MS = 1250;
const cardText = (c) => (c ? `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}` : '?');

// Seat names by position, counted from the player on the button's left.
const POSITION_NAMES = {
  2: ['BB', 'SB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'UTG', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'],
};
const positionsOf = (hand) => {
  const names = POSITION_NAMES[hand.players.length] || [];
  return Object.fromEntries(hand.players.map((p, i) => [p.seat, names[i] || '']));
};

const allInStep = (a) => a.stack === 0 && ['call', 'bet', 'raise'].includes(a.t);
function verb(a, fmt) {
  const allIn = allInStep(a);
  switch (a.t) {
    case 'sb': return `Small blind ${fmt(a.a)}`;
    case 'bb': return `Big blind ${fmt(a.a)}`;
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return `${allIn ? 'All-in' : 'Call'} ${fmt(a.a)}`;
    case 'bet': return `${allIn ? 'All-in' : 'Bet'} ${fmt(a.a)}`;
    case 'raise': return `${allIn ? 'All-in' : 'Raise to'} ${fmt(a.a)}`;
    case 'return': return `${fmt(a.a)} returned`;
    case 'win': return `Wins ${fmt(a.a)}`;
    case 'show': return 'Shows';
    default: return a.t;
  }
}
const short = (a, fmt) => (a.t === 'sb' ? `SB ${fmt(a.a)}` : a.t === 'bb' ? `BB ${fmt(a.a)}` : a.t === 'raise' && !allInStep(a) ? `Raise ${fmt(a.a)}` : verb(a, fmt));
const tone = (a) =>
  a.t === 'fold' ? 'fold'
    : allInStep(a) ? 'allin'
      : a.t === 'check' || a.t === 'call' ? 'call'
        : a.t === 'bet' || a.t === 'raise' ? 'raise'
          : a.t === 'win' ? 'win' : 'quiet';

// Every picture of the table in order: the deal, one per action, the board between streets,
// the showdown and the payout. Frames remember which bets were swept into the pot and who was paid.
function buildFrames(hand, meId) {
  const seats = {};
  for (const p of hand.players) seats[p.seat] = { stack: p.start, bet: 0, folded: false, act: null, won: 0, open: p.uid === meId };
  const frames = [];
  let street = 'preflop';
  let board = 0;
  let pot = 0;
  let lastStep = -1;
  let swept = null;
  const snap = (extra) => {
    if (extra.step >= 0) lastStep = extra.step;
    frames.push({ street, board, pot, lastStep, seats: structuredClone(seats), collected: swept, ...extra });
    swept = null;
  };
  // Bets go into the middle: remember them for the chip animation.
  const collect = () => {
    const moved = Object.entries(seats).filter(([, s]) => s.bet > 0).map(([seat, s]) => ({ seat: Number(seat), amount: s.bet }));
    if (moved.length) swept = [...(swept || []), ...moved];
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
        snap({ kind: 'street', step: -1, label: `${STREET_NAME[name]}: ${hand.board.slice(before, board).map(cardText).join(' ')}` });
      }
    }
  };
  snap({ kind: 'deal', step: -1, label: 'Cards are dealt' });
  hand.actions.forEach((a, i) => {
    if (a.st !== street) {
      if (a.st === 'result' && street !== 'result') {
        if (hand.showdown) {
          dealTo(5);
          collect();
          street = 'result';
          for (const p of hand.players) if (!seats[p.seat].folded && p.cards.some(Boolean)) seats[p.seat].open = true;
          snap({ kind: 'showdown', step: -1, label: 'Showdown' });
        } else {
          collect();
          street = 'result';
        }
      } else if (BOARD_AT[a.st] != null) dealTo(BOARD_AT[a.st]);
    }
    const s = seats[a.seat];
    if (!s) return;
    const potBefore = pot;
    s.stack = a.stack;
    s.bet = a.bet;
    if (a.t === 'fold') s.folded = true;
    if (a.t === 'show') s.open = true;
    let win = null;
    if (a.t === 'win') {
      s.won += a.a;
      win = { seat: a.seat, amount: a.a };
      for (const o of Object.values(seats)) o.bet = 0;
    }
    if (a.t !== 'return') s.act = a;
    pot = a.pot;
    snap({ kind: a.t === 'win' ? 'win' : 'act', step: i, potBefore, win });
  });
  return frames;
}

// Seats around an oval, your own at the bottom.
function seatSpot(pos, max, tall) {
  const angle = Math.PI / 2 + (pos * 2 * Math.PI) / max;
  const rx = tall ? 41 : 44;
  // On a tall phone table the upper seats sit higher, clear of the board, and the lower ones stay on the felt.
  const ry = tall ? (Math.sin(angle) < 0 ? 44 : 40) : 40;
  const bx = tall ? 24 : 26;
  const by = tall ? 22 : 22;
  return {
    seat: { left: `${50 + rx * Math.cos(angle)}%`, top: `${50 + ry * Math.sin(angle)}%` },
    bet: { left: `${50 + bx * Math.cos(angle)}%`, top: `${50 + by * Math.sin(angle)}%` },
  };
}

function ChipStack({ amount, bb }) {
  const n = amount / bb;
  const count = n <= 1 ? 1 : n <= 3 ? 2 : n <= 8 ? 3 : n <= 25 ? 4 : 5;
  return (
    <span className="rp-chipstack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <i key={i} className={`c${i % 3}`} style={{ bottom: i * 3 }} />)}
    </span>
  );
}

const useNarrow = () => {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 700px)');
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
};

export default function Replayer({ token, hands, index, me, onIndex, onClose }) {
  const hand = hands[index];
  const theme = useTableTheme();
  const fx = useTableFx();
  const narrow = useNarrow();
  const frames = useMemo(() => (hand.actions?.length ? buildFrames(hand, me.id) : []), [hand, me.id]);
  const positions = useMemo(() => positionsOf(hand), [hand]);
  const [extras, setExtras] = useState({ odds: {}, best: {}, rabbit: hand.rabbit || [], rabbitBy: hand.rabbitBy || '' });
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [inBB, setInBB] = useState(false);
  const [muted, setMuted] = useState(sfx.isMuted());
  const logRef = useRef(null);
  const last = frames.length - 1;
  const frame = frames[at];
  const bb = hand.blinds[1] || 1;
  const fmt = (n) => (inBB ? `${(Math.round((n / bb) * 10) / 10).toLocaleString('en-IN')} BB` : Number(n || 0).toLocaleString('en-IN'));

  // A new hand: start from the top and fetch its odds and winning cards.
  useEffect(() => {
    setAt(0);
    setPlaying(frames.length > 0);
    setExtras({ odds: {}, best: {}, rabbit: hand.rabbit || [], rabbitBy: hand.rabbitBy || '' });
    let gone = false;
    api(`/hand/${hand.id}`, { token })
      .then((r) => { if (!gone) setExtras({ odds: r.odds || {}, best: r.best || {}, rabbit: r.hand.rabbit || [], rabbitBy: r.hand.rabbitBy || '' }); })
      .catch(() => {});
    return () => { gone = true; };
  }, [hand.id]);

  // Autoplay, a little slower on new streets and the payout.
  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const next = frames[at + 1];
    const pause = next && (next.kind === 'street' || next.kind === 'showdown' || next.kind === 'win') ? 1.35 : 1;
    const t = setTimeout(() => setAt((n) => Math.min(last, n + 1)), (STEP_MS * pause) / speed);
    return () => clearTimeout(t);
  }, [playing, at, speed, last]);

  // Sounds while it plays forward (not while jumping around).
  const prevAt = useRef(0);
  useEffect(() => {
    const was = prevAt.current;
    prevAt.current = at;
    if (!playing || at !== was + 1 || !frame) return;
    if (frame.kind === 'street') {
      if (frame.board === 3) [0, 0.1, 0.2].forEach((d) => pokerSfx.flip(d));
      else pokerSfx.flip();
    } else if (frame.kind === 'showdown') pokerSfx.flip();
    else if (frame.kind === 'win') pokerSfx.win();
    else if (frame.kind === 'act') {
      const a = hand.actions[frame.step];
      if (allInStep(a)) pokerSfx.allIn();
      else if (a.t === 'raise' || a.t === 'bet') pokerSfx.raise();
      else if (a.t === 'call' || a.t === 'sb' || a.t === 'bb') pokerSfx.call();
      else if (a.t === 'check') pokerSfx.check();
      else if (a.t === 'fold') pokerSfx.fold();
    }
  }, [at]);

  const jump = (n) => {
    setPlaying(false);
    setAt(Math.max(0, Math.min(last, n)));
  };
  // First frame of each street, for the street buttons and the markers on the scrubber.
  const streetStarts = useMemo(() => {
    const out = [];
    frames.forEach((f, i) => {
      const key = f.kind === 'deal' || (f.step >= 0 && ['sb', 'bb'].includes(hand.actions[f.step]?.t)) ? 'blinds' : f.street;
      if (!out.some((s) => s.key === key)) out.push({ key, at: i });
    });
    return out;
  }, [frames]);
  const streetIndex = streetStarts.reduce((k, s, i) => (s.at <= at ? i : k), 0);
  const jumpStreet = (dir) => {
    const target = streetStarts[Math.max(0, Math.min(streetStarts.length - 1, streetIndex + dir))];
    if (dir < 0 && streetStarts[streetIndex].at < at) jump(streetStarts[streetIndex].at);
    else if (target) jump(target.at);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? jumpStreet(1) : jump(at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? jumpStreet(-1) : jump(at - 1); }
      else if (e.key === ' ') { e.preventDefault(); playPause(); }
      else if (e.key === 'Home') jump(0);
      else if (e.key === 'End') jump(last);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keep the current step in view in the list, without scrolling the whole page.
  useEffect(() => {
    const box = logRef.current;
    const el = box?.querySelector('.rp-step.now');
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - b.height / 3;
    if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - b.width / 3;
  }, [at]);

  const playPause = () => {
    sfx.unlock();
    if (at >= last) setAt(0);
    setPlaying(!playing || at >= last);
  };

  const mine = hand.players.find((p) => p.uid === me.id);
  const mySeat = mine ? mine.seat : 0;
  const max = Math.max(hand.maxSeats || 6, ...hand.players.map((p) => p.seat + 1));
  const bySeat = Object.fromEntries(hand.players.map((p) => [p.seat, p]));

  // The summary line: how the hand went for me.
  const foldStreet = mine && hand.actions?.find((a) => a.seat === mine.seat && a.t === 'fold')?.st;
  const summary = !mine ? '' : mine.net > 0 ? `Won ${fmt(mine.net)}` : mine.net < 0 ? `Lost ${fmt(-mine.net)}` : 'Broke even';
  const summaryNote = !mine ? '' : mine.folded ? `folded ${foldStreet === 'preflop' ? 'pre-flop' : `on the ${foldStreet}`}` : mine.hand || (mine.net > 0 ? 'everyone folded' : '');

  if (!frame) {
    return (
      <div className="rp-backdrop" onClick={onClose}>
        <div className={`rp theme-${theme}`} role="dialog" aria-label="Hand replayer" onClick={(e) => e.stopPropagation()}>
          <Header hand={hand} index={index} hands={hands} onIndex={onIndex} onClose={onClose} summary={summary} summaryNote={summaryNote} net={mine?.net || 0} />
          <div className="rp-old">
            <p className="muted small">This hand was saved before the replayer existed, so only its summary is available.</p>
            <ol className="hh-log">{hand.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
          </div>
        </div>
      </div>
    );
  }

  const step = frame.step >= 0 ? hand.actions[frame.step] : null;
  const atResult = frame.street === 'result';
  // Winning cards light up once the hand is decided at a showdown.
  const winners = hand.players.filter((p) => p.won > 0).map((p) => p.seat);
  const winning = new Set(atResult && hand.showdown ? winners.flatMap((s) => extras.best[s] || []) : []);
  const markOf = (card) => (!winning.size || !card ? '' : winning.has(card) ? 'win' : 'dim');
  const odds = !atResult ? extras.odds[frame.board] : null;
  const rabbitFrom = hand.board.length;
  const showRabbit = atResult && at === last && extras.rabbit.length > 0;

  // What is happening right now, in words.
  let caption = frame.label || '';
  let detail = '';
  if (step) {
    const p = bySeat[step.seat];
    caption = `${p?.name || 'Seat ' + (step.seat + 1)}${positions[step.seat] ? ` (${positions[step.seat]})` : ''}: ${verb(step, fmt)}`;
    if (step.t === 'call' && step.a > 0) {
      const need = Math.round((step.a / (frame.potBefore + step.a)) * 100);
      detail = `Pot odds: called ${fmt(step.a)} to win ${fmt(frame.potBefore)} · needed ${need}% to break even`;
    } else if (step.t === 'win' && hand.showdown && p?.hand) detail = p.hand;
    else if ((step.t === 'bet' || step.t === 'raise') && frame.potBefore > 0) {
      detail = `${step.t === 'bet' ? 'Bet' : 'Raised to'} ${Math.round((step.a / frame.potBefore) * 100)}% of the pot`;
    }
  }

  return (
    <div className="rp-backdrop" onClick={onClose}>
      <div className={`rp theme-${theme} ${fx ? '' : 'fx-off'}`} role="dialog" aria-label="Hand replayer" onClick={(e) => e.stopPropagation()}>
        <Header hand={hand} index={index} hands={hands} onIndex={onIndex} onClose={onClose} summary={summary} summaryNote={summaryNote} net={mine?.net || 0} />

        <div className="rp-stage">
          <div className="rp-table">
            <div className="rp-felt">
              <FeltFx />
              <div className="rp-mid">
                <span className={`rp-street ${atResult ? 'done' : ''}`}>{atResult ? (hand.showdown ? 'Showdown' : 'Hand over') : STREET_NAME[frame.street]}</span>
                <div className="rp-board">
                  {[0, 1, 2, 3, 4].map((i) =>
                    i < frame.board ? (
                      <Card key={`${hand.id}-${i}`} card={hand.board[i]} mark={`flip ${markOf(hand.board[i])}`} style={{ animationDelay: `${frame.kind === 'street' && frame.board === 3 ? i * 110 : 0}ms` }} />
                    ) : showRabbit && extras.rabbit[i - rabbitFrom] ? (
                      <Card key={`${hand.id}-r${i}`} card={extras.rabbit[i - rabbitFrom]} mark="flip rabbit" style={{ animationDelay: `${(i - rabbitFrom) * 120}ms` }} />
                    ) : (
                      <div key={i} className="pk-card slot" />
                    ),
                  )}
                </div>
                {showRabbit && <span className="rp-rabbit">🐇 {extras.rabbitBy || 'Someone'} rabbit-hunted</span>}
                <div className="rp-pot" key={`pot${frame.collected ? at : ''}`}>
                  {frame.pot > 0 && <ChipStack amount={frame.pot} bb={bb} />}
                  <span>Pot</span>
                  <b>{fmt(frame.pot)}</b>
                </div>
              </div>

              {hand.players.map((p) => {
                const s = frame.seats[p.seat];
                const spot = seatSpot((p.seat - mySeat + max) % max, max, narrow);
                const acting = step && step.seat === p.seat;
                const cards = s.folded ? null : s.open && p.cards.length ? p.cards : [null, null];
                const pct = odds && !s.folded ? odds[p.seat] : null;
                const isMe = p.uid === me.id;
                return (
                  <div key={p.seat} className={`rp-seat ${isMe ? 'me' : ''} ${s.folded ? 'out' : ''} ${acting ? 'acting' : ''} ${s.won ? 'won' : ''}`} style={spot.seat}>
                    <div className="rp-cards">
                      {cards && cards.map((c, i) => <Card key={`${i}${c ? 'f' : 'b'}`} card={c} mark={`${c && !isMe ? 'flip' : ''} ${markOf(c)}`} />)}
                      {pct != null && <span className={`rp-odds ${pct >= 100 / Object.keys(odds).length ? 'ahead' : 'behind'}`}>{pct}%</span>}
                    </div>
                    <div className="rp-plate">
                      <Avatar user={p} size={30} />
                      <div className="rp-who">
                        <div className="rp-name">{p.name}</div>
                        <div className="rp-stack">{s.stack === 0 && !s.folded && !atResult ? 'All-in' : fmt(s.stack)}</div>
                      </div>
                      {hand.button === p.seat && <span className="rp-dealer" title="Dealer button">D</span>}
                      {positions[p.seat] && <span className="rp-pos">{positions[p.seat]}</span>}
                      {s.won > 0 ? (
                        <span className="rp-act win" key={`w${s.won}`}>+{fmt(s.won)}</span>
                      ) : (
                        s.act && s.act.t !== 'show' && <span key={`${frame.lastStep}-${p.seat}`} className={`rp-act ${tone(s.act)}`}>{short(s.act, fmt)}</span>
                      )}
                    </div>
                    {atResult && s.open && !s.folded && p.hand && (
                      // Phones get the short form ("Two pair"); the full name is in the caption.
                      <span className={`rp-hand ${s.won ? 'won' : ''}`} title={p.hand}>{narrow ? p.hand.split(',')[0] : p.hand}</span>
                    )}
                  </div>
                );
              })}

              {hand.players.map((p) => {
                const s = frame.seats[p.seat];
                if (!(s.bet > 0)) return null;
                const spot = seatSpot((p.seat - mySeat + max) % max, max, narrow);
                return (
                  <div key={`b${p.seat}`} className="rp-bet" style={spot.bet}>
                    <ChipStack amount={s.bet} bb={bb} />
                    {fmt(s.bet)}
                  </div>
                );
              })}

              {/* Chips sweeping into the pot, and the pot going to the winner */}
              {frame.collected?.map((c) => {
                const from = seatSpot((c.seat - mySeat + max) % max, max, narrow).bet;
                return <span key={`c${at}-${c.seat}`} className="rp-fly in" style={{ '--x': from.left, '--y': from.top }}><ChipStack amount={c.amount} bb={bb} /></span>;
              })}
              {frame.win && (() => {
                const to = seatSpot((frame.win.seat - mySeat + max) % max, max, narrow).seat;
                return <span key={`w${at}`} className="rp-fly out" style={{ '--x': to.left, '--y': to.top }}><ChipStack amount={frame.win.amount} bb={bb} /></span>;
              })()}
            </div>
          </div>

          <div className="rp-caption" aria-live="polite">
            <b>{caption}</b>
            {detail && <span>{detail}</span>}
          </div>
        </div>

        <div className="rp-controls">
          <div className="rp-scrub">
            <input type="range" min={0} max={last} value={at} onChange={(e) => jump(Number(e.target.value))} aria-label="Position in the hand" />
            <div className="rp-marks" aria-hidden="true">
              {streetStarts.map((s) => <i key={s.key} style={{ left: `${last ? (s.at / last) * 100 : 0}%` }} title={STREET_NAME[s.key]} />)}
            </div>
          </div>
          <div className="rp-buttons">
            <button className="btn ghost" onClick={() => jump(0)} title="Start (Home)" aria-label="Back to the start">⏮</button>
            <button className="btn ghost" onClick={() => jumpStreet(-1)} title="Previous street (Shift ←)" aria-label="Previous street">«</button>
            <button className="btn ghost" onClick={() => jump(at - 1)} disabled={at === 0} title="Step back (←)" aria-label="Step back">‹</button>
            <button className="btn primary rp-play" onClick={playPause} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause (Space)">{playing ? '❚❚' : at >= last ? '↻' : '▶'}</button>
            <button className="btn ghost" onClick={() => jump(at + 1)} disabled={at === last} title="Step forward (→)" aria-label="Step forward">›</button>
            <button className="btn ghost" onClick={() => jumpStreet(1)} title="Next street (Shift →)" aria-label="Next street">»</button>
            <button className="btn ghost" onClick={() => jump(last)} title="End (End)" aria-label="Jump to the end">⏭</button>
            <span className="rp-sep" />
            <button className="btn ghost rp-small" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} title="Playback speed">{speed}×</button>
            <button className="btn ghost rp-small" onClick={() => setInBB(!inBB)} title="Show amounts in chips or big blinds">{inBB ? 'BB' : 'Chips'}</button>
            <button className="btn ghost rp-small" onClick={() => { sfx.unlock(); sfx.setMuted(!muted); setMuted(!muted); }} aria-label={muted ? 'Sound on' : 'Sound off'}>{muted ? '🔇' : '🔊'}</button>
          </div>
          <div className="rp-streets" role="tablist" aria-label="Streets">
            {streetStarts.map((s, i) => (
              <button key={s.key} role="tab" aria-selected={i === streetIndex} className={`rp-street-tab ${i === streetIndex ? 'on' : ''}`} onClick={() => jump(s.at)}>
                {STREET_NAME[s.key]}
              </button>
            ))}
          </div>
        </div>

        <div className="rp-log" ref={logRef}>
          {STREETS.map(([key, title]) => {
            const steps = hand.actions.map((a, i) => ({ a, i })).filter(({ a }) => (a.t === 'sb' || a.t === 'bb' ? 'blinds' : a.st) === key);
            if (!steps.length && key !== 'flop' && key !== 'turn' && key !== 'river') return null;
            const boardHere = key === 'flop' ? hand.board.slice(0, 3) : key === 'turn' ? hand.board.slice(3, 4) : key === 'river' ? hand.board.slice(4, 5) : [];
            if (!steps.length && !boardHere.length) return null;
            const startAt = streetStarts.find((s) => s.key === key)?.at ?? 0;
            const reached = at >= startAt;
            const potStart = frames[startAt]?.pot;
            return (
              <section key={key} className={`rp-col ${reached ? '' : 'later'}`}>
                <header className="rp-col-head" onClick={() => jump(startAt)}>
                  <b>{title}</b>
                  {key !== 'blinds' && potStart > 0 && <span>{fmt(potStart)}</span>}
                  {boardHere.length > 0 && <span className="rp-col-cards">{boardHere.map((c) => <Card key={c} card={reached ? c : null} />)}</span>}
                </header>
                {steps.map(({ a, i }) => (
                  <button key={i} className={`rp-step ${i === frame.lastStep ? 'now' : ''} ${i > frame.lastStep ? 'later' : ''}`} onClick={() => jump(frames.findIndex((f) => f.step === i))}>
                    <Avatar user={bySeat[a.seat] || { name: '?' }} size={22} />
                    <span className="rp-step-who">
                      <span>{bySeat[a.seat]?.name}</span>
                      <small>{positions[a.seat]}</small>
                    </span>
                    <span className={`rp-pill ${tone(a)}`}>{short(a, fmt)}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Header({ hand, index, hands, onIndex, onClose, summary, summaryNote, net }) {
  return (
    <header className="rp-head">
      <div className="rp-title">
        <b>{hand.tableName}</b>
        <span>
          Hand #{hand.handNo} · {hand.blinds[0]}/{hand.blinds[1]} · {hand.players.length} players ·{' '}
          {new Date(hand.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {summary && (
        <div className={`rp-result ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}`}>
          <b>{summary}</b>
          {summaryNote && <small>{summaryNote}</small>}
        </div>
      )}
      <div className="rp-nav">
        <button className="btn ghost" disabled={index >= hands.length - 1} onClick={() => onIndex(index + 1)} title="Older hand" aria-label="Older hand">‹</button>
        <span className="muted small">{hands.length - index}/{hands.length}</span>
        <button className="btn ghost" disabled={index <= 0} onClick={() => onIndex(index - 1)} title="Newer hand" aria-label="Newer hand">›</button>
        <button className="btn ghost rp-x" onClick={onClose} aria-label="Close replayer">✕</button>
      </div>
    </header>
  );
}
