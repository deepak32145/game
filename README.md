# Pitch Duel Poker

A community poker room in the browser: No-Limit Texas Hold'em cash games and Sit & Go tournaments, with a wallet for every player and an admin page for the organiser.

- `client/`: React (Vite)
- `server/`: Node.js, Express, Socket.IO, MongoDB (Mongoose), nodemailer

## What it does

- **Log in by email.** A six-digit code is emailed to the player; the login is then remembered on that device.
- **Wallet.** Every player has a balance. Only an admin can add to it or deduct from it. Every change is recorded.
- **Cash games.** Six tables at blinds 1/2, 2/4 and 5/10, each with six seats. Anyone can take an empty seat with 40 to 200 big blinds from their wallet, add chips, sit out, and stand up at any time (their chips go back to the wallet).
- **Sit & Go.** Buy-ins of 100, 250, 500 and 1,000, as heads-up (winner takes all) or 6-Max (65% / 35%). A tournament starts as soon as it is full; everyone gets 1,500 chips and blinds rise every 5 minutes.
- **Watch live.** Any running table can be opened by anyone. Hole cards stay hidden unless there is a showdown.
- **Admin.** The organiser sees every player, adds or deducts balance with a note, views wallet history, and bans or unbans players.

## Run it locally

MongoDB must be running on `mongodb://127.0.0.1:27017`.

```bash
# terminal 1
cd server
npm install
npm run dev          # http://localhost:4000

# terminal 2
cd client
npm install
npm run dev          # http://localhost:5173
```

Settings live in `server/.env` (copy `server/.env.example` if it is missing). This file is never committed.

| Setting | What it is for |
| --- | --- |
| `MONGO_URI` | The database. |
| `JWT_SECRET` | Signs logins and login codes. Required on a live server. |
| `SMTP_SERVICE` or `SMTP_HOST`/`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | The mail account that sends login codes. For Gmail: `SMTP_SERVICE=gmail` and an app password. |
| `ADMIN_EMAILS` | Comma-separated emails that may use the admin page. |
| `ALLOW_DEV_LOGIN` | `true` shows a "play as a guest" box. For local testing only; guests have no proof of identity. |

With no SMTP settings on your own computer, the login code is printed in the server's terminal instead of being emailed.

## How money is kept safe

- A wallet is changed in a single database step that also checks the balance, so two actions at once cannot overdraw it or create chips.
- Chips taken to a table are moved out of the wallet and recorded against that table. Seated stacks are saved after every hand.
- If the server stops, chips recorded on tables are returned to wallets when it starts again (cash stacks as last saved, tournament entries refunded in full).
- The server alone deals cards and decides every hand. A player is only ever sent their own hole cards.

## Starting fresh

```bash
cd server
node scripts/reset-db.js                    # shows what is in the local database
node scripts/reset-db.js --production       # shows what is in the live database
node scripts/reset-db.js --production --yes # deletes it (cannot be undone)
```

## Deploy to EC2

One EC2 instance runs everything: nginx (HTTPS) in front of the Node server, which serves both the site and the live game. The database is MongoDB Atlas.

Before the first deploy:

1. **DNS:** point an A record for your domain at the instance's public IP.
2. **EC2 security group:** allow inbound 22 (your IP), 80 and 443 (anywhere).
3. **Atlas:** under Network Access, allow the instance's public IP.
4. Put the live settings in `server/.env.production`: `MONGO_URI`, the `SMTP_...` lines and `ADMIN_EMAILS`.

Then, from Git Bash in the project folder:

```bash
./deploy/deploy.sh /path/to/key.pem ubuntu@<instance-ip> play.example.com you@example.com
```

Run the same command again to ship an update. Restarting the server ends the hands in progress; chips on tables are returned to wallets.

On the server: logs with `sudo journalctl -u pitch-duel -f`, restart with `sudo systemctl restart pitch-duel`.

## Where things are

| File | What it does |
| --- | --- |
| `server/src/poker/table.js` | One Hold'em table for 2 to 6 players: positions, betting, side pots, all-ins, showdown. |
| `server/src/poker/manager.js` | Runs the cash tables and Sit & Go tournaments, and moves chips between wallets and tables. |
| `server/src/poker/handEval.js` | Hand ranking, win percentages and the shuffled deck. |
| `server/src/wallet.js` | Every wallet change, and returning stranded chips after a restart. |
| `server/src/auth.js` | Email login codes and sessions. |
| `server/src/admin.js` | Admin-only routes: players, balance changes, bans. |
| `server/src/mailer.js` | Sends the login code by email. |
| `server/scripts/reset-db.js` | Empties the database. |
| `client/src/pages/Lobby.jsx` | Lobby: cash tables, Sit & Go, live games, wallet. |
| `client/src/pages/Table.jsx` | The poker table. |
| `client/src/pages/Admin.jsx` | Admin page. |
| `client/src/audio/sound.js` | Table sounds and lobby music. |
