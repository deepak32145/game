import { useEffect, useRef, useState } from 'react';
import Arena3D from '../game/Arena3D.jsx';
import { sfx } from '../game/sound.js';
import { commentate, say } from '../game/commentary.js';
import { Avatar, Countdown } from './Lobby.jsx';
import { oversText } from '../api.js';

const VARIATION_LABELS = {
  pace: { stock: 'Stock ball', in: 'Inswinger', out: 'Outswinger', slow: 'Slower ball' },
  spin: { stock: 'Stock ball', in: 'Turn in', out: 'Turn away', slow: 'Flighted' },
};
const VARIATIONS = ['stock', 'in', 'out', 'slow'];
const DEFAULT_AIM = { line: 0.15, length: 0.45 };

function timingText(r) {
  if (!r.shot) return 'No shot offered';
  const ms = Math.abs(r.offset);
  const when = ms < 15 ? 'spot on' : `${ms}ms ${r.offset < 0 ? 'early' : 'late'}`;
  const label = { perfect: 'Perfect', good: 'Good', ok: 'Okay', poor: 'Poor', miss: 'Missed' }[r.quality];
  return `${label} timing (${when})`;
}

function playResultSound(r) {
  if (r.contact) sfx.bat(r.shot.style === 'defend' ? 0.5 : r.runs >= 4 ? 1.3 : 1);
  if (r.wicket === 'bowled') sfx.stumps();
  if (r.wicket) sfx.cheer(1);
  else if (r.runs === 6) sfx.cheer(1.3);
  else if (r.runs === 4) sfx.cheer(0.9);
  else if (!r.contact && r.legal) sfx.gasp();
}

function describeAim({ line, length }) {
  const len = length < 0.12 ? 'Yorker' : length < 0.35 ? 'Full' : length < 0.65 ? 'Good length' : length < 0.85 ? 'Short' : 'Bouncer';
  const a = Math.abs(line);
  const side = line > 0 ? 'off' : 'leg';
  const where = a < 0.2 ? 'on the stumps' : a < 0.6 ? `just outside ${side}` : a < 1.1 ? `wide of ${side} stump` : `very wide on the ${side} side (may be called wide)`;
  return `${len}, ${where}`;
}

// Shows how early or late the swing was, like a broadcast timing graphic.
function TimingMeter({ result }) {
  if (!result || !result.shot) return null;
  const pos = 50 + (Math.max(-300, Math.min(300, result.offset)) / 300) * 50;
  return (
    <div className="timing">
      <div className="timing-labels"><span>EARLY</span><span>{result.quality.toUpperCase()}</span><span>LATE</span></div>
      <div className="timing-bar">
        <div className="timing-sweet" />
        <div className={`timing-mark ${result.quality}`} style={{ left: `${pos}%` }} />
      </div>
    </div>
  );
}

function bannerFor(r) {
  if (!r.legal) return { text: 'WIDE', tone: 'neutral' };
  if (r.wicket) return { text: r.wicket === 'lbw' ? 'LBW!' : `${r.wicket.toUpperCase()}!`, tone: 'out' };
  if (r.runs === 6) return { text: 'SIX!', tone: 'big' };
  if (r.runs === 4) return { text: 'FOUR!', tone: 'big' };
  if (r.runs === 0) return { text: 'DOT BALL', tone: 'neutral' };
  return { text: `${r.runs} RUN${r.runs > 1 ? 'S' : ''}`, tone: 'neutral' };
}

// ---- pre-match screens ------------------------------------------------------

