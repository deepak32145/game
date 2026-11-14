# Pitch Duel

Live one-on-one games in the browser. Sign in, see who is online, and challenge a player to either:

- **Cricket:** pick teams, toss, then one of you bowls while the other bats.
- **Poker:** heads-up No-Limit Texas Hold'em with play chips, 1,000 chips each, blinds starting at 5/10 and rising gradually every 5 minutes, played until one player has them all.

- `client/`: React (Vite), three.js for the 3D match view
- `server/`: Node.js, Express, Socket.IO, MongoDB (Mongoose)

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

Open http://localhost:5173. To play against yourself, open a second browser or an incognito window and log in as a different player.

Settings live in `server/.env` (copy `server/.env.example` if it is missing).

## Google sign-in

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Add `http://localhost:5173` under **Authorised JavaScript origins**.
3. Put the client ID in `server/.env` as `GOOGLE_CLIENT_ID=...` and restart the server.

The Google button appears on the login page once the ID is set. Guest login (`ALLOW_DEV_LOGIN=true`) lets you test without Google; set it to `false` before putting the site online.

## Single-process production run

```bash
cd client && npm run build
cd ../server && npm start     # serves the API and the built site on port 4000
```

## Deploy to EC2

One EC2 instance runs everything: nginx (HTTPS) in front of the Node server, which serves both the site and the live game. The database is MongoDB Atlas.

Before the first deploy:

1. **DNS:** point an A record for your domain at the instance's public IP.
2. **EC2 security group:** allow inbound 22 (your IP), 80 and 443 (anywhere).
3. **Atlas:** under Network Access, allow the instance's public IP.
4. Paste your Atlas URL into `server/.env.production`.

Then, from Git Bash in the project folder:

```bash
./deploy/deploy.sh /path/to/key.pem ubuntu@<instance-ip> play.example.com you@example.com
```

Use `ec2-user@...` on Amazon Linux. The email is used only to issue the free HTTPS certificate. Run the same command again to ship an update.

On the server: logs with `sudo journalctl -u pitch-duel -f`, restart with `sudo systemctl restart pitch-duel`.

## How to play

| Role | Controls |
| --- | --- |
| Bowler | Pick a bowler each over. Choose a variation (`1`-`4`), click the pitch to set where the ball lands, press `Space` to bowl. |
| Batter | Swing as the ball reaches the bat: `←` leg side, `↑` straight, `→` off side, `↓` defend. Hold `Shift` to loft. On-screen buttons do the same. |

Timing decides the result. Playing with the line of the ball (off-side ball to the off side) helps; lofting scores more but gets you caught when mistimed. A ball you miss that is on the stumps bowls you.

Each step has a timer, so a player who goes idle gets an automatic choice. A player who disconnects has 45 seconds to come back before forfeiting.

## Where things are

| File | What it does |
| --- | --- |
| `server/src/game/engine.js` | Cricket rules: delivery, timing, outcomes, scoring. No sockets, easy to tune. |
| `server/src/game/matchRoom.js` | One live match: team select, toss, innings, timers. |
| `server/src/realtime.js` | Online presence, challenges, socket events. |
| `server/src/poker/pokerRoom.js` | Heads-up No-Limit Hold'em table: blinds, betting rounds, all-ins, showdown. |
| `server/src/poker/handEval.js` | Poker hand ranking and the shuffled deck. |
| `client/src/pages/Poker.jsx` | Poker table screen. |
| `server/src/game/teams.js` | Teams and player ratings. |
| `client/src/pages/Match.jsx` | Match screen and controls. |
| `client/src/game/arena.js` | The 3D match view (three.js): ball flight, cameras, fielders, aiming. |
| `client/src/game/world.js` | Stadium: outfield, pitch, stands, crowd, floodlights. |
| `client/src/game/avatars.js` | Realistic player models: loading, team-colour repainting, and copying poses onto their skeletons. |
| `client/public/models/` | The player model files (Microsoft Rocketbox, MIT licence; see `LICENSE.txt` there). |
| `client/src/game/players.js` | Poses and animation (batting strokes, bowling action, running). |
| `client/src/game/models.js` | Equipment (helmets, pads, bat) and the simple fallback figures. |
| `client/src/game/sound.js` | Synthesised crowd, bat and stumps sounds. |
