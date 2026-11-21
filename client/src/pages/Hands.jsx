import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar } from '../ui.jsx';
import Replayer from './Replayer.jsx';

// Hand history, organised as: day -> game (one sitting at a table, or one tournament) -> hands.
// Any hand opens in the replayer. Other players' cards appear only if they were shown at the table.

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PAGE = 30;
const DAY = 86400000;
const PERIODS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', '7 days'],
  ['all', '30 days'],
  ['day', 'Pick a day'],
];

function MiniCard({ card }) {
  if (!card) return <span className="pk-cardname hidden-card">?</span>;
  return <span className={`pk-cardname suit-${card[1]}`}>{card[0] === 'T' ? '10' : card[0]}{SUIT[card[1]]}</span>;
}
const Cards = ({ cards }) => <span className="hh-cards">{cards.map((c, i) => <MiniCard key={i} card={c} />)}</span>;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-IN')}`;
const tone = (n) => (n > 0 ? 'plus' : n < 0 ? 'minus' : '');
const time = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

// Start and end of the chosen period, in the player's own time zone.
function periodRange(period, day) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'today') return [start.getTime(), null];
  if (period === 'yesterday') return [start.getTime() - DAY, start.getTime()];
  if (period === 'week') return [start.getTime() - 6 * DAY, null];
  if (period === 'day' && day) {
    const from = new Date(`${day}T00:00:00`).getTime();
    return [from, from + DAY];
  }
  return [null, null];
}

function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(date);
  that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Games grouped under the day they finished on, newest first.
function byDay(games) {
  const days = [];
  for (const g of games) {
    const label = dayLabel(g.end);
    let d = days[days.length - 1];
    if (!d || d.label !== label) {
      d = { label, games: [], net: 0, hands: 0 };
      days.push(d);
    }
    d.games.push(g);
    d.net += g.net;
    d.hands += g.hands;
  }
  return days;
}

function GameCard({ game, onOpen }) {
  const shown = game.opponents.slice(0, 5);
  const extra = game.opponents.length - shown.length;
  return (
    <button className="hg-card" onClick={onOpen}>
      <span className={`hg-icon ${game.kind}`} aria-hidden="true">{game.kind === 'sng' ? '🏆' : '♠'}</span>
      <span className="hg-main">
        <span className="hg-name">
          {game.tableName} <small>{game.kind === 'sng' ? 'Sit & Go' : `${game.blinds[0]}/${game.blinds[1]}`}</small>
        </span>
        <span className="hg-meta">
          {time(game.start)}{time(game.end) !== time(game.start) ? ` – ${time(game.end)}` : ''} ·{game.hands} hand{game.hands === 1 ? '' : 's'}
        </span>
        <span className="hg-opps" aria-label={`Played against ${game.opponents.map((o) => o.name).join(', ')}`}>
          <i>vs</i>
          {shown.map((o) => (
            <span key={o.name} className="hg-opp" title={`${o.name} · ${o.hands} hand${o.hands === 1 ? '' : 's'}`}>
              <Avatar user={o} size={24} />
            </span>
          ))}
          {extra > 0 && <span className="hg-more">+{extra}</span>}
          {shown.length === 1 && <span className="hg-oppname">{shown[0].name}</span>}
        </span>
      </span>
      <span className="hh-net">
        <b className={tone(game.net)}>{signed(game.net)}</b>
        <small>won {game.won} of {game.hands}</small>
      </span>
    </button>
  );
}

