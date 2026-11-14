#!/usr/bin/env bash
# Builds the site on this computer and deploys it to the EC2 instance.
# Run from Git Bash in the project folder:
#
#   ./deploy/deploy.sh <key.pem> <user@host> <domain> [email]
#
#   key.pem    the EC2 key pair file
#   user@host  e.g. ubuntu@13.233.0.10 (Ubuntu) or ec2-user@13.233.0.10 (Amazon Linux)
#   domain     e.g. play.example.com, or several in quotes: "example.com www.example.com"
#              (DNS must already point at the instance; an existing site on it is replaced)
#   email      optional; needed only if the server has no HTTPS certificate for the domain yet
set -euo pipefail

KEY="${1:?usage: deploy.sh <key.pem> <user@host> <domain> [email]}"
HOST="${2:?user@host required}"
DOMAIN="${3:?domain required}"
EMAIL="${4:-}"

cd "$(dirname "$0")/.."

if [ ! -f server/.env.production ] || grep -q 'PASTE_YOUR_ATLAS_URL_HERE' server/.env.production; then
  echo "Put your MongoDB Atlas URL in server/.env.production first." >&2
  exit 1
fi

echo "== Building the client"
(cd client && npm install --no-audit --no-fund && npm run build)

echo "== Packaging"
BUNDLE=$(mktemp -d)/pitch-duel.tgz
tar czf "$BUNDLE" \
  server/src server/package.json server/package-lock.json server/.env.production \
  client/dist deploy

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "== Uploading to $HOST"
scp "${SSH_OPTS[@]}" "$BUNDLE" "$HOST:/tmp/pitch-duel.tgz"

echo "== Installing on the server"
ssh "${SSH_OPTS[@]}" "$HOST" "
  set -e
  sudo mkdir -p /opt/pitch-duel
  sudo rm -rf /opt/pitch-duel/server/src /opt/pitch-duel/client /opt/pitch-duel/deploy
  sudo tar xzf /tmp/pitch-duel.tgz -C /opt/pitch-duel
  rm -f /tmp/pitch-duel.tgz
  sudo bash /opt/pitch-duel/deploy/remote-setup.sh '$DOMAIN' '$EMAIL'
"
