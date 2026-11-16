import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Lobby from './pages/Lobby.jsx';
import Table from './pages/Table.jsx';
import Admin from './pages/Admin.jsx';
import { pokerSfx } from './audio/sound.js';

const STORAGE_KEY = 'pitch_duel_auth';
const NO_CHAT = [];

// The strip of open tables. One tap switches table; the lobby stays one tap away for joining another.
function TableTabs({ tables, active, onPick, onClose, onLobby }) {
  const ids = Object.keys(tables);
  if (ids.length === 0) return null;
  return (
    <nav className="ttabs" aria-label="Your open tables">
      {onLobby && <button className="ttab lobby-tab" onClick={onLobby} title="Back to the lobby to join another table">＋ Lobby</button>}
      {ids.map((id) => {
        const t = tables[id];
        const seated = t.mySeat != null;
        const turn = seated && t.toAct === t.mySeat && t.phase === 'hand';
        const label = t.kind === 'cash' ? `${t.blinds[0]}/${t.blinds[1]} ${t.name.split(' ').pop()}` : `SNG ${t.info?.buyIn ?? ''}`;
        return (
          <button key={id} className={`ttab ${active === id ? 'active' : ''} ${turn ? 'turn' : ''}`} onClick={() => onPick(id)} title={t.name}>
            <b>{label}</b>
            <span>{!seated ? 'watching' : turn ? 'Your turn' : t.seats[t.mySeat].stack.toLocaleString()}</span>
            {!seated && (
              <i
                role="button"
                aria-label="Close this table"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
              >
                ✕
              </i>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function loadAuth() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export default function App() {
  const [auth, setAuth] = useState(loadAuth);
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState(null); // my account, including wallet, kept current by the server
  const [lobby, setLobby] = useState(null);
  const [tables, setTables] = useState({}); // every table I am seated at or watching, by id
  const [active, setActive] = useState(null); // the table on screen; null shows the lobby
  const [chats, setChats] = useState({}); // table id -> what has been said there
  const [page, setPage] = useState('lobby'); // 'lobby' | 'admin'
  const [toast, setToast] = useState('');
  const [banned, setBanned] = useState(false);
  // A saved login is only trusted once the server has confirmed it. Until then nothing but a
  // "signing in" screen is shown, so the lobby is never reachable with a stale or forged token.
  const [verified, setVerified] = useState(false);

  const login = (a) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
    setAuth(a);
    setMe(a.user);
    setBanned(false);
  };
  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
    setMe(null);
    setTables({});
    setActive(null);
    setLobby(null);
    setPage('lobby');
    setVerified(false);
  };

  // Returning visitor: log them back in from the token saved on this device, after checking it.
  const savedToken = auth?.token;
  useEffect(() => {
    if (!savedToken) return;
    let cancelled = false;
    setVerified(false);
    const check = (triesLeft) =>
      api('/me', { token: savedToken })
        .then((user) => {
          if (cancelled) return;
          login({ token: savedToken, user });
          setVerified(true);
        })
        .catch((err) => {
          if (cancelled) return;
          if (/banned/i.test(err.message)) {
            logout();
            setBanned(true);
          } else if (/401|unauthorized/i.test(err.message)) logout(); // expired or not genuine
          else if (triesLeft > 0) setTimeout(() => check(triesLeft - 1), 2000); // server unreachable: try again
          else setVerified('offline');
        });
    check(5);
    return () => {
      cancelled = true;
    };
  }, [savedToken]);

  const token = auth?.token;
  useEffect(() => {
    if (!token || verified !== true) return;
    const s = io({ auth: { token } });
    s.on('connect', () => {
      setConnected(true);
      // After a deploy the server restarts and this fires again: pick up the new release
      // straight away instead of running an old page until someone refreshes by hand.
      const mine = document.querySelector('script[src*="assets/index-"]')?.getAttribute('src') || '';
      api('/version')
        .then(({ buildId }) => {
          if (!buildId.startsWith('assets/') || !mine || mine.includes(buildId)) return;
          // Reload at most once per release, so a mismatch can never turn into a reload loop.
          if (sessionStorage.getItem('pitch_duel_reloaded_for') === buildId) return;
          sessionStorage.setItem('pitch_duel_reloaded_for', buildId);
          window.location.reload();
        })
        .catch(() => {});
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (err) => {
      if (err.message === 'banned') {
        logout();
        setBanned(true);
      } else if (err.message === 'unauthorized') logout();
    });
    s.on('me', setMe);
    s.on('lobby:state', setLobby);
    s.on('tables:reset', () => setTables({}));
    s.on('table:state', (t) => t && setTables((prev) => ({ ...prev, [t.id]: t })));
    s.on('table:closed', ({ id }) =>
      setTables((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      })
    );
    s.on('chat:msg', ({ tableId, msg }) => setChats((prev) => ({ ...prev, [tableId]: [...(prev[tableId] || []).slice(-49), msg] })));
    s.on('notice', setToast);
    s.on('banned', () => {
      logout();
      setBanned(true);
    });
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [token, verified]);

  // Messages from the server (knocked out, seat released, tournament starting) fade after a while.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // A table I am seated at that appears while I am in the lobby (a Sit & Go starting, or coming
  // back to the site) opens by itself. It never pulls me away from a table I am looking at.
  const ids = Object.keys(tables);
  const known = useRef(new Set());
  useEffect(() => {
    const fresh = ids.filter((id) => !known.current.has(id));
    fresh.forEach((id) => known.current.add(id));
    const mine = fresh.find((id) => tables[id].mySeat != null);
    if (mine) setActive((cur) => (cur && tables[cur] ? cur : mine));
  }, [ids.join('|')]);

  // A ping when it becomes my turn at a table that is not the one on screen.
  const waitingOnMe = ids.filter((id) => id !== active && tables[id].mySeat != null && tables[id].toAct === tables[id].mySeat && tables[id].phase === 'hand');
  useEffect(() => {
    if (waitingOnMe.length) pokerSfx.yourTurn();
  }, [waitingOnMe.join('|')]);

  if (!auth) {
    return (
      <>
        {banned && <div className="offline-bar">This account has been suspended. Contact the organiser.</div>}
        <Login onLogin={login} />
      </>
    );
  }
  if (verified === 'offline') {
    return (
      <div className="center-screen">
        <div className="login-card">
          <p>Cannot reach the server to confirm your login.</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Try again</button>
        </div>
      </div>
    );
  }
  if (verified !== true || !socket || !me) return <div className="center-screen">Signing you in…</div>;

  const games = me.games || [];
  const maxTables = lobby?.maxTables || 4;
  const canJoin = games.length < maxTables;
  const table = active ? tables[active] : null;

  const openTable = (id, onError) => {
    if (tables[id]) return setActive(id);
    socket.emit('table:watch', { tableId: id }, (r) => (r.ok ? setActive(id) : onError?.(r.error)));
  };
  const closeTable = (id) => {
    socket.emit('table:unwatch', { tableId: id });
    if (active === id) setActive(null);
  };
  const tabs = (onLobby) => <TableTabs tables={tables} active={table ? active : null} onPick={setActive} onClose={closeTable} onLobby={onLobby} />;

  return (
    <>
      {!connected && <div className="offline-bar">Reconnecting to server…</div>}
      {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}
      {table ? (
        <Table
          key={table.id}
          table={table}
          me={me}
          socket={socket}
          chat={chats[table.id] || NO_CHAT}
          onChatHistory={(msgs) => setChats((prev) => ({ ...prev, [table.id]: msgs }))}
          canJoin={canJoin}
          maxTables={maxTables}
          nav={tabs(() => setActive(null))}
          onLobby={() => setActive(null)}
          onClose={() => closeTable(table.id)}
        />
      ) : page === 'admin' && me.isAdmin ? (
        <Admin token={token} onBack={() => setPage('lobby')} />
      ) : (
        <Lobby me={{ ...me, games }} lobby={lobby} token={token} socket={socket} onLogout={logout} onAdmin={() => setPage('admin')} onOpen={openTable} nav={tabs(null)} />
      )}
    </>
  );
}
