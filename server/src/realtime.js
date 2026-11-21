import { userFromToken } from './auth.js';
import { createManager } from './poker/manager.js';
import { hub } from './hub.js';

// Socket wiring: who is connected, and passing each request to the poker manager.
export function setupRealtime(io) {
  const manager = createManager(io);
  hub.manager = manager; // lets the admin routes notify players and remove banned ones

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      if (!user) throw new Error('unauthorized');
      if (user.banned) throw new Error('banned');
      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error(err.message === 'banned' ? 'banned' : 'unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.data.user._id.toString();
    manager.connected(socket, socket.data.user);

    // Wrap handlers so one bad request can't take the server down, and always answer the caller.
    const on = (event, handler) =>
      socket.on(event, async (payload, ack) => {
        try {
          const out = await handler(payload || {});
          if (typeof ack === 'function') ack(out ?? { ok: true });
        } catch (err) {
          console.error(`handler ${event} failed`, err);
          if (typeof ack === 'function') ack({ ok: false, error: 'Something went wrong' });
        }
      });

    on('lobby:get', () => ({ ok: true, lobby: manager.lobbyState() }));
    on('table:watch', ({ tableId }) => manager.watch(socket, tableId));
    on('table:unwatch', ({ tableId }) => manager.closeView(socket, tableId));

    on('cash:sit', (p) => manager.cashSit(uid, p));
    on('cash:leave', ({ tableId }) => manager.standUp(uid, tableId));
    on('cash:topup', (p) => manager.cashTopUp(uid, p));
    on('cash:sitout', (p) => manager.sitOut(uid, p));

    on('sng:register', (p) => manager.sngRegister(uid, p));
    on('sng:unregister', (p) => manager.sngUnregister(uid, p));

    on('poker:action', (p) => manager.act(uid, p));
    on('poker:show', (p) => manager.show(uid, p));
    on('poker:rabbit', (p) => manager.rabbit(uid, p));

    on('chat:send', (p) => manager.chatSend(uid, p));
    on('chat:history', (p) => manager.chatHistory(socket, p));
    on('table:throw', (p) => manager.throwAt(uid, p));
    on('table:react', (p) => manager.react(socket, p));

    socket.on('disconnect', () => manager.disconnected(socket));
  });

  return manager;
}
