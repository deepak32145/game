import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { User, Txn, LoginCode, Hand, HAND_KEEP_DAYS } from './models.js';
import { sendLoginCode } from './mailer.js';
import mongoose from 'mongoose';
import { selfView } from './poker/manager.js';
import { bestHand, equityMulti } from './poker/handEval.js';

const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const signToken = (user) =>
  jwt.sign({ uid: user._id.toString() }, config.jwtSecret, { expiresIn: '30d' });

export async function userFromToken(token) {
  const { uid } = jwt.verify(token, config.jwtSecret);
  return User.findById(uid);
}

export async function requireUser(req, res, next) {
  let user;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    user = await userFromToken(token);
    if (!user) throw new Error('no user');
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (user.banned) return res.status(403).json({ error: 'banned', reason: user.banReason || '' });
  req.user = user;
  next();
}

const BANNED = { error: 'This account has been suspended. Contact the organiser.' };

export const router = express.Router();

router.get('/config', (_req, res) => {
  res.json({ googleClientId: config.googleClientId, devLogin: config.allowDevLogin, emailLogin: config.emailLogin });
});

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
    if (user.banned) return res.status(403).json(BANNED);
  res.json({ token: signToken(user), user: selfView(user) });
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
  if (user.banned) return res.status(403).json(BANNED);
  res.json({ token: signToken(user), user: selfView(user) });
});

// ---- email login with a one-time code ----------------------------------------

const MAX_ATTEMPTS = 5; // wrong guesses allowed per code
const RESEND_SECONDS = 60; // wait between emails to the same address
const MAX_SENDS = 5; // emails to one address before its current code must expire
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const normaliseEmail = (value) => String(value || '').trim().toLowerCase();
// Keyed hash, so a copy of the database alone is not enough to recover or forge codes.
const hashCode = (email, code) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${email}:${code}`).digest('hex');

// Sending mail costs money and can be abused to spam someone, so it is limited more tightly than other routes.
const codeRequestLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

router.post('/auth/email/request', codeRequestLimit, async (req, res) => {
  if (!config.emailLogin) return res.status(400).json({ error: 'Email login is not available' });
  const email = normaliseEmail(req.body.email);
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });

  const existing = await LoginCode.findOne({ email });
  if (existing && existing.expiresAt > new Date()) {
    const wait = RESEND_SECONDS - Math.floor((Date.now() - existing.sentAt.getTime()) / 1000);
    if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} seconds before asking for another code`, retryIn: wait });
    if (existing.sendCount >= MAX_SENDS) return res.status(429).json({ error: 'Too many codes requested. Try again in a few minutes.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const stillValid = existing && existing.expiresAt > new Date();
  await LoginCode.findOneAndUpdate(
    { email },
    {
      hash: hashCode(email, code),
      attempts: 0,
      sentAt: new Date(),
      sendCount: stillValid ? existing.sendCount + 1 : 1,
      expiresAt: new Date(Date.now() + config.otpMinutes * 60 * 1000),
    },
    { upsert: true }
  );
  try {
    await sendLoginCode(email, code);
  } catch (err) {
    console.error('could not send login code:', err.message);
    await LoginCode.deleteOne({ email });
    return res.status(502).json({ error: 'Could not send the email. Please try again in a moment.' });
  }
  res.json({ ok: true, retryIn: RESEND_SECONDS, expiresInMinutes: config.otpMinutes });
});

