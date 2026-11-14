import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT) || 4000,
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/pitch_duel',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  allowDevLogin: env.ALLOW_DEV_LOGIN
    ? env.ALLOW_DEV_LOGIN === 'true'
    : env.NODE_ENV !== 'production',
};
