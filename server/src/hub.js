// A shared handle to the running poker manager, filled in when the sockets start.
// The admin routes use it to push wallet changes to players and to remove banned ones.
export const hub = { manager: null };
