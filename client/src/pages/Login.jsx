import { useEffect, useState } from 'react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [config, setConfig] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/config').then(setConfig).catch(() => setError('Cannot reach the server. Is it running?'));
  }, []);

  const submit = async (path, body) => {
    setError('');
    try {
      onLogin(await api(path, { body }));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="center-screen login">
      <div className="login-card">
        <div className="logo">🏏</div>
        <h1>Pitch Duel</h1>
        <p className="muted">Challenge anyone online to a live one-on-one cricket match.</p>

        {config?.googleClientId && (
          <GoogleOAuthProvider clientId={config.googleClientId}>
            <div className="google-btn">
              <GoogleLogin
                onSuccess={(r) => submit('/auth/google', { credential: r.credential })}
                onError={() => setError('Google sign-in failed')}
                theme="filled_blue"
                shape="pill"
              />
            </div>
          </GoogleOAuthProvider>
        )}

        {config?.devLogin && (
          <form
            className="guest-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit('/auth/dev', { name });
            }}
          >
            {config.googleClientId && <div className="divider">or play as guest</div>}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pick a player name"
              maxLength={20}
              autoFocus
            />
            <button className="btn primary" disabled={name.trim().length < 2}>
              Enter as guest
            </button>
          </form>
        )}

        {config && !config.googleClientId && !config.devLogin && (
          <p className="error">No login method is configured on the server.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