// One game: its hands, newest first, each opening in the replayer.
function GameHands({ token, me, game, onBack }) {
  const [hands, setHands] = useState(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [replay, setReplay] = useState(null);

  const query = (before) => {
    const q = new URLSearchParams({ limit: PAGE, from: new Date(game.start).getTime(), to: new Date(game.end).getTime() + 1 });
    if (game.tableId) q.set('tableId', game.tableId);
    else q.set('table', game.tableName);
    if (before) q.set('before', before);
    return api(`/hands?${q}`, { token });
  };
  useEffect(() => {
    query().then((r) => { setHands(r.hands); setMore(r.more); }).catch((err) => setError(err.message));
  }, [game.id]);
  const loadMore = () =>
    query(new Date(hands[hands.length - 1].at).getTime())
      .then((r) => { setHands([...hands, ...r.hands]); setMore(r.more); })
      .catch((err) => setError(err.message));

  return (
    <section className="hh">
      <div className="hg-top">
        <button className="btn ghost" onClick={onBack}>‹ All games</button>
        <div className="hg-title">
          <b>{game.tableName}</b>
          <span className="muted small">
            {dayLabel(game.end)} · {time(game.start)}{time(game.end) !== time(game.start) ? ` – ${time(game.end)}` : ''} ·{game.hands} hands · <b className={tone(game.net)}>{signed(game.net)}</b>
          </span>
        </div>
      </div>
      <div className="hg-versus">
        {game.opponents.map((o) => (
          <span key={o.name} className="hg-chip"><Avatar user={o} size={20} />{o.name}<small>{o.hands}</small></span>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!hands && !error && <p className="muted small">Loading…</p>}
      {hands && (
        <>
          <ul className="hh-list">
            {hands.map((h, i) => {
              const mine = h.players.find((p) => p.uid === me.id);
              return (
                <li key={h.id}>
                  <button className="hh-row" onClick={() => setReplay(i)} title="Replay this hand">
                    <span className="hh-when">
                      <b>#{h.handNo}</b>
                      <small>{time(h.at)}</small>
                    </span>
                    <span className="hh-main">
                      <span className="hh-deal">
                        <Cards cards={mine.cards} />
                        {h.board.length > 0 && <><i>board</i><Cards cards={h.board} /></>}
                      </span>
                      <span className="hh-table"><small>{h.players.length} players · pot {h.pot.toLocaleString('en-IN')}{h.showdown ? ' · showdown' : ''}</small></span>
                    </span>
                    <span className="hh-net">
                      <b className={tone(mine.net)}>{signed(mine.net)}</b>
                      <small>{mine.folded ? 'folded' : mine.hand || (mine.net > 0 ? 'won' : '')}</small>
                    </span>
                    <span className="hh-play" aria-hidden="true">▶</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {more && <button className="btn" onClick={loadMore}>Show older hands</button>}
        </>
      )}
      {replay != null && hands?.[replay] && (
        <Replayer token={token} hands={hands} index={replay} me={me} onIndex={setReplay} onClose={() => setReplay(null)} />
      )}
    </section>
  );
}

export default function Hands({ token, me }) {
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState('');
  const [period, setPeriod] = useState('week');
  const [day, setDay] = useState('');
  const [games, setGames] = useState(null);
  const [capped, setCapped] = useState(false);
  const [game, setGame] = useState(null);
  const [error, setError] = useState('');
  const [keepDays, setKeepDays] = useState(30);

  useEffect(() => {
    api('/hands/tables', { token }).then((r) => {
      setTables(r.tables);
      setKeepDays(r.keepDays);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (period === 'day' && !day) return;
    let cancelled = false;
    setGames(null);
    setError('');
    const [from, to] = periodRange(period, day);
    const q = new URLSearchParams();
    if (table) q.set('table', table);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api(`/hands/games?${q}`, { token })
      .then((r) => {
        if (cancelled) return;
        setGames(r.games);
        setCapped(r.capped);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [table, period, day]);

  if (game) return <GameHands token={token} me={me} game={game} onBack={() => setGame(null)} />;

  const days = games ? byDay(games) : [];
  const total = (games || []).reduce((n, g) => n + g.net, 0);
  const handCount = (games || []).reduce((n, g) => n + g.hands, 0);

  return (
    <section className="hh">
      <p className="muted small tab-note">
        Your hands from the last {keepDays} days, grouped into games. Open a game to see its hands, and tap any hand to replay it step by step.
      </p>
      <div className="hh-filters">
        <div className="hg-periods" role="tablist" aria-label="When">
          {PERIODS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={period === key} className={`hg-period ${period === key ? 'on' : ''}`} onClick={() => setPeriod(key)}>
              {key === 'all' ? `${keepDays} days` : label}
            </button>
          ))}
        </div>
        {period === 'day' && (
          <label>
            <span>Day</span>
            <input type="date" value={day} max={new Date().toLocaleDateString('en-CA')} onChange={(e) => setDay(e.target.value)} />
          </label>
        )}
        <label>
          <span>Table</span>
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">All tables</option>
            {tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.hands})</option>)}
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {!games && !error && <p className="muted small">{period === 'day' && !day ? 'Choose a day.' : 'Loading…'}</p>}
      {games && games.length === 0 && (
        <div className="empty big-empty">
          <div className="empty-art">♠ ♥ ♦ ♣</div>
          <p>No games here yet.</p>
          <p className="muted small">Hands appear as soon as you play one. Try a different table or date.</p>
        </div>
      )}
      {games && games.length > 0 && (
        <>
          <div className="hh-summary">
            <span>{games.length} game{games.length === 1 ? '' : 's'}</span>
            <span>{handCount} hands</span>
            <span>result <b className={tone(total)}>{signed(total)}</b> chips</span>
          </div>
          {days.map((d) => (
            <div key={d.label} className="hg-day">
              <h4 className="hg-dayhead">
                <span>{d.label}</span>
                <small>{d.hands} hands · <b className={tone(d.net)}>{signed(d.net)}</b></small>
              </h4>
              <div className="hg-grid">
                {d.games.map((g) => <GameCard key={g.id} game={g} onOpen={() => setGame(g)} />)}
              </div>
            </div>
          ))}
          {capped && <p className="muted small">Showing your most recent hands only. Pick a shorter period to see older games.</p>}
        </>
      )}
    </section>
  );
}
