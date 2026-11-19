#!/usr/bin/env bash
# One-shot setup (and update) of BOSS (Vishal-B2B2C) on the VPS, at $DOMAIN.
# Run as root. If the repository is private, with a GitHub token that can read
# fflxplc-lang/Vishal-B2B2C (not needed once install-autodeploy.sh has given
# the server its deploy key):
#   export GH_TOKEN=ghp_xxx
#   bash setup.sh
# Touches only vishal-b2b2c things; never the production CRM (finowise user,
# port 3000, "lifex" site) or the test copy (finowise-test, port 3001).
# Safe to re-run: later runs pull the latest code and restart the app.
set -euo pipefail

DOMAIN="${DOMAIN:-boss.freedomlifex.co.in}"
# The two platforms (access.js): partners on one address, company staff on
# the other, both served by this one app and store. DOMAIN stays as the
# combined address everyone can still use.
PARTNER_DOMAIN="${PARTNER_DOMAIN:-partner.freedomlifex.co.in}"
COMPANY_DOMAIN="${COMPANY_DOMAIN:-one.freedomlifex.co.in}"
ALL_DOMAINS="$DOMAIN $PARTNER_DOMAIN $COMPANY_DOMAIN"
U=vishal-b2b2c
HOME_DIR=/home/$U
APP=$HOME_DIR/app
ENV_FILE=$HOME_DIR/app.env
SITE=/etc/nginx/sites-available/$U
SERVICE=$U
BRANCH="${BRANCH:-main}"
REPO="https://github.com/fflxplc-lang/Vishal-B2B2C.git"
ZIP="${ZIP:-}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root (sudo -i first)"

say "System packages"
export DEBIAN_FRONTEND=noninteractive
need=""
for p in git nginx curl unzip openssl; do command -v $p >/dev/null || need="$need $p"; done
if [ -n "$need" ]; then apt-get update -q && apt-get install -y -q $need; fi
NODE_OK=""
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' && NODE_OK=1
fi
if [ -z "$NODE_OK" ]; then
  echo "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
NODE=$(command -v node)
echo "$NODE $("$NODE" -v)"
systemctl enable -q --now nginx

# A re-run keeps the port chosen the first time (it is saved in app.env).
SAVED_PORT=$(sed -n 's/^PORT=//p' $ENV_FILE 2>/dev/null || true)
PORT="${PORT:-$SAVED_PORT}"
if [ -z "$PORT" ]; then
  for p in $(seq 3010 3099); do [ -z "$(ss -ltnH "sport = :$p")" ] && { PORT=$p; break; }; done
fi
say "Port $PORT"
LISTENERS=$(ss -ltnpH "sport = :$PORT")
if [ -n "$LISTENERS" ]; then
  systemctl is-active --quiet $SERVICE && [[ $LISTENERS == *node* ]] \
    || die "port $PORT is used by something else; re-run with PORT=3050 bash setup.sh"
fi

say "Linux user $U"
id $U >/dev/null 2>&1 || adduser --system --group --home $HOME_DIR --shell /bin/bash $U
mkdir -p $HOME_DIR/data $HOME_DIR/backups

say "Code"
# Keep a copy of the data before touching the code (last 20 kept).
if [ -f $HOME_DIR/data/data.json ]; then
  tar -czf $HOME_DIR/backups/data-$(date +%Y%m%d-%H%M%S).tgz -C $HOME_DIR data
  ls -1t $HOME_DIR/backups/data-*.tgz | tail -n +21 | xargs -r rm -f
fi
if [ -n "$ZIP" ]; then
  [ -f "$ZIP" ] || die "no file at ZIP=$ZIP"
  TMP=$(mktemp -d)
  unzip -q "$ZIP" -d "$TMP"
  FOUND=$(find "$TMP" -maxdepth 3 -name server.js | head -1)
  # Checked before dirname: dirname of nothing is ".", the folder this was run from.
  [ -n "$FOUND" ] || { rm -rf "$TMP"; die "the zip has no server.js"; }
  SRC=$(dirname "$FOUND")
  rm -rf $APP.new && mkdir -p $APP.new && cp -a "$SRC/." $APP.new/
  rm -rf $APP.old; [ -d $APP ] && mv $APP $APP.old; mv $APP.new $APP
  rm -rf "$TMP"
  echo "code from $ZIP"
