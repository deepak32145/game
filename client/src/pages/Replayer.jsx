import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Avatar } from '../ui.jsx';
import { Card } from './Table.jsx';
import { useTableTheme } from '../tableTheme.js';

// Hand history viewer: one still picture of how the hand ended, the whole hand street by street
// underneath, and every hand of the session down the side. Clicking an action shows the table at
// that moment. Download saves the hand as a standard text hand history; Share copies it.

const COLUMNS = [
  ['blinds', 'Blinds'],
  ['preflop', 'Pre-Flop'],
  ['flop', 'Flop'],
  ['turn', 'Turn'],
  ['river', 'River'],
];
const BOARD_AT = { preflop: 0, flop: 3, turn: 4, river: 5 };
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cardText = (c) => (c ? `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}` : '?');

const POSITION_NAMES = {
  2: ['BB', 'BTN'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'UTG', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'],
};
const positionsOf = (hand) => {
  const names = POSITION_NAMES[hand.players.length] || [];
  return Object.fromEntries(hand.players.map((p, i) => [p.seat, names[i] || '']));
};
const allIn = (a) => a.stack === 0 && ['call', 'bet', 'raise'].includes(a.t);
// The words in an action bubble: a verb, and an amount on its own line.
const bubble = (a, fmt) => {
  switch (a.t) {
    case 'sb': return ['SB', fmt(a.a)];
    case 'bb': return ['BB', fmt(a.a)];
    case 'fold': return ['Fold'];
    case 'check': return ['Check'];
    case 'call': return ['Call', fmt(a.a)];
    case 'bet': return ['Bet', fmt(a.a)];
    case 'raise': return ['Raise', fmt(a.a)];
    case 'return': return ['Returned', fmt(a.a)];
    case 'win': return ['Wins', fmt(a.a)];
    case 'show': return ['Shows'];
    default: return [a.t];
  }
};

// The table after every step, used when an action is clicked (the default view is the last one).
function buildFrames(hand, meId) {
  const seats = {};
  for (const p of hand.players) seats[p.seat] = { stack: p.start, bet: 0, folded: false, act: null, won: 0, open: p.uid === meId };
  const frames = [];
  let street = 'preflop';
  let board = 0;
  let pot = 0;
  const snap = (step) => frames.push({ step, street, board, pot, seats: structuredClone(seats) });
  const collect = () => {
    for (const s of Object.values(seats)) {
      s.bet = 0;
      if (s.act && !s.folded && s.stack > 0) s.act = null;
    }
  };
  const dealTo = (target) => {
    for (const name of ['flop', 'turn', 'river']) {
      if (BOARD_AT[name] > board && BOARD_AT[name] <= target && BOARD_AT[name] <= hand.board.length) {
        collect();
        street = name;
        board = BOARD_AT[name];
      }
    }
  };
  snap(-1);
  hand.actions.forEach((a, i) => {
    if (a.st !== street) {
      if (a.st === 'result' && street !== 'result') {
        if (hand.showdown) {
          dealTo(5);
          for (const p of hand.players) if (!seats[p.seat].folded && p.cards.some(Boolean)) seats[p.seat].open = true;
        }
        collect();
        street = 'result';
      } else if (BOARD_AT[a.st] != null) dealTo(BOARD_AT[a.st]);
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
    snap(i);
  });
  return frames;
}

// A standard text hand history, for saving or pasting into a chat.
function handText(hand, me, name) {
  const seatName = (seat) => name(hand.players.find((p) => p.seat === seat));
  const lines = [];
  const when = new Date(hand.at);
  lines.push(`Pitch Duel Hand #${hand.id.slice(-10).toUpperCase()}: Hold'em No Limit (${hand.blinds[0]}/${hand.blinds[1]}) - ${when.toLocaleString('en-IN')}`);
  lines.push(`Table '${hand.tableName}' ${hand.maxSeats || 6}-max Seat #${hand.button + 1} is the button`);
  for (const p of [...hand.players].sort((a, b) => a.seat - b.seat)) lines.push(`Seat ${p.seat + 1}: ${name(p)} (${p.start} in chips)`);
  const mine = hand.players.find((p) => p.uid === me.id);
  let street = 'preflop';
  lines.push('*** HOLE CARDS ***');
  if (mine?.cards?.every(Boolean)) lines.push(`Dealt to ${name(mine)} [${mine.cards.join(' ')}]`);
  for (const a of hand.actions || []) {
    if (a.st !== street && a.st !== 'result' && BOARD_AT[a.st] != null) {
      street = a.st;
      const shown = hand.board.slice(0, BOARD_AT[street]);
      const prev = shown.slice(0, -1 * (street === 'flop' ? 3 : 1));
      lines.push(`*** ${street.toUpperCase()} *** ${prev.length ? `[${prev.join(' ')}] ` : ''}[${shown.slice(prev.length).join(' ')}]`);
    }
    const who = seatName(a.seat);
    const tail = allIn(a) ? ' and is all-in' : '';
    if (a.t === 'sb') lines.push(`${who}: posts small blind ${a.a}`);
    else if (a.t === 'bb') lines.push(`${who}: posts big blind ${a.a}`);
    else if (a.t === 'fold') lines.push(`${who}: folds`);
    else if (a.t === 'check') lines.push(`${who}: checks`);
    else if (a.t === 'call') lines.push(`${who}: calls ${a.a}${tail}`);
    else if (a.t === 'bet') lines.push(`${who}: bets ${a.a}${tail}`);
    else if (a.t === 'raise') lines.push(`${who}: raises to ${a.a}${tail}`);
    else if (a.t === 'return') lines.push(`Uncalled bet (${a.a}) returned to ${who}`);
  }
  if (hand.showdown) {
    lines.push('*** SHOW DOWN ***');
    for (const p of hand.players) if (!p.folded && p.cards.every(Boolean)) lines.push(`${name(p)}: shows [${p.cards.join(' ')}]${p.hand ? ` (${p.hand})` : ''}`);
  }
  for (const p of hand.players) if (p.won > 0) lines.push(`${name(p)} collected ${p.won} from pot`);
  lines.push('*** SUMMARY ***');
  lines.push(`Total pot ${hand.pot}`);
  if (hand.board.length) lines.push(`Board [${hand.board.join(' ')}]`);
  for (const p of [...hand.players].sort((a, b) => a.seat - b.seat)) {
    const result = p.won > 0 ? `won (${p.won})` : p.folded ? 'folded' : 'lost';
    lines.push(`Seat ${p.seat + 1}: ${name(p)} ${result}${p.cards.every(Boolean) && p.uid !== me.id && !p.folded ? ` showed [${p.cards.join(' ')}]` : ''}`);
  }
  return lines.join('\n');
}

// Seats around the table, your own at the bottom.
function seatAt(pos, max) {
  const angle = Math.PI / 2 + (pos * 2 * Math.PI) / max;
  return {
    seat: { left: `${50 + 41 * Math.cos(angle)}%`, top: `${50 + (Math.sin(angle) > 0 ? 31 : 36) * Math.sin(angle)}%` }, // lower seats leave room for their hand name
    right: Math.cos(angle) > 0.3, // seats on the right show their cards on the inner (left) side
    button: { left: `${50 + 27 * Math.cos(angle + 0.35)}%`, top: `${48 + 24 * Math.sin(angle + 0.35)}%` },
    bet: { left: `${50 + 25 * Math.cos(angle)}%`, top: `${48 + 22 * Math.sin(angle)}%` },
  };
}

function Chips() {
  return (
    <span className="hx-chips" aria-hidden="true">
      <i className="c0" /><i className="c1" /><i className="c2" /><i className="c3" /><i className="c4" />
    </span>
  );
}

export default function Replayer({ token, hands, index, me, onIndex, onClose }) {
  const hand = hands[index];
  const theme = useTableTheme();
  const [inBB, setInBB] = useState(false);
  const [hide, setHide] = useState(false);
  const [moment, setMoment] = useState(null); // an action's index, or null for the end of the hand
  const [extras, setExtras] = useState({ best: {}, rabbit: [], rabbitBy: '' });
  const [toast, setToast] = useState('');
  const frames = useMemo(() => (hand.actions?.length ? buildFrames(hand, me.id) : []), [hand, me.id]);
  const positions = useMemo(() => positionsOf(hand), [hand]);
  const bb = hand.blinds[1] || 1;
  const fmt = (n) => (inBB ? `${(Math.round((n / bb) * 10) / 10).toLocaleString('en-IN')} BB` : Number(n || 0).toLocaleString('en-IN'));
  // Hide names: everyone but you becomes "Player" and their seat number, for sharing a screenshot.
  const nameOf = (p) => (!p ? '?' : hide && p.uid !== me.id ? `Player ${p.seat + 1}` : p.name);
  const faceOf = (p) => (hide && p.uid !== me.id ? { name: `${p.seat + 1}` } : p);

  useEffect(() => {
    setMoment(null);
    let gone = false;
    setExtras({ best: {}, rabbit: hand.rabbit || [], rabbitBy: hand.rabbitBy || '' });
    api(`/hand/${hand.id}`, { token })
      .then((r) => { if (!gone) setExtras({ best: r.best || {}, rabbit: r.hand.rabbit || [], rabbitBy: r.hand.rabbitBy || '' }); })
      .catch(() => {});
    return () => { gone = true; };
  }, [hand.id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown' && index < hands.length - 1) { e.preventDefault(); onIndex(index + 1); }
      else if (e.key === 'ArrowUp' && index > 0) { e.preventDefault(); onIndex(index - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const flash = (text) => {
    setToast(text);
    setTimeout(() => setToast(''), 2200);
  };
  const download = () => {
    const blob = new Blob([handText(hand, me, nameOf)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hand-${hand.tableName.replace(/\W+/g, '-')}-${hand.handNo}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash('Hand history saved');
  };
  const share = async () => {
    try {
      await navigator.clipboard.writeText(handText(hand, me, nameOf));
      flash('Hand copied. Paste it in your group chat');
    } catch {
      flash('Could not copy on this device');
    }
  };

  const mine = hand.players.find((p) => p.uid === me.id);
  const mySeat = mine ? mine.seat : 0;
  const max = Math.max(hand.maxSeats || 6, ...hand.players.map((p) => p.seat + 1));
  const bySeat = Object.fromEntries(hand.players.map((p) => [p.seat, p]));
  const handId = `TM${hand.id.slice(-10).toUpperCase()}`;

  // The picture: the end of the hand, or the moment of the clicked action.
  const frame = frames.length ? (moment == null ? frames[frames.length - 1] : frames.find((f) => f.step === moment) || frames[frames.length - 1]) : null;
  const atEnd = moment == null;
  const winners = hand.players.filter((p) => p.won > 0).map((p) => p.seat);
  const winning = new Set(atEnd && hand.showdown ? winners.flatMap((s) => extras.best[s] || []) : []);
  const markOf = (card) => (!winning.size || !card ? '' : winning.has(card) ? 'win' : 'dim');
  const boardCount = frame ? frame.board : hand.board.length;
  const potShown = frame ? (atEnd ? hand.pot : frame.pot) : hand.pot;

  // Pot at the start of each street; an unplayed street shows the final pot, as the hand ended with it.
  const potAt = {};
  let running = 0;
  for (const a of hand.actions || []) {
    const key = a.t === 'sb' || a.t === 'bb' ? 'blinds' : a.st;
    if (key !== 'blinds' && key !== 'result' && potAt[key] == null) potAt[key] = running;
    if (a.t !== 'win') running = a.pot;
  }
  if (potAt.preflop == null) potAt.preflop = running;
  for (const [key] of COLUMNS) if (potAt[key] == null || potAt[key] === 0) potAt[key] = hand.pot;
  const lastStreet = [...COLUMNS].reverse().find(([key]) => (hand.actions || []).some((a) => a.st === key))?.[0] || 'preflop';

  return (
    <div className="hx-backdrop" onClick={onClose}>
      <div className="hx" role="dialog" aria-label="Hand history" onClick={(e) => e.stopPropagation()}>
        <header className="hx-top">
          <div className="hx-title">
            <span className="hx-logo">HH</span>
            <b>{hand.tableName}</b>
          </div>
          <button className="hx-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="hx-body">
          <div className="hx-main">
            <div className="hx-bar">
              <span className="hx-id" title={new Date(hand.at).toLocaleString('en-IN')}>
                {handId}
                <small>Hand #{hand.handNo} · {hand.blinds[0]}/{hand.blinds[1]} · {new Date(hand.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
              </span>
              <div className="hx-tools">
                <button className="hx-tool red" onClick={download} title="Download this hand" aria-label="Download this hand">⬇</button>
                <button className={`hx-tool ${inBB ? 'on' : ''}`} onClick={() => setInBB(!inBB)} title="Show amounts in big blinds" aria-pressed={inBB}>BB</button>
                <button className={`hx-tool ${hide ? 'on' : ''}`} onClick={() => setHide(!hide)} title="Hide other players' names" aria-pressed={hide} aria-label="Hide names">🕶</button>
                <button className="hx-tool green" onClick={share} title="Copy this hand to share" aria-label="Share this hand">⤴</button>
              </div>
            </div>

            {!frame ? (
              <div className="hx-old">
                <p className="muted small">This hand was saved before step-by-step history existed, so only its summary is available.</p>
                <ol className="hh-log">{hand.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
              </div>
            ) : (
              <div className={`hx-stage theme-${theme}`}>
                <div className="hx-rail">
                  <div className="hx-felt">
                    <span className="hx-mark">PITCH DUEL</span>
                  </div>
                </div>

                <div className="hx-middle">
                  {boardCount > 0 && (
                    <div className="hx-board">
                      {hand.board.slice(0, boardCount).map((c) => <Card key={c} card={c} mark={markOf(c)} />)}
                      {atEnd && extras.rabbit.map((c) => <Card key={`r${c}`} card={c} mark="rabbit" />)}
                    </div>
                  )}
                  <div className="hx-pot"><Chips /><b>{fmt(potShown)}</b></div>
                  {atEnd && extras.rabbit.length > 0 && <span className="hx-rabbit">🐇 {extras.rabbitBy} rabbit-hunted</span>}
                </div>

                {hand.players.map((p) => {
                  const s = frame.seats[p.seat];
                  const spot = seatAt((p.seat - mySeat + max) % max, max);
                  const isMe = p.uid === me.id;
                  const won = atEnd ? p.won > 0 : s.won > 0;
                  const cards = s.open && p.cards.some(Boolean) && !s.folded ? p.cards : null;
                  const acting = moment != null && hand.actions[moment]?.seat === p.seat;
                  return (
                    <div key={p.seat} className={`hx-seat ${spot.right ? 'cards-left' : ''} ${isMe ? 'me' : ''} ${s.folded ? 'out' : ''} ${won ? 'won' : ''} ${acting ? 'acting' : ''}`} style={spot.seat}>
                      {cards && (
                        <div className="hx-cards">
                          {cards.map((c, i) => <Card key={i} card={c} mark={markOf(c)} />)}
                        </div>
                      )}
                      <div className="hx-face"><Avatar user={faceOf(p)} size={54} /></div>
                      <div className="hx-plate">
                        <span className="hx-name">{nameOf(p)}</span>
                        <span className="hx-stack">{fmt(s.stack)}</span>
                      </div>
                      {won && <span className="hx-win">WIN</span>}
                      {!won && moment != null && s.act && <span className="hx-seat-act">{bubble(s.act, fmt).join(' ')}</span>}
                      {atEnd && p.hand && !p.folded && s.open && <span className={`hx-handname ${won ? 'won' : ''}`}>{p.hand}</span>}
                    </div>
                  );
                })}

                {hand.button != null && bySeat[hand.button] && (
                  <span className="hx-dealer" style={seatAt((hand.button - mySeat + max) % max, max).button}>D</span>
                )}
                {moment != null && hand.players.map((p) => {
                  const s = frame.seats[p.seat];
                  if (!(s.bet > 0)) return null;
                  return <span key={`b${p.seat}`} className="hx-bet" style={seatAt((p.seat - mySeat + max) % max, max).bet}>{fmt(s.bet)}</span>;
                })}
                {moment != null && (
                  <button className="hx-back" onClick={() => setMoment(null)}>Show the result ›</button>
                )}
              </div>
            )}

            {frame && (
              <div className="hx-grid" role="table" aria-label="The hand, street by street">
                {COLUMNS.map(([key, title]) => {
                  const steps = hand.actions
                    .map((a, i) => ({ a, i }))
                    .filter(({ a }) => {
                      const col = a.t === 'sb' || a.t === 'bb' ? 'blinds' : a.st === 'result' ? lastStreet : a.st;
                      return col === key && a.t !== 'return';
                    });
                  const boardHere = key === 'flop' ? hand.board.slice(0, 3) : key === 'turn' ? hand.board.slice(3, 4) : key === 'river' ? hand.board.slice(4, 5) : [];
                  // Cards turned over at the showdown appear in the last street played.
                  const shown = key === lastStreet && hand.showdown ? hand.players.filter((p) => !p.folded && p.cards.every(Boolean) && p.uid !== me.id) : [];
                  return (
                    <div key={key} className="hx-col" role="rowgroup">
                      <div className="hx-col-head">
                        <b>{title === 'Blinds' ? 'Blinds' : title}</b>
                        {key === 'blinds' ? <span className="hx-potbox muted">{hand.blinds[0]}/{hand.blinds[1]}</span> : <span className="hx-potbox">{fmt(potAt[key])}</span>}
                      </div>
                      {boardHere.length > 0 && <div className="hx-col-board">{boardHere.map((c) => <Card key={c} card={c} />)}</div>}
                      {steps.map(({ a, i }) => {
                        const p = bySeat[a.seat];
                        const [verb, amount] = bubble(a, fmt);
                        return (
                          <button key={i} className={`hx-act ${moment === i ? 'now' : ''} ${a.t}`} onClick={() => setMoment(moment === i ? null : i)} title="Show the table at this moment">
                            <span className="hx-who">
                              <Avatar user={faceOf(p || { name: '?' })} size={30} />
                              {positions[a.seat] && <span className={`hx-pos ${positions[a.seat]}`}>{positions[a.seat]}</span>}
                            </span>
                            <span className="hx-what">
                              <span className="hx-actname">{nameOf(p)}</span>
                              {a.t === 'show' && p?.cards?.some(Boolean) ? (
                                <span className="hx-shown">{p.cards.map((c, k) => <Card key={k} card={c} />)}</span>
                              ) : (
                                <span className="hx-bubble">{verb}{amount && <b>{amount}</b>}</span>
                              )}
                              {allIn(a) && <span className="hx-allin">All-In</span>}
                            </span>
                          </button>
                        );
                      })}
                      {shown.map((p) => (
                        <div key={`s${p.seat}`} className="hx-act shown">
                          <span className="hx-who">
                            <Avatar user={faceOf(p)} size={30} />
                            {positions[p.seat] && <span className={`hx-pos ${positions[p.seat]}`}>{positions[p.seat]}</span>}
                          </span>
                          <span className="hx-what">
                            <span className="hx-actname">{nameOf(p)}</span>
                            <span className="hx-shown">{p.cards.map((c) => <Card key={c} card={c} />)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="hx-list" aria-label="Hands">
            <div className="hx-list-head"><span>My Cards</span><span>Winner</span><span>Pot</span></div>
            <ul>
              {hands.map((h, i) => {
                const myHand = h.players.find((p) => p.uid === me.id);
                const top = [...h.players].sort((a, b) => b.won - a.won)[0];
                return (
                  <li key={h.id}>
                    <button className={`hx-row ${i === index ? 'on' : ''}`} onClick={() => onIndex(i)} aria-current={i === index}>
                      <span className="hx-mycards">{myHand?.cards?.every(Boolean) ? myHand.cards.map((c) => <Card key={c} card={c} />) : '—'}</span>
                      <span className="hx-winner">{top && top.won > 0 ? (top.uid === me.id ? 'You' : nameOf(top)) : '—'}</span>
                      <span className="hx-rowpot">{fmt(h.pot)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
        {toast && <div className="hx-toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
