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
  const [section, setSection] = useState('players'); // 'players' | 'bot'

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

      <nav className="tabs admin-tabs">
        <button className={section === 'players' ? 'active' : ''} onClick={() => setSection('players')}>Players</button>
        <button className={section === 'bot' ? 'active' : ''} onClick={() => setSection('bot')}>🤖 AI Bot</button>
      </nav>

      {section === 'bot' && <BotPanel token={token} />}
      {section === 'players' && <>
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
      </>}

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

// The AI bot: whether it is ready, what it has cost today, the playbook it follows, and its recent decisions.
const usd = (n) => `$${Number(n || 0).toFixed(n >= 1 ? 2 : 4)}`;
function BotPanel({ token }) {
  const [status, setStatus] = useState(null);
  const [playbook, setPlaybook] = useState('');
  const [budget, setBudget] = useState('');
  const [mode, setMode] = useState('engine');
  const [style, setStyle] = useState('aggressive');
  const [model, setModel] = useState('haiku');
  const [talk, setTalk] = useState('normal');
  const [decisions, setDecisions] = useState(null);
  const [players, setPlayers] = useState(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const loadStatus = (first) =>
    api('/admin/bot', { token })
      .then((s) => {
        setStatus(s);
        if (first) {
          setPlaybook(s.playbook);
          setBudget(String(s.dailyBudgetUsd));
          setMode(s.mode || 'engine');
          setStyle(s.style || 'aggressive');
          setModel(s.claudeModel || 'haiku');
          setTalk(s.talk || 'normal');
        }
      })
      .catch((e) => setError(e.message));
  const loadDecisions = () => {
    api('/admin/bot/decisions?limit=80', { token }).then(setDecisions).catch(() => setDecisions([]));
    api('/admin/bot/players', { token }).then(setPlayers).catch(() => setPlayers([]));
  };
  const forgetPlayer = async (p) => {
    if (!window.confirm(`Forget everything the bot has learned about ${p.name}?`)) return;
    await api('/admin/bot/players/forget', { token, body: { uid: p.uid } }).catch(() => {});
    loadDecisions();
  };
  useEffect(() => {
    loadStatus(true);
    loadDecisions();
    const t = setInterval(() => { loadStatus(false); loadDecisions(); }, 8000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    setError('');
    try {
      const s = await api('/admin/bot', { token, body: { playbook, dailyBudgetUsd: Number(budget), mode, style, model, talk } });
      setStatus(s);
      setSaved('Saved. The bot uses it from its next decision.');
      setTimeout(() => setSaved(''), 3000);
    } catch (e) {
      setError(e.message);
    }
  };

  if (!status) return <p className="muted">{error || 'Loading…'}</p>;
  const today = status.today;
  return (
    <section className="bot-panel">
      {!status.ready && (
        <div className="notice">
          "Claude every turn" needs an Anthropic API key on the server, and there is none. Pick the free engine, or add the key: Add <code>ANTHROPIC_API_KEY=…</code> to
          <code> server/.env.production</code> on your computer and deploy again.
        </div>
      )}
      <div className="admin-summary">
        <div><span className="muted small">Status</span><b className={status.ready ? 'plus' : 'minus'}>{status.ready ? 'Ready' : 'No API key'}</b></div>
        <div><span className="muted small">Brain</span><b>{status.model}</b></div>
        <div><span className="muted small">Spent today</span><b>{usd(today.spentUsd)} <small className="muted">of {usd(status.dailyBudgetUsd)}</small></b></div>
        <div><span className="muted small">Decisions today</span><b>{today.decisions}</b></div>
        <div><span className="muted small">Average answer</span><b>{today.avgMs ? `${(today.avgMs / 1000).toFixed(1)} s` : '—'}</b></div>
        <div><span className="muted small">Claude failed</span><b>{today.fallbacks}</b></div>
        <div><span className="muted small">Seats playing now</span><b>{status.seats}</b></div>
      </div>
      <p className="muted small">
        To play with the bot, sit at a cash table or register for a Sit &amp; Go and choose <b>🤖 Join as Bot</b>. It plays your
        seat with your chips, and you can take over from the table at any time; other players are not told it is a bot. The free
        engine decides on the server at no cost. With Claude, if it is slow, fails or the daily budget is used up, the engine plays that turn.
      </p>

      <div className="bot-settings">
        <div className="bot-choice">
          <span><b>Brain</b> <small className="muted">Who decides the bot's moves.</small></span>
          <div className="seg">
            {[
              ['engine', '⚙️ Free engine', 'Rules on the server: hand strength, draws, equity, pot odds, position and how each opponent plays. Costs nothing.'],
              ['hybrid', '⚙️+🧠 Hybrid', 'The engine plays everyday spots; Claude decides big pots and big calls. Small cost.'],
              ['claude', '🧠 Claude every turn', 'Claude decides every move and improvises from the whole session.'],
            ].map(([k, label, hint]) => (
              <button key={k} type="button" className={`seg-opt ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)} title={hint}>
                {label}
              </button>
            ))}
          </div>
          <small className="muted">{{ engine: 'Rules on the server: hand strength, draws, equity, pot odds, position and how each opponent plays. Costs nothing.', hybrid: 'The engine plays everyday spots; Claude decides big pots and big calls. Small cost.', claude: 'Claude decides every move and improvises from the whole session.' }[mode]}{mode !== 'engine' && !status.claudeReady ? ' Needs an API key on the server.' : ''}</small>
        </div>
        {mode !== 'engine' && (
          <div className="bot-choice">
            <span><b>Claude model</b> <small className="muted">Which Claude plays its turns.</small></span>
            <div className="seg">
              {[['haiku', 'Haiku · cheapest'], ['sonnet', 'Sonnet'], ['opus', 'Opus · strongest']].map(([k, label]) => (
                <button key={k} type="button" className={`seg-opt ${model === k ? 'on' : ''}`} onClick={() => setModel(k)}>{label}</button>
              ))}
            </div>
            <small className="muted">{{ haiku: 'About $0.0005 a move: a whole session costs a few cents.', sonnet: 'About $0.004 a move.', opus: 'About $0.006 a move, the deepest reads.' }[model]}</small>
          </div>
        )}
        <div className="bot-choice">
          <span><b>Table talk</b> <small className="muted">How often the bot shows feelings at the table: Hinglish chat, emojis, throwables.</small></span>
          <div className="seg">
            {[['off', 'Silent'], ['low', 'Now and then'], ['normal', 'Normal'], ['high', 'Chatty']].map(([k, label]) => (
              <button key={k} type="button" className={`seg-opt ${talk === k ? 'on' : ''}`} onClick={() => setTalk(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="bot-choice">
          <span><b>Engine style</b> <small className="muted">How boldly the engine plays.</small></span>
          <div className="seg">
            {[['tight', 'Tight'], ['balanced', 'Balanced'], ['aggressive', 'Aggressive']].map(([k, label]) => (
              <button key={k} type="button" className={`seg-opt ${style === k ? 'on' : ''}`} onClick={() => setStyle(k)}>{label}</button>
            ))}
          </div>
        </div>
        <label className="bot-playbook">
          <span><b>Playbook</b> <small className="muted">For Claude: teach it how to play. It reads this before every decision it makes.</small></span>
          <textarea value={playbook} onChange={(e) => setPlaybook(e.target.value)} rows={9} maxLength={6000} />
        </label>
        <label className="bot-budget">
          <span><b>Daily budget</b> <small className="muted">US dollars for Claude. Above it the free engine plays every turn.</small></span>
          <input type="number" min="0" max="100" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={save}>Save</button>
          {saved && <span className="muted small">{saved}</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      </div>

      <h3 className="bot-log-title">Player notes</h3>
      <p className="muted small">What the bot has learned about each player across all its games. It starts every new game with these, and today's play counts more.</p>
      {!players && <p className="muted small">Loading…</p>}
      {players && players.length === 0 && <p className="muted small">No notes yet. They build up as the bot plays.</p>}
      {players && players.length > 0 && (
        <div className="notes-wrap">
          <table className="notes-table">
            <thead>
              <tr>
                <th>Player</th><th>Reads as</th><th title="Hands seen / games">Hands</th><th title="Share of hands they put money in">Plays</th><th title="Share of hands they raise before the flop">Raises</th>
                <th title="Bets and raises per call after the flop">Aggr.</th><th title="Folds when bet into after the flop">Folds to bet</th><th title="Bets when checked to">Stabs</th><th title="Calls a river bet">River calls</th><th title="River bets shown down that were bluffs">River bluffs</th><th />
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.uid}>
                  <td><b>{p.name}</b>{p.shown?.length ? <small className="muted"> showed {p.shown.join(', ')}</small> : null}</td>
                  <td><span className={`note-style ${p.style}`}>{{ maniac: 'Maniac', station: 'Calling station', nit: 'Tight / passive', regular: 'Regular', unknown: 'Not enough hands' }[p.style] || p.style}</span></td>
                  <td>{p.hands}<small className="muted"> / {p.sessions}</small></td>
                  <td>{p.vpip ?? '—'}{p.vpip != null && '%'}</td>
                  <td>{p.pfr ?? '—'}{p.pfr != null && '%'}</td>
                  <td>{p.aggression ?? 'high'}</td>
                  <td>{p.foldToBet != null ? `${p.foldToBet}%` : '—'}</td>
                  <td>{p.betsWhenCheckedTo != null ? `${p.betsWhenCheckedTo}%` : '—'}</td>
                  <td>{p.riverCall != null ? `${p.riverCall}%` : '—'}</td>
                  <td>{p.riverBluffs ?? '—'}</td>
                  <td><button className="btn small" onClick={() => forgetPlayer(p)}>Forget</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="bot-log-title">Recent decisions</h3>
      {!decisions && <p className="muted small">Loading…</p>}
      {decisions && decisions.length === 0 && <p className="muted small">No decisions yet. Seat the bot at a table to see it play.</p>}
      {decisions && decisions.length > 0 && (
        <ul className="bot-log">
          {decisions.map((d) => (
            <li key={d.id} className={d.fallback ? 'safe' : ''}>
              <span className="bot-log-when">
                <b>{new Date(d.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b>
                <small>{d.tableName} · #{d.handNo}</small>
              </span>
              <span className="bot-log-spot">
                <b>{(d.cards || []).join(' ')}</b>
                <small>{d.street}{d.board?.length ? ` · ${d.board.join(' ')}` : ''} · pot {d.pot}{d.toCall ? ` · to call ${d.toCall}` : ''}</small>
              </span>
              <span className="bot-log-move">
                <b className={`bot-move ${d.action}`}>{d.action === 'raise' ? `raise ${d.amount}` : d.action}</b>
                <small>{d.model === 'engine' ? '⚙️ ' : '🧠 '}{d.reason}{d.fallback ? ` (Claude: ${d.fallback})` : ''}</small>
              </span>
              <span className="bot-log-cost">
                <b>{d.ms ? `${(d.ms / 1000).toFixed(1)} s` : '—'}</b>
                <small>{usd(d.costUsd)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
