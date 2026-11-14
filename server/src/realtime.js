import crypto from 'crypto';
import { userFromToken, publicUser } from './auth.js';
import { User, Match } from './models.js';
import { MatchRoom } from './game/matchRoom.js';
import { PokerRoom } from './poker/pokerRoom.js';

const CHALLENGE_MS = 30000;
const RECONNECT_MS = 45000;
const OVERS_OPTIONS = [2, 5, 10];
const GAMES = ['cricket', 'poker'];

export function setupRealtime(io) {
  const online = new Map(); // uid -> { user, sockets:Set<string> }
  const userMatch = new Map(); // uid -> MatchRoom
  const challenges = new Map(); // id -> { id, from, to, overs, timer }
  const reconnectTimers = new Map(); // uid -> timeout

  const emitTo = (uid, event, payload) => io.to(`user:${uid}`).emit(event, payload);

  const lobbyList = () =>
    [...online.values()].map(({ user }) => ({
      ...user,
      status: userMatch.has(user.id) ? 'in_match' : 'available',
    }));

  const broadcastLobby = () => io.emit('lobby:users', lobbyList());

  const isAvailable = (uid) => online.has(uid) && !userMatch.has(uid);

  function closeChallenge(id, reason) {
    const c = challenges.get(id);
    if (!c) return;
    clearTimeout(c.timer);
    challenges.delete(id);
    emitTo(c.from, 'challenge:closed', { id, reason });
    emitTo(c.to, 'challenge:closed', { id, reason });
  }

  function closeChallengesOf(uid, reason) {
    for (const c of [...challenges.values()]) {
      if (c.from === uid || c.to === uid) closeChallenge(c.id, reason);
    }
  }

  async function onMatchFinished(room) {
    try {
      const winner = room.result.winner;
      const { played, ...record } = room.record();
      await Match.create({ ...record, winner, resultText: room.result.text });
      for (const p of room.players) {
        const field = winner ? (winner === p.id ? 'wins' : 'losses') : played ? 'ties' : null;
        if (!field) continue;
        const updated = await User.findByIdAndUpdate(p.id, { $inc: { [field]: 1 } }, { new: true });
        if (updated && online.has(p.id)) online.get(p.id).user = publicUser(updated);
      }
    } catch (err) {
      console.error('failed to save match', err);
    }
    // Anyone who already dropped off doesn't need to be held in the finished room.
    for (const p of room.players) {
      if (!online.has(p.id)) userMatch.delete(p.id);
    }
    broadcastLobby();
  }

  function startMatch(fromId, toId, overs, game) {
    const players = [fromId, toId].map((uid) => {
      const { id, name, picture } = online.get(uid).user;
      return { id, name, picture };
    });
    const base = { id: crypto.randomUUID(), players, emitTo, onFinish: onMatchFinished };
    const room = game === 'poker' ? new PokerRoom(base) : new MatchRoom({ ...base, overs });
    userMatch.set(fromId, room);
    userMatch.set(toId, room);
    closeChallengesOf(fromId, 'cancelled');
    closeChallengesOf(toId, 'cancelled');
    room.broadcast();
    broadcastLobby();
  }

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      if (!user) throw new Error('no user');
      socket.data.user = publicUser(user);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;
    const uid = me.id;
    socket.join(`user:${uid}`);

    const entry = online.get(uid) || { user: me, sockets: new Set() };
    entry.user = me;
    entry.sockets.add(socket.id);
    online.set(uid, entry);

    clearTimeout(reconnectTimers.get(uid));
    reconnectTimers.delete(uid);

    const room = userMatch.get(uid);
    if (room) room.setConnected(uid, true);
    socket.emit('match:state', room ? room.publicState(uid) : null);
    broadcastLobby();

    // Wrap handlers so one bad payload can't take the process down.
    const on = (event, handler) =>
      socket.on(event, (payload, ack) => {
        try {
          const out = handler(payload || {});
          if (typeof ack === 'function') ack(out ?? { ok: true });
        } catch (err) {
          console.error(`handler ${event} failed`, err);
          if (typeof ack === 'function') ack({ ok: false, error: 'Something went wrong' });
        }
      });

    on('lobby:get', () => ({ ok: true, users: lobbyList() }));

    on('challenge:send', ({ to, overs, game = 'cricket' }) => {
      if (to === uid || !isAvailable(to)) return { ok: false, error: 'That player is not available' };
      if (!isAvailable(uid)) return { ok: false, error: 'You are already in a match' };
      if (!GAMES.includes(game)) return { ok: false, error: 'Unknown game' };
      if (game === 'cricket' && !OVERS_OPTIONS.includes(overs)) return { ok: false, error: 'Invalid overs' };
      if ([...challenges.values()].some((c) => c.from === uid)) {
        return { ok: false, error: 'You already have a pending challenge' };
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => closeChallenge(id, 'expired'), CHALLENGE_MS);
      challenges.set(id, { id, from: uid, to, overs, game, timer });
      const { name, picture } = online.get(uid).user;
      emitTo(to, 'challenge:incoming', { id, overs, game, from: { id: uid, name, picture }, expiresIn: CHALLENGE_MS });
      return { ok: true, id, expiresIn: CHALLENGE_MS };
    });

    on('challenge:cancel', ({ id }) => {
      if (challenges.get(id)?.from === uid) closeChallenge(id, 'cancelled');
    });

    on('challenge:respond', ({ id, accept }) => {
      const c = challenges.get(id);
      if (!c || c.to !== uid) return { ok: false, error: 'Challenge expired' };
      if (!accept) {
        closeChallenge(id, 'declined');
        return { ok: true };
      }
      if (!isAvailable(c.from) || !isAvailable(c.to)) {
        closeChallenge(id, 'cancelled');
        return { ok: false, error: 'Player is no longer available' };
      }
      closeChallenge(id, 'accepted');
      startMatch(c.from, c.to, c.overs, c.game);
      return { ok: true };
    });

    const inMatch = (fn) => (payload) => {
      const r = userMatch.get(uid);
      if (r) fn(r, payload);
    };
    on('match:pickTeam', inMatch((r, p) => r.pickTeam?.(uid, p.teamId)));
    on('match:tossCall', inMatch((r, p) => r.tossCall?.(uid, p.call)));
    on('match:tossChoice', inMatch((r, p) => r.tossChoice?.(uid, p.choice)));
    on('match:selectBowler', inMatch((r, p) => r.selectBowler?.(uid, p.idx)));
    on('match:bowl', inMatch((r, p) => r.bowl?.(uid, p)));
    on('match:shot', inMatch((r, p) => r.shot?.(uid, p)));
    on('poker:action', inMatch((r, p) => r.game === 'poker' && r.act(uid, p)));
    on('match:leave', inMatch((r) => {
      r.forfeit(uid); // no-op when the match is already finished
      userMatch.delete(uid);
      emitTo(uid, 'match:state', null);
      broadcastLobby();
    }));

    socket.on('disconnect', () => {
      const e = online.get(uid);
      if (!e) return;
      e.sockets.delete(socket.id);
      if (e.sockets.size > 0) return;

      online.delete(uid);
      closeChallengesOf(uid, 'cancelled');
      const r = userMatch.get(uid);
      if (r) {
        if (r.phase === 'finished') {
          userMatch.delete(uid);
        } else {
          r.setConnected(uid, false);
          reconnectTimers.set(
            uid,
            setTimeout(() => {
              reconnectTimers.delete(uid);
              if (online.has(uid)) return;
              r.forfeit(uid);
              userMatch.delete(uid);
              broadcastLobby();
            }, RECONNECT_MS)
          );
        }
      }
      broadcastLobby();
    });
  });
}
