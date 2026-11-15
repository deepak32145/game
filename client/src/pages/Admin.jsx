import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TxnList, money } from '../ui.jsx';

// Admin page: every player's wallet, with tools to add or deduct balance and to ban or unban.
// The server checks admin rights on every request; this page is only the front for it.

export default function Admin({ token, onBack }) {
  const [users, setUsers] = useState([]);
  const [summary, setSummary] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // the player whose wallet is being changed
  const [history, setHistory] = useState(null); // { user, txns }

  const load = () => {
    api(`/admin/users?q=${encodeURIComponent(q)}`, { token }).then(setUsers).catch((e) => setError(e.message));
    api('/admin/summary', { token }).then(setSummary).catch(() => {});
  };
  useEffect(() => {
    const t = setTimeout(load, 250); // wait for typing to pause
    return () => clearTimeout(t);
  }, [q]);

  const replace = (u) => setUsers((list) => list.map((x) => (x.id === u.id ? u : x)));

  const ban = async (u) => {
    setError('');
    const banned = !u.banned;
    const reason = banned ? window.prompt(`Ban ${u.name}? They are removed from any table (chips go back to their wallet) and cannot log in.\n\nReason (optional):`, '') : '';
    if (banned && reason === null) return;
    try {
      replace(await api(`/admin/users/${u.id}/ban`, { token, body: { banned, reason } }));
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const showHistory = async (u) => {
    setHistory({ user: u, txns: null });
    setHistory({ user: u, txns: await api(`/admin/users/${u.id}/txns`, { token }).catch(() => []) });
  };

  return (
    <div className="page admin">
      <header className="topbar">
        <div className="brand">♠ Admin</div>
        <button className="btn ghost" onClick={onBack}>‹ Back to lobby</button>
      </header>

      {summary && (
        <div className="admin-summary">
          <div><span className="muted small">Players</span><b>{summary.players}</b></div>
          <div><span className="muted small">Online now</span><b>{summary.online ?? 0}</b></div>
          <div><span className="muted small">In all wallets</span><b>{money(summary.wallets)}</b></div>
          <div><span className="muted small">On cash tables</span><b>{money(summary.chipsOnTables)}</b></div>
          <div><span className="muted small">Banned</span><b>{summary.banned}</b></div>
        </div>
      )}

      <input className="admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" />
      {error && <div className="notice" onClick={() => setError('')}>{error}</div>}

      <div className="admin-list">
        {users.map((u) => (
          <div key={u.id} className={`admin-row ${u.banned ? 'banned' : ''}`}>
            <div className="admin-who">
              <b>{u.name}</b> {u.isAdmin && <span className="pill">admin</span>} {u.banned && <span className="pill red">banned</span>}
              <div className="muted small">{u.email || 'no email (guest)'}</div>
              {u.banned && u.banReason && <div className="muted small">Reason: {u.banReason}</div>}
            </div>
            <div className="admin-money">
              <b>{money(u.balance)}</b>
              {u.inPlay > 0 && <div className="muted small">+{money(u.inPlay)} on tables</div>}
            </div>
            <div className="admin-actions">
              <button className="btn primary" onClick={() => setEditing({ user: u, sign: 1 })}>Add</button>
              <button className="btn" onClick={() => setEditing({ user: u, sign: -1 })}>Deduct</button>
              <button className="btn ghost" onClick={() => showHistory(u)}>History</button>
              <button className={`btn ${u.banned ? '' : 'danger'}`} disabled={u.isAdmin && !u.banned} onClick={() => ban(u)}>{u.banned ? 'Unban' : 'Ban'}</button>
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="muted">No players found.</p>}
      </div>

      {editing && (
        <Adjust
          {...editing}
          token={token}
          onClose={() => setEditing(null)}
          onDone={(u) => {
            replace(u);
            setEditing(null);
            load();
          }}
        />
      )}

      {history && (
        <div className="modal-backdrop" onClick={() => setHistory(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{history.user.name}: wallet history</h3>
            {history.txns ? <TxnList txns={history.txns} showBy /> : <p className="muted">Loading…</p>}
            <button className="btn" onClick={() => setHistory(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Adjust({ user, sign, token, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Math.floor(Number(amount));
  const valid = n > 0;
  const after = user.balance + sign * (valid ? n : 0);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await api(`/admin/users/${user.id}/adjust`, { token, body: { amount: sign * n, note } }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{sign > 0 ? 'Add balance to' : 'Deduct balance from'} {user.name}</h3>
        <p className="muted small">Current wallet: {money(user.balance)}</p>
        <input className="admin-amount" type="number" inputMode="numeric" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" autoFocus />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. paid in cash" maxLength={200} />
        {valid && <p>New wallet balance: <b className={after < 0 ? 'error' : ''}>{money(after)}</b></p>}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid || after < 0 || busy}>{sign > 0 ? 'Add' : 'Deduct'} {valid ? money(n) : ''}</button>
        </div>
      </form>
    </div>
  );
}
