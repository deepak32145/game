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
    on('table:unwatch', () => {
      manager.unwatch(socket);
      socket.emit('table:state', null);
    });

    on('cash:sit', (p) => manager.cashSit(uid, p));
    on('cash:leave', () => manager.standUp(uid));
    on('cash:topup', (p) => manager.cashTopUp(uid, p));
    on('cash:sitout', ({ on: value }) => manager.sitOut(uid, value));

    on('sng:register', (p) => manager.sngRegister(uid, p));
    on('sng:unregister', () => manager.sngUnregister(uid));

    on('poker:action', (p) => manager.act(uid, p));
    on('poker:show', ({ which }) => manager.show(uid, which));

    socket.on('disconnect', () => manager.disconnected(socket));
  });

  return manager;
}