router.post('/auth/email/verify', async (req, res) => {
  if (!config.emailLogin) return res.status(400).json({ error: 'Email login is not available' });
  const email = normaliseEmail(req.body.email);
  const code = String(req.body.code || '').replace(/\D/g, '');
  const wrong = () => res.status(401).json({ error: 'That code is not right or has expired' });
  if (!EMAIL_RE.test(email) || code.length !== 6) return wrong();

  // Count the attempt first, so guesses made at the same moment cannot dodge the limit.
  const record = await LoginCode.findOneAndUpdate(
    { email, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!record) return wrong();
  const given = Buffer.from(hashCode(email, code));
  const stored = Buffer.from(record.hash);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    if (record.attempts >= MAX_ATTEMPTS) return res.status(401).json({ error: 'Too many wrong tries. Ask for a new code.' });
    return wrong();
  }
  await LoginCode.deleteOne({ email }); // a code works once

  const id = `email:${email}`;
  let user = await User.findOne({ googleId: id });
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const nameOk = /^[\w .-]{2,20}$/.test(name);
  if (!user) {
    // First login: use the name they chose, or a neutral one (never part of their email address).
    user = await User.create({ googleId: id, email, name: nameOk ? name : `Player ${crypto.randomInt(1000, 10000)}` });
  } else if (nameOk && name !== user.name) {
    user.name = name;
    await user.save();
  }
  if (user.banned) return res.status(403).json(BANNED);
  res.json({ token: signToken(user), user: selfView(user) });
});

router.get('/me', requireUser, (req, res) => res.json(selfView(req.user)));

// A player's own recent wallet history.
// ---- hand history: only hands the player was dealt into, and only cards they are allowed to see ----
const handView = (h, uid) => ({
  id: h._id.toString(),
  at: h.at,
  tableId: h.tableId,
  tableName: h.tableName,
  kind: h.kind,
  handNo: h.handNo,
  blinds: h.blinds,
  button: h.button,
  maxSeats: h.maxSeats || 6,
  sbSeat: h.sbSeat ?? null,
  bbSeat: h.bbSeat ?? null,
  board: h.board,
  pot: h.pot,
  showdown: h.showdown,
  log: h.log,
  actions: h.actions || [],
  rabbit: h.rabbit || [],
  rabbitBy: h.rabbitBy || '',
  players: h.players.map((p) => ({
    uid: p.uid,
    name: p.name,
    picture: p.picture || '',
    seat: p.seat,
    cards: (p.uid === uid ? p.cards : p.revealed).map((c) => c || null),
    start: p.start,
    won: p.won,
    net: p.net,
    folded: p.folded,
    hand: p.hand,
  })),
});

// Extras for replaying one hand, worked out from what this viewer is allowed to see.
// Odds are only given for a street when every player still in the hand at that point has
// cards this viewer can see (their own, or ones turned over at the table), so a figure
// never hints at a hidden hand.
const STREET_BOARD = { preflop: 0, flop: 3, turn: 4, river: 5 };
function handExtras(view) {
  const known = Object.fromEntries(view.players.filter((p) => p.cards.length === 2 && p.cards.every(Boolean)).map((p) => [p.seat, p.cards]));
  // The street on which each player folded, if they did.
  const order = ['preflop', 'flop', 'turn', 'river', 'result'];
  const foldedAt = {};
  for (const a of view.actions) if (a.t === 'fold' && foldedAt[a.seat] == null) foldedAt[a.seat] = order.indexOf(a.st);
  const odds = {};
  for (const street of ['preflop', 'flop', 'turn']) {
    const count = STREET_BOARD[street];
    if (view.board.length < count) break;
    const si = order.indexOf(street);
    // Still in when this street's cards are out: did not fold on an earlier street.
    const live = view.players.filter((p) => foldedAt[p.seat] == null || foldedAt[p.seat] >= si);
    if (live.length < 2 || live.some((p) => !known[p.seat])) continue;
    const pct = equityMulti(live.map((p) => known[p.seat]), view.board.slice(0, count));
    odds[count] = Object.fromEntries(live.map((p, i) => [p.seat, pct[i]]));
  }
  // Each shown hand's best five cards, for lighting up the winning combination.
  const best = {};
  if (view.board.length === 5) {
    for (const p of view.players) if (known[p.seat] && !p.folded) best[p.seat] = bestHand([...known[p.seat], ...view.board]).cards;
  }
  return { odds, best };
}

router.get('/hand/:id', requireUser, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Hand not found' });
  const uid = req.user._id.toString();
  const h = await Hand.findOne({ _id: req.params.id, uids: uid }).lean();
  if (!h) return res.status(404).json({ error: 'Hand not found' });
  const view = handView(h, uid);
  res.json({ hand: view, ...handExtras(view) });
});

