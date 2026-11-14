#!/usr/bin/env bash
# Runs ON the EC2 instance (as root, via deploy.sh). Safe to run again on every deploy.
# Usage: remote-setup.sh "<domain> [more domains]" [email-for-https-certificate]
# Any existing nginx site for the same domain is switched off (and backed up) so this app replaces it.
set -euo pipefail

DOMAINS="${1:?domain required}"   # e.g. "example.com www.example.com"
EMAIL="${2:-}"
DOMAIN="${DOMAINS%% *}"            # the first one is the main domain
APP=/opt/pitch-duel

# Refuse to continue if another program already holds the game's port.
if ss -ltn 2>/dev/null | grep -q ':4000 ' && ! systemctl is-active -q pitch-duel; then
  echo "Port 4000 is already used by another program on this server:" >&2
  ss -ltnp | grep ':4000 ' >&2
  exit 1
fi

# ---- packages: Node 20, nginx, certbot (Ubuntu/Debian or Amazon Linux) ----
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  apt-get install -y nginx certbot python3-certbot-nginx
else
  PKG=$(command -v dnf || command -v yum)
  if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    "$PKG" install -y nodejs
  fi
  "$PKG" install -y nginx certbot python3-certbot-nginx
fi

# ---- app user, settings, dependencies ----
id pitchduel >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pitchduel

ENV_FILE="$APP/server/.env"
# Keep the existing JWT secret across deploys so players stay logged in.
OLD_SECRET=$(grep -s '^JWT_SECRET=' "$ENV_FILE" || true)
cp "$APP/server/.env.production" "$ENV_FILE"
rm -f "$APP/server/.env.production"
if ! grep -q '^JWT_SECRET=' "$ENV_FILE"; then
  echo "${OLD_SECRET:-JWT_SECRET=$(openssl rand -hex 32)}" >> "$ENV_FILE"
fi
chown root:pitchduel "$ENV_FILE"
chmod 640 "$ENV_FILE"

cd "$APP/server"
npm ci --omit=dev --no-audit --no-fund

# ---- service ----
cp "$APP/deploy/pitch-duel.service" /etc/systemd/system/pitch-duel.service
systemctl daemon-reload
systemctl enable pitch-duel >/dev/null
systemctl restart pitch-duel

# ---- nginx ----
CONF=/etc/nginx/conf.d/pitch-duel.conf

# Back up the whole nginx config once per deploy, then switch off any other site using this domain.
BACKUP=/root/nginx-backup-$(date +%Y%m%d-%H%M%S).tgz
tar czf "$BACKUP" -C /etc nginx
echo "nginx config backed up to $BACKUP"
mkdir -p /etc/nginx/replaced-by-pitch-duel
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || continue
  [ "$f" = "$CONF" ] && continue
  if grep -Eqs "server_name[^;]*[[:space:]]$DOMAIN([[:space:];])" "$f"; then
    echo "Switching off existing site config: $f"
    mv "$f" /etc/nginx/replaced-by-pitch-duel/"$(basename "$f")".off
  fi
done

# Don't overwrite a config certbot has already upgraded to HTTPS.
if ! grep -qs 'managed by Certbot' "$CONF"; then
  sed "s/__DOMAIN__/$DOMAINS/g" "$APP/deploy/nginx.conf" > "$CONF"
fi
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx

# ---- HTTPS ----
if ! grep -qs 'managed by Certbot' "$CONF"; then
  D_ARGS=()
  for d in $DOMAINS; do D_ARGS+=(-d "$d"); done
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    # The old site already had a certificate for this domain: reuse it.
    certbot install --nginx --cert-name "$DOMAIN" "${D_ARGS[@]}" --redirect --non-interactive
  elif [ -n "$EMAIL" ]; then
    certbot --nginx "${D_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect
  else
    echo "No certificate found and no email given: site is HTTP only for now." >&2
  fi
fi

sleep 2
systemctl is-active pitch-duel
curl -fsS http://127.0.0.1:4000/api/config && echo
echo "Deployed. Open: https://$DOMAIN"
