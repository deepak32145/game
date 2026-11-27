import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { sfx, music } from '../audio/sound.js';
import { Avatar, TxnList, money } from '../ui.jsx';
import Hands from './Hands.jsx';

const sizeName = (size) => (size === 2 ? 'Heads-up' : `${size}-Max`);

// The poker lobby: your wallet at a glance, cash tables, Sit & Go tournaments, live games to watch.

const STAKE_CLASS = { 2: 'low', 4: 'mid', 10: 'high' };

// A small picture of a table with its seats, so you can see at a glance how full it is.
function MiniTable({ players, max, title, sub, tone = 'low' }) {
  return (
    <div className={`mini seats-${max} tone-${tone}`} aria-label={`${players.length} of ${max} seats taken`}>
      <div className="mini-felt">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`mini-seat s${i} ${players[i] ? 'taken' : ''}`} title={players[i]?.name || 'Empty seat'}>
          {players[i] ? players[i].name[0].toUpperCase() : ''}
        </span>
      ))}
    </div>
  );
}

export default function Lobby({ me, lobby, token, socket, onLogout, onAdmin, onOpen, nav }) {
  const [tab, setTab] = useState('cash');
  const [notice, setNotice] = useState('');
  const [txns, setTxns] = useState(null);
  const [musicOn, setMusicOn] = useState(music.isOn());

  // Lobby music. Browsers only allow sound after a tap or key press, so it starts on the first one.
  useEffect(() => {
    const begin = () => {
      sfx.unlock();
      music.start();
    };
    begin();
    window.addEventListener('pointerdown', begin);
    window.addEventListener('keydown', begin);
    return () => {
      window.removeEventListener('pointerdown', begin);
      window.removeEventListener('keydown', begin);
      music.stop();
    };
  }, []);

  useEffect(() => {
    if (tab === 'wallet') api('/wallet/txns', { token }).then(setTxns).catch(() => setTxns([]));
  }, [tab, me.balance]);

  const open = (tableId) => onOpen(tableId, setNotice);
  const ask = (event, payload) => {
    setNotice('');
    socket.emit(event, payload, (r) => !r.ok && setNotice(r.error));
  };

  const cash = lobby?.cash || [];
  const sngs = lobby?.sng || [];
  const stakes = [...new Set(cash.map((t) => t.blinds.join('/')))];
  const mine = new Set(me.games.map((g) => g.id)); // every table and tournament I am in
  const maxTables = lobby?.maxTables || 4;
  const full = mine.size >= maxTables;
  const waitingSngs = sngs.filter((s) => s.status === 'registering' && mine.has(s.id));
  const running = sngs.filter((s) => s.status === 'running');
  const live = [
    ...cash.filter((t) => t.players.length >= 2).map((t) => ({ id: t.id, name: t.name, kind: 'Cash game', players: t.players, max: t.maxSeats, title: t.blinds.join('/'), sub: t.pot ? `pot ${t.pot}` : 'blinds', tone: STAKE_CLASS[t.blinds[1]], detail: `${t.players.length} players${t.watchers ? ` · ${t.watchers} watching` : ''}` })),
    ...running.map((s) => ({ id: s.tableId, name: `${money(s.buyIn)} Sit & Go`, kind: `${sizeName(s.size)} tournament`, players: Array.from({ length: s.left }, (_, i) => ({ name: s.registered[i] || '?' })), max: s.size, title: s.blinds.join('/'), sub: 'blinds', tone: 'gold', detail: `${s.left} of ${s.size} left · prize ${money(s.prizes[0])}` })),
  ];
  const tablesRunning = cash.filter((t) => t.playing).length + running.length;

  // "Quick seat": the busiest table with a free seat that your wallet can afford.
  const quick = full
    ? null
    : cash
        .filter((t) => !mine.has(t.id) && t.players.length < t.maxSeats && t.minBuyIn <= me.balance)
        .sort((a, b) => b.players.length - a.players.length || a.blinds[1] - b.blinds[1])[0];
  const lowestBuyIn = cash.length ? Math.min(...cash.map((t) => t.minBuyIn)) : 0;

  const TABS = [
    ['cash', 'Cash games', cash.reduce((n, t) => n + t.players.length, 0)],
    ['sng', 'Sit & Go', sngs.filter((s) => s.status === 'registering').reduce((n, s) => n + s.registered.length, 0)],
    ['live', 'Live', live.length],
    ['hands', 'Hands', 0],
    ['wallet', 'Wallet', 0],
  ];

  return (
    <div className="page lobby">
      <header className="topbar lobby-top">
        <div className="brand"><i className="brand-mark">♠</i><b className="brand-name">Pitch Duel</b> <span>Poker</span></div>
        <div className="me">
          <button className="wallet-pill" onClick={() => setTab('wallet')} title="Your wallet">
            <span className="muted small">Wallet</span>
            <b>{money(me.balance)}</b>
          </button>
          {me.isAdmin && <button className="btn admin-btn" onClick={onAdmin}>Admin</button>}
          <button
            className="btn ghost icon-btn"
            title={musicOn ? 'Lobby music is on' : 'Lobby music is off'}
            aria-label="Lobby music"
            onClick={() => {
              music.setOn(!musicOn);
              setMusicOn(!musicOn);
            }}
          >
            {musicOn ? '🎵' : '🔇'}
          </button>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>

      {/* Welcome strip: who you are, what you have, and the fastest way into a game */}
      <section className="welcome">
        <div className="welcome-who">
          <Avatar user={me} size={54} />
          <div>
            <div className="muted small">Welcome back</div>
            <h1 className="me-name">{me.name}</h1>
          </div>
        </div>
        <div className="stats">
          <div className="stat gold"><span>Wallet</span><b>{money(me.balance)}</b></div>
          <div className="stat"><span>On tables</span><b>{money(me.inPlay)}</b></div>
          <div className="stat"><span>Players online</span><b>{lobby?.online ?? 0}</b></div>
          <div className="stat"><span>Games running</span><b>{tablesRunning}</b></div>
        </div>
        <div className="welcome-cta">
          {full ? (
            <span className="muted small">You are in {maxTables} games, the most allowed at once. Leave one to join another.</span>
          ) : quick ? (
            <button className="btn primary big" onClick={() => open(quick.id)}>
              {mine.size ? 'Add a table' : 'Quick seat'} <span className="cta-sub">{quick.name}</span>
            </button>
          ) : (
            <span className="muted small">
              {me.balance < lowestBuyIn ? `You need ${money(lowestBuyIn)} to sit at the smallest table. Ask the organiser to add balance, or watch a live game.` : 'Every table you can afford is full. Watch one, or try a Sit & Go.'}
            </span>
          )}
        </div>
      </section>

      {nav && (
        <section className="my-tables">
          <div className="my-tables-head">
            <b>Your open tables</b>
            <span className="muted small">{mine.size} of {maxTables} games · tap one to go back to it</span>
          </div>
          {nav}
        </section>
      )}

      {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
      {waitingSngs.map((s) => (
        <div key={s.id} className="notice info">
          You are registered for the {money(s.buyIn)} {sizeName(s.size)} Sit & Go ({s.registered.length}/{s.size}). It starts as soon as it is full.
          <button className="btn ghost" onClick={() => ask('sng:unregister', { id: s.id })}>Unregister</button>
        </div>
      ))}

      <nav className="tabs">
        {TABS.map(([id, label, count]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            {count > 0 && <i className="tab-count">{count}</i>}
          </button>
        ))}
      </nav>

      {tab === 'cash' && (
        <section>
          <p className="muted small tab-note">
            No-Limit Hold'em, up to 6 players. Sit down with 40 to 200 big blinds from your wallet; stand up any time and your chips go back to it. You can play up to {maxTables} tables at once.
          </p>
          {stakes.map((s) => {
            const group = cash.filter((t) => t.blinds.join('/') === s);
            const tone = STAKE_CLASS[group[0].blinds[1]] || 'low';
            return (
              <div key={s} className="stake-group">
                <h3><span className={`stake-badge tone-${tone}`}>{s}</span> Blinds {s} <span className="muted">· buy-in {money(group[0].minBuyIn)} to {money(group[0].maxBuyIn)}</span></h3>
                <div className="table-cards">
                  {group.map((t) => {
                    const seatedHere = mine.has(t.id);
                    const canSit = t.players.length < t.maxSeats && !full;
                    return (
                      <div key={t.id} className={`table-card tone-${tone} ${seatedHere ? 'mine' : ''}`}>
                        <div className="table-card-head">
                          <b>{t.name}</b>
                          <span className={`status ${t.playing ? 'available' : 'in_match'}`}>{t.playing ? 'Playing' : t.players.length ? 'Waiting' : 'Open'}</span>
                        </div>
                        <MiniTable players={t.players} max={t.maxSeats} title={s} sub={t.playing && t.pot ? `pot ${t.pot}` : 'blinds'} tone={tone} />
                        <div className="table-card-foot">
                          <span className="muted small">{t.players.length}/{t.maxSeats} seated{t.watchers ? ` · ${t.watchers} watching` : ''}</span>
                          <button className={`btn ${canSit || seatedHere ? 'primary' : ''}`} onClick={() => open(t.id)}>
                            {seatedHere ? 'Return to table' : canSit ? 'Take a seat' : 'Watch'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {tab === 'sng' && (
        <section>
          <p className="muted small tab-note">
            A tournament that starts as soon as every seat is filled. Everyone begins with {(lobby?.stack || 1500).toLocaleString()} chips, blinds rise every {lobby?.levelMinutes || 5} minutes, and play continues until one player has all the chips.
          </p>
          {[2, 3, 6].map((size) => (
            <div key={size} className="stake-group">
              <h3>{sizeName(size)} <span className="muted">· {size === 6 ? 'top two are paid' : 'winner takes all'}</span></h3>
              <div className="table-cards">
                {sngs.filter((s) => s.size === size && s.status === 'registering').sort((a, b) => a.buyIn - b.buyIn).map((s) => {
                  const registered = mine.has(s.id);
                  return (
                    <div key={s.id} className={`table-card ticket ${registered ? 'mine' : ''}`}>
                      <div className="table-card-head">
                        <b>{money(s.buyIn)} buy-in</b>
                        <span className="status in_match">{s.registered.length}/{s.size}</span>
                      </div>
                      <div className="prize-pool">
                        <span className="muted small">Prize pool</span>
                        <b>{money(s.buyIn * s.size)}</b>
                      </div>
                      <div className="prize-line">
                        {s.prizes.map((p, i) => <span key={i}>{['1st', '2nd'][i]} <b>{money(p)}</b></span>)}
                      </div>
                      <div className="fill" title={`${s.registered.length} of ${s.size} registered`}>
                        <i style={{ width: `${(s.registered.length / s.size) * 100}%` }} />
                      </div>
                      <div className="muted small names">{s.registered.length ? s.registered.join(', ') : 'Be the first to register'}</div>
                      {registered ? (
                        <button className="btn" onClick={() => ask('sng:unregister', { id: s.id })}>Unregister</button>
                      ) : (
                        <div className={`reg-row ${me.isAdmin ? 'two' : ''}`}>
                          <button className="btn primary" disabled={full || me.balance < s.buyIn} onClick={() => ask('sng:register', { id: s.id })}>
                            {me.balance < s.buyIn ? 'Not enough balance' : full ? `Already in ${maxTables} games` : 'Register'}
                          </button>
                          {me.isAdmin && me.balance >= s.buyIn && !full && (
                            <button className="btn reg-bot" title="Register the AI bot: Claude plays your seat" onClick={() => ask('sng:register', { id: s.id, asBot: true })}>🤖 As Bot</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {tab === 'live' && (
        <section>
          <p className="muted small tab-note">Games in progress. Anyone can watch; hole cards stay hidden unless there is a showdown.</p>
          {live.length === 0 ? (
            <div className="empty big-empty">
              <div className="empty-art">♠ ♥ ♦ ♣</div>
              <p>No games are running right now.</p>
              <p className="muted small">Open a cash table and take a seat to start one.</p>
              <button className="btn primary" onClick={() => setTab('cash')}>See cash tables</button>
            </div>
          ) : (
            <div className="table-cards">
              {live.map((t) => (
                <div key={t.id} className={`table-card tone-${t.tone}`}>
                  <div className="table-card-head"><b>{t.name}</b><span className="live-tag">● LIVE</span></div>
                  <MiniTable players={t.players} max={t.max} title={t.title} sub={t.sub} tone={t.tone} />
                  <div className="table-card-foot">
                    <span className="muted small">{t.kind} · {t.detail}</span>
                    <button className="btn primary" onClick={() => open(t.id)}>Watch</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'hands' && <Hands token={token} me={me} />}

      {tab === 'wallet' && (
        <section className="wallet">
          <div className="wallet-card">
            <div className="wallet-card-top"><span>Pitch Duel wallet</span><i>♠</i></div>
            <b className="big-money">{money(me.balance)}</b>
            <div className="wallet-card-foot">
              <span>{me.name}</span>
              <span>On tables: {money(me.inPlay)}</span>
            </div>
          </div>
          <p className="muted small">Balance is added by the organiser. Chips you take to a table or tournament come out of your wallet and return to it when you leave or win.</p>
          <h3>Recent activity</h3>
          {txns ? <TxnList txns={txns} /> : <p className="muted small">Loading…</p>}
        </section>
      )}
    </div>
  );
}
