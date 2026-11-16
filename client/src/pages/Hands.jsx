import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Hand history: every hand you were dealt into, newest first, filtered by table and by date.
// Other players' cards appear only if they were turned over at the table.

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PAGE = 20;

function MiniCard({ card }) {
  if (!card) return <span className="pk-cardname hidden-card">?</span>;
  return <span className={`pk-cardname suit-${card[1]}`}>{card[0] === 'T' ? '10' : card[0]}{SUIT[card[1]]}</span>;
}
const Cards = ({ cards }) => <span className="hh-cards">{cards.map((c, i) => <MiniCard key={i} card={c} />)}</span>;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-IN')}`;
const tone = (n) => (n > 0 ? 'plus' : n < 0 ? 'minus' : '');

// Start and end of the chosen period, in the player's own time zone.
function periodRange(period, day) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const DAY = 86400000;
  if (period === 'today') return [start.getTime(), null];
  if (period === 'yesterday') return [start.getTime() - DAY, start.getTime()];
  if (period === 'week') return [start.getTime() - 6 * DAY, null];
  if (period === 'day' && day) {
    const from = new Date(`${day}T00:00:00`).getTime();
    return [from, from + DAY];
  }
  return [null, null];
}

export default function Hands({ token, me }) {
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState('');
  const [period, setPeriod] = useState('all');
  const [day, setDay] = useState('');
  const [hands, setHands] = useState(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const [keepDays, setKeepDays] = useState(30);

  const query = (before) => {
    const [from, to] = periodRange(period, day);
    const q = new URLSearchParams({ limit: PAGE });
    if (table) q.set('table', table);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (before) q.set('before', before);
    return api(`/hands?${q}`, { token });
  };

  useEffect(() => {
    api('/hands/tables', { token }).then((r) => {
      setTables(r.tables);
      setKeepDays(r.keepDays);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (period === 'day' && !day) return;
    let cancelled = false;
    setHands(null);
    setOpen(null);
    setError('');
    query()
      .then((r) => {
        if (cancelled) return;
        setHands(r.hands);
        setMore(r.more);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [table, period, day]);

  const loadMore = () =>
    query(new Date(hands[hands.length - 1].at).getTime()).then((r) => {
      setHands([...hands, ...r.hands]);
      setMore(r.more);
    }).catch((err) => setError(err.message));

  const net = (hands || []).reduce((n, h) => n + h.players.find((p) => p.uid === me.id).net, 0);
  const wonCount = (hands || []).filter((h) => h.players.find((p) => p.uid === me.id).net > 0).length;

  return (
    <section className="hh">
      <p className="muted small tab-note">
        Every hand you are dealt is saved for {keepDays} days. You always see your own cards; other players' cards appear only if they were shown at the table.
      </p>
      <div className="hh-filters">
        <label>
          <span>Table</span>
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">All tables</option>
            {tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.hands})</option>)}
          </select>
        </label>
        <label>
          <span>When</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="all">Last {keepDays} days</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">Last 7 days</option>
            <option value="day">Pick a day…</option>
          </select>
        </label>
        {period === 'day' && (
          <label>
            <span>Day</span>
            <input type="date" value={day} max={new Date().toLocaleDateString('en-CA')} onChange={(e) => setDay(e.target.value)} />
          </label>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {!hands && !error && <p className="muted small">{period === 'day' && !day ? 'Choose a day.' : 'Loading…'}</p>}
      {hands && hands.length === 0 && (
        <div className="empty big-empty">
          <div className="empty-art">♠ ♥ ♦ ♣</div>
          <p>No hands here yet.</p>
          <p className="muted small">Hands appear as soon as you play one. Try a different table or date.</p>
        </div>
      )}
      {hands && hands.length > 0 && (
        <>
          <div className="hh-summary">
            <span>{hands.length}{more ? '+' : ''} hands</span>
            <span>won {wonCount}</span>
            <span>result <b className={tone(net)}>{signed(net)}</b> chips</span>
          </div>
          <ul className="hh-list">
            {hands.map((h) => {
              const mine = h.players.find((p) => p.uid === me.id);
              const isOpen = open === h.id;
              return (
                <li key={h.id} className={isOpen ? 'open' : ''}>
                  <button className="hh-row" onClick={() => setOpen(isOpen ? null : h.id)} aria-expanded={isOpen}>
                    <span className="hh-when">
                      <b>{new Date(h.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</b>
                      <small>{new Date(h.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</small>
                    </span>
                    <span className="hh-main">
                      <span className="hh-table">{h.tableName} <small>· {h.blinds[0]}/{h.blinds[1]} · hand {h.handNo}</small></span>
                      <span className="hh-deal">
                        <Cards cards={mine.cards} />
                        {h.board.length > 0 && <><i>board</i><Cards cards={h.board} /></>}
                      </span>
                    </span>
                    <span className="hh-net">
                      <b className={tone(mine.net)}>{signed(mine.net)}</b>
                      <small>{mine.folded ? 'folded' : mine.hand || (mine.net > 0 ? 'won' : '')}</small>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="hh-detail">
                      <div className="hh-players">
                        {h.players.map((p) => (
                          <div key={p.uid} className={p.uid === me.id ? 'me' : ''}>
                            <span className="hh-pname">{p.name}{p.seat === h.button ? ' (D)' : ''}</span>
                            <Cards cards={p.cards.length ? p.cards : [null, null]} />
                            <span className="muted small">{p.hand || (p.folded ? 'folded' : '')}</span>
                            <b className={tone(p.net)}>{signed(p.net)}</b>
                          </div>
                        ))}
                      </div>
                      <ol className="hh-log">
                        {h.log.map((line, i) => <li key={i}>{line}</li>)}
                      </ol>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {more && <button className="btn" onClick={loadMore}>Show older hands</button>}
        </>
      )}
    </section>
  );
}
