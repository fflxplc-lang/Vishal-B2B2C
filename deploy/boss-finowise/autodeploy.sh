#!/usr/bin/env bash
# Auto-deployer for BOSS (Vishal-B2B2C). Installed to /home/vishal-b2b2c/deploy.sh
# by install-autodeploy.sh and run every minute by vishal-b2b2c-deploy.timer.
#
# It watches the `deploy` branch, not `main`: changes land on main, and only
# moving `deploy` (when the owner says "deploy") puts them live. On a new
# commit it backs up the data, installs, checks, restarts, and waits for
# /api/health. If any step fails, the previous commit is put back by itself.
# The data in /home/vishal-b2b2c/data is never written here, only copied into
# backups/. What happened is one line in deploy-status.txt, which the app
# serves at https://<your domain>/deploy-status.txt.
#
# This copy runs from outside the app folder on purpose: a bad commit must not
# be able to break the thing that rolls bad commits back.
set -uo pipefail

U=vishal-b2b2c
HOME_DIR=/home/$U
APP=$HOME_DIR/app
SERVICE=$U
# The branch that is live: `deploy`, unless app.env says DEPLOY_BRANCH=...
BRANCH=$(sed -n 's/^DEPLOY_BRANCH=//p' $HOME_DIR/app.env 2>/dev/null)
BRANCH=${BRANCH:-deploy}
STATUS=$HOME_DIR/deploy-status.txt
BACKUPS=$HOME_DIR/backups
PORT=$(sed -n 's/^PORT=//p' $HOME_DIR/app.env)
NODE=$(command -v node)

as_app() { runuser -u $U -- "$@"; }
log() { echo "$(date -u +%FT%TZ) $*"; }
status() { echo "$(date -u +%FT%TZ) $*" > $STATUS; chown $U:$U $STATUS; log "$*"; }

healthy() {
  for _ in $(seq 1 30); do
    curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0
    sleep 1
  done
  return 1
}

install_and_start() {   # $1 = commit
  as_app git -C $APP reset -q --hard "$1" &&
  (cd $APP && as_app npm ci --omit=dev --no-audit --no-fund --loglevel=error) &&
  as_app "$NODE" --check $APP/server.js &&
  systemctl restart $SERVICE &&
  healthy
}

CUR=$(as_app git -C $APP rev-parse HEAD)
if ! ERR=$(as_app git -C $APP fetch -q origin "$BRANCH" 2>&1); then
  # Said once in the status, not every minute in the log: a deploy key that
  # stopped working must not look like "nothing to deploy".
  grep -q '^.* WAITING' $STATUS 2>/dev/null || status "WAITING: LIVE ${CUR:0:7}, but GitHub cannot be read - $(echo "$ERR" | tail -1 | cut -c1-160)"
  exit 0
fi
NEW=$(as_app git -C $APP rev-parse "origin/$BRANCH")
FAILED=$(cat $HOME_DIR/deploy-failed 2>/dev/null || true)
# First run, or GitHub readable again after a WAITING line: say what is live.
if [ ! -s $STATUS ] || grep -q 'WAITING' $STATUS; then
  if [ -n "$FAILED" ] && [ "$NEW" = "$FAILED" ]; then status "ROLLED BACK to ${CUR:0:7} - ${NEW:0:7} failed (see: journalctl -u $SERVICE-deploy -n 50)"
  else status "LIVE ${CUR:0:7}"; fi
fi
[ "$NEW" = "$CUR" ] && exit 0
# A commit that already failed is not retried every minute; push a new one.
[ "$NEW" = "$FAILED" ] && exit 0

log "deploying ${NEW:0:7} (was ${CUR:0:7})"
status "DEPLOYING ${NEW:0:7} (was ${CUR:0:7})"
mkdir -p $BACKUPS
STAMP=$(date -u +%Y%m%d-%H%M%S)
cp -a $HOME_DIR/data "$BACKUPS/$STAMP-before-${NEW:0:7}"
ls -1dt $BACKUPS/*/ 2>/dev/null | tail -n +21 | xargs -r rm -rf   # keep the last 20
chown -R $U:$U $BACKUPS

if install_and_start "$NEW"; then
  rm -f $HOME_DIR/deploy-failed
  status "LIVE ${NEW:0:7}"
else
  echo "$NEW" > $HOME_DIR/deploy-failed
  log "${NEW:0:7} failed; putting ${CUR:0:7} back"
  if install_and_start "$CUR"; then
    status "ROLLED BACK to ${CUR:0:7} - ${NEW:0:7} failed (see: journalctl -u $SERVICE-deploy -n 50)"
  else
    status "CRITICAL: ${NEW:0:7} failed and rolling back to ${CUR:0:7} also failed"
  fi
  exit 1
fi
