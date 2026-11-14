#!/usr/bin/env bash
# One-shot setup (and update) of the B2C app at boss.finowise.com on the VPS.
# Run as root, with a GitHub token that can read fflxplc-lang/FINOWISE_BOSS
# (not needed once install-autodeploy.sh has given the server its deploy key):
#   export GH_TOKEN=ghp_xxx
#   bash setup.sh
# Touches only finowise-b2c things; never the production CRM (finowise user,
# port 3000, "lifex" site) or the test copy (finowise-test, port 3001).
# Safe to re-run: later runs pull the latest code and restart the app.
set -euo pipefail

DOMAIN="${DOMAIN:-boss.finowise.com}"
U=finowise-b2c
HOME_DIR=/home/$U
APP=$HOME_DIR/app
ENV_FILE=$HOME_DIR/app.env
SITE=/etc/nginx/sites-available/finowise-b2c
SERVICE=finowise-b2c
BRANCH="${BRANCH:-main}"
REPO="https://github.com/fflxplc-lang/FINOWISE_BOSS.git"
# A re-run keeps the port chosen the first time (it is saved in app.env).
SAVED_PORT=$(sed -n 's/^PORT=//p' $ENV_FILE 2>/dev/null || true)
PORT="${PORT:-${SAVED_PORT:-3002}}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root"

# The repo is private. Once install-autodeploy.sh has run, the app's user
# fetches with its own read-only deploy key and no token is needed. Before
# that, a token is passed to git for this run only, never saved.
USES_KEY=""
[ -d $APP/.git ] && [[ "$(git -C $APP remote get-url origin 2>/dev/null)" == git@github.com:* ]] && USES_KEY=1
if [ -z "$USES_KEY" ]; then
  if [ -z "${GH_TOKEN:-}" ]; then
    printf 'GitHub token with read access to fflxplc-lang/FINOWISE_BOSS (hidden as you type): ' >/dev/tty 2>/dev/null || true
    { read -rs GH_TOKEN </dev/tty; echo; } 2>/dev/null || true
  fi
  [ -n "${GH_TOKEN:-}" ] || die "no GitHub token; run: export GH_TOKEN=ghp_xxx  then re-run"
  AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
fi
gitauth() { git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${AUTH:-}" "$@"; }

say "Checking Node.js"
NODE=$(command -v node) || die "node is not installed"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $("$NODE" -v) is too old; need 22.13+"
echo "$NODE $("$NODE" -v)"

say "Checking port $PORT is free (or already ours)"
LISTENERS=$(ss -ltnpH "sport = :$PORT")
if [ -n "$LISTENERS" ]; then
  systemctl is-active --quiet $SERVICE && [[ $LISTENERS == *node* ]] \
    || die "port $PORT is used by something else; re-run with PORT=3003 bash setup.sh"
fi

say "Linux user $U"
id $U >/dev/null 2>&1 || adduser --system --group --home $HOME_DIR --shell /bin/bash $U
mkdir -p $HOME_DIR/data

say "Code ($BRANCH)"
if [ -n "$USES_KEY" ]; then
  runuser -u $U -- git -C $APP fetch -q origin $BRANCH
  runuser -u $U -- git -C $APP reset -q --hard origin/$BRANCH
elif [ -d $APP/.git ]; then
  git -C $APP remote set-url origin $REPO
  gitauth -C $APP fetch -q origin $BRANCH
  git -C $APP reset -q --hard origin/$BRANCH
else
  gitauth clone -q -b $BRANCH $REPO $APP || die "could not download the repo; check the token can read fflxplc-lang/FINOWISE_BOSS"
fi
git config --global --add safe.directory $APP 2>/dev/null || true
chown -R $U:$U $HOME_DIR
(cd $APP && runuser -u $U -- npm ci --omit=dev --no-audit --no-fund)
runuser -u $U -- "$NODE" --check $APP/server.js
echo "commit $(git -C $APP rev-parse --short HEAD)"

say "Environment"
if [ ! -f $ENV_FILE ]; then
  cat > $ENV_FILE <<EOF
PORT=$PORT
HOST=127.0.0.1
CRM_DB_FILE=$HOME_DIR/data/data.json
CRM_USERS_DB=$HOME_DIR/data/users.db
CRM_API_KEY=$(openssl rand -hex 32)
CRM_SESSION_SECRET=$(openssl rand -hex 32)
EOF
  echo "created $ENV_FILE with new secrets"
else
  echo "keeping existing $ENV_FILE"
fi
chown $U:$U $ENV_FILE && chmod 600 $ENV_FILE

say "Service $SERVICE"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Finowise B2C app ($DOMAIN)
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
for i in $(seq 1 20); do curl -fs http://127.0.0.1:$PORT/api/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:$PORT/api/health >/dev/null \
  || { journalctl -u $SERVICE -n 30 --no-pager; die "app did not start (logs above)"; }
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

say "nginx site for $DOMAIN"
if grep -rqs "server_name[^;]*\b$DOMAIN\b" /etc/nginx/sites-enabled/ && [ ! -f $SITE ]; then
  die "another nginx site already uses $DOMAIN: $(grep -rls "server_name[^;]*\b$DOMAIN\b" /etc/nginx/sites-enabled/)"
fi
if [ ! -f $SITE ]; then
  cat > $SITE <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf $SITE /etc/nginx/sites-enabled/finowise-b2c
  if ! nginx -t 2>/dev/null; then
    rm -f /etc/nginx/sites-enabled/finowise-b2c $SITE
    nginx -t || true
    die "nginx rejected the new site; removed it again, other sites untouched"
  fi
  systemctl reload nginx
  echo "site enabled"
else
  echo "site already exists, leaving it as is"
fi

say "HTTPS"
IP_DNS=$(timeout 10 getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -z "$IP_DNS" ] || [[ " $(hostname -I) " != *" $IP_DNS "* ]]; then
  echo "$DOMAIN resolves to '${IP_DNS:-nothing}', not this server ($(hostname -I | awk '{print $1}'))."
  echo "Add the DNS A record (boss -> this server's IP) at GoDaddy, wait a few minutes,"
  echo "then re-run this script to get HTTPS."
  exit 0
fi
command -v certbot >/dev/null || apt-get install -y -q certbot python3-certbot-nginx
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring

say "Done: https://$DOMAIN"
