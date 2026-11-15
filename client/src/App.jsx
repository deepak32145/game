import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Lobby from './pages/Lobby.jsx';
import Table from './pages/Table.jsx';
import Admin from './pages/Admin.jsx';

const STORAGE_KEY = 'pitch_duel_auth';

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
  const [table, setTable] = useState(null); // the table I am seated at or watching
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
    setTable(null);
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
    s.on('table:state', setTable);
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

  const inGame = me.inPlay > 0;
  return (
    <>
      {!connected && <div className="offline-bar">Reconnecting to server…</div>}
      {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}
      {table ? (
        <Table key={table.id} table={table} me={{ ...me, inGame }} socket={socket} />
      ) : page === 'admin' && me.isAdmin ? (
        <Admin token={token} onBack={() => setPage('lobby')} />
      ) : (
        <Lobby me={me} lobby={lobby} token={token} socket={socket} onLogout={logout} onAdmin={() => setPage('admin')} />
      )}
    </>
  );
}
