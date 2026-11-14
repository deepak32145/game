import { useEffect, useState } from 'react';
import { api } from '../api.js';

export function Avatar({ user, size = 36 }) {
  const style = { width: size, height: size, fontSize: size * 0.45 };
  return user.picture ? (
    <img className="avatar" style={style} src={user.picture} alt="" referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar" style={style}>{user.name[0].toUpperCase()}</div>
  );
}

export function Countdown({ ms, onDone }) {
  const [end] = useState(() => Date.now() + ms);
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    const t = setInterval(() => {
      const l = end - Date.now();
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onDone?.();
      }
    }, 250);
    return () => clearInterval(t);
  }, [end]);
  return <span className="countdown">{Math.max(0, Math.ceil(left / 1000))}s</span>;
}

const CLOSED_TEXT = {
  declined: 'Your challenge was declined.',
  expired: 'The challenge expired.',
  cancelled: 'The challenge was cancelled.',
};

export default function Lobby({ me, token, socket, onLogout }) {
  const [users, setUsers] = useState([]);
  const [overs, setOvers] = useState(2);
  const [game, setGame] = useState('cricket');
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState(null); // { id, to, expiresIn }
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState([]);
  const [leaders, setLeaders] = useState([]);

  useEffect(() => {
    const onIncoming = (c) => setIncoming((list) => [...list, c]);
    const onClosed = ({ id, reason }) => {
      setIncoming((list) => list.filter((c) => c.id !== id));
      setOutgoing((o) => {
        if (o?.id === id && CLOSED_TEXT[reason]) setNotice(CLOSED_TEXT[reason]);
        return o?.id === id ? null : o;
      });
    };
    socket.on('lobby:users', setUsers);
    socket.on('challenge:incoming', onIncoming);
    socket.on('challenge:closed', onClosed);
    socket.emit('lobby:get', {}, (r) => r?.users && setUsers(r.users));
    return () => {
      socket.off('lobby:users', setUsers);
      socket.off('challenge:incoming', onIncoming);
      socket.off('challenge:closed', onClosed);
    };
  }, [socket]);

  useEffect(() => {
    api('/matches/mine', { token }).then(setHistory).catch(() => {});
    api('/leaderboard').then(setLeaders).catch(() => {});
  }, [token]);

  const challenge = (user) => {
    setNotice('');
    socket.emit('challenge:send', { to: user.id, overs, game }, (r) => {
      if (r.ok) setOutgoing({ id: r.id, to: user, expiresIn: r.expiresIn });
      else setNotice(r.error);
    });
  };

  const respond = (c, accept) => {
    socket.emit('challenge:respond', { id: c.id, accept }, (r) => {
      if (!r.ok) setNotice(r.error);
    });
    setIncoming((list) => list.filter((x) => x.id !== c.id));
  };

  const self = users.find((u) => u.id === me.id) || { ...me, status: 'available' };
  const others = users.filter((u) => u.id !== me.id);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">🏏 Pitch Duel</div>
        <div className="me">
          <Avatar user={self} />
          <div>
            <div className="me-name">{self.name}</div>
            <div className="muted small">
              {self.wins}W · {self.losses}L · {self.ties}T
            </div>
          </div>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>

      <div className="lobby-grid">
        <section className="card">
          <div className="card-head">
            <h2>Players online <span className="pill">{others.length}</span></h2>
            <div className="game-pick">
              <button className={`btn ${game === 'cricket' ? 'selected' : ''}`} onClick={() => setGame('cricket')}>🏏 Cricket</button>
              <button className={`btn ${game === 'poker' ? 'selected' : ''}`} onClick={() => setGame('poker')}>♠ Poker</button>
            </div>
            {game === 'poker' && (
              <span className="muted small">No-Limit Hold'em · 1,000 chips each · blinds start at 5/10 and rise a little every 5 minutes · play until one is out</span>
            )}
            <label className="overs-select" style={{ display: game === 'cricket' ? undefined : 'none' }}>
              Match length
              <select value={overs} onChange={(e) => setOvers(Number(e.target.value))}>
                <option value={2}>2 overs</option>
                <option value={5}>5 overs</option>
                <option value={10}>10 overs</option>
              </select>
            </label>
          </div>

          {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}

          {outgoing && (
            <div className="outgoing">
              Waiting for <b>{outgoing.to.name}</b> to respond… <Countdown ms={outgoing.expiresIn} />
              <button className="btn ghost" onClick={() => socket.emit('challenge:cancel', { id: outgoing.id })}>
                Cancel
              </button>
            </div>
          )}

          {others.length === 0 ? (
            <div className="empty">
              <p>Nobody else is online right now.</p>
              <p className="muted small">
                Open this site in another browser or an incognito window and log in as a second player to try it out.
              </p>
            </div>
          ) : (
            <ul className="user-list">
              {others.map((u) => (
                <li key={u.id}>
                  <Avatar user={u} />
                  <div className="user-info">
                    <div>{u.name}</div>
                    <div className="muted small">{u.wins}W · {u.losses}L</div>
                  </div>
                  <span className={`status ${u.status}`}>{u.status === 'available' ? 'Available' : 'In a match'}</span>
                  <button
                    className="btn primary"
                    disabled={u.status !== 'available' || !!outgoing}
                    onClick={() => challenge(u)}
                  >
                    Challenge
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="side">
          <section className="card">
            <h2>Leaderboard</h2>
            {leaders.length === 0 ? (
              <p className="muted small">No matches played yet.</p>
            ) : (
              <ol className="leaders">
                {leaders.map((u) => (
                  <li key={u.id}>
                    <span>{u.name}</span>
                    <span className="muted">{u.wins}W · {u.losses}L</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card">
            <h2>Your recent matches</h2>
            {history.length === 0 ? (
              <p className="muted small">Your results will show up here.</p>
            ) : (
              <ul className="history">
                {history.map((m) => (
                  <li key={m.id}>
                    <span className={`tag ${m.won === null ? 'tie' : m.won ? 'win' : 'loss'}`}>
                      {m.won === null ? 'T' : m.won ? 'W' : 'L'}
                    </span>
                    <div>
                      <div className="small">
                        {m.players.map((p) => (m.game === 'poker' ? `${p.name} ${p.runs} chips` : `${p.name} ${p.runs}/${p.wickets}`)).join('  v  ')}
                      </div>
                      <div className="muted small">{m.game === 'poker' ? '♠ Poker' : `🏏 ${m.overs} ov`} · {m.resultText}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {incoming.map((c) => (
        <div className="modal-backdrop" key={c.id}>
          <div className="modal">
            <Avatar user={c.from} size={56} />
            <h3>{c.from.name} challenges you!</h3>
            <p className="muted">
              {c.game === 'poker' ? "Poker: No-Limit Hold'em, 1,000 chips each, blinds from 5/10 rising gradually every 5 minutes" : `Cricket: ${c.overs}-over match`} · <Countdown ms={c.expiresIn} />
            </p>
            <div className="row">
              <button className="btn ghost" onClick={() => respond(c, false)}>Decline</button>
              <button className="btn primary" onClick={() => respond(c, true)}>Accept</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
