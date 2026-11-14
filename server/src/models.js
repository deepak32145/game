import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true },
    email: String,
    name: { type: String, required: true },
    picture: String,
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    ties: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const matchSchema = new mongoose.Schema({
  players: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      team: String,
      runs: Number,
      wickets: Number,
      balls: Number,
    },
  ],
  game: { type: String, default: 'cricket' }, // 'cricket' | 'poker'
  overs: Number,
  winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resultText: String,
  finishedAt: { type: Date, default: Date.now },
});
matchSchema.index({ 'players.user': 1, finishedAt: -1 });

export const User = mongoose.model('User', userSchema);
export const Match = mongoose.model('Match', matchSchema);
