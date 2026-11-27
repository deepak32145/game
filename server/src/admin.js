import express from 'express';
import mongoose from 'mongoose';
import { User, Txn, BotDecision } from './models.js';
import { requireUser } from './auth.js';
import { isAdmin } from './poker/manager.js';
import * as wallet from './wallet.js';
import { hub } from './hub.js';

// Admin-only tools: see players, change wallet balances, ban and unban.
export const adminRouter = express.Router();

adminRouter.use(requireUser, (req, res, next) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  next();
});

const row = (u) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email || '',
  balance: u.balance,
  inPlay: wallet.inPlay(u),
  banned: !!u.banned,
  banReason: u.banReason || '',
  isAdmin: isAdmin(u),
  joined: u.createdAt,
});

const validId = (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Unknown player' });
  next();
};

adminRouter.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // search text is matched literally
  const filter = q ? { $or: [{ name: new RegExp(safe, 'i') }, { email: new RegExp(safe, 'i') }] } : {};
  const users = await User.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json(users.map(row));
});

adminRouter.get('/summary', async (_req, res) => {
  const [totals] = await User.aggregate([{ $group: { _id: null, wallets: { $sum: '$balance' }, players: { $sum: 1 }, banned: { $sum: { $cond: ['$banned', 1, 0] } } } }]);
  res.json({ players: totals?.players || 0, banned: totals?.banned || 0, wallets: totals?.wallets || 0, ...(hub.manager?.summary() || {}) });
});

// Add to (positive amount) or take from (negative amount) a player's wallet.
adminRouter.post('/users/:id/adjust', validId, async (req, res) => {
  const amount = Math.trunc(Number(req.body.amount));
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Enter an amount other than zero' });
  if (Math.abs(amount) > 10000000) return res.status(400).json({ error: 'That amount is too large' });
  const user = amount > 0
    ? await wallet.adminCredit(req.params.id, amount, req.user._id, note)
    : await wallet.adminDebit(req.params.id, -amount, req.user._id, note);
  if (!user) {
    const exists = await User.exists({ _id: req.params.id });
    return res.status(400).json({ error: exists ? 'The wallet does not hold that much (chips on a table cannot be deducted)' : 'Unknown player' });
  }
  hub.manager?.emitMe(user._id.toString());
  res.json(row(user));
});

adminRouter.post('/users/:id/ban', validId, async (req, res) => {
  const banned = !!req.body.banned;
  if (banned && req.params.id === req.user._id.toString()) return res.status(400).json({ error: 'You cannot ban yourself' });
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { banned, banReason: banned ? String(req.body.reason || '').trim().slice(0, 200) : '' },
    { new: true }
  );
  if (!user) return res.status(400).json({ error: 'Unknown player' });
  // A banned player is taken off any table (their chips go back to their wallet) and disconnected.
  if (banned) await hub.manager?.kick(user._id.toString());
  res.json(row(await User.findById(user._id)));
});

adminRouter.get('/users/:id/txns', validId, async (req, res) => {
  const txns = await Txn.find({ user: req.params.id }).sort({ createdAt: -1 }).limit(100).populate('by', 'name');
  res.json(txns.map((t) => ({ type: t.type, amount: t.amount, balanceAfter: t.balanceAfter, ref: t.ref || '', note: t.note || '', by: t.by?.name || '', at: t.createdAt })));
});

// ---- the AI bot: status, playbook and daily budget, and its recent decisions ----
// The API key itself is never sent anywhere; the page only learns whether one is configured.
adminRouter.get('/bot', (_req, res) => {
  if (!hub.manager) return res.status(503).json({ error: 'The game server is starting' });
  res.json(hub.manager.bots.status());
});

adminRouter.post('/bot', async (req, res) => {
  if (!hub.manager) return res.status(503).json({ error: 'The game server is starting' });
  const { playbook, dailyBudgetUsd, mode, style, model, talk } = req.body || {};
  res.json(await hub.manager.bots.saveSettings({ playbook, dailyBudgetUsd, mode, style, model, talk }));
});

// What the bot has learned about each player, across all its games, and forgetting a player.
adminRouter.get('/bot/players', (_req, res) => {
  if (!hub.manager) return res.status(503).json({ error: 'The game server is starting' });
  res.json(hub.manager.bots.playerNotes());
});
adminRouter.post('/bot/players/forget', async (req, res) => {
  if (!hub.manager) return res.status(503).json({ error: 'The game server is starting' });
  const uid = String(req.body?.uid || '');
  if (!uid) return res.status(400).json({ error: 'Which player?' });
  res.json(await hub.manager.bots.forgetPlayer(uid));
});

adminRouter.get('/bot/decisions', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 60));
  const rows = await BotDecision.find().sort({ at: -1 }).limit(limit).lean();
  res.json(rows.map(({ _id, __v, uid, ...d }) => ({ id: _id.toString(), ...d })));
});