router.get('/hands', requireUser, async (req, res) => {
  const uid = req.user._id.toString();
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const limit = Math.min(50, num(req.query.limit) || 20);
  const from = num(req.query.from);
  const to = [num(req.query.to), num(req.query.before)].filter(Boolean).sort((a, b) => a - b)[0];
  const find = { uids: uid };
  if (typeof req.query.table === 'string' && req.query.table) find.tableName = req.query.table.slice(0, 80);
  if (typeof req.query.tableId === 'string' && req.query.tableId) find.tableId = req.query.tableId.slice(0, 80);
  if (from || to) find.at = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lt: new Date(to) } : {}) };
  const hands = await Hand.find(find).sort({ at: -1 }).limit(limit + 1).lean();
  res.json({ hands: hands.slice(0, limit).map((h) => handView(h, uid)), more: hands.length > limit });
});

// The player's games: each unbroken sitting at one table (a whole tournament, or a cash session
// with no gap longer than GAME_GAP_MS between hands), with who they played against.
const GAME_GAP_MS = 20 * 60 * 1000;
router.get('/hands/games', requireUser, async (req, res) => {
  const uid = req.user._id.toString();
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const from = num(req.query.from);
  const to = num(req.query.to);
  const find = { uids: uid };
  if (typeof req.query.table === 'string' && req.query.table) find.tableName = req.query.table.slice(0, 80);
  if (from || to) find.at = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lt: new Date(to) } : {}) };
  const rows = await Hand.find(find, { tableId: 1, tableName: 1, kind: 1, blinds: 1, at: 1, 'players.uid': 1, 'players.name': 1, 'players.picture': 1, 'players.net': 1 })
    .sort({ at: -1 })
    .limit(5000)
    .lean();
  const open = new Map(); // table id -> the game being built for it (rows run newest first)
  const games = [];
  for (const h of rows) {
    const mine = h.players.find((p) => p.uid === uid);
    if (!mine) continue;
    const key = h.tableId || h.tableName;
    let g = open.get(key);
    if (!g || (h.kind !== 'sng' && g.start - h.at > GAME_GAP_MS)) {
      g = { tableId: h.tableId, tableName: h.tableName, kind: h.kind, blinds: h.blinds, start: h.at, end: h.at, hands: 0, won: 0, net: 0, opp: new Map() };
      open.set(key, g);
      games.push(g);
    }
    g.start = h.at;
    g.hands += 1;
    g.net += mine.net;
    if (mine.net > 0) g.won += 1;
    for (const p of h.players) {
      if (p.uid === uid) continue;
      const o = g.opp.get(p.uid) || { name: p.name, picture: p.picture || '', hands: 0 };
      o.hands += 1;
      g.opp.set(p.uid, o);
    }
  }
  res.json({
    games: games.map((g) => ({
      id: `${g.tableId || g.tableName}@${new Date(g.start).getTime()}`,
      tableId: g.tableId,
      tableName: g.tableName,
      kind: g.kind,
      blinds: g.blinds,
      start: g.start,
      end: g.end,
      hands: g.hands,
      won: g.won,
      net: g.net,
      opponents: [...g.opp.values()].sort((a, b) => b.hands - a.hands).slice(0, 8),
    })),
    capped: rows.length === 5000,
  });
});

// The tables the player has hands at, for the filter.
router.get('/hands/tables', requireUser, async (req, res) => {
  const rows = await Hand.aggregate([
    { $match: { uids: req.user._id.toString() } },
    { $group: { _id: '$tableName', hands: { $sum: 1 }, last: { $max: '$at' } } },
    { $sort: { last: -1 } },
    { $limit: 60 },
  ]);
  res.json({ tables: rows.map((r) => ({ name: r._id, hands: r.hands })), keepDays: HAND_KEEP_DAYS });
});

router.get('/wallet/txns', requireUser, async (req, res) => {
  const txns = await Txn.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30);
  res.json(txns.map((t) => ({ type: t.type, amount: t.amount, balanceAfter: t.balanceAfter, ref: t.ref || '', note: t.note || '', at: t.createdAt })));
});
