import 'dotenv/config';

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

// This repository is public, so the fallback signing secret below is known to everyone.
// It is only for running on your own computer: a live server must set its own JWT_SECRET,
// otherwise anyone could forge a login token for any player.
if (isProduction && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

// SMTP account used to email login codes. Either name a well-known service (SMTP_SERVICE=gmail)
// or give the host and port of any SMTP provider.
const smtpPort = Number(env.SMTP_PORT) || 587;
const smtp = {
  service: env.SMTP_SERVICE || (!env.SMTP_HOST && /@gmail\.com$/i.test(env.SMTP_USER || '') ? 'gmail' : ''),
  host: env.SMTP_HOST || '',
  port: smtpPort,
  secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : smtpPort === 465,
  user: env.SMTP_USER || '',
  pass: env.SMTP_PASS || '',
};
const mailConfigured = !!(smtp.service || smtp.host);

export const config = {
  isProduction,
  port: Number(env.PORT) || 4000,
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/pitch_duel',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  // Guest accounts have no proof of who they are, so with wallets they are off unless switched on for testing.
  allowDevLogin: env.ALLOW_DEV_LOGIN === 'true',
  smtp,
  mailConfigured,
  mailFrom: env.MAIL_FROM || (smtp.user ? `Pitch Duel <${smtp.user}>` : 'Pitch Duel <no-reply@localhost>'),
  // Email login works whenever mail can be sent; on your own computer it also works without SMTP
  // (the code is printed in the server log).
  emailLogin: mailConfigured || !isProduction,
  otpMinutes: 10,
};