function TeamSelect({ view, me, teams, socket }) {
  const opp = view.players.find((p) => p.id !== me.id);
  const mine = view.teams[me.id];
  const theirs = view.teams[opp.id];
  const [preview, setPreview] = useState(mine || Object.keys(teams)[0]);
  const team = teams[preview];

  return (
    <div className="card stage">
      <h2>Choose your team</h2>
      <p className="muted">
        {view.overs}-over match against <b>{opp.name}</b>.{' '}
        {theirs ? `${opp.name} picked ${teams[theirs].name}.` : `${opp.name} is still choosing.`}
      </p>
      <div className="team-grid">
        {Object.values(teams).map((t) => (
          <button
            key={t.id}
            className={`team-card ${preview === t.id ? 'active' : ''}`}
            style={{ '--team': t.color }}
            disabled={theirs === t.id}
            onClick={() => setPreview(t.id)}
          >
            <span className="team-badge">{t.short}</span>
            <span>{t.name}</span>
            {theirs === t.id && <span className="muted small">Taken</span>}
            {mine === t.id && <span className="small">✓ Yours</span>}
          </button>
        ))}
      </div>

      <div className="squad">
        <h3>{team.name} squad</h3>
        <table>
          <thead>
            <tr><th>#</th><th>Player</th><th>Role</th><th>Bat</th><th>Bowl</th></tr>
          </thead>
          <tbody>
            {team.players.map((p, i) => (
              <tr key={p.name}>
                <td>{i + 1}</td>
                <td>{p.name}</td>
                <td>{p.role}{p.kind ? ` · ${p.kind}` : ''}</td>
                <td>{p.bat}</td>
                <td>{p.bowl || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        className="btn primary big"
        disabled={theirs === preview || mine === preview}
        onClick={() => socket.emit('match:pickTeam', { teamId: preview })}
      >
        {mine === preview ? 'Locked in. Waiting for opponent…' : `Play as ${team.name}`}
      </button>
    </div>
  );
}

function Toss({ view, me, socket }) {
  const t = view.toss;
  const name = (id) => view.players.find((p) => p.id === id).name;
  return (
    <div className="card stage toss">
      <div className="coin">🪙</div>
      <h2>The toss</h2>
      {t.stage === 'call' &&
        (t.caller === me.id ? (
          <>
            <p>Your call.</p>
            <div className="row">
              <button className="btn primary big" onClick={() => socket.emit('match:tossCall', { call: 'heads' })}>Heads</button>
              <button className="btn primary big" onClick={() => socket.emit('match:tossCall', { call: 'tails' })}>Tails</button>
            </div>
          </>
        ) : (
          <p>{name(t.caller)} is calling the toss…</p>
        ))}
      {t.stage === 'choose' && (
        <>
          <p>
            {name(t.caller)} called {t.call}. It's <b>{t.coin}</b>! {t.winner === me.id ? 'You win' : `${name(t.winner)} wins`} the toss.
          </p>
          {t.winner === me.id ? (
            <div className="row">
              <button className="btn primary big" onClick={() => socket.emit('match:tossChoice', { choice: 'bat' })}>Bat first</button>
              <button className="btn primary big" onClick={() => socket.emit('match:tossChoice', { choice: 'bowl' })}>Bowl first</button>
            </div>
          ) : (
            <p className="muted">{name(t.winner)} is deciding…</p>
          )}
        </>
      )}
    </div>
  );
}

// ---- scorecard --------------------------------------------------------------

function Scorecard({ inn, team, label }) {
  return (
    <div className="scorecard">
      <h3>
        {label}: {team.name} {inn.runs}/{inn.wickets} <span className="muted">({oversText(inn.balls)} ov)</span>
      </h3>
      <table>
        <thead>
          <tr><th>Batter</th><th></th><th>R</th><th>B</th><th>4s</th><th>6s</th></tr>
        </thead>
        <tbody>
          {inn.batters.filter((b) => b.batted).map((b) => (
            <tr key={b.name}>
              <td>{b.name}</td>
              <td className="muted small">{b.out ? b.how : 'not out'}</td>
              <td><b>{b.runs}</b></td>
              <td>{b.balls}</td>
              <td>{b.fours}</td>
              <td>{b.sixes}</td>
            </tr>
          ))}
          <tr><td>Extras</td><td></td><td>{inn.extras}</td><td colSpan={3}></td></tr>
        </tbody>
      </table>
      <table>
        <thead>
          <tr><th>Bowler</th><th>O</th><th>R</th><th>W</th></tr>
        </thead>
        <tbody>
          {inn.bowlers.filter((b) => b.balls > 0 || b.runs > 0).map((b) => (
            <tr key={b.name}>
              <td>{b.name}</td>
              <td>{oversText(b.balls)}</td>
              <td>{b.runs}</td>
              <td><b>{b.wickets}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- main -------------------------------------------------------------------

export default function Match({ match, me, teams, socket }) {
  const anim = useRef({});
  const noShotTimer = useRef(null);
  const [view, setView] = useState(match);
  const [banner, setBanner] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [aim, setAim] = useState(DEFAULT_AIM);
  const [variation, setVariation] = useState('stock');
  const [inFlight, setInFlight] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [muted, setMuted] = useState(sfx.isMuted());
  const [caption, setCaption] = useState('');

  // Hold back a result until the ball has reached the batter on this screen,
  // so the scoreboard never spoils the delivery.
  useEffect(() => {
    const a = anim.current;
    const isResult = match.phase === 'innings' && match.innings[match.current]?.ballPhase === 'result';
    const delay = isResult && a.contact ? Math.max(0, a.contact - performance.now()) : 0;
    if (!delay) {
      setView(match);
      return;
    }
    const t = setTimeout(() => setView(match), delay);
    return () => clearTimeout(t);
  }, [match]);

  const inn = view.innings[view.current];
  const batting = inn?.battingUser === me.id;
  const ballPhase = view.phase === 'innings' ? inn.ballPhase : null;
  const opp = view.players.find((p) => p.id !== me.id);

  const sendShot = (shot) => {
    const a = anim.current;
    if (a.shotSent) return;
    a.shotSent = true;
    clearTimeout(noShotTimer.current);
    socket.emit('match:shot', shot);
  };

  useEffect(() => {
    const onStart = (d) => {
      const now = performance.now();
      anim.current = {
        delivery: d,
        t0: now,
        release: now + d.runupMs,
        contact: now + d.runupMs + d.flightMs,
        swing: null,
        result: null,
        shotSent: false,
      };
      setBanner(null);
      setFeedback('');
      setLastResult(null);
      setCaption('');
      setInFlight(true);
      clearTimeout(noShotTimer.current);
      noShotTimer.current = setTimeout(() => sendShot({ none: true }), d.runupMs + d.flightMs + 320);
    };
    const onResult = (r) => {
      const a = anim.current;
      const delay = a.contact ? Math.max(0, a.contact - performance.now()) : 0;
      setTimeout(() => {
        a.result = r;
        a.resultAt = performance.now();
        if (r.shot && !a.swing) a.swing = { ...r.shot, at: a.resultAt - 120 };
        playResultSound(r);
        setCaption(commentate(r));
        setLastResult(r);
        setBanner(bannerFor(r));
        setFeedback(`${timingText(r)} · ${r.text}`);
        setInFlight(false);
      }, delay);
    };
    socket.on('ball:start', onStart);
    socket.on('ball:result', onResult);
    return () => {
      socket.off('ball:start', onStart);
      socket.off('ball:result', onResult);
      clearTimeout(noShotTimer.current);
    };
  }, [socket]);

  // Clear the last ball off the pitch once the next one is being set up.
  useEffect(() => {
    if (ballPhase === 'await_delivery' || ballPhase === 'select_bowler') {
      anim.current = {};
      setBanner(null);
      setLastResult(null);
      setCaption('');
      setInFlight(false);
    }
  }, [ballPhase, inn?.balls, inn?.extras, view.current]);

  // The commentator also calls the innings break and the final result.
  const targetNow = view.target;
  const resultText = view.result?.text;
  useEffect(() => {
    if (view.phase === 'innings_break') say(`That is the end of the innings. The target is ${targetNow}.`);
    if (view.phase === 'finished' && resultText) say(`And that is the match! ${resultText}.`, true);
  }, [view.phase]);

  const playShot = (dir, style) => {
    const a = anim.current;
    const now = performance.now();
    if (!batting || !a.delivery || a.shotSent || now < a.release) return;
    a.swing = { dir, style, at: now };
    sendShot({ dir, style, offset: now - a.contact });
  };

  const bowl = () => {
    if (batting || ballPhase !== 'await_delivery') return;
    socket.emit('match:bowl', { variation, ...aim });
  };

  // Keyboard: batter uses arrows/WASD (+Shift to loft); bowler uses 1-4 and Space.
  const keyHandler = useRef(null);
  keyHandler.current = (e) => {
    if (view.phase !== 'innings' || e.repeat) return;
    const k = e.key.toLowerCase();
    if (batting) {
      const style = e.shiftKey ? 'loft' : 'stroke';
      if (k === 'arrowleft' || k === 'a') playShot('leg', style);
      else if (k === 'arrowup' || k === 'w') playShot('straight', style);
      else if (k === 'arrowright' || k === 'd') playShot('off', style);
      else if (k === 'arrowdown' || k === 's') playShot('straight', 'defend');
      else return;
      e.preventDefault();
    } else if (ballPhase === 'await_delivery') {
      if (['1', '2', '3', '4'].includes(k)) setVariation(VARIATIONS[Number(k) - 1]);
      else if (k === ' ' || k === 'enter') bowl();
      else return;
      e.preventDefault();
    }
  };
  useEffect(() => {
    const h = (e) => {
      sfx.unlock();
      sfx.setAmbience(true);
      keyHandler.current(e);
    };
    window.addEventListener('keydown', h);
    window.addEventListener('pointerdown', sfx.unlock);
    return () => {
      window.removeEventListener('keydown', h);
      window.removeEventListener('pointerdown', sfx.unlock);
    };
  }, []);

  const leave = () => {
    if (view.phase === 'finished' || window.confirm('Leave the match? You will forfeit.')) {
      socket.emit('match:leave');
    }
  };

  const header = (
    <header className="topbar">
      <div className="brand">🏏 Pitch Duel</div>
      <div className="versus">
        <Avatar user={me} size={28} /> {me.name} <span className="muted">vs</span> {opp.name} <Avatar user={opp} size={28} />
      </div>
      <button className="btn ghost" onClick={leave}>{view.phase === 'finished' ? 'Back to lobby' : 'Forfeit'}</button>
    </header>
  );

  const oppAway = view.disconnected.includes(opp.id) && view.phase !== 'finished';
  const awayBar = oppAway && (
    <div className="notice">{opp.name} lost connection. They forfeit if they are not back within 45 seconds.</div>
  );

  if (view.phase === 'team_select' || view.phase === 'toss') {
    return (
      <div className="page">
        {header}
        {awayBar}
        {view.deadlineIn != null && (
          <div className="timer-line">Time left: <Countdown key={`${view.phase}${view.toss.stage}`} ms={view.deadlineIn} /></div>
        )}
        {view.phase === 'team_select' ? (
          <TeamSelect view={view} me={me} teams={teams} socket={socket} />
        ) : (
          <Toss view={view} me={me} socket={socket} />
        )}
      </div>
    );
  }

  const teamOf = (uid) => teams[view.teams[uid]];

  if (view.phase === 'finished' || !inn) {
    const won = view.result?.winner === me.id;
    return (
      <div className="page">
        {header}
        <div className="card stage">
          <div className="result-emoji">{view.result?.winner ? (won ? '🏆' : '😞') : '🤝'}</div>
          <h2>{view.result?.winner ? (won ? 'You won!' : 'You lost') : 'Match tied'}</h2>
          <p>{view.result?.text}</p>
          <button className="btn primary big" onClick={() => socket.emit('match:leave')}>Back to lobby</button>
          <div className="scorecards">
            {view.innings.map((i, n) => (
              <Scorecard key={n} inn={i} team={teamOf(i.battingUser)} label={n === 0 ? '1st innings' : '2nd innings'} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const batTeam = teamOf(inn.battingUser);
  const bowlTeam = teamOf(inn.bowlingUser);
  const striker = inn.striker != null ? inn.batters[inn.striker] : null;
  const nonStriker = inn.batters[inn.nonStriker];
  const bowler = inn.currentBowler != null ? inn.bowlers[inn.currentBowler] : null;
  const ballsLeft = view.overs * 6 - inn.balls;
  const labels = VARIATION_LABELS[bowler?.kind || 'pace'];
  const canAim = !batting && ballPhase === 'await_delivery';
  const batterView = batting && view.phase === 'innings';

  return (
    <div className="page">
      {header}
      {awayBar}

      <div className="match-grid">
        <div className="pitch-wrap">
          <Arena3D
            animRef={anim}
            camMode={batting ? 'bat' : 'bowl'}
            canAim={canAim}
            aim={aim}
            onAim={setAim}
            bowlerKind={bowler?.kind}
            colors={{
              batColor: batTeam.color, batAccent: batTeam.accent, batShort: batTeam.short,
              bowlColor: bowlTeam.color, bowlAccent: bowlTeam.accent, bowlShort: bowlTeam.short,
            }}
          />

          <div className="hud-top">
            <span className="live-tag">● LIVE</span>
            <span>{batting ? 'BATTING' : 'BOWLING'}</span>
            <button
              className="mute"
              onClick={() => {
                sfx.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          </div>

          {banner && <div key={`${inn.balls}-${inn.extras}`} className={`banner ${banner.tone}`}><span>{banner.text}</span></div>}
          {view.phase === 'innings_break' && (
            <div className="banner neutral">
              <span>INNINGS BREAK</span>
              <small>{teamOf(inn.bowlingUser).name} need {view.target} to win</small>
            </div>
          )}
          {inFlight && anim.current.delivery && (
            <div className="speed"><b>{anim.current.delivery.speedKph}</b> km/h</div>
          )}
          {!inFlight && <TimingMeter result={lastResult} />}
          {caption && !inFlight && <div className="caption">🎙 {caption}</div>}

          <div className="score-bug">
            <div className="bug-team" style={{ background: batTeam.color }}>{batTeam.short}</div>
            <div className="bug-score">{inn.runs}<span>/{inn.wickets}</span></div>
            <div className="bug-overs"><b>{oversText(inn.balls)}</b> / {view.overs} OV</div>
            <div className="bug-info">
              {view.target
                ? <>NEED <b>{Math.max(0, view.target - inn.runs)}</b> OFF <b>{ballsLeft}</b></>
                : <>v {bowlTeam.short} · 1ST INNINGS</>}
            </div>
            <div className="this-over">
              {inn.thisOver.map((b, i) => (
                <span key={i} className={`ball-chip ${b === 'W' ? 'w' : b === '4' || b === '6' ? 'b' : ''}`}>{b}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="card compact">
            <div className="crease-row">
              <span>🏏 <b>{striker ? striker.name : '—'}</b>*</span>
              <span>{striker ? `${striker.runs} (${striker.balls})` : ''}</span>
            </div>
            <div className="crease-row muted">
              <span>{nonStriker.name}</span>
              <span>{nonStriker.runs} ({nonStriker.balls})</span>
            </div>
            <div className="crease-row">
              <span>⚾ <b>{bowler ? bowler.name : 'Choosing bowler…'}</b></span>
              <span>{bowler ? `${oversText(bowler.balls)}-${bowler.runs}-${bowler.wickets}` : ''}</span>
            </div>
          </div>

          <div className="card compact controls">
            {/* The batter's panel never changes layout: the shot buttons must not move mid-ball. */}
            {view.deadlineIn != null && !batterView && (
              <div className="timer-line">
                <Countdown key={`${view.current}-${inn.balls}-${inn.extras}-${ballPhase}-${view.phase}`} ms={view.deadlineIn} />
              </div>
            )}

            {view.phase === 'innings_break' && <p>Second innings starts in a moment…</p>}

            {ballPhase === 'select_bowler' &&
              (batting ? null : (
                <>
                  <h3>Choose your bowler</h3>
                  <ul className="bowler-list">
                    {inn.bowlers.map((b, i) =>
                      b.kind ? (
                        <li key={b.name}>
                          <button
                            className="btn"
                            disabled={!view.eligibleBowlers.includes(i)}
                            onClick={() => socket.emit('match:selectBowler', { idx: i })}
                          >
                            <span>{b.name}</span>
                            <span className="muted small">
                              {b.kind} · {bowlTeam.players[i].bowl} · {oversText(b.balls)}-{b.runs}-{b.wickets}
                            </span>
                          </button>
                        </li>
                      ) : null
                    )}
                  </ul>
                  <p className="muted small">
                    Max {view.maxOversPerBowler} over{view.maxOversPerBowler > 1 ? 's' : ''} each, no back-to-back overs.
                  </p>
                </>
              ))}

            {ballPhase === 'await_delivery' &&
              (batting ? null : (
                <>
                  <h3>Bowl your delivery</h3>
                  <div className="btn-grid">
                    {VARIATIONS.map((v, i) => (
                      <button key={v} className={`btn ${variation === v ? 'selected' : ''}`} onClick={() => setVariation(v)}>
                        <kbd>{i + 1}</kbd> {labels[v]}
                      </button>
                    ))}
                  </div>
                  <p className="muted small">Click the coloured zone on the pitch to place the red marker.</p>
                  <p className="aim-readout">{describeAim(aim)}</p>
                  <button className="btn primary big" onClick={bowl}>Bowl <kbd>Space</kbd></button>
                </>
              ))}

            {(ballPhase === 'in_flight' || ballPhase === 'result') && !batting && (
              <p>{ballPhase === 'in_flight' ? 'Ball is on its way…' : feedback}</p>
            )}

            {batterView && (
              <>
                <h3>Your shots</h3>
                <div className="shot-grid">
                  <button className="btn" onPointerDown={() => playShot('leg', 'stroke')}><kbd>←</kbd> Leg</button>
                  <button className="btn" onPointerDown={() => playShot('straight', 'stroke')}><kbd>↑</kbd> Straight</button>
                  <button className="btn" onPointerDown={() => playShot('off', 'stroke')}><kbd>→</kbd> Off</button>
                  <button className="btn loft" onPointerDown={() => playShot('leg', 'loft')}>Loft leg</button>
                  <button className="btn loft" onPointerDown={() => playShot('straight', 'loft')}>Loft straight</button>
                  <button className="btn loft" onPointerDown={() => playShot('off', 'loft')}>Loft off</button>
                  <button className="btn defend" onPointerDown={() => playShot('straight', 'defend')}><kbd>↓</kbd> Defend</button>
                </div>
                <div className="bat-status">
                  {ballPhase === 'select_bowler' && <span>{opp.name} is choosing a bowler… {view.deadlineIn != null && <Countdown key={`${view.current}-${inn.balls}-${inn.extras}-${ballPhase}-${view.phase}`} ms={view.deadlineIn} />}</span>}
                  {ballPhase === 'await_delivery' && <span>{opp.name} is setting up the delivery. Get ready… {view.deadlineIn != null && <Countdown key={`${view.current}-${inn.balls}-${inn.extras}-${ballPhase}-${view.phase}`} ms={view.deadlineIn} />}</span>}
                  {ballPhase === 'in_flight' && <span>Ball is on its way. Swing as it reaches the bat!</span>}
                  {ballPhase === 'result' && <span className="feedback">{feedback}</span>}
                </div>
                <p className="muted small">
                  Swing as the ball reaches the bat. Hold <kbd>Shift</kbd> with an arrow key to loft: bigger reward, bigger risk.
                </p>
              </>
            )}
          </div>

          <div className="card compact commentary">
            {view.commentary.map((c, i) => (
              <div key={i} className={i === 0 ? '' : 'muted'}>{c}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
