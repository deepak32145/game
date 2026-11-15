import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { sfx, music } from '../audio/sound.js';
import { Avatar, TxnList, money } from '../ui.jsx';

// The poker lobby: cash tables, Sit & Go tournaments, live games to watch, and your wallet.

function SeatDots({ players, max }) {
  return (
    <div className="seat-dots" aria-label={`${players.length} of ${max} seats taken`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={players[i] ? 'taken' : ''} title={players[i]?.name || 'Empty seat'}>
          {players[i] ? players[i].name[0].toUpperCase() : ''}
        </span>
      ))}
    </div>
  );
}

export default function Lobby({ me, lobby, token, socket, onLogout, onAdmin }) {
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

  const open = (tableId) => socket.emit('table:watch', { tableId }, (r) => !r.ok && setNotice(r.error));
  const ask = (event, payload) => {
    setNotice('');
    socket.emit(event, payload, (r) => !r.ok && setNotice(r.error));
  };

  const cash = lobby?.cash || [];
  const sngs = lobby?.sng || [];
  const stakes = [...new Set(cash.map((t) => t.blinds.join('/')))];
  const mySng = sngs.find((s) => s.ids.includes(me.id));
  const myCash = cash.find((t) => t.ids.includes(me.id));
  const busy = !!mySng || !!myCash;
  const live = [
    ...cash.filter((t) => t.players.length >= 2).map((t) => ({ id: t.id, name: t.name, detail: `Cash · blinds ${t.blinds.join('/')} · ${t.players.length} players`, pot: t.pot, watchers: t.watchers })),
    ...sngs.filter((s) => s.status === 'running').map((s) => ({ id: s.tableId, name: `${money(s.buyIn)} Sit & Go · ${s.size === 2 ? 'Heads-up' : '6-Max'}`, detail: `Tournament · ${s.left} left · blinds ${s.blinds.join('/')}`, watchers: 0 })),
  ];
  const TABS = [['cash', 'Cash games'], ['sng', 'Sit & Go'], ['live', `Live${live.length ? ` (${live.length})` : ''}`], ['wallet', 'Wallet']];

  return (
    <div className="page lobby">
      <header className="topbar">
        <div className="brand">♠ Pitch Duel <span>Poker</span></div>
        <div className="me">
          <button className="wallet-pill" onClick={() => setTab('wallet')} title="Your wallet">
            <span className="muted small">Wallet</span>
            <b>{money(me.balance)}</b>
            {me.inPlay > 0 && <span className="muted small">+{money(me.inPlay)} in play</span>}
          </button>
          <Avatar user={me} />
          <div className="me-name">{me.name}</div>
          {me.isAdmin && <button className="btn" onClick={onAdmin}>Admin</button>}
          <button
            className="btn ghost"
            title="Lobby music"
            onClick={() => {
              music.setOn(!musicOn);
              setMusicOn(!musicOn);
            }}
          >
            {musicOn ? '🎵 On' : '🎵 Off'}
          </button>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>

      {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
      {mySng && mySng.status === 'registering' && (
        <div className="notice info">
          You are registered for the {money(mySng.buyIn)} {mySng.size === 2 ? 'Heads-up' : '6-Max'} Sit & Go ({mySng.registered.length}/{mySng.size}). It starts as soon as it is full.
          <button className="btn ghost" onClick={() => ask('sng:unregister', {})}>Unregister</button>
        </div>
      )}
      {myCash && (
        <div className="notice info">
          You are seated at {myCash.name}.
          <button className="btn primary" onClick={() => open(myCash.id)}>Return to table</button>
        </div>
      )}

      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span className="online muted small">{lobby?.online ?? 0} online</span>
      </nav>

      {tab === 'cash' && (
        <section>
          <p className="muted small tab-note">
            No-Limit Hold'em, up to 6 players. Sit down with 40 to 200 big blinds from your wallet; stand up any time and your chips go back to it.
          </p>
          {stakes.map((s) => {
            const group = cash.filter((t) => t.blinds.join('/') === s);
            return (
              <div key={s} className="stake-group">
                <h3>Blinds {s} <span className="muted">· buy-in {money(group[0].minBuyIn)} to {money(group[0].maxBuyIn)}</span></h3>
                <div className="table-cards">
                  {group.map((t) => (
                    <div key={t.id} className="table-card">
                      <div className="table-card-head">
                        <b>{t.name}</b>
                        <span className={`status ${t.playing ? 'available' : 'in_match'}`}>{t.playing ? 'Playing' : t.players.length ? 'Waiting' : 'Empty'}</span>
                      </div>
                      <SeatDots players={t.players} max={t.maxSeats} />
                      <div className="muted small">
                        {t.players.length}/{t.maxSeats} seated{t.playing && t.pot ? ` · pot ${t.pot}` : ''}{t.watchers ? ` · ${t.watchers} watching` : ''}
                      </div>
                      <button className="btn primary" onClick={() => open(t.id)}>
                        {t.ids.includes(me.id) ? 'Return to table' : t.players.length < t.maxSeats && !busy ? 'Open table and take a seat' : 'Watch'}
                      </button>
                    </div>
                  ))}
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
          {[2, 6].map((size) => (
            <div key={size} className="stake-group">
              <h3>{size === 2 ? 'Heads-up' : '6-Max'} <span className="muted">· {size === 2 ? 'winner takes all' : 'top two are paid'}</span></h3>
              <div className="table-cards">
                {sngs.filter((s) => s.size === size && s.status === 'registering').sort((a, b) => a.buyIn - b.buyIn).map((s) => {
                  const mine = s.ids.includes(me.id);
                  return (
                    <div key={s.id} className="table-card">
                      <div className="table-card-head">
                        <b>{money(s.buyIn)} buy-in</b>
                        <span className="status in_match">{s.registered.length}/{s.size}</span>
                      </div>
                      <div className="prize-line">
                        {s.prizes.map((p, i) => <span key={i}>{['1st', '2nd'][i]} <b>{money(p)}</b></span>)}
                      </div>
                      <SeatDots players={s.registered.map((name) => ({ name }))} max={s.size} />
                      {mine ? (
                        <button className="btn" onClick={() => ask('sng:unregister', {})}>Unregister</button>
                      ) : (
                        <button className="btn primary" disabled={busy || me.balance < s.buyIn} onClick={() => ask('sng:register', { id: s.id })}>
                          {me.balance < s.buyIn ? 'Not enough balance' : busy ? 'Already in a game' : 'Register'}
                        </button>
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
            <div className="empty">No games are running right now. Open a cash table and take a seat to start one.</div>
          ) : (
            <div className="table-cards">
              {live.map((t) => (
                <div key={t.id} className="table-card">
                  <div className="table-card-head"><b>{t.name}</b><span className="live-tag">● LIVE</span></div>
                  <div className="muted small">{t.detail}{t.pot ? ` · pot ${t.pot}` : ''}</div>
                  <button className="btn primary" onClick={() => open(t.id)}>Watch</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'wallet' && (
        <section className="wallet">
          <div className="wallet-box">
            <div><span className="muted small">Wallet balance</span><b className="big-money">{money(me.balance)}</b></div>
            <div><span className="muted small">On tables</span><b>{money(me.inPlay)}</b></div>
          </div>
          <p className="muted small">Balance is added by the organiser. Chips you take to a table or tournament come out of your wallet and return to it when you leave or win.</p>
          <h3>Recent activity</h3>
          {txns ? <TxnList txns={txns} /> : <p className="muted small">Loading…</p>}
        </section>
      )}
    </div>
  );
}
