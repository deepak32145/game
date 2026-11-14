import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { config } from './config.js';
import { router } from './auth.js';
import { setupRealtime } from './realtime.js';

const app = express();
app.set('trust proxy', 1); // behind nginx in production, so client IPs come from X-Forwarded-For
app.use(cors());
app.use(express.json({ limit: '10kb' }));
// Stop one address from mass-creating guest accounts.
app.use('/api/auth', rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.get('/api/version', (_req, res) => res.json({ buildId: readBuildId() }));
app.use('/api', router);

// Serve the built client when it exists, so one process can host everything.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// The built page names its script after its contents, so that name identifies the release.
// Open pages compare it with their own and reload when a newer release has been deployed.
// It is read from disk on every request, so it always matches the page actually being served.
const indexFile = path.join(clientDist, 'index.html');
const readBuildId = () => {
  try {
    return (fs.readFileSync(indexFile, 'utf8').match(/assets\/index-[\w-]+\.js/) || ['unknown'])[0];
  } catch {
    return 'dev';
  }
};
if (fs.existsSync(clientDist)) {
  // The page itself must never be served stale, or phones keep running an old release.
  const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');
  app.use(express.static(clientDist, { setHeaders: (res, file) => file.endsWith('.html') && noCache(res) }));
  app.get('*', (_req, res) => {
    noCache(res);
    res.sendFile(indexFile);
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
setupRealtime(io);

await mongoose.connect(config.mongoUri);
server.listen(config.port, () => {
  console.log(`Pitch Duel server on http://localhost:${config.port}`);
  if (!config.googleClientId) console.log('GOOGLE_CLIENT_ID not set: Google login is hidden.');
  if (config.allowDevLogin) console.log('Guest login is enabled (ALLOW_DEV_LOGIN).');
});
