import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Lobby from './pages/Lobby.jsx';
import Match from './pages/Match.jsx';
import Poker from './pages/Poker.jsx';

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
  const [match, setMatch] = useState(null);
  const [teams, setTeams] = useState(null);

  const login = (a) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
    setAuth(a);
  };
  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
    setMatch(null);
  };

  useEffect(() => {
    api('/teams').then((list) => setTeams(Object.fromEntries(list.map((t) => [t.id, t]))));
  }, []);

  const token = auth?.token;
  useEffect(() => {
    if (!token) return;
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
      if (err.message === 'unauthorized') logout();
    });
    s.on('match:state', setMatch);
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [token]);

  if (!auth) return <Login onLogin={login} />;
  if (!socket || !teams) return <div className="center-screen">Loading…</div>;

  return (
    <>
      {!connected && <div className="offline-bar">Reconnecting to server…</div>}
      {match ? (
        match.game === 'poker' ? (
          <Poker key={match.id} match={match} me={auth.user} socket={socket} />
        ) : (
          <Match key={match.id} match={match} me={auth.user} teams={teams} socket={socket} />
        )
      ) : (
        <Lobby me={auth.user} token={token} socket={socket} onLogout={logout} />
      )}
    </>
  );
}
