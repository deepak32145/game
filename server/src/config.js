import 'dotenv/config';

const env = process.env;

// This repository is public, so the fallback signing secret below is known to everyone.
// It is only for running on your own computer: a live server must set its own JWT_SECRET,
// otherwise anyone could forge a login token for any player.
if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

export const config = {
  port: Number(env.PORT) || 4000,
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/pitch_duel',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  allowDevLogin: env.ALLOW_DEV_LOGIN
    ? env.ALLOW_DEV_LOGIN === 'true'
    : env.NODE_ENV !== 'production',
};
