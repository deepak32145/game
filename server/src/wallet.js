import { User, Txn } from './models.js';

// All movement of money. Every function changes the wallet in ONE database update, with the
// "enough balance" check inside that same update, so two things happening at once can never
// overdraw a wallet or create chips. The ledger entry is written straight afterwards.

async function record(user, type, amount, extra = {}) {
  try {
    await Txn.create({ user: user._id, type, amount, balanceAfter: user.balance, ...extra });
  } catch (err) {
    console.error('could not write ledger entry', type, amount, err.message);
  }
}

// Admin: add to a wallet.
export async function adminCredit(uid, amount, by, note) {
  const user = await User.findByIdAndUpdate(uid, { $inc: { balance: amount } }, { new: true });
  if (user) await record(user, 'admin_credit', amount, { by, note });
  return user;
}

// Admin: take from a wallet. Fails (returns null) if the wallet does not hold that much.
export async function adminDebit(uid, amount, by, note) {
  const user = await User.findOneAndUpdate({ _id: uid, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
  if (user) await record(user, 'admin_debit', -amount, { by, note });
  return user;
}

// Move chips from the wallet onto a table (a cash buy-in or top-up, or a tournament entry).
export async function toTable(uid, tableId, amount, type) {
  const user = await User.findOneAndUpdate(
    { _id: uid, balance: { $gte: amount }, banned: { $ne: true } },
    { $inc: { balance: -amount, [`tables.${tableId}`]: amount } },
    { new: true }
  );
  if (user) await record(user, type, -amount, { ref: tableId });
  return user;
}

// Remember how many chips a seated player has, so a crash loses at most the hand in progress.
export async function saveTableStack(uid, tableId, stack) {
  await User.updateOne({ _id: uid, [`tables.${tableId}`]: { $exists: true } }, { $set: { [`tables.${tableId}`]: stack } });
}

// Leave a table: whatever they have there goes back to the wallet.
export async function fromTable(uid, tableId, amount, type) {
  const user = await User.findOneAndUpdate(
    { _id: uid, [`tables.${tableId}`]: { $exists: true } },
    { $inc: { balance: amount }, $unset: { [`tables.${tableId}`]: 1 } },
    { new: true }
  );
  if (user && amount > 0) await record(user, type, amount, { ref: tableId });
  return user;
}

// After the server restarts no table is running, so any chips still recorded on a table belong
// back in the wallet: seated cash stacks as last saved, and tournament entries refunded in full.
export async function recoverStrandedChips() {
  const users = await User.find({ tables: { $exists: true, $ne: {} } });
  let total = 0;
  for (const u of users) {
    const entries = [...(u.tables || new Map()).entries()];
    if (!entries.length) continue;
    const sum = entries.reduce((s, [, v]) => s + (v || 0), 0);
    const unset = Object.fromEntries(entries.map(([k]) => [`tables.${k}`, 1]));
    // Only applies if those entries are still there, so running this twice cannot pay twice.
    const filter = { _id: u._id, ...Object.fromEntries(entries.map(([k, v]) => [`tables.${k}`, v])) };
    const updated = await User.findOneAndUpdate(filter, { $inc: { balance: sum }, $unset: unset }, { new: true });
    if (updated && sum > 0) {
      total += sum;
      await record(updated, 'recovered', sum, { note: 'Returned from tables after a server restart' });
    }
  }
  if (total) console.log(`Returned ${total} chips from tables to ${users.length} wallet(s) after restart.`);
}

export const inPlay = (user) => [...(user.tables || new Map()).values()].reduce((s, v) => s + (v || 0), 0);
