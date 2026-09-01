#!/bin/bash
set -e
cd /opt/claudable
git fetch origin main -q
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date -u +%FT%TZ) change $LOCAL -> $REMOTE, deploying" >> /opt/claudable/webhook/poll.log
  /opt/claudable/deploy.sh >> /opt/claudable/webhook/poll.log 2>&1
fi
