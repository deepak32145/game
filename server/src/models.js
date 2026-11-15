import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    // How the account logs in: "email:<address>", a Google account id, or "dev:<name>" for local guests.
    googleId: { type: String, required: true, unique: true },
    email: String,
    name: { type: String, required: true },
    picture: String,

    // Wallet. Whole numbers only. Chips sitting on a table are moved out of `balance` into `tables`
    // (table id -> amount), so the two together are always everything the player owns. If the
    // server stops unexpectedly, whatever is in `tables` is put back into `balance` on restart.
    balance: { type: Number, default: 0, min: 0 },
    tables: { type: Map, of: Number, default: {} },

    banned: { type: Boolean, default: false },
    banReason: String,
  },
  { timestamps: true }
);

// Every change to a wallet, so balances can always be explained.
const txnSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // admin_credit | admin_debit | cash_buyin | cash_cashout | sng_buyin | sng_refund | sng_prize | recovered
  type: { type: String, required: true },
  amount: { type: Number, required: true }, // positive = into the wallet, negative = out of it
  balanceAfter: Number,
  ref: String, // table or tournament it relates to
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // the admin, for admin changes
  note: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

// A pending email login code. Only a keyed hash of the code is stored, never the code itself,
// and MongoDB deletes the record by itself once it has expired.
const loginCodeSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  hash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now },
  sendCount: { type: Number, default: 1 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export const User = mongoose.model('User', userSchema);
export const Txn = mongoose.model('Txn', txnSchema);
export const LoginCode = mongoose.model('LoginCode', loginCodeSchema);
