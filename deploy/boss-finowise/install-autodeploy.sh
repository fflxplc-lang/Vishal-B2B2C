#!/usr/bin/env bash
# Turns on auto-deploy for boss.finowise.com. Run once as root, after setup.sh:
#   bash /home/finowise-b2c/app/deploy/boss-finowise/install-autodeploy.sh
#
# What it does:
#   1. Gives the app's Linux user a read-only GitHub "deploy key" for this one
#      repository, so the server can fetch new code by itself. No token is
#      stored anywhere. You paste the key into GitHub once (it shows how).
#   2. Copies autodeploy.sh to /home/finowise-b2c/deploy.sh, outside the app
#      folder, and runs it every minute with a systemd timer.
# From then on, moving the `deploy` branch on GitHub puts that commit live
# within a minute, with a data backup first and an automatic rollback if the
# new code does not start. Status: https://boss.finowise.com/deploy-status.txt
# Safe to re-run (for example to pick up a newer autodeploy.sh).
set -euo pipefail

U=finowise-b2c
HOME_DIR=/home/$U
APP=$HOME_DIR/app
OWNER_REPO=fflxplc-lang/FINOWISE_BOSS
KEY=$HOME_DIR/.ssh/id_ed25519

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u $U -- "$@"; }

[ "$(id -u)" = 0 ] || die "run this as root"
[ -d $APP/.git ] || die "run setup.sh first: $APP is not there"
SRC_SCRIPT=$APP/deploy/boss-finowise/autodeploy.sh
[ -f $SRC_SCRIPT ] || die "$SRC_SCRIPT is missing; run setup.sh again to get the latest code"

say "Deploy key for $U"
mkdir -p $HOME_DIR/.ssh && chmod 700 $HOME_DIR/.ssh && chown $U:$U $HOME_DIR/.ssh
if [ ! -f $KEY ]; then
  as_app ssh-keygen -q -t ed25519 -N '' -C "boss.finowise.com auto-deploy" -f $KEY
  echo "made a new key"
else
  echo "keeping the existing key"
fi
touch $HOME_DIR/.ssh/known_hosts
ssh-keyscan -t ed25519 github.com 2>/dev/null >> $HOME_DIR/.ssh/known_hosts
sort -u -o $HOME_DIR/.ssh/known_hosts $HOME_DIR/.ssh/known_hosts
chown $U:$U $HOME_DIR/.ssh/known_hosts

can_read() { as_app git ls-remote "git@github.com:$OWNER_REPO.git" HEAD >/dev/null 2>&1; }
if ! can_read; then
  echo
  echo "GitHub does not know this key yet. Add it once:"
  echo "  1. Open https://github.com/$OWNER_REPO/settings/keys/new"
  echo "  2. Title: boss.finowise.com auto-deploy"
  echo "  3. Key: paste the line below"
  echo "  4. Leave \"Allow write access\" UNticked, then click Add key"
  echo
  cat $KEY.pub
  echo
  for _ in 1 2 3 4 5; do
    { read -rp "Press Enter once the key is added on GitHub... " _ </dev/tty; } 2>/dev/null || sleep 30
    can_read && break
    echo "GitHub still refuses the key. Check it was pasted whole, on the repository $OWNER_REPO."
  done
  can_read || die "GitHub did not accept the key; nothing else was changed. Add the key and run this again."
fi
echo "GitHub accepts the key (read-only)"

say "Code fetched with the key from now on"
git config --global --add safe.directory $APP 2>/dev/null || true
as_app git -C $APP remote set-url origin "git@github.com:$OWNER_REPO.git"
as_app git -C $APP fetch -q origin
echo "running $(as_app git -C $APP rev-parse --short HEAD)"

say "Auto-deploy timer"
install -m 700 -o root -g root $SRC_SCRIPT $HOME_DIR/deploy.sh
bash -n $HOME_DIR/deploy.sh

cat > /etc/systemd/system/finowise-b2c-deploy.service <<'EOF'
[Unit]
Description=Deploy boss.finowise.com from the deploy branch

[Service]
Type=oneshot
ExecStart=/home/finowise-b2c/deploy.sh
EOF

cat > /etc/systemd/system/finowise-b2c-deploy.timer <<'EOF'
[Unit]
Description=Check the deploy branch for boss.finowise.com every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now finowise-b2c-deploy.timer
systemctl start finowise-b2c-deploy.service || true

say "Done"
echo "Auto-deploy is on. Moving the deploy branch on GitHub puts it live within a minute."
echo "Status:  cat $HOME_DIR/deploy-status.txt   (also https://boss.finowise.com/deploy-status.txt)"
echo "History: journalctl -u finowise-b2c-deploy -n 30 --no-pager"
echo "Backups: ls $HOME_DIR/backups   (the data, copied before every deploy; the last 20 are kept)"