else
  AUTH=""
  [ -n "${GH_TOKEN:-}" ] && AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
  gitauth() { if [ -n "$AUTH" ]; then git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $AUTH" "$@"; else git "$@"; fi; }
  if [ -d $APP/.git ] && [[ "$(git -C $APP remote get-url origin 2>/dev/null)" == git@github.com:* ]]; then
    # install-autodeploy.sh moved the checkout to the app user's deploy key;
    # root has no key, so the app user fetches.
    runuser -u $U -- git -C $APP fetch -q origin $BRANCH
    runuser -u $U -- git -C $APP reset -q --hard origin/$BRANCH
  elif [ -d $APP/.git ]; then
    gitauth -C $APP fetch -q origin $BRANCH
    git -C $APP reset -q --hard origin/$BRANCH
  else
    rm -rf $APP
    gitauth clone -q -b $BRANCH $REPO $APP \
      || die "could not download $REPO (branch $BRANCH). If the repo is private: export GH_TOKEN=ghp_xxx and re-run. If it is still empty, use ZIP=/root/BOSS_merged.zip bash setup.sh"
  fi
  git config --global --add safe.directory $APP 2>/dev/null || true
  echo "commit $(git -C $APP rev-parse --short HEAD)"
fi
chown -R $U:$U $HOME_DIR
(cd $APP && runuser -u $U -- npm ci --omit=dev --no-audit --no-fund)
runuser -u $U -- "$NODE" --check $APP/server.js

say "Environment"
if [ ! -f $ENV_FILE ]; then
  cat > $ENV_FILE <<EOF
PORT=$PORT
HOST=127.0.0.1
CRM_DB_FILE=$HOME_DIR/data/data.json
CRM_USERS_DB=$HOME_DIR/data/users.db
CRM_PAYOUT_DB=$HOME_DIR/data/payout.db
CRM_API_KEY=$(openssl rand -hex 32)
CRM_SESSION_SECRET=$(openssl rand -hex 32)
CRM_PARTNER_HOSTS=$PARTNER_DOMAIN
CRM_COMPANY_HOSTS=$COMPANY_DOMAIN
CRM_PARTNER_URL=https://$PARTNER_DOMAIN
CRM_COMPANY_URL=https://$COMPANY_DOMAIN
EOF
  echo "created $ENV_FILE with new secrets"
else
  echo "keeping existing $ENV_FILE"
  grep -q '^CRM_PARTNER_HOSTS=' $ENV_FILE || printf 'CRM_PARTNER_HOSTS=%s\nCRM_COMPANY_HOSTS=%s\nCRM_PARTNER_URL=https://%s\nCRM_COMPANY_URL=https://%s\n' \
    "$PARTNER_DOMAIN" "$COMPANY_DOMAIN" "$PARTNER_DOMAIN" "$COMPANY_DOMAIN" >> $ENV_FILE
fi
chown $U:$U $ENV_FILE && chmod 600 $ENV_FILE

say "Service $SERVICE"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=BOSS ($DOMAIN)
After=network.target

[Service]
User=$U
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=$NODE server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q $SERVICE
systemctl restart $SERVICE
for i in $(seq 1 30); do curl -fs http://127.0.0.1:$PORT/api/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:$PORT/api/health >/dev/null \
  || { journalctl -u $SERVICE -n 40 --no-pager; die "app did not start (logs above)"; }
echo "app answering on 127.0.0.1:$PORT"

say "Admin login"
EMAIL=""
{ read -rp "Admin email (blank to skip): " EMAIL </dev/tty; } 2>/dev/null || echo "(no terminal, skipping)"
if [ -n "$EMAIL" ]; then
  read -rsp "Password for $EMAIL: " PW </dev/tty; echo
  (cd $APP && runuser -u $U -- env $(grep -v '^#' $ENV_FILE | xargs) "$NODE" scripts/user.js add "$EMAIL" "$PW" \
    || echo "(user may already exist; setting role anyway)")
  (cd $APP && runuser -u $U -- env $(grep -v '^#' $ENV_FILE | xargs) "$NODE" scripts/user.js role "$EMAIL" admin)
fi

say "nginx site for $ALL_DOMAINS"
for d in $ALL_DOMAINS; do
  if grep -rqs "server_name[^;]*\b$d\b" /etc/nginx/sites-enabled/ && ! grep -qs "server_name[^;]*\b$d\b" $SITE; then
    die "another nginx site already uses $d: $(grep -rls "server_name[^;]*\b$d\b" /etc/nginx/sites-enabled/)"
  fi
done
# Written when it is missing, and again when the addresses it answers on have
# changed (the Partner and Company platforms were added). certbot puts its
# HTTPS lines back below.
if [ ! -f $SITE ] || ! grep -q "server_name $ALL_DOMAINS;" $SITE; then
  [ -f $SITE ] && cp $SITE $SITE.bak
  cat > $SITE <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $ALL_DOMAINS;
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # live updates are a long-lived stream
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
EOF
  ln -sf $SITE /etc/nginx/sites-enabled/$U
  if ! nginx -t 2>/dev/null; then
    if [ -f $SITE.bak ]; then mv $SITE.bak $SITE; else rm -f /etc/nginx/sites-enabled/$U $SITE; fi
    nginx -t || true
    die "nginx rejected the site; the previous one is back, other sites untouched"
  fi
  systemctl reload nginx
  echo "site enabled for: $ALL_DOMAINS"
else
  echo "site already answers on $ALL_DOMAINS"
fi

say "HTTPS"
# A certificate for every address that already points at this server; the
# rest are named so their DNS record can be added, and picked up on a re-run.
HERE=" $(hostname -I) "
READY=""
for d in $ALL_DOMAINS; do
  ip=$(timeout 10 getent ahostsv4 "$d" | awk 'NR==1{print $1}' || true)
  if [ -n "$ip" ] && [[ "$HERE" == *" $ip "* ]]; then READY="$READY -d $d"
  else echo "$d resolves to '${ip:-nothing}', not this server ($(hostname -I | awk '{print $1}')). Add a DNS A record for it, then re-run this script."; fi
done
if [ -z "$READY" ]; then
  echo "No address points here yet. The site works on http:// once DNS is in place."
  exit 0
fi
command -v certbot >/dev/null || apt-get install -y -q certbot python3-certbot-nginx
certbot --nginx $READY --cert-name "$U" --expand --redirect --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring

say "Done"
for d in $ALL_DOMAINS; do echo "  https://$d"; done
echo "  Partners sign in at https://$PARTNER_DOMAIN, company staff at https://$COMPANY_DOMAIN."
