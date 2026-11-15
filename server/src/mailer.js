import nodemailer from 'nodemailer';
import { config } from './config.js';

// Sends the login code by email using the SMTP account in the server's .env file.
// When no SMTP account is set (your own computer), the code is printed in the server log instead,
// so the login flow can be tried without sending real mail. A live server always needs SMTP.

let transport = null;

function getTransport() {
  if (transport) return transport;
  const { service, host, port, secure, user, pass } = config.smtp;
  transport = nodemailer.createTransport({
    ...(service ? { service } : { host, port, secure }),
    ...(user ? { auth: { user, pass } } : {}),
  });
  return transport;
}

export async function sendLoginCode(email, code) {
  if (!config.mailConfigured) {
    if (config.isProduction) throw new Error('Email is not configured on the server');
    console.log(`[login code] ${email}: ${code}  (no SMTP configured, so it is shown here instead of being emailed)`);
    return;
  }
  await getTransport().sendMail({
    from: config.mailFrom,
    to: email,
    subject: `${code} is your Pitch Duel login code`,
    text: `Your Pitch Duel login code is ${code}.\n\nIt expires in ${config.otpMinutes} minutes. If you did not ask for it, you can ignore this email.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:auto;padding:24px;background:#0c1424;color:#eef2f8;border-radius:12px">
        <h2 style="margin:0 0 8px">Pitch Duel</h2>
        <p style="margin:0 0 16px;color:#94a3bd">Use this code to log in:</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#162238;border-radius:10px;padding:14px;text-align:center">${code}</div>
        <p style="margin:16px 0 0;color:#94a3bd;font-size:13px">It expires in ${config.otpMinutes} minutes. If you did not ask for it, you can ignore this email.</p>
      </div>`,
  });
}
