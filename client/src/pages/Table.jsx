import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Avatar, money } from '../ui.jsx';
import { sfx, pokerSfx } from '../audio/sound.js';

// The poker table: up to six seats around the felt, for players and spectators alike.

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const CREST = { K: '♚', Q: '♛', J: '♞' };
const RUNOUT_FIRST_MS = 900; // pause on the hands before the board starts
const RUNOUT_STEP_MS = 500; // between flop, turn and river (matches the server)
const RUNOUT_END_MS = 800; // pause on the river before the chips move
const ACT_LABEL = { check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL-IN', fold: 'FOLD' };

// How amounts are written: as chips, or as a number of big blinds. Tapping any amount switches.
const Unit = createContext({ fmt: (n) => n.toLocaleString(), toggle: () => {} });
const SWITCH_HINT = 'Tap to switch between chips and big blinds';

// Table talk: one tap sends a reaction or a stock phrase.
const QUICK_EMOJI = ['👍', '👏', '😂', '😎', '🤯', '😭', '😡', '🤑', '🔥', '💰', '🃏', '♠️', '♥️', '🎰', '🦈', '🐟', '🐔', '🤡', '💀', '🍀', '🙏', '🥶', '🚀', '🤝'];
const QUICK_TEXT = ['Nice hand', 'GG', 'Good luck', 'Thanks', 'Unlucky', 'Bluff?', 'Ship it!', 'Wow'];
const BUBBLE_MS = 4000;
// A message that is only an emoji or two is shown big, without a speech bubble.
const isEmojiOnly = (text) => !/[\x00-\x7F]/.test(text) && [...text].length <= 4;

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

function Card({ card, mark = '', style }) {
  if (!card) return <div className={`pk-card back ${mark}`} style={style} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUIT[card[1]];
  const kind = card[0] === 'A' ? 'ace' : CREST[card[0]] ? 'court' : 'num';
  return (
    <div className={`pk-card suit-${card[1]} ${kind} ${mark}`} style={style}>
      <span className="pk-corner">{rank}<i>{suit}</i></span>
      {kind === 'court' ? (
        <span className="pk-court"><em>{CREST[card[0]]}</em><b>{suit}</b></span>
      ) : (
        <span className="pk-pip">{suit}</span>
      )}
    </div>
  );
}

function CardName({ card }) {
  return <span className={`pk-cardname suit-${card[1]}`}>{card[0] === 'T' ? '10' : card[0]}{SUIT[card[1]]}</span>;
}

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

function TimerRing({ ms }) {
  return (
    <svg className="pk-ring" viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="22" style={{ animationDuration: `${ms}ms` }} />
    </svg>
  );
}

// Choosing how much to bring to a cash table.
function BuyIn({ view, me, seat, socket, onClose, topUp }) {
  const { minBuyIn, maxBuyIn } = view.info;
  const mine = topUp ? view.seats[view.mySeat] : null;
  const min = topUp ? 1 : minBuyIn;
  const max = Math.min(topUp ? maxBuyIn - mine.stack : maxBuyIn, me.balance);
  const [amount, setAmount] = useState(Math.max(min, Math.min(max, topUp ? max : Math.round(maxBuyIn / 2))));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const short = max < min;
  const go = () => {
    setBusy(true);
    socket.emit(topUp ? 'cash:topup' : 'cash:sit', topUp ? { tableId: view.id, amount } : { tableId: view.id, seat, amount }, (r) => {
      setBusy(false);
      if (r.ok) onClose();
      else setError(r.error);
    });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{topUp ? 'Add chips' : `Take seat ${seat + 1}`}</h3>
        <p className="muted small">
          {view.name} · blinds {view.blinds[0]}/{view.blinds[1]}
          {!topUp && <> · buy-in {money(minBuyIn)} to {money(maxBuyIn)} (40 to 200 big blinds)</>}
        </p>
        <p>Your wallet: <b>{money(me.balance)}</b></p>
        {short ? (
          <p className="error">
            {topUp && maxBuyIn - mine.stack <= 0
              ? 'You already have the most chips this table allows.'
              : `You need at least ${money(min)} in your wallet. Ask the organiser to add balance.`}
          </p>
        ) : (
          <>
            <div className="buyin-amount">{money(amount)}</div>
            <input type="range" min={min} max={max} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
            <div className="buyin-range"><span>{money(min)}</span><span>{money(max)}</span></div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={short || busy} onClick={go}>{topUp ? 'Add chips' : 'Sit down'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Table({ table: view, me, socket, canJoin, maxTables, nav, onLobby, onClose, chat, onChatHistory }) {
  const max = view.maxSeats;
  const seated = view.mySeat != null;
  const mySeat = seated ? view.seats[view.mySeat] : null;
  const myTurn = seated && view.toAct === view.mySeat;
  const bigBlind = view.blinds[1];
  const isCash = view.kind === 'cash';
  const finished = view.phase === 'closed';
  const [raiseTo, setRaiseTo] = useState(view.minRaiseTo);
  const [muted, setMuted] = useState(sfx.isMuted());
  const [showMenu, setShowMenu] = useState(false);
  const [buyIn, setBuyIn] = useState(null); // { seat } or { topUp: true }

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
      setTimeout(() => setStage({ hand, shown: 5, done: true }), RUNOUT_FIRST_MS + (stages.length - 1) * RUNOUT_STEP_MS + RUNOUT_END_MS)
    );
    return () => timers.forEach(clearTimeout);
  }, [runoutKey]);

  const boardCount = runout ? (revealing ? shown : 5) : view.board.length;
  const pot = revealing ? runout.pot : view.pot;
  const result = revealing ? null : hr;
  const oddsNow = revealing && shown < 5 ? runout.odds[shown < 3 ? 0 : shown] : null;
  const stackOf = (p) => (revealing && runout.stacks[p.uid] != null ? runout.stacks[p.uid] : p.stack);

  // ---- chips sliding to the pot and to the winners ----
  const [fly, setFly] = useState(null);
  const before = useRef({ hand: 0, bets: {}, hadResult: false });
  const betKey = view.seats.map((p) => (p ? p.bet : 0)).join(',');
  useEffect(() => {
    const prev = before.current;
    const bets = Object.fromEntries(view.seats.filter(Boolean).map((p) => [p.seat, p.bet]));
    const total = Object.values(bets).reduce((a, b) => a + b, 0);
    const prevTotal = Object.values(prev.bets).reduce((a, b) => a + b, 0);
    let next = null;
    if (prev.hand === view.handNo && prevTotal > 0 && total === 0) {
      next = { type: 'collect', seats: Object.keys(prev.bets).filter((s) => prev.bets[s] > 0).map(Number) };
    }
    if (result && !prev.hadResult) {
      next = { type: 'award', seats: view.seats.filter((p) => p && result.won[p.uid]).map((p) => p.seat) };
    }
    before.current = { hand: view.handNo, bets, hadResult: !!result };
    if (!next) return;
    next.key = `${view.handNo}-${view.street}-${next.type}`;
    setFly(next);
    if (next.type === 'collect') pokerSfx.call();
    const t = setTimeout(() => setFly(null), 650);
    return () => clearTimeout(t);
  }, [view.handNo, betKey, !!result]);

  // ---- sounds ----
  useEffect(() => {
    window.addEventListener('pointerdown', sfx.unlock);
    return () => window.removeEventListener('pointerdown', sfx.unlock);
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
        else if (['turn', 'river', 'showdown', 'show'].includes(e.type)) pokerSfx.flip();
        else if (e.type === 'allin') pokerSfx.allIn();
        else if (e.type === 'blinds') pokerSfx.blindsUp();
        else if (e.type === 'sit') pokerSfx.deal(1);
        else if (pokerSfx[e.type]) pokerSfx[e.type]();
      }, i * 220)
    );
    return () => timers.forEach(clearTimeout);
  }, [newestSeq]);

  const resultKey = result ? `${view.handNo}` : '';
  useEffect(() => {
    if (!result || !seated || !mySeat.inHand) return;
    const t = setTimeout(() => (result.won[me.id] ? pokerSfx.win() : pokerSfx.lose()), 350);
    return () => clearTimeout(t);
  }, [resultKey]);

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

  // ---- chat ----
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [chatError, setChatError] = useState('');
  const [unread, setUnread] = useState(0);
  const [bubbles, setBubbles] = useState({}); // uid -> the message floating over their seat
  const seenChat = useRef(null); // id of the newest message already dealt with; null until the history has loaded
  const chatEnd = useRef(null);
  const lastChatId = chat.length ? chat[chat.length - 1].id : 0;
  useEffect(() => {
    socket.emit('chat:history', { tableId: view.id }, (r) => {
      const msgs = r?.ok ? r.msgs : [];
      seenChat.current = msgs.length ? msgs[msgs.length - 1].id : 0;
      if (r?.ok) onChatHistory(msgs);
    });
  }, []);
  useEffect(() => {
    if (seenChat.current === null) return;
    const fresh = chat.filter((m) => m.id > seenChat.current);
    seenChat.current = Math.max(seenChat.current, lastChatId);
    if (!fresh.length) return;
    if (!chatOpen) setUnread((n) => n + fresh.filter((m) => m.uid !== me.id).length);
    setBubbles((b) => ({ ...b, ...Object.fromEntries(fresh.map((m) => [m.uid, m])) }));
    const t = setTimeout(() => setBubbles((b) => Object.fromEntries(Object.entries(b).filter(([, m]) => !fresh.includes(m)))), BUBBLE_MS);
    return () => clearTimeout(t);
  }, [lastChatId]);
  useEffect(() => {
    if (!chatOpen) return;
    setUnread(0);
    chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [chatOpen, lastChatId]);
  const sendChat = (text) => {
    text = text.trim();
    if (!text) return;
    socket.emit('chat:send', { tableId: view.id, text }, (r) => setChatError(r?.ok ? '' : r?.error || 'Could not send'));
    setDraft('');
  };

  // ---- betting controls ----
  useEffect(() => {
    setRaiseTo(view.minRaiseTo);
  }, [view.minRaiseTo, view.handNo, view.street]);

  const tableId = view.id;
  const act = (type, amount) => socket.emit('poker:action', { tableId, type, amount });
  const clampRaise = (v) => Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, Math.round(v) || 0));
  const amount = clampRaise(raiseTo);
  const potAfterCall = view.pot + view.toCall;
  const presets = [
    ['Min', view.minRaiseTo],
    ['½ Pot', view.currentBet + Math.round(potAfterCall / 2)],
    ['Pot', view.currentBet + potAfterCall],
    ['All-in', view.maxRaiseTo],
  ];
  const opened = view.currentBet > 0;

  // Decide ahead of time: the choice is played automatically the moment the action reaches you.
  const [pre, setPre] = useState(null); // 'checkfold' | 'callany' | null
  useEffect(() => setPre(null), [view.handNo]);
  useEffect(() => {
    if (!myTurn || !pre) return;
    if (pre === 'checkfold') act(view.toCall === 0 ? 'check' : 'fold');
    else act(view.toCall === 0 ? 'check' : 'call');
    setPre(null);
  }, [myTurn]);

  // Going to the lobby keeps your seat: the table stays open in the strip at the top.
  // A spectator, or anyone at a finished tournament, closes the table instead.
  const toLobby = () => (seated && !finished ? onLobby() : onClose());
  const standUp = () => {
    if (!window.confirm(`Stand up and take your ${mySeat.stack.toLocaleString()} chips back to your wallet?`)) return;
    socket.emit('cash:leave', { tableId }, () => onClose());
  };

  // Which cards make the winning hands: those are lifted and lit, the rest are dimmed.
  const winning = new Set(result?.showdown ? result.winners.flatMap((w) => result.best[w]) : []);
  const mark = (card) => (!result?.showdown || !card ? '' : winning.has(card) ? 'win' : 'dim');

  // Seats are drawn so that you always sit at the bottom of the screen.
  const turn = seated ? view.mySeat : 0;
  const posOf = (seat) => (seat - turn + max) % max;
  const inHandLive = seated && mySeat.inHand && !mySeat.folded && !hr;
  const canShow = !!hr && !hr.showdown && seated && hr.winners[0] === me.id;
  const info = view.info || {};
  const canTakeSeat = isCash && !seated && canJoin;
  const lastResult = info.results?.length ? [...info.results].sort((a, b) => a.place - b.place) : null;

  const menu = (
    <>
      {seated && isCash && (
        <div className="pk-menu">
          <button className="btn" onClick={() => setBuyIn({ topUp: true })}>Add chips</button>
          <button className="btn" onClick={() => socket.emit('cash:sitout', { tableId, on: !mySeat.sittingOut })}>
            {mySeat.sittingOut ? "I'm back" : 'Sit out next hand'}
          </button>
          <button className="btn" onClick={standUp}>Stand up</button>
        </div>
      )}
      {!isCash && info.prizes && (
        <div className="pk-prizes">
          <b>Prizes</b>
          {info.prizes.map((p, i) => <span key={i}>{['1st', '2nd', '3rd'][i]}: {money(p)}</span>)}
          <span className="muted">Entry {money(info.buyIn)}</span>
        </div>
      )}
      <div className="pk-side-head">Hand history</div>
      {(revealing ? view.log.slice(1) : view.log).map((line, i) => (
        <div key={`${view.handNo}-${view.log.length - i}`} className={i === 0 ? '' : 'muted'}>{line}</div>
      ))}
    </>
  );

  return (
    <Unit.Provider value={unit}>
      <div className="pk-page">
        {nav}
        <header className="pk-top">
          {seated && isCash && !finished ? (
            <button className="btn ghost pk-back" onClick={standUp} title="Stand up and take your chips back to your wallet">Stand up</button>
          ) : (
            <button className="btn ghost pk-back" onClick={toLobby} title={seated && !finished ? 'Back to the lobby. You stay in this tournament.' : 'Close this table'}>
              {seated && !finished ? '‹ Lobby' : '✕ Close'}
            </button>
          )}
          <div className="pk-info">
            <span className="pk-tname">{view.name}</span>
            <span className="pk-blinds-pill"><b>{view.blinds[0]}/{view.blinds[1]}</b></span>
            {info.nextBlinds && !finished && (
              <span className="pk-next">
                {info.nextBlinds[0]}/{info.nextBlinds[1]} in <BlindClock ms={info.nextLevelIn} level={info.level} />
              </span>
            )}
            {view.watchers > 0 && <span className="pk-eye" title="People watching">👁 {view.watchers}</span>}
          </div>
          <div className="pk-top-buttons">
            <button className={`btn ghost pk-icon pk-chat-btn ${chatOpen ? 'on' : ''}`} onClick={() => setChatOpen(!chatOpen)} title="Table chat" aria-label="Table chat">
              💬{unread > 0 && <i className="pk-unread">{unread > 9 ? '9+' : unread}</i>}
            </button>
            <button className="btn ghost pk-icon pk-menu-btn" onClick={() => setShowMenu(!showMenu)} title="Table menu and hand history">☰</button>
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
          </div>
        </header>

        <div className="pk-main">
          <div className="pk-table">
            <div className={`pk-felt ring seats-${max}`}>
              <div className="pk-watermark">PITCH DUEL</div>

              {view.seats.map((p, seat) => {
                const pos = posOf(seat);
                if (!p) {
                  return (
                    <div key={seat} className={`st empty pos-${pos}`}>
                      {canTakeSeat ? (
                        <button className="st-sit" onClick={() => setBuyIn({ seat })}>Sit</button>
                      ) : (
                        <span className="st-open">{isCash ? 'Empty' : ''}</span>
                      )}
                    </div>
                  );
                }
                const isMe = seat === view.mySeat;
                const acting = view.toAct === seat;
                const won = !!result && !!result.won[p.uid];
                const folded = p.folded;
                const live = !result && !revealing;
                const badge = live || revealing ? p.act : folded ? { type: 'fold' } : null;
                const cards = p.cards || (p.hasCards ? [null, null] : null);
                const handName = result?.hands ? result.hands[p.uid] : isMe && !revealing ? view.myHand : null;
                const shownCards = result?.shown?.uid === p.uid ? result.shown.cards : null;
                return (
                  <div key={seat} className={`st pos-${pos} ${isMe ? 'me' : ''} ${acting ? 'acting' : ''} ${won ? 'won' : ''} ${folded || !p.inHand ? 'out' : ''}`}>
                    {cards && (
                      <div className="st-cards" key={view.handNo}>
                        {cards.map((c, i) => (
                          <Card
                            key={`${i}${c ? 'f' : 'b'}`}
                            card={c}
                            mark={`${!isMe && c ? 'flip' : ''} ${mark(c)} ${shownCards?.[i] ? 'shown' : ''}`}
                            style={{ animationDelay: `${pos * 60 + i * 180}ms` }}
                          />
                        ))}
                        {oddsNow && oddsNow[p.uid] != null && (
                          <div className={`pk-odds ${oddsNow[p.uid] >= 100 / Object.keys(oddsNow).length ? 'ahead' : 'behind'}`}>
                            <b>{oddsNow[p.uid]}%</b>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="st-plate">
                      <div className="st-face">
                        <Avatar user={p} size={34} />
                        {acting && view.deadlineIn != null && <TimerRing key={`${view.handNo}-${view.street}-${view.pot}-${seat}`} ms={view.deadlineIn} />}
                        {view.button === seat && view.handNo > 0 && <span className="pk-button" title="Dealer button">D</span>}
                      </div>
                      <div className="st-who">
                        <div className="st-name">{p.name}</div>
                        <div className="st-stack" role="button" title={SWITCH_HINT} onClick={unit.toggle}>
                          {p.sittingOut ? 'Sitting out' : unit.fmt(stackOf(p))}
                        </div>
                      </div>
                      {badge && <span key={`${badge.type}${badge.amount}`} className={`pk-act ${badge.type}`}>{ACT_LABEL[badge.type]}{badge.amount ? ` ${unit.fmt(badge.amount)}` : ''}</span>}
                      {won && <span className="pk-ribbon">+{unit.fmt(result.won[p.uid])}</span>}
                      {p.away && !p.sittingOut && <span className="st-away">away</span>}
                      {bubbles[p.uid] && (
                        <span key={bubbles[p.uid].id} className={`st-bubble ${isEmojiOnly(bubbles[p.uid].text) ? 'big' : ''}`}>{bubbles[p.uid].text}</span>
                      )}
                      {view.sbSeat === seat && <span className="pos-tag sb" title="Small blind">SB</span>}
                      {view.bbSeat === seat && <span className="pos-tag bb" title="Big blind">BB</span>}
                    </div>
                    {handName && <div className={`pk-handname ${result?.hands ? '' : 'live'}`}>{handName}</div>}
                  </div>
                );
              })}

              {/* Bets sit between each player and the middle of the table */}
              {view.seats.map((p, seat) =>
                p && p.bet > 0 && !revealing ? (
                  <div key={`bet${seat}`} className={`pk-betspot pos-${posOf(seat)}`}><Chips amount={p.bet} bigBlind={bigBlind} /></div>
                ) : null
              )}

              <div className="pk-middle">
                <div className="pk-board">
                  {[0, 1, 2, 3, 4].map((i) =>
                    i < boardCount && view.board[i] ? (
                      <Card key={`${view.handNo}-${i}`} card={view.board[i]} mark={`flip ${mark(view.board[i])}`} style={{ animationDelay: `${i < 3 ? i * 110 : 0}ms` }} />
                    ) : (
                      <div key={i} className="pk-card slot" />
                    )
                  )}
                </div>
                <div className="pk-pot">
                  {revealing && <span className="pk-allin">ALL-IN</span>}
                  {view.phase === 'hand' && view.street && !revealing && <span className="pk-street">{view.street}</span>}
                  <span className="pk-pot-label">POT</span>
                  <Chips amount={pot} bigBlind={bigBlind} />
                </div>
                {view.phase === 'waiting' && <div className="pk-wait">Waiting for players…</div>}
              </div>

              {fly && (
                <div key={fly.key} className="pk-flights">
                  {fly.seats.map((s) => <i key={s} className={`pk-fly2 ${fly.type} pos-${posOf(s)}`} />)}
                </div>
              )}

              {finished && lastResult && (
                <div className="pk-result final">
                  <div>🏆 Tournament over</div>
                  {lastResult.map((r) => (
                    <small key={r.uid}>{r.place}. {r.name}{r.prize ? ` — wins ${money(r.prize)}` : ''}</small>
                  ))}
                  <button className="btn primary big" onClick={onClose}>Back to lobby</button>
                </div>
              )}
            </div>
          </div>

          <aside className={`pk-side ${showMenu ? 'open' : ''}`}>
            <button className="btn ghost pk-icon pk-close" onClick={() => setShowMenu(false)}>✕</button>
            {menu}
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
                    <input type="range" min={view.minRaiseTo} max={view.maxRaiseTo} step={1} value={amount} onChange={(e) => setRaiseTo(Number(e.target.value))} />
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
                'Tournament finished.'
              ) : !seated ? (
                <>
                  <span>You are watching this table.</span>
                  {canTakeSeat && <span className="muted small">Tap an empty seat to sit down (buy-in {money(info.minBuyIn)} to {money(info.maxBuyIn)}).</span>}
                  {isCash && !canTakeSeat && <span className="muted small">You are already playing {maxTables} tables, the most allowed at once.</span>}
                </>
              ) : revealing ? (
                'All-in! Running out the board…'
              ) : hr ? (
                <>
                  <div className="pk-result">
                    {hr.text}
                    <small>
                      {hr.shown && hr.shown.uid !== me.id ? `shows ${hr.shown.cards.filter(Boolean).length === 2 ? 'both cards' : 'a card'}` : 'Next hand coming up…'}
                    </small>
                  </div>
                  {canShow && mySeat.cards && (
                    <div className="pk-show">
                      <span>Show:</span>
                      {[['first', 0], ['second', 1]].map(([which, i]) => (
                        <button key={which} className="btn" disabled={!!hr.shown?.cards[i]} onClick={() => socket.emit('poker:show', { tableId, which })}>
                          <CardName card={mySeat.cards[i]} />
                        </button>
                      ))}
                      <button className="btn" disabled={!!(hr.shown?.cards[0] && hr.shown?.cards[1])} onClick={() => socket.emit('poker:show', { tableId, which: 'both' })}>
                        Both
                      </button>
                    </div>
                  )}
                </>
              ) : mySeat.sittingOut ? (
                <>
                  <span>You are sitting out.</span>
                  <button className="btn primary" onClick={() => socket.emit('cash:sitout', { tableId, on: false })}>I'm back</button>
                </>
              ) : view.phase === 'waiting' ? (
                <span>Waiting for another player to join…</span>
              ) : inHandLive ? (
                <>
                  <span>Waiting for {view.toAct != null && view.seats[view.toAct] ? view.seats[view.toAct].name : 'the next player'}…</span>
                  <div className="pk-pre">
                    <button className={`btn ${pre === 'checkfold' ? 'selected' : ''}`} onClick={() => setPre(pre === 'checkfold' ? null : 'checkfold')}>Check / Fold</button>
                    <button className={`btn ${pre === 'callany' ? 'selected' : ''}`} onClick={() => setPre(pre === 'callany' ? null : 'callany')}>Check / Call any</button>
                  </div>
                </>
              ) : (
                <span>{mySeat.folded ? 'You folded. Waiting for the next hand…' : 'You will be dealt in next hand…'}</span>
              )}
            </div>
          )}
        </div>

        {chatOpen && (
          <div className="pk-chat" role="dialog" aria-label="Table chat">
            <div className="pk-chat-head">
              <b>Table chat</b>
              <button className="btn ghost pk-icon" onClick={() => setChatOpen(false)} aria-label="Close chat">✕</button>
            </div>
            <div className="pk-chat-list">
              {chat.length === 0 && <p className="muted small">Nobody has said anything yet. Say hello!</p>}
              {chat.map((m) => (
                <div key={m.id} className={`pk-chat-msg ${m.uid === me.id ? 'mine' : ''} ${isEmojiOnly(m.text) ? 'big' : ''}`}>
                  <b>{m.uid === me.id ? 'You' : m.name}</b>
                  <span>{m.text}</span>
                </div>
              ))}
              <div ref={chatEnd} />
            </div>
            {seated ? (
              <>
                <div className="pk-chat-quick emoji">
                  {QUICK_EMOJI.map((e) => <button key={e} onClick={() => sendChat(e)} aria-label={`Send ${e}`}>{e}</button>)}
                </div>
                <div className="pk-chat-quick">
                  {QUICK_TEXT.map((t) => <button key={t} onClick={() => sendChat(t)}>{t}</button>)}
                </div>
                {chatError && <p className="error small">{chatError}</p>}
                <form
                  className="pk-chat-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendChat(draft);
                  }}
                >
                  <input value={draft} maxLength={120} placeholder="Say something…" onChange={(e) => setDraft(e.target.value)} aria-label="Message" />
                  <button className="btn primary" disabled={!draft.trim()}>Send</button>
                </form>
              </>
            ) : (
              <p className="muted small pk-chat-note">Take a seat to join the chat. You can read along while watching.</p>
            )}
          </div>
        )}

        {buyIn && <BuyIn view={view} me={me} seat={buyIn.seat} topUp={buyIn.topUp} socket={socket} onClose={() => setBuyIn(null)} />}
      </div>
    </Unit.Provider>
  );
}
