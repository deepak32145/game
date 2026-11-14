import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Avatar } from './Lobby.jsx';
import { sfx, pokerSfx } from '../game/sound.js';

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RUNOUT_FIRST_MS = 900; // pause on the two hands before the board starts
const RUNOUT_STEP_MS = 500; // between flop, turn and river (matches the server)
const RUNOUT_END_MS = 800; // pause on the river before the chips move
const ACT_LABEL = { check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL-IN', fold: 'FOLD' };

// How amounts are written: as chips, or as a number of big blinds. Tapping any amount switches.
const Unit = createContext({ fmt: (n) => n.toLocaleString(), toggle: () => {} });
const SWITCH_HINT = 'Tap to switch between chips and big blinds';

// Counts down to the next blind level. The new blinds apply from the hand after it reaches zero.
function BlindClock({ ms, level }) {
  const [end, setEnd] = useState(() => Date.now() + ms);
  const [, tick] = useState(0);
  useEffect(() => setEnd(Date.now() + ms), [level, Math.round(ms / 5000)]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((end - Date.now()) / 1000));
  if (left === 0) return <b>next hand</b>;
  return <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b>;
}

function Card({ card, hidden, mark = '', style }) {
  if (hidden || !card) return <div className={`pk-card back ${mark}`} style={style} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  return (
    <div className={`pk-card suit-${card[1]} ${mark}`} style={style}>
      <span className="pk-corner">{rank}<i>{SUIT[card[1]]}</i></span>
      <span className="pk-pip">{SUIT[card[1]]}</span>
    </div>
  );
}

// A little pile of chips whose height grows with the size of the bet.
function ChipPile({ amount, bigBlind }) {
  const bb = amount / bigBlind;
  const count = bb <= 1 ? 1 : bb <= 3 ? 2 : bb <= 8 ? 3 : bb <= 25 ? 4 : 5;
  return (
    <span className="pk-pile" style={{ height: 14 + count * 3 }}>
      {Array.from({ length: count }, (_, i) => <i key={i} className={`pk-disc c${i % 3}`} style={{ bottom: i * 3 }} />)}
    </span>
  );
}

function Chips({ amount, bigBlind }) {
  const { fmt, toggle } = useContext(Unit);
  return (
    <span className="pk-chips" role="button" title={SWITCH_HINT} onClick={toggle}>
      <ChipPile amount={amount} bigBlind={bigBlind} />{fmt(amount)}
    </span>
  );
}

// The time left to act, as a ring around the player's picture that drains and turns red.
function TimerRing({ ms }) {
  return (
    <svg className="pk-ring" viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="22" style={{ animationDuration: `${ms}ms` }} />
    </svg>
  );
}

function Seat({ player, isMe, s }) {
  const { fmt, toggle } = useContext(Unit);
  const id = player.id;
  return (
    <div className={`pk-seat ${isMe ? 'me' : 'opp'} ${s.acting ? 'acting' : ''} ${s.won ? 'won' : ''} ${s.folded ? 'folded' : ''}`}>
      <div className="pk-plate">
        <div className="pk-face">
          <Avatar user={player} size={40} />
          {s.acting && s.deadline != null && <TimerRing key={s.timerKey} ms={s.deadline} />}
          {s.button && <span className="pk-button" title="Dealer button">D</span>}
        </div>
        <div className="pk-who">
          <div className="pk-name">{player.name}</div>
          <div className="pk-stack" role="button" title={SWITCH_HINT} onClick={toggle}>{fmt(s.stack)}</div>
        </div>
        {s.act && <span key={`${s.act.type}${s.act.amount}`} className={`pk-act ${s.act.type}`}>{ACT_LABEL[s.act.type]}{s.act.amount ? ` ${fmt(s.act.amount)}` : ''}</span>}
        {s.won && <span className="pk-ribbon">WINNER</span>}
      </div>

      <div className="pk-hole" key={s.handNo}>
        {[0, 1].map((i) => (
          <Card
            key={`${i}${s.hidden ? 'back' : 'face'}`}
            card={s.cards?.[i]}
            hidden={s.hidden}
            mark={`${!isMe && !s.hidden ? 'flip' : ''} ${s.marks ? s.marks(s.cards?.[i]) : ''}`}
            style={{ animationDelay: `${(isMe ? 120 : 0) + i * 220}ms` }}
          />
        ))}
        {s.odds != null && (
          <div className={`pk-odds ${s.odds >= 50 ? 'ahead' : 'behind'}`}>
            <b>{s.odds}%</b>
            <span><i style={{ width: `${s.odds}%` }} /></span>
          </div>
        )}
      </div>

      <div className="pk-under">
        {s.handName && <span className={`pk-handname ${s.showdown ? '' : 'live'}`}>{s.handName}</span>}
        {s.bet > 0 && <Chips amount={s.bet} bigBlind={s.bigBlind} />}
      </div>
    </div>
  );
}

export default function Poker({ match: view, me, socket }) {
  const opp = view.players.find((p) => p.id !== me.id);
  const mine = view.players.find((p) => p.id === me.id);
  const myTurn = view.toAct === me.id;
  const [raiseTo, setRaiseTo] = useState(view.minRaiseTo);
  const [muted, setMuted] = useState(sfx.isMuted());
  const [showLog, setShowLog] = useState(false);
  const finished = view.phase === 'finished';
  const bigBlind = view.blinds[1];

  // Chips or big blinds: remembered on this device.
  const [inBB, setInBB] = useState(() => {
    try {
      return localStorage.getItem('pitch_duel_bb') === '1';
    } catch {
      return false;
    }
  });
  const unit = {
    fmt: (n) => (inBB ? `${Number((n / bigBlind).toFixed(1))} BB` : n.toLocaleString()),
    toggle: () => {
      setInBB(!inBB);
      try {
        localStorage.setItem('pitch_duel_bb', inBB ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
    },
  };

  // ---- all-in runout: turn the board over in stages ----
  const hr = view.handResult;
  const runout = hr?.runout || null;
  // Progress is tracked per hand, so a new all-in starts hidden on its very first frame.
  const [stage, setStage] = useState({ hand: 0, shown: 0, done: false });
  const mineStage = stage.hand === view.handNo;
  const shown = runout ? (mineStage ? stage.shown : runout.from) : view.board.length;
  const revealing = !!runout && !(mineStage && stage.done);
  const runoutKey = runout ? view.handNo : 0;
  useEffect(() => {
    if (!runout) return;
    const hand = view.handNo;
    setStage({ hand, shown: runout.from, done: false });
    const stages = [3, 4, 5].filter((n) => n > runout.from);
    const timers = stages.map((n, i) =>
      setTimeout(() => {
        setStage({ hand, shown: n, done: false });
        if (n === 3) [0, 0.1, 0.2].forEach((d) => pokerSfx.flip(d));
        else pokerSfx.flip();
      }, RUNOUT_FIRST_MS + i * RUNOUT_STEP_MS)
    );
    timers.push(
      setTimeout(
        () => setStage({ hand, shown: 5, done: true }),
        RUNOUT_FIRST_MS + (stages.length - 1) * RUNOUT_STEP_MS + RUNOUT_END_MS
      )
    );
    return () => timers.forEach(clearTimeout);
  }, [runoutKey]);

  const boardCount = runout ? (revealing ? shown : 5) : view.board.length;
  const stacks = revealing ? runout.stacks : view.stacks;
  const pot = revealing ? runout.pot : view.pot;
  const result = revealing ? null : hr;
  const oddsNow = revealing && shown < 5 ? runout.odds[shown < 3 ? 0 : shown] : null;

  // ---- chips sliding across the table ----
  // Bets are swept into the pot when a betting round ends, and the pot is pushed to the winner.
  const [fly, setFly] = useState(null);
  const before = useRef({ hand: 0, bets: { [me.id]: 0, [opp.id]: 0 }, hadResult: false });
  useEffect(() => {
    const prev = before.current;
    const total = view.bets[me.id] + view.bets[opp.id];
    const prevTotal = prev.bets[me.id] + prev.bets[opp.id];
    let next = null;
    if (prev.hand === view.handNo && prevTotal > 0 && total === 0 && !hr?.folded) {
      next = { type: 'collect', top: prev.bets[opp.id] > 0, bottom: prev.bets[me.id] > 0 };
    }
    if (result && !prev.hadResult) {
      next = { type: 'award', top: result.winners.includes(opp.id), bottom: result.winners.includes(me.id) };
    }
    before.current = { hand: view.handNo, bets: { ...view.bets }, hadResult: !!result };
    if (!next) return;
    next.key = `${view.handNo}-${view.street}-${next.type}`;
    setFly(next);
    if (next.type === 'collect') pokerSfx.call();
    const t = setTimeout(() => setFly(null), 650);
    return () => clearTimeout(t);
  }, [view.handNo, view.bets[me.id], view.bets[opp.id], !!result]);

  // ---- sounds ----
  useEffect(() => {
    sfx.setAmbience(false);
    window.addEventListener('pointerdown', sfx.unlock);
    return () => {
      window.removeEventListener('pointerdown', sfx.unlock);
      sfx.setAmbience(true);
    };
  }, []);

  const lastSeq = useRef(null);
  const newestSeq = view.events.length ? view.events[view.events.length - 1].seq : 0;
  useEffect(() => {
    if (lastSeq.current === null) {
      lastSeq.current = newestSeq; // joined mid-game: don't replay old sounds
      return;
    }
    const fresh = view.events.filter((e) => e.seq > lastSeq.current);
    lastSeq.current = newestSeq;
    const timers = fresh.map((e, i) =>
      setTimeout(() => {
        if (e.type === 'newhand') {
          pokerSfx.shuffle();
          pokerSfx.deal(4, 0.9);
        } else if (e.type === 'flop') [0, 0.1, 0.2].forEach((d) => pokerSfx.flip(d));
        else if (e.type === 'turn' || e.type === 'river') pokerSfx.flip();
        else if (e.type === 'showdown') pokerSfx.flip();
        else if (e.type === 'allin') pokerSfx.allIn();
        else if (e.type === 'blinds') pokerSfx.blindsUp();
        else if (pokerSfx[e.type]) pokerSfx[e.type]();
      }, i * 260)
    );
    return () => timers.forEach(clearTimeout);
  }, [newestSeq]);

  // The win or lose sting plays when the result is actually shown, after any staged reveal.
  const resultKey = result ? `${view.handNo}` : '';
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => (result.winners.includes(me.id) ? pokerSfx.win() : pokerSfx.lose()), 350);
    return () => clearTimeout(t);
  }, [resultKey]);

  // Your turn: a chime, then a tick each second once only five seconds are left.
  const turnKey = myTurn ? `${view.handNo}-${view.street}-${view.pot}` : '';
  useEffect(() => {
    if (!myTurn || view.deadlineIn == null) return;
    pokerSfx.yourTurn();
    const end = Date.now() + view.deadlineIn;
    const t = setInterval(() => {
      const left = end - Date.now();
      if (left > 0 && left <= 5200) pokerSfx.tick();
    }, 1000);
    return () => clearInterval(t);
  }, [turnKey]);

  // ---- betting controls ----
  useEffect(() => {
    setRaiseTo(view.minRaiseTo);
  }, [view.minRaiseTo, view.handNo, view.street]);

  const act = (type, amount) => socket.emit('poker:action', { type, amount });
  const clampRaise = (v) => Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, Math.round(v) || 0));
  const amount = clampRaise(raiseTo);
  const potAfterCall = view.pot + view.toCall;
  const presets = [
    ['Min', view.minRaiseTo],
    ['½ Pot', view.bets[opp.id] + Math.round(potAfterCall / 2)],
    ['Pot', view.bets[opp.id] + potAfterCall],
    ['All-in', view.maxRaiseTo],
  ];
  const opened = view.bets[opp.id] > 0 || view.bets[me.id] > 0;
  const won = view.result?.winner === me.id;

  // Decide ahead of time: the choice is played automatically the moment the action reaches you.
  const [pre, setPre] = useState(null); // 'checkfold' | 'callany' | null
  useEffect(() => setPre(null), [view.handNo]);
  useEffect(() => {
    if (!myTurn || !pre) return;
    if (pre === 'checkfold') act(view.toCall === 0 ? 'check' : 'fold');
    else act(view.toCall === 0 ? 'check' : 'call');
    setPre(null);
  }, [myTurn]);

  const leave = () => {
    if (finished || window.confirm('Leave the table? You will forfeit the match.')) socket.emit('match:leave');
  };

  // Which cards make the winning hand: those are lifted and lit, the rest are dimmed.
  const winning = new Set(result?.showdown ? result.winners.flatMap((w) => result.best[w]) : []);
  const mark = (card) => (!result?.showdown || !card ? '' : winning.has(card) ? 'win' : 'dim');

  const seat = (player, cards, hidden) => {
    const id = player.id;
    const live = !result && !revealing;
    return {
      handNo: view.handNo,
      bigBlind,
      cards,
      hidden,
      stack: stacks[id],
      bet: revealing ? 0 : view.bets[id],
      odds: oddsNow ? oddsNow[id] : null,
      acting: view.toAct === id,
      deadline: view.deadlineIn,
      timerKey: `${view.handNo}-${view.street}-${view.pot}-${id}`,
      button: view.button === id,
      act: live || revealing ? view.acts[id] : result?.folded === id ? { type: 'fold' } : null,
      won: !!result && result.winners.includes(id) && result.winners.length === 1,
      folded: result?.folded === id,
      marks: result?.showdown ? mark : null,
      // At a showdown both hands are named; before that each player sees only their own, from the flop on.
      handName: result?.hands ? result.hands[id] : id === me.id && !revealing ? view.myHand : null,
      showdown: !!result?.hands,
    };
  };

  const handLive = !hr && !finished;

  return (
    <Unit.Provider value={unit}>
      <div className="pk-page">
        <header className="pk-top">
          <div className="brand">♠ Poker</div>
          <div className="pk-info">
            <span><i className="pk-word">Blinds </i><b>{view.blinds[0]}/{view.blinds[1]}</b></span>
            {view.nextBlinds && !finished && (
              <span className="pk-next">
                {view.nextBlinds[0]}/{view.nextBlinds[1]} in <BlindClock ms={view.nextLevelIn} level={view.level} />
              </span>
            )}
            <span className="pk-handno">#{view.handNo}</span>
          </div>
          <div className="pk-top-buttons">
            <button className="btn ghost pk-icon" onClick={() => setShowLog(!showLog)} title="Hand history">☰</button>
            <button className="btn ghost pk-unit" onClick={unit.toggle} title={SWITCH_HINT}>{inBB ? 'BB' : 'Chips'}</button>
            <button
              className="btn ghost pk-icon"
              title="Sound"
              onClick={() => {
                sfx.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <button className="btn ghost" onClick={leave}>{finished ? 'Lobby' : 'Forfeit'}</button>
          </div>
        </header>

        {view.disconnected.includes(opp.id) && !finished && (
          <div className="notice pk-notice">{opp.name} lost connection. They forfeit if not back within 45 seconds.</div>
        )}

        <div className="pk-main">
          <div className="pk-table">
            <div className="pk-felt">
              <div className="pk-watermark">PITCH DUEL</div>
              <Seat player={opp} s={seat(opp, view.oppCards, !view.oppCards)} />

              <div className="pk-middle">
                <div className="pk-board">
                  {[0, 1, 2, 3, 4].map((i) =>
                    i < boardCount && view.board[i] ? (
                      <Card
                        key={`${view.handNo}-${i}`}
                        card={view.board[i]}
                        mark={`flip ${mark(view.board[i])}`}
                        style={{ animationDelay: `${i < 3 ? i * 110 : 0}ms` }}
                      />
                    ) : (
                      <div key={i} className="pk-card slot" />
                    )
                  )}
                </div>
                <div className="pk-pot">
                  {revealing && <span className="pk-allin">ALL-IN</span>}
                  <span className="pk-pot-label">POT</span>
                  <Chips amount={pot} bigBlind={bigBlind} />
                </div>
              </div>

              <Seat player={mine} isMe s={seat(mine, view.myCards, false)} />

              {/* Chips in motion: purely decoration, the numbers above are already correct */}
              {fly && (
                <div key={fly.key} className="pk-flights">
                  {fly.top && <i className={`pk-fly ${fly.type} top`} />}
                  {fly.bottom && <i className={`pk-fly ${fly.type} bottom`} />}
                </div>
              )}

              {finished && (
                <div className="pk-result final">
                  <div>{won ? '🏆 You won the match!' : 'You lost the match'}</div>
                  <small>{view.result.text}</small>
                  <button className="btn primary big" onClick={() => socket.emit('match:leave')}>Back to lobby</button>
                </div>
              )}
            </div>
          </div>

          <aside className={`pk-side ${showLog ? 'open' : ''}`}>
            <div className="pk-side-head">
              Hand history
              <button className="btn ghost pk-icon pk-close" onClick={() => setShowLog(false)}>✕</button>
            </div>
            {/* While an all-in is being run out, hold back the line that gives away the winner. */}
            {(revealing ? view.log.slice(1) : view.log).map((line, i) => (
              <div key={`${view.handNo}-${view.log.length - i}`} className={i === 0 ? '' : 'muted'}>{line}</div>
            ))}
          </aside>
        </div>

        {/* Fixed-height bar pinned to the bottom of the screen: the buttons never move or scroll away. */}
        <div className="pk-bar">
          {myTurn && !finished ? (
            <>
              {view.canRaise && (
                <div className="pk-sizing">
                  <div className="pk-presets">
                    {presets.map(([label, v]) => (
                      <button key={label} className="btn" onClick={() => setRaiseTo(clampRaise(v))}>{label}</button>
                    ))}
                  </div>
                  <div className="pk-stepper">
                    <button className="btn pk-step" aria-label="Decrease bet" onClick={() => setRaiseTo(clampRaise(amount - bigBlind))}>−</button>
                    <input
                      type="range"
                      min={view.minRaiseTo}
                      max={view.maxRaiseTo}
                      step={5}
                      value={amount}
                      onChange={(e) => setRaiseTo(Number(e.target.value))}
                    />
                    <button className="btn pk-step" aria-label="Increase bet" onClick={() => setRaiseTo(clampRaise(amount + bigBlind))}>+</button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={view.minRaiseTo}
                      max={view.maxRaiseTo}
                      value={raiseTo}
                      onChange={(e) => setRaiseTo(Number(e.target.value))}
                      onBlur={() => setRaiseTo(amount)}
                    />
                  </div>
                </div>
              )}
              <div className="pk-buttons">
                <button className="btn fold" disabled={view.toCall === 0} onClick={() => act('fold')}>Fold</button>
                {view.toCall === 0 ? (
                  <button className="btn call" onClick={() => act('check')}>Check</button>
                ) : (
                  <button className="btn call" onClick={() => act('call')}>Call <b>{unit.fmt(view.toCall)}</b></button>
                )}
                <button className="btn raise" disabled={!view.canRaise} onClick={() => act('raise', amount)}>
                  {!view.canRaise ? 'Raise' : amount >= view.maxRaiseTo ? 'All-in' : opened ? 'Raise to' : 'Bet'}{' '}
                  {view.canRaise && <b>{unit.fmt(amount)}</b>}
                </button>
              </div>
            </>
          ) : (
            <div className="pk-waiting">
              {finished ? (
                'Match over.'
              ) : revealing ? (
                'All-in! Running out the board…'
              ) : hr ? (
                <div className="pk-result">{hr.text}<small>Next hand coming up…</small></div>
              ) : (
                <>
                  <span>Waiting for {opp.name}…</span>
                  {handLive && (
                    <div className="pk-pre">
                      <button className={`btn ${pre === 'checkfold' ? 'selected' : ''}`} onClick={() => setPre(pre === 'checkfold' ? null : 'checkfold')}>
                        Check / Fold
                      </button>
                      <button className={`btn ${pre === 'callany' ? 'selected' : ''}`} onClick={() => setPre(pre === 'callany' ? null : 'callany')}>
                        Check / Call any
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Unit.Provider>
  );
}
