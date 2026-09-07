#!/bin/bash
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_DIR="${AGENT_BROWSER_CONFIG_DIR:-$CONFIG_HOME/agent-browser}"
DATA_DIR="${AGENT_BROWSER_DATA_DIR:-$DATA_HOME/agent-browser}"

docker compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.yaml" ps
test "$(docker info --format '{{.OSType}}')" = linux
docker compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.yaml" \
  exec -T desktop node /opt/agent-browser/node_modules/@playwright/mcp/cli.js --version
docker compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.yaml" \
  exec -T desktop sh -c \
  'node /opt/agent-browser/node_modules/@playwright/mcp/cli.js --help | grep -E -- "--sandbox|--user-data-dir|--output-dir|--timeout-action|--timeout-navigation"'

test -d "$DATA_DIR/profile"
test -d "$DATA_DIR/artifacts"
test -d "$DATA_DIR/logs"
test -s "$DATA_DIR/secrets/vnc-password"
curl --fail --silent --show-error http://127.0.0.1:6080/vnc.html >/dev/null

echo "Runtime preflight passed. Complete concurrent MCP isolation, reconnect, manual takeover, and worker cleanup tests from fresh sessions."
