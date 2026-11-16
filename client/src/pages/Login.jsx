import { useEffect, useRef, useState } from 'react';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { api } from '../api.js';

// Email login: enter your address, receive a six-digit code by email, type it in.
function EmailLogin({ onLogin, setError }) {
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const codeInput = useRef(null);

  // Countdown until another code may be requested.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const requestCode = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api('/auth/email/request', { body: { email } });
      setStep('code');
      setCode('');
      setResendIn(r.retryIn || 60);
      setTimeout(() => codeInput.current?.focus(), 50);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError('');
    setBusy(true);
    try {
      onLogin(await api('/auth/email/verify', { body: { email, code, name } }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (step === 'email') {
    return (
      <form
        className="guest-form"
        onSubmit={(e) => {
          e.preventDefault();
          requestCode();
        }}
      >
        <label className="field-label" htmlFor="login-email">Log in with your email</label>
        <input
          id="login-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoFocus
          required
        />
        <button className="btn primary" disabled={busy || !email.includes('@')}>
          {busy ? 'Sending…' : 'Send me a login code'}
        </button>
        <p className="muted small">We email you a six-digit code. No password needed.</p>
      </form>
    );
  }

  return (
    <form
      className="guest-form"
      onSubmit={(e) => {
        e.preventDefault();
        verify();
      }}
    >
      <p className="muted small">
        We sent a code to <b>{email}</b>. It can take a minute to arrive; check your spam folder too.
      </p>
      <label className="field-label" htmlFor="login-code">Six-digit code</label>
      <input
        id="login-code"
        ref={codeInput}
        className="code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="••••••"
      />
      <label className="field-label" htmlFor="login-name">Display name <span className="muted">(optional, shown to other players)</span></label>
      <input
        id="login-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Leave blank to keep your current name"
        maxLength={20}
        autoComplete="nickname"
      />
      <button className="btn primary" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Log in'}
      </button>
      <div className="login-links">
        <button type="button" className="link" disabled={resendIn > 0 || busy} onClick={requestCode}>
          {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setStep('email');
            setError('');
          }}
        >
          Use a different email
        </button>
      </div>
    </form>
  );
}

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

  const nothing = config && !config.emailLogin && !config.googleClientId && !config.devLogin;

  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="brand"><i className="brand-mark">♠</i>Pitch Duel <span>Poker</span></div>
        <h1>Poker night, <em>any night.</em></h1>
        <p>A private poker room for your community. Pull up a seat at a cash table, or race for the prize in a Sit & Go.</p>
        <div className="fan" aria-hidden="true">
          <span>A<small>♠</small></span>
          <span className="r">K<small>♥</small></span>
          <span>Q<small>♣</small></span>
          <span className="r">J<small>♦</small></span>
          <span>10<small>♠</small></span>
        </div>
        <ul className="landing-points">
          <li><i>♣</i><div><b>Cash games</b><span>Blinds 1/2, 2/4 and 5/10. Six seats a table, sit down and stand up when you like.</span></div></li>
          <li><i>🏆</i><div><b>Sit & Go tournaments</b><span>Heads-up or 6-Max, starting the moment the table fills.</span></div></li>
          <li><i>👁</i><div><b>Watch live</b><span>Open any running table and follow the action.</span></div></li>
        </ul>
      </section>
      <div className="login-card">
        <h2>Log in to play</h2>
        <p className="muted small">New here? The same form creates your account.</p>

        {config?.emailLogin && <EmailLogin onLogin={onLogin} setError={setError} />}

        {config?.googleClientId && (
          <GoogleOAuthProvider clientId={config.googleClientId}>
            {config.emailLogin && <div className="divider">or</div>}
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
            {(config.googleClientId || config.emailLogin) && <div className="divider">or play as a guest (no account)</div>}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pick a player name"
              maxLength={20}
            />
            <button className="btn" disabled={name.trim().length < 2}>
              Enter as guest
            </button>
          </form>
        )}

        {nothing && <p className="error">No login method is configured on the server.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <p className="landing-foot">Your login is remembered on this device. Play responsibly.</p>
      </div>
    </div>
  );
}
