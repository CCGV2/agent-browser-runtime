#!/bin/sh
set -eu

umask 077
LOCK_FILE=/data/profile/.agent-browser-mcp.lock

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required to protect the persistent browser profile" >&2
  exit 70
fi

exec flock --nonblock --conflict-exit-code 75 "$LOCK_FILE" \
  node /opt/agent-browser/node_modules/@playwright/mcp/cli.js \
    --browser chromium \
    --sandbox \
    --user-data-dir /data/profile \
    --output-dir /data/artifacts \
    --timeout-action 10000 \
    --timeout-navigation 90000 \
    --viewport-size 1440x900
