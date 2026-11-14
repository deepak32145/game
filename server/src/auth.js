import express from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { User, Match } from './models.js';
import { TEAMS } from './game/teams.js';

const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

export const publicUser = (u) => ({
  id: u._id.toString(),
  name: u.name,
  picture: u.picture || '',
  wins: u.wins,
  losses: u.losses,
  ties: u.ties,
});

const signToken = (user) =>
  jwt.sign({ uid: user._id.toString() }, config.jwtSecret, { expiresIn: '7d' });

export async function userFromToken(token) {
  const { uid } = jwt.verify(token, config.jwtSecret);
  return User.findById(uid);
}

async function requireUser(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = await userFromToken(token);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

export const router = express.Router();

router.get('/config', (_req, res) => {
  res.json({ googleClientId: config.googleClientId, devLogin: config.allowDevLogin });
});

router.get('/teams', (_req, res) => res.json(TEAMS));

router.post('/auth/google', async (req, res) => {
  if (!googleClient) return res.status(400).json({ error: 'Google login is not configured' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body.credential,
      audience: config.googleClientId,
    });
    const p = ticket.getPayload();
    const user = await User.findOneAndUpdate(
      { googleId: p.sub },
      { email: p.email, name: p.name || p.email, picture: p.picture },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch {
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

router.post('/auth/dev', async (req, res) => {
  if (!config.allowDevLogin) return res.status(403).json({ error: 'Guest login is disabled' });
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!/^[\w .-]{2,20}$/.test(name)) {
    return res.status(400).json({ error: 'Name must be 2-20 letters, numbers or spaces' });
  }
  const user = await User.findOneAndUpdate(
    { googleId: `dev:${name.toLowerCase()}` },
    { name },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireUser, (req, res) => res.json(publicUser(req.user)));

router.get('/matches/mine', requireUser, async (req, res) => {
  const matches = await Match.find({ 'players.user': req.user._id })
    .sort({ finishedAt: -1 })
    .limit(10)
    .lean();
  res.json(
    matches.map((m) => ({
      id: m._id.toString(),
      game: m.game || 'cricket',
      overs: m.overs,
      resultText: m.resultText,
      finishedAt: m.finishedAt,
      won: m.winner ? m.winner.toString() === req.user._id.toString() : null,
      players: m.players.map((p) => ({
        name: p.name,
        team: p.team,
        runs: p.runs,
        wickets: p.wickets,
        balls: p.balls,
      })),
    }))
  );
});

router.get('/leaderboard', async (_req, res) => {
  const users = await User.find({ $or: [{ wins: { $gt: 0 } }, { losses: { $gt: 0 } }] })
    .sort({ wins: -1, losses: 1 })
    .limit(10);
  res.json(users.map(publicUser));
});
