import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { User, Txn, LoginCode } from './models.js';
import { sendLoginCode } from './mailer.js';
import { selfView } from './poker/manager.js';

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
router.get('/wallet/txns', requireUser, async (req, res) => {
  const txns = await Txn.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30);
  res.json(txns.map((t) => ({ type: t.type, amount: t.amount, balanceAfter: t.balanceAfter, ref: t.ref || '', note: t.note || '', at: t.createdAt })));
});
